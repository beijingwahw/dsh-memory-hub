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
import { tokenize } from './tokenize'
import type { GraphRecallSource, MemoryEntry } from './types'

/**
 * 1.1.1 实体归一化（图内规范键）：NFKC 小写 + 空白折叠 + 首尾连接标点剥离。
 * 动机：此前图内以**原始字符串**为键做精确匹配——「MySQL。」「mysql」「Mysql」是三个
 * 互不相通的实体；查询侧与记忆侧任何措辞/大小写/尾标点差异都直接 miss。
 * 全部内部 Map（outgoing/incident/lastSeen/tokenIndex）与查询入口统一走此规范形。
 */
export function normalizeEntityKey(s: string): string {
  return normalizeForMatch(s)
    .replace(/\s+/g, ' ')
    .replace(/^[\s，、:：,;；.。!！?？]+/, '')
    .replace(/[\s，、:：,;；.。!！?？]+$/, '')
    .trim()
}

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
 * 1.5.0（DESIGN-1.5 模块 N）双语扩展：补齐英文技术文档高频关系面
 * （based on / powered by / written in / returns / throws / emits / supports / …）
 * 与中文对应面（基于/支持/提供/返回/抛出/发出/改为/换成…）——1.2.0/1.3.0 声明的
 * 「英文语料仅产出片段型实体、词表扩展属后续独立课题」边界自此收敛为双语词表。
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
  ['基于', 0.9, 'zh'],
  ['支持', 0.9, 'zh'],
  ['提供', 0.9, 'zh'],
  ['返回', 0.85, 'zh'],
  ['抛出', 0.9, 'zh'],
  ['发出', 0.85, 'zh'],
  ['继承', 0.9, 'zh'],
  ['实现', 0.9, 'zh'],
  ['改为', 1.0, 'zh'],
  ['换成', 1.0, 'zh'],
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
  ['based on', 0.9, 'en'],
  ['powered by', 0.9, 'en'],
  ['written in', 1.0, 'en'],
  ['deployed on', 1.0, 'en'],
  ['migrated to', 1.0, 'en'],
  ['upgraded to', 1.0, 'en'],
  ['replaced by', 1.0, 'en'],
  ['part of', 0.95, 'en'],
  ['belongs to', 0.95, 'en'],
  ['supports', 0.9, 'en'],
  ['provides', 0.9, 'en'],
  ['returns', 0.85, 'en'],
  ['accepts', 0.9, 'en'],
  ['throws', 0.9, 'en'],
  ['emits', 0.9, 'en'],
  ['extends', 0.9, 'en'],
  ['implements', 0.9, 'en'],
]

/** 主语侧常见指示词前缀（归一化匹配；命中则剥除——「用户/我们/项目」不作为实体主语）。
 * 1.1.1 锁定语义：只剥**指示词**前缀（the user/the system…），普通定冠词短语
 * （'the app'）保留为实体主语——1.5.0 模块 N 维持该锁定，不追加裸 'the '。 */
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

/** 1.5.0（模块 N）：句点分隔判定——标识符内部的点（node.js / fs.readfile，两侧均为
 * 字母数字）不是句分隔；真正的句末点号（后随空白/结尾/非字母数字）才是。 */
function isAlnumChar(ch: string): boolean {
  return ch !== '' && /[a-z0-9]/.test(ch)
}

/** seg 内最后一个句分隔符位置（标识符内部的点不计） */
function lastSepIndex(seg: string): number {
  let last = -1
  for (const s of SENTENCE_SEPS) {
    if (s === '.') {
      for (let i = seg.length - 1; i >= 0; i--) {
        if (seg[i] !== '.') continue
        const prev = i > 0 ? (seg[i - 1] ?? '') : ''
        const next = i + 1 < seg.length ? (seg[i + 1] ?? '') : ''
        if (isAlnumChar(prev) && isAlnumChar(next)) continue // node.js 内部点
        if (i > last) last = i
        break
      }
    } else {
      const i = seg.lastIndexOf(s)
      if (i > last) last = i
    }
  }
  return last
}

