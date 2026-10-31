/**
 * 本地向量召回线（1.5.0，DESIGN-1.5 模块 M）——零依赖 HNSW 近似最近邻索引。
 *
 * roadmap 未勾选项「向量召回后端（本地 HNSW）作为第六线接入 RRF」落地：
 * - 向量空间：与 A2 语义线同源的特征空间（tokenize.semanticFeatureCounts——
 *   英文/数字词字符 3-gram + CJK 2-gram），权重 = TF·IDF（语料侧文档频率），
 *   稀疏表示 + L2 归一化，余弦相似度 = 归一化点积；
 * - 与 A2 语义线（查询覆盖率，非对称——「查询特征被文档覆盖多少」）互补：
 *   向量线是**对称相似度**（文档侧特异性也参与计分），是独立的第六条排序信号；
 * - HNSW（Hierarchical Navigable Small World）确定性工程化：
 *   · 层指派 fnv1a(id, seed) 哈希 → u ∈ (0,1] → level = ⌊−ln(u)·mL⌋（mL = 1/ln M），
 *     不依赖 Math.random——同一 id 集合与次序下图结构与查询结果可复算；
 *   · 插入：上层贪心下降定位 + 每层 efConstruct 候选束搜索 + 近邻互连
 *     （M 上限裁剪，并列按 id 字典序打破——确定性）；
 *   · 查询：贪心下降至底层 + ef 候选束搜索，top-k（相似度降序、id 字典序兜底）；
 *   · 有界性：每节点每层度 ≤ M、候选 ≤ ef、结果 ≤ k——大库查询近对数级；
 * - 零行为回归：本线默认关闭（vectorEnabled=false），engine 侧仅在
 *   options.vector 注入且 vectorEnabled=true 时参与融合（与图谱/推理线同形态）。
 *
 * 依赖方向纪律：本模块位于 engine 之下（engine → vector → tokenize/hash），
 * 不得反向导入 engine（会成环）——共享的 fnv1a/semanticFeatures/fingerprint
 * 已为此下沉至叶子模块（tokenize.ts / hash.ts）。
 */
import { fingerprint } from './hash'
import { fnv1a, semanticFeatureCounts } from './tokenize'
import type { MemoryEntry, VectorRecallSource } from './types'

/** 每节点每层近邻上限（经典 HNSW/hnswlib 缺省 M=16：簇状语料导航性的实测平衡点；
 *  底层上限为 2M——簇内 hub 裁剪掉跨簇回链会使图退化为不可达子图，更大 M 抑制该病理） */
export const HNSW_DEFAULT_M = 16
/** 构建期候选束宽（efConstruction：召回质量 × 构建成本；100 为记忆库千级语料的平衡点） */
export const HNSW_DEFAULT_EF_CONSTRUCT = 100
/** 查询期候选束宽下限（ef ≥ 常用 k 且留余量，保证 top-k 召回质量） */
export const HNSW_DEFAULT_EF = 128
/** 第六线插值权重（与图谱 0.35 / 推理 0.25 同量级；向量是独立信号，0.30） */
export const VECTOR_LINE_WEIGHT = 0.3
/** 每次查询取回的近邻数上限（融合线的候选面足够宽，又不放大 hub 噪声） */
export const VECTOR_LINE_TOP_K = 24

/** 稀疏向量（L2 归一化前的权重 + 预计算范数；norm=0 表示零向量，永不参与相似度） */
export interface SparseVector {
  weights: ReadonlyMap<string, number>
  norm: number
}

/**
 * 特征计数 → TF·IDF 稀疏向量（L2 归一化前）。
 * IDF 缺省（查询含语料未见特征）= log(1+N)：未见即最特异，不因缺省被抹平。
 */
