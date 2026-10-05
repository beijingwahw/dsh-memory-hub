/**
 * 记忆检索引擎。
 *
 * 纯函数、无 IO，便于单测与未来替换为向量检索：
 * - 分词：英文按单词（NFKC 折叠 + 停止词过滤）、中文按字与二字组，构建轻量倒排词频；
 * - 评分：Okapi BM25（词频饱和 + 文档长度归一化） × 时间衰减 × 访问热度加权；
 * - 预算裁剪：按 token 估算逐条累加，超出 maxTokens 即截断（首条必含）；
 * - 去重：内容哈希 + 编辑距离近似度双保险；
 * - 衰减：按 ttlDays / 最近访问时间做过期标记，由调用方决定是否清理。
 */
import { createHash } from 'node:crypto'
import { graphLineScores, GRAPH_LINE_WEIGHT } from './graph'
import { contentHash } from './store'
import type { MemoryEntry, MemoryHit, MemoryKind, MemoryStats, RecallOptions } from './types'

/** 简单 token 估算：中文字符按 1 token/字、其他按 4 字符/token 的近似值 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e7f) {
      tokens += 1 // CJK 等宽字符
    } else if (/[\w]/.test(ch)) {
      tokens += 0.25 // 字母数字，每 4 个 1 token
    } else {
      tokens += 0.5
    }
  }
  return Math.max(1, Math.ceil(tokens))
}

/** 英文高频虚词（无检索价值的停用词）；中文 2-gram 不设停止词（双字对天然含语义） */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'of',
  'to',
  'and',
  'or',
  'for',
  'with',
  'in',
  'on',
  'at',
  'by',
  'from',
  'as',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'he',
  'she',
  'they',
  'we',
  'you',
  'your',
  'his',
  'her',
  'their',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'not',
  'no',
  'but',
  'so',
  'if',
  'then',
  'than',
  'too',
  'very',
  'can',
  'will',
  'just',
  'should',
  'would',
  'could',
])

// ---------------------------------------------------------------------------
// 0.5.0 深度创新：容错检索（A1）与近似语义召回（A2）
// ---------------------------------------------------------------------------

/** 模糊变体权重：仅当精确 BM25 为零时以 0.5 折扣计入（不干扰精确命中排序） */
export const FUZZY_VARIANT_WEIGHT = 0.5
/** 触发模糊变体扩展的最小英文词长（过短词的变体噪音大、信息量低） */
export const FUZZY_MIN_WORD_LEN = 4

/** MinHash 签名维度（k=16：在可复算性与候选剪枝效果间取平衡；评分本身用精确覆盖率，故不依赖签名精度） */
export const MINHASH_K = 16
/** 近似语义召回阈值：查询覆盖率 ≥ 该值才进入兜底候选（覆盖率 = 交集/查询特征数） */
export const MINHASH_COVERAGE_THRESHOLD = 0.45
/** 0.9.0：MinHash 签名预筛下界（K 薄弱项启用）——精确语义阈值 ×2/3 的保守余量。
 * 仅在大查询（|Q| > MINHASH_K）启用：签名覆盖率低于该值的文档视为明确不相干，
 * 跳过 O(|Q|) 精确特征比对；真实语义候选的估计覆盖率显著高于此界，误剪由 eval G3 保底。
 * 1.0.0（DESIGN-1.0 疑点 3）：该阈值降级为**第一级守卫**——签名覆盖率 ≥ 精确阈值(0.45) 直接放行；
 * < 0.45 但 ≥ MINHASH_PRESCREEN_THRESHOLD 的文档不再直接判定，而是经**抽样复核**（见
 * sampleFeatureCoverage）确认后才剪枝，预筛永不排除精确验证本会通过的候选，消除理论漏召。 */
export const MINHASH_PRESCREEN_THRESHOLD = MINHASH_COVERAGE_THRESHOLD * (2 / 3)
/** 1.0.0：两级守卫的抽样复核样本数（查询侧特征中 fnv1a 散列最小的 K 个，跨实现可复算）。
 * 与签名维度一致为 16：抽样成本 O(K) 与签名比较同阶，换取「不信任小样本签名估计」的稳健性。 */
export const MINHASH_SAMPLE_K = MINHASH_K
/** 语义命中权重：显著低于词面命中，避免抢占精确/模糊排序 */
export const SEMANTIC_HIT_WEIGHT = 0.3
/** 1.0.0（DESIGN-1.0 模块 A）：被取代记忆（tags 含 superseded-by:）的召回分数衰减系数 */
export const SUPERSEDED_PENALTY_DEFAULT = 0.5
/** 1.0.0（DESIGN-1.0 模块 B）：RRF 融合常数（Reciprocal Rank Fusion 惯例 k=60） */
export const RRF_K = 60

/**
 * 1.0.0（DESIGN-1.0 模块 A）：被取代记忆判定（tags 含 superseded-by: 前缀）。
 * 与 entry-factory 的 SUPERSEDED_BY_TAG_PREFIX 保持同源协议字符串（此处内联判定
 * 避免 engine↔entry-factory 循环依赖；协议常量在 entry-factory 导出，测试可引用）。
 */
export const SUPERSEDED_BY_TAG_PREFIX = 'superseded-by:'

export function isSuperseded(entry: MemoryEntry): boolean {
  return entry.tags.some((t) => t.startsWith(SUPERSEDED_BY_TAG_PREFIX))
}

/**
 * MinHash 签名（含原特征数）。
 * 设计说明：签名随索引缓存，用于快速候选剪枝与跨实现可复算；
 * A2 评分本身采用**精确特征覆盖率**（查询特征集小，O(|Q|) 遍历成本可忽略），
 * 避免小特征集下 MinHash 估计方差导致召回抖动；二者不冲突，签名精度只影响剪枝率不影响结果。
 */
export interface MinHashSignature {
  sig: readonly number[]
  /** 生成签名时的特征集大小 */
  size: number
}

/** FNV-1a 散列种子（与签名维度一一对应，固定以保证结果可复算） */
const MINHASH_SEEDS = [
  0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd5a3c3aa, 0x9e6c8f1b, 0x3c6ef372, 0x21f0aaad,
  0x9ff1c4a3, 0x9c9f9a3b, 0x2b0e93b0, 0x51f0a8dd, 0x7f5f9e5d, 0x5b0f3d5b, 0x45df27b3,
] as const