/** seg 内第一个句分隔符位置（标识符内部的点不计） */
function firstSepIndex(seg: string): number {
  let first = -1
  for (const s of SENTENCE_SEPS) {
    if (s === '.') {
      for (let i = 0; i < seg.length; i++) {
        if (seg[i] !== '.') continue
        const prev = i > 0 ? (seg[i - 1] ?? '') : ''
        const next = i + 1 < seg.length ? (seg[i + 1] ?? '') : ''
        if (isAlnumChar(prev) && isAlnumChar(next)) continue
        if (first < 0 || i < first) first = i
        break
      }
    } else {
      const i = seg.indexOf(s)
      if (i >= 0 && (first < 0 || i < first)) first = i
    }
  }
  return first
}

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
  /**
   * 1.1.1 重断言复活时间：同一三元组被新的非取代条目重新确立时记录。
   * 活跃性判定：invalidAt ≤ now < reassertedAt 期间为失效（asOf 回放忠实还原
   * 「失效期间」），now ≥ reassertedAt 复活——纯 delete invalidAt 会抹掉失效期。
   */
  reassertedAt?: number
  entryIds: string[]
  confidence: number
}

/** 1.1.1：边在时刻 now 是否失效（invalidAt 已过且未被更晚的重断言复活） */
function isEdgeInvalidAt(edge: StoredEdge, now: number): boolean {
  if (edge.invalidAt === undefined) return false
  if (edge.invalidAt > now) return false
  return edge.reassertedAt === undefined || edge.reassertedAt > now
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
      // 1.1.1 裸「是」降噪：双侧均纯 CJK 时跳过——「今天是周三」「这是对的」类日常句
      // 产出垃圾三元组且 0.9 置信直通下限；任一侧含拉丁/数字（专名形态）仍产出
      if (rel === '是' && !/[a-z0-9]/.test(subject) && !/[a-z0-9]/.test(object)) continue
      if (!validEntity(subject)) continue
      // 1.5.0（模块 N）：宾语连词拆分——「A uses B and C」「A 使用 B、C」逐并列产出
      for (const obj of splitConjuncts(object)) {
        if (!validEntity(obj) || subject === obj) continue
        const confidence = shapeConfidence(subject, obj, weight)
        if (confidence < CONFIDENCE_FLOOR) continue
        found.push({ subject, relation: rel, object: obj, confidence })
      }
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
  const lastSep = lastSepIndex(seg)
  if (lastSep >= 0) seg = seg.slice(lastSep + 1)
  for (const p of SUBJECT_PREFIXES) {
    if (seg.startsWith(p)) {
      seg = seg.slice(p.length)
      break
    }
  }
  seg = trimEdge(seg)
  // 1.5.0（模块 N）：主语尾部系动词剥除——'fs is part of the core' 的主语是 'fs'
  // 而非 'fs is'（is/was/are/were/be 尾缀不构成实体名）
  seg = seg.replace(/\s+(?:is|was|are|were|be)$/, '')
  return seg.slice(0, 24)
}

/** 宾语：取到句分隔符前；遇下一关系词提前截断（嵌套关系优先拆分主句）；剥离尾部虚词 */
function preprocessTail(text: string, start: number, rel: string): string {
  let seg = text.slice(start)
  const firstSep = firstSepIndex(seg)
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
  // 1.5.0（模块 N）：宾语前导冠词剥除（'readfile returns a promise' → 'promise'）
  seg = seg.replace(/^(?:a|an|the)\s+/, '')
  return seg.slice(0, 24)
}

/** 1.5.0（模块 N）：宾语连词拆分——空格连接的 and/or/与/和 与顿号「、」按并列切分。
 * 高精度取向：不拆无空格的「与/和」（避免切坏「和平」「参与」类词内字）。 */
const CONJUNCT_SPLIT = /\s+(?:and|or|与|和)\s+|\s*、\s*/

function splitConjuncts(object: string): string[] {
  const parts = object
    .split(CONJUNCT_SPLIT)
    .map((p) => trimEdge(p))
    .filter((p) => p.length > 0)
  return parts.length > 0 ? parts : [object]
}

/** 去首尾空白与连接标点（归一化实体保留，避免尾部残留 ','） */
function trimEdge(s: string): string {
  return s.replace(/^[\s\t，、:：,;；]+/, '').replace(/[\s\t，、:：,;；]+$/, '')
}