export function sparseFromFeatures(
  counts: ReadonlyMap<string, number>,
  idf: ReadonlyMap<string, number>,
  docCount: number,
): SparseVector {
  const weights = new Map<string, number>()
  const defaultIdf = Math.log(1 + Math.max(1, docCount))
  let sq = 0
  for (const [f, tf] of counts) {
    const w = (1 + Math.log(tf)) * (idf.get(f) ?? defaultIdf)
    weights.set(f, w)
    sq += w * w
  }
  return { weights, norm: Math.sqrt(sq) }
}

/** 两个稀疏向量的余弦相似度（任一侧零向量 → 0；小侧迭代交集） */
export function cosineSparse(a: SparseVector, b: SparseVector): number {
  if (a.norm === 0 || b.norm === 0) return 0
  const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a]
  let dot = 0
  for (const [f, w] of small.weights) {
    const o = large.weights.get(f)
    if (o !== undefined) dot += w * o
  }
  return dot / (a.norm * b.norm)
}

/** 距离比较器（距离升序，id 字典序兜底——确定性；模块级纯函数） */
function byDistance(a: { id: string; d: number }, b: { id: string; d: number }): number {
  return a.d - b.d || (a.id < b.id ? -1 : 1)
}

/** HNSW 图节点：level+1 层，每层邻接表（近邻 id → 相似度缓存） */
interface HnswNode {
  id: string
  level: number
  layers: Array<Map<string, number>>
}

/** HNSW 索引可观测统计（规模/边数/层高/距离计算计数——评估与测试用） */
export interface HnswStats {
  nodes: number
  edges: number
  maxLevel: number
  distanceCalculations: number
}

/**
 * 确定性 HNSW 索引（纯内存、可重建；insert 幂等——同 id 重复插入忽略）。
 *
 * 距离 = 1 − 余弦相似度；并列按 id 字典序打破，全部排序路径确定。
 * 相似度在连接时缓存（邻接表 value），搜索期对查询向量现算。
 */
export class HnswVectorIndex {
  private nodes = new Map<string, HnswNode>()
  private vectors = new Map<string, SparseVector>()
  private entryPoint: { id: string; level: number } | undefined
  private readonly m: number
  private readonly efConstruct: number
  private readonly seed: number
  private readonly levelFactor: number
  private distanceCalls = 0

  constructor(opts: { m?: number; efConstruct?: number; seed?: number } = {}) {
    this.m = Math.max(2, Math.floor(opts.m ?? HNSW_DEFAULT_M))
    this.efConstruct = Math.max(1, Math.floor(opts.efConstruct ?? HNSW_DEFAULT_EF_CONSTRUCT))
    this.seed = (opts.seed ?? 0x5eed1234) >>> 0
    this.levelFactor = 1 / Math.log(this.m)
  }

  /** 确定性层指派：fnv1a(id, seed) → u ∈ (0,1] → ⌊−ln(u)·mL⌋（指数层高分布） */
  private levelFor(id: string): number {
    const h = fnv1a(id, this.seed)
    const u = ((h % 10000) + 1) / 10000
    return Math.floor(-Math.log(u) * this.levelFactor)
  }

  private similarity(a: SparseVector, b: SparseVector): number {
    this.distanceCalls++
    return cosineSparse(a, b)
  }

  get size(): number {
    return this.nodes.size
  }

  stats(): HnswStats {
    let edges = 0
    let maxLevel = 0
    for (const n of this.nodes.values()) {
      for (const l of n.layers) edges += l.size
      if (n.level > maxLevel) maxLevel = n.level
    }
    return { nodes: this.nodes.size, edges, maxLevel, distanceCalculations: this.distanceCalls }
  }