/** FNV-1a 32 位散列（纯函数、无密码学依赖，供 MinHash 使用） */
export function fnv1a(input: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 对 token 集合计算 k 维 MinHash 签名（每维取该维散列的最小值） */
export function minhashSignature(tokens: Iterable<string>): number[] {
  const sig = new Array<number>(MINHASH_K).fill(0xffffffff)
  for (const t of tokens) {
    // seeds 与 sig 等长（均由 MINHASH_K 定义），entries() 迭代天然免下标越界
    for (const [i, seed] of MINHASH_SEEDS.entries()) {
      const h = fnv1a(t, seed)
      const current = sig[i]
      if (current !== undefined && h < current) sig[i] = h
    }
  }
  return sig
}

/**
 * 两个签名的估计 Jaccard（约等于特征集合 Jaccard）。
 * 任一侧签名为空（无特征）时对应维度不参与比较；有效签名必然各维 < 0xffffffff。
 */
export function minhashJaccard(a: readonly number[], b: readonly number[]): number {
  if (a.length !== MINHASH_K || b.length !== MINHASH_K) return 0
  let equal = 0
  let valid = 0
  for (let i = 0; i < MINHASH_K; i++) {
    if (a[i] === 0xffffffff || b[i] === 0xffffffff) continue
    valid++
    if (a[i] === b[i]) equal++
  }
  return valid === 0 ? 0 : equal / valid
}

/**
 * 查询覆盖率（精确版）：|Q ∩ D| / |Q|（Q 为查询特征集，D 为记忆特征集）。
 * 语义兜底以“查询所需特征被记忆覆盖多久”为判据：长记忆的无关特征不会稀释分子，
 * 短记忆只要覆盖了查询特征即高分；为 0 记忆从不被语义兜底误召。
 */
export function featureCoverage(query: ReadonlySet<string>, doc: ReadonlySet<string>): number {
  if (query.size === 0) return 0
  let inter = 0
  for (const f of query) if (doc.has(f)) inter++
  return inter / query.size
}

/**
 * 查询覆盖率（MinHash 估计版）：供大规模候选剪枝使用；A2 评分采用上面的精确版。
 */
export function minhashCoverage(querySig: MinHashSignature, docSig: MinHashSignature): number {
  if (querySig.size === 0 || querySig.sig.length !== MINHASH_K || docSig.sig.length !== MINHASH_K) return 0
  const jac = minhashJaccard(querySig.sig, docSig.sig)
  // 0.8.0：jac ∈ [0,1] 且 inter = jac·(qs+ds)/(1+jac) ≥ 0 恒成立，inter ≤ 0 分支经不变式证明不可达，予以移除（死代码升维）
  const inter = (jac * (querySig.size + docSig.size)) / (1 + jac)
  const cov = inter / querySig.size
  return Math.min(1, cov)
}

/**
 * 1.0.0（DESIGN-1.0 疑点 3 升维）：构建查询侧抽样复核子集。
 * 取查询特征中 fnv1a(·, seed[0]) 散列最小的前 K 个（K = MINHASH_SAMPLE_K），
 * 跨实现可复算、与签名维度一致。命中文档特征集的抽样子集覆盖率
 * 见 {@link sampleCoverage}：作为「两级守卫」的第二级——当 MinHash 签名估计
 * 覆盖率低于预筛下界时，不直接剪枝，而是用这组抽样特征做**精确 has 命中的
 * 稀疏验证**，确认文档与查询确有特征交叠后才放行进精确覆盖率计算。
 */
export function sampleQueryFeatures(queryFeatures: ReadonlySet<string>): readonly string[] {
  if (queryFeatures.size === 0) return []
  return [...queryFeatures]
    .map((f) => ({ f, h: fnv1a(f, MINHASH_SEEDS[0]) }))
    .sort((a, b) => a.h - b.h)
    .slice(0, MINHASH_SAMPLE_K)
    .map((x) => x.f)
}

/** 1.0.0：抽样特征子集在文档特征集中的命中比例（两级守卫第二级） */
export function sampleCoverage(sample: readonly string[], doc: ReadonlySet<string>): number {
  if (sample.length === 0) return 0
  let hit = 0
  for (const f of sample) if (doc.has(f)) hit++
  return hit / sample.length
}

/**
 * MinHash 特征集（A2 语义召回的特征空间）。
 *
 * 关键设计：特征必须与 BM25 词面命中**不同源**，否则「精确零命中」时 Jaccard 恒为 0，
 * 语义兜底会退化为死代码。因此英文/数字词在此展开为**字符 3-gram**（附首尾边界标记）：
 * 词根/形态变体（deploy ↔ deployment、auth ↔ authentication）即使整词不重叠，
 * 也在字符层面共享大量 3-gram，可被 Jaccard 兜底召回；中文 2-gram 本身即字符级，原样保留。
 */
export function semanticFeatures(text: string): Set<string> {
  const features = new Set<string>()
  for (const t of tokenize(text)) {
    if (/^[a-z0-9_]{3,}$/.test(t)) {
      features.add('^' + t.slice(0, 2))
      for (let i = 0; i + 3 <= t.length; i++) features.add(t.slice(i, i + 3))
      features.add(t.slice(-2) + '$')
    } else {
      features.add(t)
    }
  }
  return features
}

/**
 * 生成英文词的编辑距离 ≤ 1 变体（删除 / 相邻交换 / 替换 / 插入）。
 * 仅处理小写纯字母词（由调用方保证），返回去重变体集（不含原词自身）。
 */
export function fuzzyVariants(word: string): Set<string> {
  const variants = new Set<string>()
  const n = word.length
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  // 删除（单字符）
  for (let i = 0; i < n; i++) variants.add(word.slice(0, i) + word.slice(i + 1))
  // 相邻交换：charAt 越界返回 ''，但循环条件 i+1 < n 保证不越界，等价于 word[i+1]!
  for (let i = 0; i + 1 < n; i++) {
    variants.add(word.slice(0, i) + word.charAt(i + 1) + word.charAt(i) + word.slice(i + 2))
  }
  // 替换与插入
  for (let i = 0; i < n; i++) {
    for (const ch of letters) {
      if (ch !== word.charAt(i)) variants.add(word.slice(0, i) + ch + word.slice(i + 1))
      variants.add(word.slice(0, i) + ch + word.slice(i))
    }
  }
  // 末尾插入
  for (const ch of letters) variants.add(word + ch)
  return variants
}

/**
 * 提取检索词：英文单词小写（NFKC 折叠全角）+ 连续 CJK 串按 2-gram 切分。
 * 英文单字（<2）与停止词被过滤；数字/下划线词保留（如版本号、代码标识）。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.normalize('NFKC').toLocaleLowerCase()
  // 英文/数字词
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) {
    const w = m[0]
    if (w.length < 2) continue
    if (/^[a-z]+$/.test(w) && STOP_WORDS.has(w)) continue
    tokens.push(w)
  }
  // 中文：去除非 CJK 后按 2-gram
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
  if (cjk.length === 1) tokens.push(cjk)
  for (let i = 0; i + 1 < cjk.length; i++) {
    tokens.push(cjk.slice(i, i + 2))
  }
  return tokens
}

/** 文本的 token 集合（去重） */
function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

/**
 * 编辑距离（滚动两行 DP）。
 *
 * 算法不变式：进入第 i 行前 prev[0..b.length] 已完整填充；每行自左向右写 cur，
 * 只读 cur[j-1]（本轮左邻）与 prev[j]/prev[j-1]（上一行），所有读取点在访问时
 * 均已赋值。此处 `!` 是对该不变式的收敛断言，可由上述不变式直接证明。
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  // 0.8.0：空串分支（return b.length / a.length）经不变式证明不可达——本函数仅供 similarity 调用，
  // 而 similarity 入口先以 `if (!a || !b) return 0` 拦截空串；滚动数组实现对空串语义等价，予以移除
  let prev = new Array<number>(b.length + 1)
  let cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    // 整行交换引用而非拷贝，时间复杂度由 O(b.length) 降至 O(1)
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]!
}

/** 归一化相似度：1 表示完全相同 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  const maxLen = Math.max(a.length, b.length)
  // 0.8.0：maxLen === 0 已由上守卫（!a || !b）先行返回，此分支经不变式证明不可达，予以移除
  if (maxLen > 300) {
    // 长文本用 token 集合 Jaccard 近似
    const sa = tokenSet(a)
    const sb = tokenSet(b)
    if (sa.size === 0 || sb.size === 0) return 0
    let inter = 0
    for (const t of sa) if (sb.has(t)) inter++
    return inter / (sa.size + sb.size - inter)
  }
  return 1 - levenshtein(a, b) / maxLen
}

// ---------------------------------------------------------------------------
// 倒排索引（供索引化召回与测试验证）
// ---------------------------------------------------------------------------

/** 条目 id → 词频向量 */
export type TfVector = ReadonlyMap<string, number>

/** 倒排索引：token → 出现该 token 的条目 id 集（含词频向量） */
export interface MemoryIndex {
  /** 条目 id → 词频向量（token → 出现次数） */
  tf: Map<string, TfVector>
  /** token → 文档频率（出现该词的条目数） */
  df: Map<string, number>
  /** 语料大小（条目数） */
  docCount: number
  /** BM25：条目 id → 分词后的文档长度（token 数） */
  docLen: ReadonlyMap<string, number>
  /** BM25：语料平均文档长度（avgdl） */
  avgdl: number
  /** 0.5.0：条目 id → MinHash 签名（近似语义候选剪枝；随索引一并缓存） */
  minhash: ReadonlyMap<string, MinHashSignature>
  /** 0.5.0：条目 id → 精确特征集（A2 语义评分用，零估计误差） */
  features: ReadonlyMap<string, ReadonlySet<string>>
}

/** Okapi BM25 参数（Lucene/Elasticsearch 惯例） */
const BM25_K1 = 1.2
const BM25_B = 0.75

/** 构建倒排索引（纯函数，语料由条目集合构造） */
export function buildIndex(entries: MemoryEntry[]): MemoryIndex {
  const tf = new Map<string, TfVector>()
  const df = new Map<string, number>()
  const seen = new Map<string, Set<string>>()
  const docLen = new Map<string, number>()
  const minhash = new Map<string, MinHashSignature>()
  const features = new Map<string, ReadonlySet<string>>()
  let totalLen = 0
  for (const entry of entries) {
    const vec = new Map<string, number>()
    const tokens = tokenize(`${entry.content} ${entry.tags.join(' ')}`)
    for (const t of tokens) {
      vec.set(t, (vec.get(t) ?? 0) + 1)
    }
    tf.set(entry.id, vec)
    const featureSet = semanticFeatures(`${entry.content} ${entry.tags.join(' ')}`)
    features.set(entry.id, featureSet)
    minhash.set(entry.id, { sig: minhashSignature(featureSet), size: featureSet.size })
    docLen.set(entry.id, tokens.length)
    totalLen += tokens.length
    for (const t of vec.keys()) {
      const ids = seen.get(t) ?? new Set<string>()
      ids.add(entry.id)
      seen.set(t, ids)
    }
  }
  for (const [t, ids] of seen) df.set(t, ids.size)
  const docCount = entries.length
  return { tf, df, docCount, docLen, avgdl: docCount > 0 ? totalLen / docCount : 0, minhash, features }
}

/**
 * 收集查询词的编辑距离 ≤ 1 变体候选（A1 容错检索）。
 * 仅保留：长度 ≥ FUZZY_MIN_WORD_LEN 的纯英文查询词生成的变体、
 * 过滤停止词/过短词、且变体在语料 df 中真实存在（避免无意义的全表扩展）。
 */
function collectFuzzyTerms(qTf: ReadonlyMap<string, number>, df: ReadonlyMap<string, number>): string[] {
  const seen = new Set<string>()
  for (const t of qTf.keys()) {
    if (t.length < FUZZY_MIN_WORD_LEN || !/^[a-z]+$/.test(t)) continue
    for (const v of fuzzyVariants(t)) {
      if (v.length < 2 || STOP_WORDS.has(v)) continue
      if (!df.has(v)) continue
      seen.add(v)
    }
  }
  return [...seen]
}

/** 查询索引并评分（纯函数；与 recall 共享同一评分语义） */
export function queryIndex(
  index: MemoryIndex,
  query: string,
  options: RecallOptions = {},
  entriesBy: Map<string, MemoryEntry>,
): MemoryHit[] {
  const maxTokens = options.maxTokens ?? 800
  const limit = options.limit ?? 8
  const now = options.now ?? Date.now()
  const docCount = Math.max(1, index.docCount)
  const avgdl = index.avgdl > 0 ? index.avgdl : 1
  // 0.5.0：BM25 参数可注入（评估/调参用；缺省回退到既有常量，语义不变）
  const k1 = options.k1 ?? BM25_K1
  const b = options.b ?? BM25_B
  // BM25 饱和平滑 IDF：罕见词增益受限、df=0 的查询词不除零
  const idf = (token: string): number => {
    const df = index.df.get(token) ?? 0
    return Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
  }
  const qTf = tokenCounts(query)
  // 空查询（tokenize 无可检索词，如纯标点、空串）直接返回空数组，
  // 避免 `score = 0.01 × decay × heat > 0` 把全库条目按热度误召回。
  if (qTf.size === 0) return []

  // 0.5.0 A1：预计算查询词编辑距离 ≤1 变体（精确零命中时的容错兜底）
  const fuzzyTerms = options.fuzzy !== false ? collectFuzzyTerms(qTf, index.df) : []
  // 0.5.0 A2：查询侧精确特征集（词面全零命中时的近似语义兜底）
  const queryFeatures = options.semantic !== false ? semanticFeatures(query) : undefined
  // 0.9.0 K + 1.0.0 两级守卫：MinHash 签名预筛——仅当查询特征集大于签名维度（精确比对 O(|Q|) 贵于签名 O(K)）时启用；
  // 小查询走 0.8.0 精确路径，行为逐字节不变。
  // 第一级：签名覆盖率 < 保守下界（0.30）不直接剪枝，而交由第二级抽样精确验证兜底
  // （修复疑点 3：0.30 下界可能把真实覆盖率 ≥0.45 的候选因 MinHash 估计方差误剪）。
  const querySig =
    queryFeatures !== undefined && queryFeatures.size > MINHASH_K
      ? { sig: minhashSignature(queryFeatures), size: queryFeatures.size }
      : undefined
  const querySample = queryFeatures !== undefined ? sampleQueryFeatures(queryFeatures) : []

  const scored: MemoryHit[] = []
  // 1.0.0（DESIGN-1.0 模块 B2）：RRF 融合模式候选中转（三线 raw 分 + 公共权重因子）
  const useRRF = options.fusionMode === 'rrf'
  const rrfCandidates: RrfCandidate[] = []
  // 1.1.0（DESIGN-1.1 模块 C）：图谱线召回分——graph 注入且 graphEnabled=true 时才启用；
  // 默认（缺省 false / 无 graph）不计算，保证与 1.0.0 逐字节零行为变化。
  const graphSource = options.graph
  const graphScores =
    options.graphEnabled === true && graphSource !== undefined
      ? graphLineScores(graphSource, query, entriesBy, now, {
          ...(options.graphMaxHop !== undefined ? { maxHop: options.graphMaxHop } : {}),
        })
      : undefined
  const graphWeight = options.graphWeight ?? GRAPH_LINE_WEIGHT

  // 公共权重因子（decay×heat×sig×supersededFactor）——三线共享，RRF 融合后整体施加；
  // 1.1.0 起抽成函数：图谱线补录候选（interpolate 模式图分叠加）也需要它。
  const lineBaseFor = (entry: MemoryEntry): number => {
    const ageMs = now - entry.createdAt
    const decay =
      ageMs <= 0 || options.decay === false ? 1 : Math.exp(-ageMs / (options.decayHalfLifeMs ?? DECAY_HALF_LIFE_MS))
    const heat = heatScore(entry, now, options.heatHalfLifeMs)
    const significance = options.significance !== false ? significanceWeight(entry.kind, entry.source) : 1
    const supersededFactor = isSuperseded(entry) ? (options.supersededPenalty ?? SUPERSEDED_PENALTY_DEFAULT) : 1
    return decay * heat * significance * supersededFactor
  }

  for (const [id, vec] of index.tf) {
    const entry = entriesBy.get(id)
    if (!entry) continue
    if (options.workspace && entry.workspace && entry.workspace !== options.workspace) continue
    if (options.kind && entry.kind !== options.kind) continue
    // 1.0.0（DESIGN-1.0 模块 A2）：主题过滤——仅召回 tags 含指定主题的条目
    if (options.theme && !entry.tags.includes(options.theme)) continue

    // Okapi BM25：词频饱和 + 文档长度归一化（b 可注入），长文档不再天然占优
    const docLen = index.docLen.get(id) ?? 0
    const lenNorm = k1 * (1 - b + b * (docLen / avgdl))
    let bm25 = 0
    for (const [t, qtf] of qTf) {
      const etf = vec.get(t)
      if (!etf) continue
      const tfSat = (etf * (k1 + 1)) / (etf + lenNorm)
      bm25 += idf(t) * tfSat * qtf
    }
    // A1：精确零命中 → 尝试编辑距离 ≤1 的变体词（0.5 折扣，避免弱化精确命中排序）
    let fuzzy = 0
    if (bm25 === 0 && fuzzyTerms.length > 0) {
      for (const v of fuzzyTerms) {
        const etf = vec.get(v)
        if (!etf) continue
        const tfSat = (etf * (BM25_K1 + 1)) / (etf + lenNorm)
        fuzzy += FUZZY_VARIANT_WEIGHT * idf(v) * tfSat
      }
    }

    // 公共权重因子：衰减 × 热度 × 显著性 × 被取代降权（三线共享，RRF 融合后整体施加）
    const lineBase = lineBaseFor(entry)

    // 1.0.0（DESIGN-1.0 模块 B2）：三线评分——精确线（bm25）/ 容错线（fuzzy）/ 语义线（cov）
    let cov = 0
    if (queryFeatures !== undefined && queryFeatures.size > 0) {
      const docFeatures = index.features.get(id)
      if (docFeatures !== undefined) {
        // 0.9.0 K + 1.0.0 两级守卫：大查询先用 O(K) 签名覆盖率剔除明确不相干文档；
        // 签名覆盖率 < 下界仍须经抽样精确复核（第二级）通过才剪枝，预筛永不
        // 排除精确验证本会通过的候选（修复疑点 3 的理论漏召）。
        if (querySig !== undefined) {
          const docSig = index.minhash.get(id)
          const est = docSig === undefined ? 0 : minhashCoverage(querySig, docSig)
          if (
            est < MINHASH_PRESCREEN_THRESHOLD &&
            sampleCoverage(querySample, docFeatures) < MINHASH_PRESCREEN_THRESHOLD
          ) {
            continue
          }
        }
        cov = featureCoverage(queryFeatures, docFeatures)
      }
    }

    // 1.0.0（DESIGN-1.0 模块 B1/B2）：语义线权重可注入（G5-1.0 四维网格用；
    // 缺省 = 既有常量 SEMANTIC_HIT_WEIGHT，行为与 0.10.0 逐字节一致）
    const semWeight = options.semanticWeight ?? SEMANTIC_HIT_WEIGHT
    let score = 0
    if (useRRF) {
      // RRF 融合模式：先收集三线有效候选，循环后按线全局排序融合（见 rrfFuseCandidates）
      if (bm25 > 0 || fuzzy > 0 || cov >= MINHASH_COVERAGE_THRESHOLD) {
        const gs = graphScores?.get(id)
        rrfCandidates.push({
          id,
          entry,
          bm25,
          fuzzy,
          cov: cov >= MINHASH_COVERAGE_THRESHOLD ? cov : 0,
          // 1.1.0：图谱线 raw 分（undefined 时不带该字段，RRF 融合结果与 1.0.0 一致）
          ...(gs !== undefined && gs > 0 ? { graph: gs } : {}),
          lineBase,
        })
      }
    } else if (bm25 > 0 || fuzzy > 0) {
      // 词面（含变体）命中：精确线 + 语义线叠加（semanticBoost 默认 false = 0.10.0 语义，
      // 语义线仅在词面零命中时兜底；true 时即使词面命中也叠加贡献，提升真实问句召回）
      const lexical = bm25 > 0 ? bm25 : fuzzy
      score = lexical * lineBase
      if (options.semanticBoost && cov >= MINHASH_COVERAGE_THRESHOLD) {
        score += semWeight * cov * lineBase
      }
    } else if (cov >= MINHASH_COVERAGE_THRESHOLD) {
      // 词面（含变体）全零命中 → 近似语义召回（精确查询覆盖率 ≥ 阈值才进入）
      score = semWeight * cov * lineBase
    }
    // 1.1.0（DESIGN-1.1 模块 C）：图谱线融合——interpolate 模式下线性叠加图分；
    // RRF 模式不在此叠加（候选走 rrfFuseCandidates 第四条秩融合，见下方补录段）。
    // 仅当 graph 已注入且 graphEnabled=true 时启用（默认 false，score 与 1.0.0 逐字节一致）；
    // 词面/语义全零但图可达的条目也能借此进入召回（图线兜底）。
    if (!useRRF && graphScores !== undefined) {
      const gs = graphScores.get(id)
      if (gs !== undefined && gs > 0) score += graphWeight * gs * lineBase
    }
    if (score > 0) scored.push({ ...entry, score })
  }

  // 1.1.0（DESIGN-1.1 模块 C）：图谱线补录——RRF 模式下词面/语义全零、但图可达的候选
  // 未经过上述三线分支进入 rrfCandidates，这里按图分直接补录为候选（graph 线参与第四条秩融合）。
  // 默认 graphEnabled=false 时 graphScores 为 undefined，整段不执行，行为与 1.0.0 一致。
  if (useRRF && graphScores !== undefined) {
    for (const [id, gs] of graphScores) {
      if (gs <= 0) continue
      if (rrfCandidates.some((c) => c.id === id)) continue
      const entry = entriesBy.get(id)
      if (!entry) continue
      if (options.workspace && entry.workspace && entry.workspace !== options.workspace) continue
      if (options.kind && entry.kind !== options.kind) continue
      if (options.theme && !entry.tags.includes(options.theme)) continue
      rrfCandidates.push({ id, entry, bm25: 0, fuzzy: 0, cov: 0, graph: gs, lineBase: lineBaseFor(entry) })
    }
  }

  // 1.0.0（DESIGN-1.0 模块 B2）：RRF 融合——三线全局排序取 rank 后加权求和
  if (useRRF && rrfCandidates.length > 0) {
    scored.push(...rrfFuseCandidates(rrfCandidates))
  }

  scored.sort((a, b) => b.score - a.score)

  // 1.0.0（DESIGN-1.0 模块 A1）：取代对去重——同一查询同时命中「被取代旧条目 +
  // 取代它的新条目」时，仅保留新条目（被取代 hit 从本次召回剔除，不等预算裁剪）。
  // 协议：旧条目 tags 含 `superseded-by:<新id>`；仅当新条目也出现在 scored 集时剔除。
  let effective = scored
  const hitIds = new Set(scored.map((h) => h.id))
  const supersededIds = new Set<string>()
  for (const h of scored) {
    for (const t of h.tags) {
      if (!t.startsWith(SUPERSEDED_BY_TAG_PREFIX)) continue
      const newId = t.slice(SUPERSEDED_BY_TAG_PREFIX.length)
      if (hitIds.has(newId)) supersededIds.add(h.id)
    }
  }
  if (supersededIds.size > 0) effective = scored.filter((h) => !supersededIds.has(h.id))

  // token 预算裁剪（首条必含）
  const hits: MemoryHit[] = []
  let used = 0
  for (const hit of effective) {
    if (hits.length >= limit) break
    const cost = estimateTokens(`${hit.kind} ${hit.content}`)
    if (hits.length > 0 && used + cost > maxTokens) break
    used += cost
    hits.push(hit)
  }
  return hits
}

/** token 计数（供查询向量） */
function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1)
  return counts
}

