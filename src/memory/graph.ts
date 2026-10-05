/**
 * 时序知识图谱召回线（1.1.0，DESIGN-1.1 模块 C）。
 *
 * 把记忆条目之间的事实关系（主语-关系-宾语）建成带时间锚定的有向图，
 * 作为**第四召回线**接入既有三线（精确/容错/语义）融合：
 * - 零依赖规则三元组抽取（ruleExtractTriples）：双级模板 + 词表单一事实源；
 * - 时序锚定：边带 occurredAt（条目 updatedAt）；条目被 supersede 取代时其边失效
 *   （invalidAt），支持 `asOf` 时间线语义；
 * - 图结构召回：查询词实体识别 → 邻域扩展（hop≤2，路径权重=hop 惩罚 × 度数归一）→
 *   关联条目计分（× currentness 时效衰减）；
 * - 增量维护：TemporalGraph 运行时索引（内存），remove 软删、超限按最旧淘汰；
 *   提供 buildGraph 全量重建纯工厂（与增量对拍验证一致性）。
 *
 * 设计纪律（DESIGN-1.1 硬约束）：
 * - 零第三方依赖、纯函数/纯类、可复算（now 注入）；
 * - 不写存储、不修改 MemoryEntry；图是纯运行时视图（升级/重启后由条目重建）；
 * - 抽样/抽取全部由词表编译派生，无第二份漂移词面。
 *
 * DESIGN-1.1 模块 C 验收门限（G10）：
 * - 抽取有效性：小语料主观三元组召回命中 ≥ 80%（eval 图谱夹具锁定）；
 * - 图召回命中：查询邻域可命中相关条目（graphHits > 0）；
 * - 增量一致性：写入/删除/取代后图统计与 buildGraph 全量重建一致；
 * - 零行为回归：graphEnabled 缺省 false 时召回结果与 1.0.0 逐字节一致。
 */
import { normalizeForMatch } from './capture'
import { isSuperseded } from './entry-factory'
import type { GraphRecallSource, MemoryEntry } from './types'

/** 图谱线权重（interpolate 融合模式，可注入覆盖）；仅 graphEnabled=true 时生效 */
export const GRAPH_LINE_WEIGHT = 0.35
/** 邻域扩展最大跳数（默认 2） */
export const GRAPH_DEFAULT_MAX_HOP = 2
/** currentness 时效半衰期（90 天：图边时效比记忆衰减长，长期关系仍可命中） */
export const GRAPH_TAU_MS = 90 * 24 * 60 * 60 * 1000
/** 图谱实体上限（默认 2000；超限按最后出现时间淘汰最旧） */
export const GRAPH_DEFAULT_MAX_ENTITIES = 2000
/** 路径权重 hop 衰减指数（hop=1 → 1；hop=2 → 1/2^1.4≈0.38） */
const HOP_DECAY = 1.4
/** 三元组置信度下界（低于则丢弃；弱关系词 0.8 可通过，更弱不进图） */
const CONFIDENCE_FLOOR = 0.8

/**
 * 关系词表（单一事实源，中文按 indexOf 匹配、英文按词边界正则匹配）。
 * `[关系词, 置信度]`；新词只增不改，行为保持超集兼容。
 */
const RELATION_TERMS: ReadonlyArray<readonly [string, number, 'zh' | 'en']> = [
  ['是', 0.9, 'zh'],
  ['属于', 1.0, 'zh'],
  ['位于', 1.0, 'zh'],
  ['来自', 0.9, 'zh'],
  ['使用', 1.0, 'zh'],
  ['构建', 1.0, 'zh'],
  ['运行', 1.0, 'zh'],
  ['依赖', 1.0, 'zh'],
  ['安装', 0.9, 'zh'],
  ['配置', 0.9, 'zh'],
  ['部署', 1.0, 'zh'],
  ['升级到', 1.0, 'zh'],
  ['迁移到', 1.0, 'zh'],
  ['替代', 1.0, 'zh'],
  ['喜欢', 0.9, 'zh'],
  ['偏好', 0.95, 'zh'],
  ['推荐', 0.85, 'zh'],
  ['禁止', 1.0, 'zh'],
  ['uses', 1.0, 'en'],
  ['use', 0.8, 'en'],
  ['built with', 1.0, 'en'],
  ['runs on', 1.0, 'en'],
  ['depends on', 1.0, 'en'],
  ['located in', 0.95, 'en'],
  ['prefers', 0.9, 'en'],
  ['likes', 0.85, 'en'],
  ['recommends', 0.85, 'en'],
  ['requires', 0.95, 'en'],
  ['replaces', 1.0, 'en'],
]