  /**
   * 单层候选束搜索（经典 HNSW SEARCH-LAYER）：
   * 从 entryPoints 出发，维护 ef 个最近结果与候选队列，扩展未被访问的近邻，
   * 候选最优劣于结果最劣且结果已满时终止。返回 ef 个 {id: 相似度}。
   */
  private searchLayer(
    query: SparseVector,
    entryPoints: readonly string[],
    ef: number,
    layer: number,
  ): Map<string, number> {
    const visited = new Set(entryPoints)
    const candidates: Array<{ id: string; d: number }> = []
    const results: Array<{ id: string; d: number }> = []
    // 不变式：入口 id 全部来自在驻节点（greedyClosest 结果 / entryPoint），vectors 必命中
    for (const e of entryPoints) {
      const d = 1 - this.similarity(query, this.vectors.get(e)!)
      candidates.push({ id: e, d })
      results.push({ id: e, d })
    }
    candidates.sort(byDistance)
    results.sort(byDistance)
    results.length = Math.min(results.length, ef)
    while (candidates.length > 0) {
      const c = candidates.shift()!
      const worst = results[results.length - 1]
      if (worst !== undefined && results.length >= ef && c.d > worst.d) break
      // 不变式：候选来自本图在驻节点；其 layers[layer] 必存在（level ≥ layer 的建图不变式）
      const links = this.nodes.get(c.id)!.layers[layer]!
      for (const nid of links.keys()) {
        if (visited.has(nid)) continue
        visited.add(nid)
        const d = 1 - this.similarity(query, this.vectors.get(nid)!)
        const w = results[results.length - 1]
        if (results.length < ef || (w !== undefined && d < w.d)) {
          candidates.push({ id: nid, d })
          results.push({ id: nid, d })
          results.sort(byDistance)
          results.length = Math.min(results.length, ef)
        }
      }
      candidates.sort(byDistance)
    }
    return new Map(results.map((r) => [r.id, 1 - r.d]))
  }

  /** 上层贪心下降：从 entryId 出发移动到任一严格更近的近邻（无则返回当前） */
  private greedyClosest(query: SparseVector, entryId: string, layer: number): string {
    let best = entryId
    const bestVec = this.vectors.get(best)
    let bestD = bestVec === undefined ? 1 : 1 - this.similarity(query, bestVec)
    let improved = true
    while (improved) {
      improved = false
      // 不变式：best 为在驻节点且 level ≥ layer（贪心只沿同层链移动）
      const links = this.nodes.get(best)!.layers[layer]!
      for (const nid of links.keys()) {
        const d = 1 - this.similarity(query, this.vectors.get(nid)!)
        if (d < bestD) {
          best = nid
          bestD = d
          improved = true
          break
        }
      }
    }
    return best
  }

  /** 每层邻接上限：底层 2M（论文 M_max0），上层 M */
  private layerCapacity(layer: number): number {
    return layer === 0 ? this.m * 2 : this.m
  }

  /**
   * 近邻多样性选择（论文 Algorithm 4 + keepPrunedConnections 回填）。
   * 候选 e 仅当「到查询的距离（c.d，调用方已算）< 到任一已选近邻的距离」才入选——
   * 比单纯最近 M 个多保留不同方向的近邻，防止簇内 hub 全量裁剪掉新节点回链
   * （图退化为主子图不可达）；不足上限时按距离升序回填被丢弃者（局部召回不受损）。
   */
  private selectNeighbors(
    candidates: ReadonlyArray<{ id: string; d: number }>,
    cap: number,
  ): Array<{ id: string; d: number }> {
    const sorted = [...candidates].sort(byDistance)
    const selected: Array<{ id: string; d: number }> = []
    const discarded: Array<{ id: string; d: number }> = []
    for (const c of sorted) {
      if (selected.length >= cap) {
        discarded.push(c)
        continue
      }
      // 不变式：候选全部来自本索引在驻节点（searchLayer 结果 / 邻接表键），vectors 必命中
      const cv = this.vectors.get(c.id)!
      let diverse = true
      for (const s of selected) {
        const dToSelected = 1 - this.similarity(cv, this.vectors.get(s.id)!)
        if (dToSelected <= c.d) {
          diverse = false
          break
        }
      }
      if (diverse) selected.push(c)
      else discarded.push(c)
    }
    for (const d of discarded) {
      if (selected.length >= cap) break
      selected.push(d)
    }
    return selected.sort(byDistance)
  }