/** 实体有效性：长度 2-24、不含关系词自身、不含敏感 */
function validEntity(s: string): boolean {
  if (s.length < 2 || s.length > 24) return false
  // 1.1.1：英文实体允许 . + -（node.js / c++ / koa-router 等技术栈专名此前被拒，
  // 无法进图）；仍拒绝混排中文以外的其他unicode噪声
  if (/[A-Za-z]+/.test(s) && /^[a-z0-9_ .+-]+$/.test(s) === false && /[\u0080-\uffff]/.test(s) === false) {
    return false
  }
  // 只含英文标点/符号 → 无效
  if (/^[\s\-_.:：,，;；+/\\()（）'"]+$/.test(s)) return false
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
  /**
   * 1.1.1 对齐层：实体特异 token 倒排（token → 实体键集）。
   * 自然语言查询（「用户喜欢什么编辑器」）与记忆侧主语（「编辑器」为被截断的原文
   * 片段）此前**零对齐机制**——查询实体串与图键精确匹配，miss 即全空。对齐层把
   * 查询 token 与实体 token 的共享面作为召回信号（共享 ≥2 个特异 token，或短实体
   * 共享 ≥1），hub token（出现在过多实体中）不参与。
   */
  private tokenIndex = new Map<string, Set<string>>()
  /** 对齐层 hub 护栏：posting 超过该数的 token 不参与对齐（与聚类护栏同量级） */
  private static readonly ALIGN_MAX_DF = 64
  /** 对齐层返回实体数上限（防大图广播） */
  private static readonly ALIGN_MAX_ENTITIES = 8
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
      // 对齐层索引：新实体键的特异 token 入倒排（图键已是规范形）
      for (const t of tokenize(entity)) {
        const set = this.tokenIndex.get(t)
        if (set) set.add(entity)
        else this.tokenIndex.set(t, new Set([entity]))
      }
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
      // 对齐层索引同步清理（该实体各 token 的 posting 集合中移除）
      for (const t of tokenize(entity)) {
        const set = this.tokenIndex.get(t)
        if (!set) continue
        set.delete(entity)
        if (set.size === 0) this.tokenIndex.delete(t)
      }
      this.evicted++
    }
  }

  /**
   * 1.1.1 对齐层：给定查询 token 集，返回共享足够特异 token 的图实体键。
   * 判定：共享 ≥ 2 个特异 token；实体自身 token 数 ≤ 2（短专名）时共享 ≥ 1 即命中。
   * 确定性排序（共享数降序、键字典序兜底），上限 ALIGN_MAX_ENTITIES；纯函数式只读。
   */
  alignByTokens(tokens: readonly string[]): readonly string[] {
    if (tokens.length === 0 || this.tokenIndex.size === 0) return []
    const shared = new Map<string, number>()
    for (const t of new Set(tokens)) {
      const postings = this.tokenIndex.get(t)
      if (postings === undefined || postings.size > TemporalGraph.ALIGN_MAX_DF) continue
      for (const entity of postings) shared.set(entity, (shared.get(entity) ?? 0) + 1)
    }
    const out: Array<{ key: string; n: number; size: number }> = []
    for (const [key, n] of shared) {
      const entityTokenCount = tokenize(key).length
      if (n >= 2 || (entityTokenCount <= 2 && n >= 1)) out.push({ key, n, size: entityTokenCount })
    }
    return out
      .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1))
      .slice(0, TemporalGraph.ALIGN_MAX_ENTITIES)
      .map((x) => x.key)
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
    // 1.1.1：实体以规范键入图（大小写/空白/尾标点变体归一，杜绝同义异形实体分裂）
    const s = normalizeEntityKey(subject)
    const t = normalizeEntityKey(target)
    if (!s || !t || s === t) return 0
    this.ensureEntity(s)
    this.ensureEntity(t)
    const bucket = this.outgoing.get(s)!
    const key = this.edgeKey(relation, t)
    const existing = bucket.get(key)
    if (existing) {
      if (!existing.entryIds.includes(entry.id)) existing.entryIds.push(entry.id)
      existing.occurredAt = Math.max(existing.occurredAt, entry.updatedAt)
      existing.confidence = Math.max(existing.confidence, confidence)
      if (invalid) {
        if (existing.invalidAt === undefined) existing.invalidAt = entry.updatedAt
      } else if (existing.invalidAt !== undefined) {
        // 1.1.1 重断言复活：同一三元组被新的非取代条目重新确立时，记录复活时间——
        // 此前 invalidAt 只设不清，「A 使用 X」被取代后用户重新确立同一事实，
        // 该边在图召回中永久死亡。reassertedAt 保留失效期供 asOf 回放忠实还原。
        if (existing.reassertedAt === undefined || entry.updatedAt > existing.reassertedAt) {
          existing.reassertedAt = entry.updatedAt
        }
      }
    } else {
      const edge: StoredEdge = {
        relation,
        target: t,
        occurredAt: entry.updatedAt,
        entryIds: [entry.id],
        confidence,
        ...(invalid ? { invalidAt: entry.updatedAt } : {}),
      }
      bucket.set(key, edge)
    }
    this.incident.get(s)!.add(entry.id)
    this.incident.get(t)!.add(entry.id)
    this.touch(s, entry.updatedAt)
    this.touch(t, entry.updatedAt)
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

  /** 查询实体在邻域扩展后的拓扑得分（hop 惩罚 × 度数归一累积）；入参实体经规范键对齐 */
  neighborEntityScores(
    queryEntities: readonly string[],
    now: number,
    maxHop: number = GRAPH_DEFAULT_MAX_HOP,
  ): Map<string, number> {
    const scores = new Map<string, number>()
    const seen = new Set<string>()
    // 1.1.1：查询实体经规范键对齐（大小写/空白/尾标点差异不再 miss）
    let frontier = [...new Set(queryEntities.map(normalizeEntityKey))].filter(
      (e) => e.length > 0 && this.outgoing.has(e),
    )
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
          if (isEdgeInvalidAt(edge, now)) continue
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

  /** 反查：实体 → 提及该实体的条目 id 集（入参经规范键对齐） */
  entryIdsByEntity(entity: string): readonly string[] {
    const set = this.incident.get(normalizeEntityKey(entity))
    return set ? [...set] : []
  }

  /**
   * 1.2.0（DESIGN-1.2 模块 E）：实体在时刻 now 的活跃出边（推理线遍历入口）。
   * 只返回 isEdgeInvalidAt 判定活跃的边（asOf 时间线正确性由这里保证——推理线
   * 不能穿越已被取代/软删除失效的关系）；按 (target, relation) 字典序确定性排序，
   * 使链枚举与实体插入顺序无关。
   * 1.3.0（DESIGN-1.3 模块 G）注：深情景回放（条目层日志回放）下调用方应使用
   * buildGraph(replayAsOf(...)) 重建 T 时刻图视图——occurredAt 是「最近一次触碰该边
   * 的写入时刻」（取代标记回写也会推高它），不等于「关系发生时刻」，故此处不做
   * occurredAt ≤ now 过滤（1.2.0 已锁定的 asOf 语义保持逐字节不变）。
   */
  activeOutEdges(
    entity: string,
    now: number,
  ): ReadonlyArray<{ relation: string; target: string; confidence: number; occurredAt: number }> {
    const bucket = this.outgoing.get(normalizeEntityKey(entity))
    if (!bucket) return []
    const out: Array<{ relation: string; target: string; confidence: number; occurredAt: number }> = []
    for (const e of bucket.values()) {
      if (isEdgeInvalidAt(e, now)) continue
      out.push({ relation: e.relation, target: e.target, confidence: e.confidence, occurredAt: e.occurredAt })
    }
    return out.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : a.relation < b.relation ? -1 : 1))
  }

  /** 图谱统计（status 可观测 / 与 buildGraph 全量重建对拍） */
  stats(now = Date.now()): GraphStats {
    let edges = 0
    let activeEdges = 0
    let supersededEdges = 0
    for (const bucket of this.outgoing.values()) {
      for (const e of bucket.values()) {
        edges++
        if (isEdgeInvalidAt(e, now)) supersededEdges++
        else activeEdges++
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

  /**
   * 1.5.0（DESIGN-1.5 模块 L）：时刻 now 的活跃边全量清单（图维 diff 的数据源）。
   * 按 (from, relation, target) 字典序确定性排序（与 activeOutEdges 同排序约定）；
   * 只含 isEdgeInvalidAt 判定活跃的边（失效/复活时间线语义与推理线一致）。
   */
  activeEdgeList(
    now = Date.now(),
  ): ReadonlyArray<{ from: string; relation: string; target: string; confidence: number }> {
    const out: Array<{ from: string; relation: string; target: string; confidence: number }> = []
    for (const [from, bucket] of this.outgoing) {
      for (const e of bucket.values()) {
        if (isEdgeInvalidAt(e, now)) continue
        out.push({ from, relation: e.relation, target: e.target, confidence: e.confidence })
      }
    }
    return out.sort(edgeListCompare)
  }
}

/** activeEdgeList 的确定性排序：(from, relation, target) 字典序 */
function edgeListCompare(
  a: { from: string; relation: string; target: string },
  b: { from: string; relation: string; target: string },
): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1
  if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1
  if (a.target !== b.target) return a.target < b.target ? -1 : 1
  return 0
}

/**
 * 1.5.0（DESIGN-1.5 模块 L）：图维 diff 的一条边（实体-关系-实体）。
 */
export interface GraphDiffEdge {
  from: string
  relation: string
  to: string
}

/** 1.5.0（模块 L）：两个时刻语料的图视图差异（纯函数、确定性） */
export interface GraphDiff {
  /** diff 终点时刻（活跃性判定基准） */
  until: number
  beforeEntities: number
  afterEntities: number
  /** T2 图有、T1 图无的活跃边（activeEdgeList 序） */
  addedEdges: GraphDiffEdge[]
  /** T1 图有、T2 图无的活跃边（新关系确立 / 取代失效 / tombstone 消失） */
  removedEdges: GraphDiffEdge[]
  addedEdgeCount: number
  removedEdgeCount: number
}

/**
 * 1.5.0（DESIGN-1.5 模块 L）：图维时间对账——两个回放快照各自重建图视图后
 * 对活跃边集合做差集（T1↔T2 期间「知识图谱发生了什么」的实体/关系级答案）。
 *
 * 语义与 diffReplay（条目维）互补：added 边 = 新关系确立（新条目抽取或重断言复活）；
 * removed 边 = 关系消失（携带该边的唯一条目被 tombstone，或其条目被取代标注）。
 * 纯函数：buildGraph 双侧重建（corpus 各自时点状态），活跃性以 until 为基准；
 * 派生数组继承 activeEdgeList 的确定性排序。
 */
export function diffGraphs(
  before: readonly MemoryEntry[],
  after: readonly MemoryEntry[],
  until: number,
  maxEntities: number = GRAPH_DEFAULT_MAX_ENTITIES,
): GraphDiff {
  const g1 = buildGraph(before, maxEntities)
  const g2 = buildGraph(after, maxEntities)
  const key = (f: string, r: string, t: string) => `${f}\u0000${r}\u0000${t}`
  const set1 = new Map(g1.activeEdgeList(until).map((x) => [key(x.from, x.relation, x.target), x]))
  const set2 = new Map(g2.activeEdgeList(until).map((x) => [key(x.from, x.relation, x.target), x]))
  const added: GraphDiffEdge[] = []
  const removed: GraphDiffEdge[] = []
  for (const [k, x] of set2) {
    if (!set1.has(k)) added.push({ from: x.from, relation: x.relation, to: x.target })
  }
  for (const [k, x] of set1) {
    if (!set2.has(k)) removed.push({ from: x.from, relation: x.relation, to: x.target })
  }
  return {
    until,
    beforeEntities: g1.stats(until).entities,
    afterEntities: g2.stats(until).entities,
    addedEdges: added,
    removedEdges: removed,
    addedEdgeCount: added.length,
    removedEdgeCount: removed.length,
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
  // 1.1.1 对齐层：查询 token 直接对齐图实体——自然语言问句（「用户喜欢什么编辑器」）
  // 与记忆侧主语（被截断的原文片段）零精确匹配时，共享特异 token 的实体仍可作种子
  const aligned =
    typeof graph.alignByTokens === 'function' ? graph.alignByTokens(tokenize(query)) : ([] as readonly string[])
  const seeds = [...entities, ...aligned]
  const scores = new Map<string, number>()
  if (seeds.length === 0) return scores
  const nbr = graph.neighborEntityScores(seeds, now, maxHop)
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