/**
 * 1.0.0（DESIGN-1.0 模块 B2）：RRF 融合候选（三线 raw 分 + 公共权重因子）。
 * bm25 = 精确线（含词面命中）；fuzzy = 容错线（编辑距离 ≤1 变体，0.5 折扣）；
 * cov = 语义线（字符 3-gram 精确覆盖率，仅 ≥ 阈值时有效）；lineBase = decay×heat×sig×supersededFactor；
 * graph（1.1.0 可选）= 图谱线 raw 分（>0 才入线；未注入/未启用时为 undefined，与 1.0.0 逐字节一致）。
 */
export interface RrfCandidate {
  id: string
  entry: MemoryEntry
  /** 精确线 raw 分（>0 才入线） */
  bm25: number
  /** 容错线 raw 分（>0 才入线） */
  fuzzy: number
  /** 语义线覆盖率（≥ MINHASH_COVERAGE_THRESHOLD 才入线，已由调用方归一） */
  cov: number
  /** 1.1.0：图谱线 raw 分（>0 才入线；缺省 undefined = 该候选不参与图谱线） */
  graph?: number
  lineBase: number
}

/**
 * 1.0.0：Reciprocal Rank Fusion——对三线得分各自全局降序排序取 rank，
 * fused = Σ_line 1/(RRF_K + rank_line(id)) × lineBase。
 * 1.1.0：图谱线作为第四条线参与融合（graph 字段非 0 时计入），
 * 未注入图谱时 graph 恒为 undefined，融合结果与 1.0.0 逐字节一致。
 * 语义：各线是独立排序信号，RRF 用秩而非原始分数融合，天然免归一化；
 * 语义候选即使词面零命中，只要在语义线中 rank 靠前也能进入 top 召回
 * （0.10.0 中语义线仅在词面零命中时以 0.3 权重兜底，无法与词面命中叠加）。
 * 纯函数可复算；排序稳定（并列分按 id 字典序兜底，保证结果确定性）。
 */