  /** 每层邻接表按多样性选择裁剪到该层上限（相似度缓存沿用原值） */
  private pruneLayer(node: HnswNode, layer: number): void {
    const links = node.layers[layer]
    const cap = this.layerCapacity(layer)
    if (links === undefined || links.size <= cap) return
    const own = this.vectors.get(node.id)
    if (own === undefined) return
    const cands = [...links.entries()].map(([id, sim]) => ({ id, d: 1 - sim }))
    const kept = this.selectNeighbors(cands, cap)
    node.layers[layer] = new Map(kept.map((x) => [x.id, links.get(x.id)!]))
  }

  /**
   * 插入一个向量（构建期按语料序调用）：
   * 上层贪心下降定位 → level..0 每层 efConstruct 束搜索 → **多样性选择** ≤M 近邻
   * 互连 → 对侧超限按同规则裁剪；超越当前入口层高时更新入口。
   */
  insert(id: string, vec: SparseVector): void {
    if (this.vectors.has(id)) return // 幂等：同 id 重复插入忽略
    const level = this.levelFor(id)
    const node: HnswNode = { id, level, layers: Array.from({ length: level + 1 }, () => new Map<string, number>()) }
    this.nodes.set(id, node)
    this.vectors.set(id, vec)
    if (this.entryPoint === undefined) {
      this.entryPoint = { id, level }
      return
    }
    let cur = this.entryPoint.id
    const top = this.entryPoint.level
    for (let l = top; l > level; l--) {
      cur = this.greedyClosest(vec, cur, l)
    }
    for (let l = Math.min(level, top); l >= 0; l--) {
      const cands = this.searchLayer(vec, [cur], this.efConstruct, l)
      const candList = [...cands.entries()].map(([nid, sim]) => ({ id: nid, d: 1 - sim }))
      const neighbors = this.selectNeighbors(candList, this.m)
      for (const n of neighbors) {
        const sim = cands.get(n.id)!
        node.layers[l]!.set(n.id, sim)
        const other = this.nodes.get(n.id)!
        other.layers[l]!.set(id, sim)
        this.pruneLayer(other, l)
      }
      const first = neighbors[0]
      if (first !== undefined) cur = first.id
    }
    if (level > top) this.entryPoint = { id, level }
  }

  /**
   * 近邻查询：贪心下降至底层 → ef 候选束搜索 → top-k（相似度降序，id 字典序兜底）。
   * 空索引 / 零查询向量返回空。ef 实际取 max(ef, k)（k > ef 时自动放宽）。
   */
  search(query: SparseVector, k: number, ef: number = HNSW_DEFAULT_EF): Array<{ id: string; score: number }> {
    if (this.entryPoint === undefined || query.norm === 0) return []
    let cur = this.entryPoint.id
    for (let l = this.entryPoint.level; l >= 1; l--) {
      cur = this.greedyClosest(query, cur, l)
    }
    const found = this.searchLayer(query, [cur], Math.max(ef, k), 0)
    return [...found.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, k)
      .map(([id, score]) => ({ id, score }))
  }
}

/** 向量线构建选项（评估网格/调参注入位；缺省全取经典常数） */
export interface VectorIndexOptions {
  m?: number
  efConstruct?: number
  seed?: number
  topK?: number
}

/**
 * 向量第六线的召回源（实现 types.VectorRecallSource）。
 * 构建即全量：语料特征空间统计 IDF → 逐条向量化（零范数条目跳过——不可经向量线
 * 召回，词面/语义/图谱线不受影响）→ HNSW 按语料序插入（createdAt 升序 = 确定性）。
 * `exactTopK` 提供同特征空间的暴力全量对拍（评估门禁 G23 的真值锚）。
 */