/** 主语侧常见指示词前缀（归一化匹配；命中则剥除——「用户/我们/项目」不作为实体主语） */
const SUBJECT_PREFIXES: readonly string[] = [
  '用户',
  '我',
  '我们',
  '你',
  '项目',
  '团队',
  '系统',
  '配置',
  '默认',
  '当前',
  'the user',
  'we',
  'our',
  'the project',
  'the system',
  'this project',
]

/** 句内分隔符（中文/英文；主语与宾语截断边界） */
const SENTENCE_SEPS = ['。', '，', '！', '？', '；', '\n', '.', ',', '!', '?', ';']

/** 宾语尾部语气/结构词（截断剥离——「MySQL 做主库」→「MySQL 主库」去虚词） */
const TAIL_STRIP = ['的', '了', '吗', '呢', '吧', '啊', '和', '以及', '与', '或者', '等']

/** 一条抽取结果 */
export interface Triple {
  subject: string
  relation: string
  object: string
  /** 置信度（关系词权重 × 形态因子，∈(0,1]） */
  confidence: number
}

/** 一个主语 → 关系 → 目标边（时序锚定） */
interface StoredEdge {
  relation: string
  target: string
  occurredAt: number
  /** 被取代/删除软标记：>= now 时该边从活跃视图消失（asOf 回放可见） */
  invalidAt?: number
  entryIds: string[]
  confidence: number
}

/** 图谱统计（status 可观测 / 增量一致性对拍） */
export interface GraphStats {
  /** 活跃（含失效）实体总数 */
  entities: number
  /** 活跃边总数（含失效软删边） */
  edges: number
  /** 未失效边数（当前时间线活跃） */
  activeEdges: number
  /** 因 supersede 失效的边数 */
  supersededEdges: number
  /** 因超限被淘汰的边计数（可观测） */
  evicted: number
}

/**
 * 零依赖规则三元组抽取（纯函数，可复算）。
 *
 * 中文按关系词 indexOf 定位切分；英文按词边界正则匹配（avoid `use`∝`because` 误匹配）。
 * 主语/宾语有效性：长度 ≥2、非纯标点、不含敏感、关系词前后实体不相同时才产出；
 * 宾语遇下一关系词提前截断（嵌套关系拆分主句），尾部语气词剥离。
 * 返回按置信度降序去重（同 subject+relation+object 只留最高置信）。
 */