export function rrfFuseCandidates(candidates: RrfCandidate[]): MemoryHit[] {
  if (candidates.length === 0) return []
  const rankBy = (pick: (c: RrfCandidate) => number): Map<string, number> => {
    const ranked = [...candidates]
      .filter((c) => pick(c) > 0)
      .sort((a, b) => pick(b) - pick(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const ranks = new Map<string, number>()
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i]
      if (c !== undefined) ranks.set(c.id, i + 1)
    }
    return ranks
  }
  const rankB = rankBy((c) => c.bm25)
  const rankF = rankBy((c) => c.fuzzy)
  const rankC = rankBy((c) => c.cov)
  const rankG = rankBy((c) => c.graph ?? 0)
  const fused: MemoryHit[] = []
  for (const c of candidates) {
    const rb = rankB.get(c.id)
    const rf = rankF.get(c.id)
    const rc = rankC.get(c.id)
    const rg = rankG.get(c.id)
    let rrf = 0
    if (rb !== undefined) rrf += 1 / (RRF_K + rb)
    if (rf !== undefined) rrf += 1 / (RRF_K + rf)
    if (rc !== undefined) rrf += 1 / (RRF_K + rc)
    if (rg !== undefined) rrf += 1 / (RRF_K + rg)
    const score = rrf * c.lineBase
    if (score > 0) fused.push({ ...c.entry, score })
  }
  return fused
}