export class VectorRecallIndex implements VectorRecallSource {
  private readonly index: HnswVectorIndex
  private readonly idf: ReadonlyMap<string, number>
  private readonly docCount: number
  private readonly topK: number
  /** 条目 id → 向量（exactTopK 对拍与可观测用；零范数条目缺席 = 不进索引） */
  private readonly vectorTable: ReadonlyMap<string, SparseVector>

  constructor(entries: readonly MemoryEntry[], opts: VectorIndexOptions = {}) {
    const df = new Map<string, number>()
    const countsById = new Map<string, ReadonlyMap<string, number>>()
    for (const e of entries) {
      const counts = semanticFeatureCounts(`${e.content} ${e.tags.join(' ')}`)
      countsById.set(e.id, counts)
      for (const f of counts.keys()) df.set(f, (df.get(f) ?? 0) + 1)
    }
    const n = entries.length
    this.docCount = n
    this.idf = new Map([...df.entries()].map(([f, c]) => [f, Math.log(1 + n / c)]))
    this.index = new HnswVectorIndex(opts)
    const table = new Map<string, SparseVector>()
    for (const e of entries) {
      const vec = sparseFromFeatures(countsById.get(e.id)!, this.idf, n)
      if (vec.norm > 0) {
        table.set(e.id, vec)
        this.index.insert(e.id, vec)
      }
    }
    this.vectorTable = table
    this.topK = Math.max(1, Math.floor(opts.topK ?? VECTOR_LINE_TOP_K))
  }

  get size(): number {
    return this.index.size
  }

  stats(): HnswStats {
    return this.index.stats()
  }

  private vectorize(text: string): SparseVector {
    return sparseFromFeatures(semanticFeatureCounts(text), this.idf, this.docCount)
  }

  /** 暴力全量对拍真值：同特征空间全量余弦 top-k（O(N)，评估/测试专用） */
  exactTopK(queryText: string, k: number): Array<{ id: string; score: number }> {
    const q = this.vectorize(queryText)
    const out: Array<{ id: string; score: number }> = []
    for (const [id, vec] of this.vectorTable) {
      const score = cosineSparse(q, vec)
      if (score > 0) out.push({ id, score })
    }
    return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, k)
  }

  /** 查询入口：文本 → 稀疏向量 → HNSW top-k → {id: 余弦相似度}（k ≤ topK；
   * 零相似度结果过滤——无特征交集的近邻不是向量命中） */
  search(queryText: string, k: number = this.topK): ReadonlyMap<string, number> {
    const q = this.vectorize(queryText)
    if (q.norm === 0) return new Map()
    return new Map(
      this.index
        .search(q, Math.min(k, this.topK))
        .filter((x) => x.score > 0)
        .map((x) => [x.id, x.score]),
    )
  }
}

/**
 * 从条目语料构建向量召回索引（buildVectorIndex(entries) 的纯工厂形态）。
 */
export function buildVectorIndex(entries: readonly MemoryEntry[], opts: VectorIndexOptions = {}): VectorRecallIndex {
  return new VectorRecallIndex(entries, opts)
}

/**
 * 向量索引缓存：按 (revision, 内容指纹) 复用已构建的 HNSW 索引
 * （构建 O(N·efConstruct·log) 远贵于查询，语料未变时不重建——与 engine.IndexCache
 * 同失效语义：revision 或指纹任一变化即重建）。
 */
export class VectorIndexCache {
  private index: VectorRecallIndex | undefined
  private cacheKey = ''

  acquire(entries: readonly MemoryEntry[], revision?: number, opts: VectorIndexOptions = {}): VectorRecallIndex {
    const key = `${revision ?? 0}:${fingerprint(entries)}`
    if (this.index === undefined || key !== this.cacheKey) {
      this.index = buildVectorIndex(entries, opts)
      this.cacheKey = key
    }
    return this.index
  }

  clear(): void {
    this.index = undefined
    this.cacheKey = ''
  }
}