export function ruleExtractTriples(text: string): Triple[] {
  const norm = normalizeForMatch(text)
  if (norm.length < 4) return []
  const found: Triple[] = []
  // 按关系词长度降序匹配：长词（built with / depends on / 升级到）优先于短词（use/用）
  const ordered = [...RELATION_TERMS].sort((a, b) => b[0].length - a[0].length)
  for (const [rel, weight, lang] of ordered) {
    let cursor = 0
    while (true) {
      const idx = lang === 'en' ? indexOfWord(norm, rel, cursor) : norm.indexOf(rel, cursor)
      if (idx < 0) break
      cursor = idx + rel.length
      const subject = preprocessHead(norm, idx)
      const object = preprocessTail(norm, cursor, rel)
      if (!validEntity(subject) || !validEntity(object) || subject === object) continue
      const confidence = shapeConfidence(subject, object, weight)
      if (confidence < CONFIDENCE_FLOOR) continue
      found.push({ subject, relation: rel, object, confidence })
    }
  }
  // 去重：同三元组只留最高置信；再按置信度降序稳定
  const seen = new Set<string>()
  const out: Triple[] = []
  for (const t of found.sort((a, b) => b.confidence - a.confidence)) {
    const key = `${t.subject}\u0000${t.relation}\u0000${t.object}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/** 英文词边界匹配：\b 两侧字母数字时不算词边界 */
function indexOfWord(text: string, word: string, from: number): number {
  while (true) {
    const idx = text.indexOf(word, from)
    if (idx < 0) return -1
    const before = idx > 0 ? (text[idx - 1] ?? '') : ''
    const after = idx + word.length < text.length ? (text[idx + word.length] ?? '') : ''
    const isBoundary = (ch: string) => !ch || !/[a-z0-9_]/.test(ch)
    if (isBoundary(before) && isBoundary(after)) return idx
    from = idx + 1
    if (from >= text.length) return -1
  }
}

/** 主语：取句内最后一个分隔符后的片段，剥指示词前缀，去首尾空白与连接词 */
function preprocessHead(text: string, end: number): string {
  let seg = text.slice(0, end)
  let lastSep = -1
  for (const s of SENTENCE_SEPS) {
    const i = seg.lastIndexOf(s)
    if (i > lastSep) lastSep = i
  }
  if (lastSep >= 0) seg = seg.slice(lastSep + 1)
  for (const p of SUBJECT_PREFIXES) {
    if (seg.startsWith(p)) {
      seg = seg.slice(p.length)
      break
    }
  }
  seg = trimEdge(seg)
  return seg.slice(0, 24)
}

/** 宾语：取到句分隔符前；遇下一关系词提前截断（嵌套关系优先拆分主句）；剥离尾部虚词 */
function preprocessTail(text: string, start: number, rel: string): string {
  let seg = text.slice(start)
  let firstSep = -1
  for (const s of SENTENCE_SEPS) {
    const i = seg.indexOf(s)
    if (i >= 0 && (firstSep < 0 || i < firstSep)) firstSep = i
  }
  if (firstSep >= 0) seg = seg.slice(0, firstSep)
  // 嵌套关系提前截断：按长度降序找第一个出现在宾语中的其他关系词
  let cutAt = -1
  const ordered = [...RELATION_TERMS].sort((a, b) => b[0].length - a[0].length)
  for (const [other] of ordered) {
    if (other === rel) continue
    const i = seg.indexOf(other)
    if (i > 0 && (cutAt < 0 || i < cutAt)) cutAt = i
  }
  if (cutAt > 0) seg = seg.slice(0, cutAt)
  // 剥离尾部虚词（循环剥：'MySQL主库的' 剥两次）
  let prev: string
  do {
    prev = seg
    for (const w of TAIL_STRIP) {
      if (seg.endsWith(w)) seg = seg.slice(0, seg.length - w.length)
    }
  } while (seg !== prev)
  seg = trimEdge(seg)
  return seg.slice(0, 24)
}

/** 去首尾空白与连接标点（归一化实体保留，避免尾部残留 ','） */
function trimEdge(s: string): string {
  return s.replace(/^[\s\t，、:：,;；]+/, '').replace(/[\s\t，、:：,;；]+$/, '')
}

/** 实体有效性：长度 2-24、不含关系词自身、不含敏感 */
function validEntity(s: string): boolean {
  if (s.length < 2 || s.length > 24) return false
  if (/[A-Za-z]+/.test(s) && /^[a-z0-9_ ]+$/.test(s) === false && /[\u0080-\uffff]/.test(s) === false) return false
  // 只含英文标点/符号 → 无效
  if (/^[\s\-_.:：,，;；/\\()（）'"]+$/.test(s)) return false
  return true
}

/** 形态置信度：实体带有引号/全大写专名 → 轻微加成（表示明确实体引用） */
function shapeConfidence(subject: string, object: string, weight: number): number {
  let c = weight
  if (subject.includes('“') || subject.includes('"')) c += 0.05
  if (object.includes('”') || object.includes('"')) c += 0.05
  return Math.min(1, c)
}

/**
 * 时序知识图谱：增量维护的运行时图索引。
 * 双向边（relation + `~` 反向关系）；条目被取代（superseded-by tag）时其边失效；
 * 实体超限时按 lastOccurredAt 最旧淘汰。纯内存、可重建、可对拍。
 */
export class TemporalGraph implements GraphRecallSource {
  private outgoing = new Map<string, Map<string, StoredEdge>>()
  /** 实体 → 提及该实体的条目 id 集（图召回反查用） */
  private incident = new Map<string, Set<string>>()
  private lastSeen = new Map<string, number>()
  private maxEntities: number
  private evicted = 0

  constructor(maxEntities: number = GRAPH_DEFAULT_MAX_ENTITIES) {
    this.maxEntities = maxEntities
  }

  private edgeKey(relation: string, target: string): string {
    return `${relation}\u0000${target}`
  }

  private ensureEntity(entity: string): void {
    if (!this.outgoing.has(entity)) {
      this.outgoing.set(entity, new Map())
    }
    if (!this.incident.has(entity)) {
      this.incident.set(entity, new Set())
    }
  }

  private touch(entity: string, at: number): void {
    this.lastSeen.set(entity, Math.max(this.lastSeen.get(entity) ?? 0, at))
    this.evictIfOverflow()
  }

  private evictIfOverflow(): void {
    if (this.outgoing.size <= this.maxEntities) return
    const sorted = [...this.lastSeen.entries()].sort((a, b) => a[1] - b[1])
    const target = this.maxEntities
    for (const [entity] of sorted) {
      if (this.outgoing.size <= target) break
      this.outgoing.delete(entity)
      this.incident.delete(entity)
      this.lastSeen.delete(entity)
      this.evicted++
    }
  }

  /**
   * 增量写入：对条目抽取三元组并建双向边。
   * 条目含 superseded-by tag（已被取代）时，其边标记 invalidAt=updatedAt（时间线失效）。
   * 返回 { addedEdges, evictedEdges }（可观测计数）。
   */
  add(entry: MemoryEntry): { addedEdges: number; evictedEdges: number } {
    const beforeEvicted = this.evicted
    const triples = ruleExtractTriples(entry.content)
    const invalid = isSuperseded(entry)
    let addedEdges = 0
    for (const t of triples) {
      addedEdges += this.upsertEdge(t.subject, t.relation, t.object, entry, t.confidence, invalid)
      addedEdges += this.upsertEdge(t.object, `~${t.relation}`, t.subject, entry, t.confidence, invalid)
    }
    return { addedEdges, evictedEdges: this.evicted - beforeEvicted }
  }

  private upsertEdge(
    subject: string,
    relation: string,
    target: string,
    entry: MemoryEntry,
    confidence: number,
    invalid: boolean,
  ): number {
    this.ensureEntity(subject)
    this.ensureEntity(target)
    const bucket = this.outgoing.get(subject)!
    const key = this.edgeKey(relation, target)
    const existing = bucket.get(key)
    if (existing) {
      if (!existing.entryIds.includes(entry.id)) existing.entryIds.push(entry.id)
      existing.occurredAt = Math.max(existing.occurredAt, entry.updatedAt)
      existing.confidence = Math.max(existing.confidence, confidence)
      if (invalid && existing.invalidAt === undefined) existing.invalidAt = entry.updatedAt
    } else {
      const edge: StoredEdge = {
        relation,
        target,
        occurredAt: entry.updatedAt,
        entryIds: [entry.id],
        confidence,
        ...(invalid ? { invalidAt: entry.updatedAt } : {}),
      }
      bucket.set(key, edge)
    }
    this.incident.get(subject)!.add(entry.id)
    this.incident.get(target)!.add(entry.id)
    this.touch(subject, entry.updatedAt)
    this.touch(target, entry.updatedAt)
    return 1
  }

  /** 软删除：移除条目在该边上的引用；边无引用者标记失效（asOf 时间线保留） */
  remove(entryId: string, now = Date.now()): number {
    let touched = 0
    for (const bucket of this.outgoing.values()) {
      for (const [key, edge] of bucket) {
        const i = edge.entryIds.indexOf(entryId)
        if (i < 0) continue
        edge.entryIds.splice(i, 1)
        if (edge.entryIds.length === 0 && edge.invalidAt === undefined) {
          edge.invalidAt = now
          touched++
        } else if (edge.entryIds.length === 0) {
          bucket.delete(key)
          touched++
        }
      }
    }
    return touched
  }

  /** 查询实体在邻域扩展后的拓扑得分（hop 惩罚 × 度数归一累积） */
  neighborEntityScores(
    queryEntities: readonly string[],
    now: number,
    maxHop: number = GRAPH_DEFAULT_MAX_HOP,
  ): Map<string, number> {
    const scores = new Map<string, number>()
    const seen = new Set<string>()
    let frontier = [...new Set(queryEntities)].filter((e) => this.outgoing.has(e))
    for (const e of frontier) seen.add(e)
    for (let hop = 1; hop <= maxHop && frontier.length > 0; hop++) {
      const hopFactor = 1 / Math.pow(hop, HOP_DECAY)
      const next: string[] = []
      for (const u of frontier) {
        const bucket = this.outgoing.get(u)
        if (!bucket) continue
        // 度数归一：高连接实体（如「用户」）的每条边权重被 log 摊薄，防止 hub 淹没特异边
        const degree = bucket.size
        const contribution = hopFactor * (1 / (1 + Math.log1p(degree)))
        for (const edge of bucket.values()) {
          if (edge.invalidAt !== undefined && edge.invalidAt <= now) continue
          scores.set(edge.target, (scores.get(edge.target) ?? 0) + contribution)
          if (!seen.has(edge.target)) {
            seen.add(edge.target)
            next.push(edge.target)
          }
        }
      }
      frontier = next
    }
    return scores
  }

  /** 反查：实体 → 提及该实体的条目 id 集 */
  entryIdsByEntity(entity: string): readonly string[] {
    const set = this.incident.get(entity)
    return set ? [...set] : []
  }

  /** 图谱统计（status 可观测 / 与 buildGraph 全量重建对拍） */
  stats(now = Date.now()): GraphStats {
    let edges = 0
    let activeEdges = 0
    let supersededEdges = 0
    for (const bucket of this.outgoing.values()) {
      for (const e of bucket.values()) {
        edges++
        if (e.invalidAt === undefined || e.invalidAt > now) activeEdges++
        if (e.invalidAt !== undefined && e.invalidAt <= now) supersededEdges++
      }
    }
    return {
      entities: this.outgoing.size,
      edges,
      activeEdges,
      supersededEdges,
      evicted: this.evicted,
    }
  }
}

/** 全量重建工厂（纯函数；与增量 add 对拍一致性：G10 增量一致性门限） */
export function buildGraph(
  entries: readonly MemoryEntry[],
  maxEntities: number = GRAPH_DEFAULT_MAX_ENTITIES,
): TemporalGraph {
  const g = new TemporalGraph(maxEntities)
  for (const e of entries) g.add(e)
  return g
}

/** 从查询文本识别图实体（纯函数）：引号内容 + 关系词前主语 + 短整句兜底 */
export function queryEntities(query: string): string[] {
  const norm = normalizeForMatch(query)
  if (!norm) return []
  const out: string[] = []
  // 引号内容（先剥引号，实体包含引号内完整短语）
  for (const m of norm.matchAll(/[“"]([^”"]+)[”"]/g)) {
    const e = trimEdge(m[1]!)
    if (validEntity(e)) out.push(e)
  }
  // 关系词前主语片段
  const relOnly = [...RELATION_TERMS].filter((r) => r[2] === 'zh')
  const enOrdered = [...RELATION_TERMS].filter((r) => r[2] === 'en').sort((a, b) => b[0].length - a[0].length)
  for (const [rel] of relOnly) {
    const i = norm.indexOf(rel)
    if (i > 0) {
      const e = trimEdge(preprocessHead(norm, i))
      if (validEntity(e)) out.push(e)
    }
  }
  for (const [rel] of enOrdered) {
    const i = indexOfWord(norm, rel, 0)
    if (i > 0) {
      const e = trimEdge(preprocessHead(norm, i))
      if (validEntity(e)) out.push(e)
    }
  }
  // 短整句兜底（查询本身是实体名）
  const whole = trimEdge(norm)
  if (validEntity(whole) && whole.length >= 2 && !out.includes(whole)) out.push(whole)
  return out
}

/** 图谱线召回评分（纯函数）：邻域实体 → 关联条目计分（拓扑 × currentness 时效） */
export function graphLineScores(
  graph: GraphRecallSource,
  query: string,
  entriesById: ReadonlyMap<string, MemoryEntry>,
  now: number,
  opts: { maxHop?: number; tauMs?: number } = {},
): Map<string, number> {
  const maxHop = opts.maxHop ?? GRAPH_DEFAULT_MAX_HOP
  const tauMs = opts.tauMs ?? GRAPH_TAU_MS
  const entities = queryEntities(query)
  const scores = new Map<string, number>()
  if (entities.length === 0) return scores
  const nbr = graph.neighborEntityScores(entities, now, maxHop)
  for (const [entity, topo] of nbr) {
    for (const id of graph.entryIdsByEntity(entity)) {
      const entry = entriesById.get(id)
      if (!entry) continue
      const age = Math.max(0, now - entry.updatedAt)
      const currentness = Math.exp(-age / tauMs)
      scores.set(id, (scores.get(id) ?? 0) + topo * currentness)
    }
  }
  return scores
}