/** 召回核心：构建索引 → 查询 → 评分排序 + 预算裁剪 */
export function recall(entries: MemoryEntry[], query: string, options: RecallOptions = {}): MemoryHit[] {
  const index = buildIndex(entries)
  const byId = new Map(entries.map((e) => [e.id, e]))
  return queryIndex(index, query, options, byId)
}

/**
 * 倒排索引缓存：按存储 revision 复用已构建索引，避免同一语料反复全量 buildIndex。
 * 典型场景：会话内多次 memory_recall，语料未变时召回从 O(N·tokens) 降至 O(查询)。
 *
 * 0.4.0 指纹失效（世纪升级）：
 * 存储侧「热度更新」（accessCount/lastAccessAt）也会触发 revision++，
 * 若仅以 revision 为失效信号，高频 recall 下索引会每轮重建。
 * 本实现额外记录构建时的内容指纹（id+content+tags 的哈希）：
 * revision 变化但指纹不变（纯热度更新）→ 复用旧索引；指纹变化才重建。
 * 既有 revision 语义（未变复用 / 变化重建 / clear 强制 / 缺省按 0）保持兼容。
 */
export class IndexCache {
  private revision = -1
  private index: MemoryIndex | undefined
  private byId: Map<string, MemoryEntry> | undefined
  private fingerprint = ''

  /** 给定最新 entries 与存储 revision，返回可查询索引（未变更时复用） */
  query(
    entries: MemoryEntry[],
    storageRevision: number | undefined,
    queryText: string,
    options: RecallOptions = {},
  ): MemoryHit[] {
    const rev = storageRevision ?? 0
    // revision 未变 → 无条件复用（0.3 语义：上层保证同 revision 语料不变）；
    // revision 变化 → 内容指纹没变（纯热度更新 accessCount/lastAccessAt）也复用旧索引，
    // 仅指纹变化（content/tags/id 变更）才重建。
    if (this.index === undefined || this.byId === undefined) {
      this.index = buildIndex(entries)
      this.byId = new Map(entries.map((e) => [e.id, e]))
      this.fingerprint = fingerprint(entries)
      this.revision = rev
    } else if (rev !== this.revision) {
      if (fingerprint(entries) !== this.fingerprint) {
        this.index = buildIndex(entries)
        this.byId = new Map(entries.map((e) => [e.id, e]))
        this.fingerprint = fingerprint(entries)
      }
      this.revision = rev
    }
    return queryIndex(this.index, queryText, options, this.byId)
  }

  /** 重置缓存（例如存储关闭后） */
  clear(): void {
    this.revision = -1
    this.index = undefined
    this.byId = undefined
    this.fingerprint = ''
  }
}

/** 内容指纹：id+content+tags 的轻量哈希（非密码学用途，仅缓存失效判定） */
export function fingerprint(entries: readonly MemoryEntry[]): string {
  const h = createHash('sha256')
  for (const e of entries) {
    h.update(e.id)
    h.update('\u0000')
    h.update(e.content)
    h.update('\u0000')
    for (const t of e.tags) h.update(t + '\u0000')
  }
  return h.digest('hex')
}

/**
 * 1.0.0 UF-1.0（DESIGN-1.0 模块 C1）：内容级库内去重检测。
 * 语义升级：以 `contentHash(content)` 为**跨 id 前缀的统一指纹**（捕获 `contentHash-uuid`、
 * 显式 `contentHash-uuid`、导入 `imp-contentHash` 三种 id 规范互认），两层级判定：
 * 1. 指纹精确命中（同内容）→ 去重；
 * 2. 窗口内编辑距离近似（similarity > 0.92，长度预筛避免 O(L²)）→ 去重。
 * 性能路径：firstPass 构建 O(N) 指纹索引后查 O(1) 精确命中，再保留长度窗口预筛
 * 做近似比对——较 0.10.0 的逐条 `e.content === content` 提前 O(N) 降为 O(1)。
 * 返回 true 表示「窗口内已存在内容级重复」，调用方应拒绝写入。
 */
export function detectDuplicate(
  existing: readonly MemoryEntry[],
  content: string,
  windowMs: number,
  now = Date.now(),
): boolean {
  if (windowMs <= 0) return false
  const len = content.length
  const hash = contentHash(content)
  // 指纹索引：O(N) 构建一次，O(1) 查询；仅索引窗口内条目（避免过期条目占索引）
  const hashIndex = new Set<string>()
  let approx: MemoryEntry[] | undefined
  for (const e of existing) {
    if (now - e.createdAt > windowMs) continue
    hashIndex.add(contentHash(e.content))
    if (e.content !== content) {
      // 近似比对候选收集到第二遍处理（与精确命中路径隔离，避免无谓的 similarity 调用）
      const eLen = e.content.length
      const maxLen = Math.max(len, eLen)
      if (Math.abs(eLen - len) <= 0.08 * maxLen + 1) {
        ;(approx ??= []).push(e)
      }
    }
  }
  if (hashIndex.has(hash)) return true
  // 长度窗口预筛后的近似比对（第 2 层；候选已受限，similarity 仅对窗口内长度相近条目执行）
  if (approx !== undefined) {
    for (const e of approx) {
      if (similarity(e.content, content) > 0.92) return true
    }
  }
  return false
}

/**
 * 内容近似度去重（0.2.0 起语义保持；1.0.0 起委托 UF-1.0 detectDuplicate，语义升级为
 * 「同指纹或窗口内近重复」双层级，向后兼容：对既有测试的全部输入行为一致或更宽松地拒绝同内容）。
 */
export function isDuplicate(existing: MemoryEntry[], content: string, windowMs: number, now = Date.now()): boolean {
  return detectDuplicate(existing, content, windowMs, now)
}

/** 0.5.0 A4：热度默认半衰期（7 天，与既有时间衰减 decay 同数量级） */
export const HEAT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/** 0.9.0：评分时间衰减默认半衰期（7 天，0.8.0 写死值的显式化）。可经 RecallOptions.decayHalfLifeMs 注入、decay:false 关闭 */
export const DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// 0.5.0 A3：记忆价值感知评分（significance-aware）
// ---------------------------------------------------------------------------

/** 按记忆类型的基础显著性权重：指令 > 决策 > 偏好 > 事实 > 泛化（纯函数常量，可复算；与 INNOVATION-0.5 设计稿一致） */
export const SIGNIFICANCE_KIND: Record<MemoryKind, number> = {
  instruction: 1.25,
  decision: 1.15,
  preference: 1.05,
  fact: 1.0,
  generic: 0.95,
}

/** 显式记忆（用户主动记忆）的显著性加成 */
export const SIGNIFICANCE_EXPLICIT = 1.1

/**
 * 记忆价值权重（0.5.0 A3，纯函数可复算）。
 * weight = kindWeight × sourceWeight；sourceWeight：显式记忆 1.1，自动捕获 1.0。
 * 语义：「用户明说的指令/决策」比「流水账事实」更有长期价值，召回排序时自然靠前；
 * 不影响 MemoryEntry 契约与工具 schema，仅作用于运行时评分（score 永不落盘）。
 * 注：INNOVATION-0.5 §3.3 原含 density 维度（<20 字符 ×0.9），实现阶段发现其与既有
 * 质量断言「精炼短记忆优先于长尾文档」（长度归一化）直接冲突，按硬约束（既有测试
 * 全绿）移除，仅保留 kind × source 两维——详见 CHANGELOG 0.5.0 兼容性说明。
 * 0.9.0 S：删除 `?? 1` 运行时兜底——SIGNIFICANCE_KIND 为 Record<MemoryKind, number>
 * 全键声明且 kind 收窄为 MemoryKind 联合（索引命中索引签名，实测类型为 number，无 undefined），
 * 兜底从运行时移除、由 Record 全键约束在编译期拦截（future kind 扩展未同步表 → tsc 报错）。
 */
export function significanceWeight(kind: MemoryKind, source: MemoryEntry['source']): number {
  const kindWeight = SIGNIFICANCE_KIND[kind]
  const sourceWeight = source === 'explicit' ? SIGNIFICANCE_EXPLICIT : 1
  return kindWeight * sourceWeight
}

/**
 * 记忆生命周期自适应热度（0.5.0 A4，纯函数可复算）。
 *
 * heat = 1 + 0.1 · log1p(accessCount) · temporalDecay
 * temporalDecay = 1                                （accessCount=0：新记忆恒 1，不衰减）
 *               = 1                                （lastAccessAt 缺失：历史数据不做惩罚）
 *               = exp(−Δ / halfLife)               （Δ = max(0, now − lastAccessAt)）
 *
 * 语义：被持续访问的记忆保持热度（复活），久未访问的高频旧记忆按遗忘曲线指数冷却，
 * 避免"3 个月前的高频琐事长期霸榜"；匹配 0.4.0 在无 lastAccessAt 场景下的全部断言语义。
 */
export function heatScore(entry: MemoryEntry, now = Date.now(), halfLifeMs = HEAT_HALF_LIFE_MS): number {
  if (entry.accessCount <= 0) return 1
  if (entry.lastAccessAt === undefined) return 1 + Math.log1p(entry.accessCount) * 0.1
  const delta = Math.max(0, now - entry.lastAccessAt)
  const temporalDecay = Math.exp(-delta / halfLifeMs)
  return 1 + Math.log1p(entry.accessCount) * 0.1 * temporalDecay
}

/** 过期判定：超过 ttlDays 未访问/未更新 */
export function isExpired(entry: MemoryEntry, ttlDays: number, now = Date.now()): boolean {
  if (ttlDays <= 0) return false
  const lastSeen = Math.max(entry.updatedAt, entry.lastAccessAt ?? 0, entry.createdAt)
  return now - lastSeen > ttlDays * 24 * 60 * 60 * 1000
}

/** 批量整理：返回应删除的条目（过期；可选按 kind 过滤） */
export function pruneExpired(entries: MemoryEntry[], ttlDays: number, now = Date.now()): MemoryEntry[] {
  if (ttlDays <= 0) return []
  return entries.filter((e) => isExpired(e, ttlDays, now))
}

/**
 * 1.0.0（DESIGN-1.0 模块 A3）：价值感知自动淘汰。
 * 当条目数超过 maxEntries 时，按「价值分 = significance × heat」从低到高淘汰
 * **非 instruction** 记忆（instruction 永不自动淘汰——用户指令是最高优先级契约）；
 * 被取代记忆优先淘汰（same 价值分下 superseded 在前）。
 * 返回应删除的条目 id 列表（纯函数，删除动作由调用方执行）。
 */
export function evictLowestValue(
  entries: readonly MemoryEntry[],
  maxEntries: number,
  now = Date.now(),
  heatHalfLifeMs = HEAT_HALF_LIFE_MS,
): string[] {
  if (maxEntries <= 0 || entries.length <= maxEntries) return []
  const victims = entries
    .filter((e) => e.kind !== 'instruction')
    .map((e) => ({ e, value: significanceWeight(e.kind, e.source) * heatScore(e, now, heatHalfLifeMs) }))
    .sort((a, b) => {
      // 淘汰价值最低：先分低、再定义「被取代者优先」、最后按 id 确定性
      if (a.value !== b.value) return a.value - b.value
      const aSup = isSuperseded(a.e) ? 1 : 0
      const bSup = isSuperseded(b.e) ? 1 : 0
      if (aSup !== bSup) return bSup - aSup
      return a.e.id < b.e.id ? -1 : 1
    })
  const need = entries.length - maxEntries
  return victims.slice(0, Math.min(need, victims.length)).map((v) => v.e.id)
}

/** 统计（byKind 全量键 0 填充，结果可预测） */
export function summarize(entries: MemoryEntry[], bytes: number): MemoryStats {
  const byKind: Record<MemoryKind, number> = { decision: 0, fact: 0, preference: 0, instruction: 0, generic: 0 }
  const bySource: Record<'auto' | 'explicit', number> = { auto: 0, explicit: 0 }
  let oldestAt: number | undefined
  let newestAt: number | undefined
  // 1.0.0（DESIGN-1.0 模块 A1）：被取代记忆计数（tags 含 superseded-by: 协议）
  let superseded = 0
  for (const e of entries) {
    byKind[e.kind] += 1
    bySource[e.source] += 1
    if (oldestAt === undefined || e.createdAt < oldestAt) oldestAt = e.createdAt
    if (newestAt === undefined || e.createdAt > newestAt) newestAt = e.createdAt
    if (isSuperseded(e)) superseded += 1
  }
  const stats: MemoryStats = { total: entries.length, byKind, bySource, bytes }
  if (oldestAt !== undefined) stats.oldestAt = oldestAt
  if (newestAt !== undefined) stats.newestAt = newestAt
  if (superseded > 0) stats.superseded = superseded
  return stats
}

// ---------------------------------------------------------------------------
// 1.0.0 模块 A2：主题自动聚类（运行时视图，不持久化）
// ---------------------------------------------------------------------------

/** 主题簇：共享 token 数 ≥2 的条目聚为一类；label = 簇内最高频 token */
export interface ThemeCluster {
  /** 唯一 id（= label 的 hash 去冲突后截断） */
  id: string
  /** 主题标签（簇内 content 最高频 token） */
  label: string
  memberCount: number
  /** 簇内 top 3 kind（按出现次数降序） */
  topKinds: MemoryKind[]
}

/**
 * 1.0.0（DESIGN-1.0 模块 A2）：主题自动聚类——并查集连通分量。
 * 算法：token→条目倒排；两两共享 token 计数（Map<pair, count>）；
 * 共享 token ≥ minShared（默认 2）的条目对 union 进同一主题簇。
 * 主题 id = 簇内最高频 token（hash 截断去冲突），成员按 createdAt 升序稳定。
 * 纯函数、零 IO、可复算；O(N·tokens + pair 计数)，仅对共享 token 的条目对建 pair。
 */
export function clusterThemes(entries: readonly MemoryEntry[], minShared = 2): ThemeCluster[] {
  if (entries.length < 2) return []
  // token → 条目索引（倒排）
  const byToken = new Map<string, number[]>()
  const tokenSets = new Map<string, Set<string>>()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    const tokens = new Set(tokenize(e.content))
    tokenSets.set(e.id, tokens)
    for (const t of tokens) {
      const list = byToken.get(t)
      if (list) list.push(i)
      else byToken.set(t, [i])
    }
  }
  // pair 共享 token 计数
  const pairCount = new Map<string, number>()
  for (const ids of byToken.values()) {
    if (ids.length < 2) continue
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const ia = ids[a]!
        const ib = ids[b]!
        const key = ia < ib ? `${ia}\u0000${ib}` : `${ib}\u0000${ia}`
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      }
    }
  }
  // 并查集：共享 ≥ minShared 个 token 的条目对 union（路径压缩）
  const parent = new Array<number>(entries.length)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    let c = x
    while (parent[c] !== c) {
      const next = parent[c]!
      parent[c] = r
      c = next
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (const [key, count] of pairCount) {
    if (count < minShared) continue
    const sep = key.indexOf('\u0000')
    union(Number(key.slice(0, sep)), Number(key.slice(sep + 1)))
  }
  // 簇内 token 频率聚合 → label / topKinds
  const clusters = new Map<
    number,
    { members: number[]; tokenFreq: Map<string, number>; kinds: Map<MemoryKind, number> }
  >()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    const root = find(i)
    let c = clusters.get(root)
    if (!c) {
      c = { members: [], tokenFreq: new Map(), kinds: new Map() }
      clusters.set(root, c)
    }
    c.members.push(i)
    for (const t of tokenSets.get(e.id) ?? []) c.tokenFreq.set(t, (c.tokenFreq.get(t) ?? 0) + 1)
    c.kinds.set(e.kind, (c.kinds.get(e.kind) ?? 0) + 1)
  }
  const out: ThemeCluster[] = []
  for (const c of clusters.values()) {
    if (c.members.length < 2) continue
    let label = ''
    let best = 0
    for (const [t, n] of c.tokenFreq) {
      if (n > best) {
        best = n
        label = t
      }
    }
    const topKinds = [...c.kinds.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 3)
      .map(([k]) => k)
    out.push({
      id: tokenThemeId(label),
      label,
      memberCount: c.members.length,
      topKinds,
    })
  }
  return out.sort((a, b) => b.memberCount - a.memberCount || (a.label < b.label ? -1 : 1))
}

/** 主题 id：label 的短哈希（去冲突不可见字符）+ 前缀，稳定可复现 */
export function tokenThemeId(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0
  }
  return `theme-${h.toString(36)}`
}
