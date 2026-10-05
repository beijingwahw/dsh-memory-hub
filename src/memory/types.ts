/**
 * dsh-memory-hub 数据模型
 *
 * MemoryEntry 是记忆的最小持久化单元，以 JSONL 形式落在本地，
 * 全部字段保持可序列化，便于审计、迁移与未来扩展。
 */

/** 记忆类型：决策 / 事实 / 偏好 / 指令 / 通用 */
export type MemoryKind = 'decision' | 'fact' | 'preference' | 'instruction' | 'generic'

/** 记忆来源：自动捕获 / 显式记忆 */
export type MemorySource = 'auto' | 'explicit'

/** 单条记忆条目 */
export interface MemoryEntry {
  /** 短哈希 id，用于幂等去重 */
  id: string
  kind: MemoryKind
  /** 记忆正文（自然语言） */
  content: string
  /** 标签，便于检索分组 */
  tags: string[]
  source: MemorySource
  /** 来源会话 id（可选） */
  sessionId?: string
  /** 来源工作区（可选），用于会话级隔离 */
  workspace?: string
  /** 创建时间戳（ms） */
  createdAt: number
  /** 最近更新时间戳（ms） */
  updatedAt: number
  /** 访问次数（召回热度） */
  accessCount: number
  /** 最近访问时间（ms，可选） */
  lastAccessAt?: number
}

/** 运行时类型守卫：unknown → MemoryEntry（供存储校验、外部 API 防御） */
export function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  const kind = e['kind']
  return (
    typeof e['id'] === 'string' &&
    typeof kind === 'string' &&
    (kind === 'decision' || kind === 'fact' || kind === 'preference' || kind === 'instruction' || kind === 'generic') &&
    typeof e['content'] === 'string' &&
    Array.isArray(e['tags']) &&
    (e['tags'] as unknown[]).every((t) => typeof t === 'string') &&
    (e['source'] === 'auto' || e['source'] === 'explicit') &&
    typeof e['createdAt'] === 'number' &&
    typeof e['updatedAt'] === 'number' &&
    typeof e['accessCount'] === 'number' &&
    (e['sessionId'] === undefined || typeof e['sessionId'] === 'string') &&
    (e['workspace'] === undefined || typeof e['workspace'] === 'string') &&
    (e['lastAccessAt'] === undefined || typeof e['lastAccessAt'] === 'number')
  )
}

/**
 * 解析一行 JSONL 为 MemoryEntry。
 * 返回 undefined 表示结构非法（调用方按损坏行处理，不抛出）。
 */
export function parseMemoryEntry(line: string): MemoryEntry | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  return toMemoryEntry(value)
}

/** 丢弃未知字段后，把任意对象规整为最小 MemoryEntry 形状（未知字段不保留） */
export function toMemoryEntry(value: unknown): MemoryEntry | undefined {
  if (!isMemoryEntry(value)) return undefined
  const e = value as unknown as Record<string, unknown>
  const out: MemoryEntry = {
    id: e['id'] as string,
    kind: e['kind'] as MemoryKind,
    content: e['content'] as string,
    tags: [...(e['tags'] as string[])],
    source: e['source'] as MemorySource,
    createdAt: e['createdAt'] as number,
    updatedAt: e['updatedAt'] as number,
    accessCount: e['accessCount'] as number,
  }
  if (e['sessionId'] !== undefined) out.sessionId = e['sessionId'] as string
  if (e['workspace'] !== undefined) out.workspace = e['workspace'] as string
  if (e['lastAccessAt'] !== undefined) out.lastAccessAt = e['lastAccessAt'] as number
  return out
}

/** 检索引擎返回的命中结果（score 为拍入时计算） */
export interface MemoryHit extends MemoryEntry {
  score: number
}

/** 存储层读写接口，便于测试注入内存实现 */
export interface MemoryStore {
  /** 写入一条记忆（实现方负责去重/合并） */
  upsert(entry: MemoryEntry): Promise<MemoryEntry>
  /**
   * 批量写入（1.0.0 可选成员）：一次落盘多行，供热度合并回写等高频小写场景
   * 降低系统调用次数；缺省实现可退化为逐个 upsert。返回成功写入数。
   */
  upsertMany?(entries: MemoryEntry[]): Promise<number>
  /** 按 id 删除，返回是否删除成功 */
  remove(id: string): Promise<boolean>
  /** 批量删除，返回实际删除数（0.3.0 新增；缺省实现可退化为逐个 remove） */
  removeMany?(ids: string[]): Promise<number>
  /**
   * 全量遍历。契约（1.0.0 显式化，对应 DESIGN-1.0 疑点 5）：
   * 返回**只读共享视图**，调用方不得修改返回数组或其元素；
   * 需要可变副本时自行拷贝（如 `[...await store.list()]`）。实现在写时置脏重建，
   * 外部持有旧引用并修改不影响存储后续状态（copy-on-write），但违反只读约定
   * 仍可能导致调用方自身数据污染——调用方必须遵守只读契约。
   */
  list(): Promise<MemoryEntry[]>
  /** 按 id 精确读取 */
  get(id: string): Promise<MemoryEntry | undefined>
  /** 批量写入（导入用） */
  importAll(entries: MemoryEntry[]): Promise<number>
  /** 全量导出为 JSON 数组字符串，与 importAll 组成迁移闭环（0.4.0 可选成员） */
  exportAll?(): Promise<string>
  /** 关闭并落盘 */
  close(): Promise<void>
  /** 结构性版本号：任何写入后自增，供调用方做索引/快照缓存失效（0.3.0 可选） */
  readonly revision?: number
  /**
   * 1.0.0：最近一次结构性写入新增的条目（供 IndexCache 增量索引构建复用；
   * 读取后即失效，实现可在下次读前清空或保留同一次写入的数据）。
   */
  lastInserted?: () => MemoryEntry[]
}

/** 检索配置 */
export interface RecallOptions {
  /** 召回上限（token 估算） */
  maxTokens?: number
  /** 召回上限（条数） */
  limit?: number
  /** 按工作区过滤（可选） */
  workspace?: string
  /** 按记忆类型过滤（可选） */
  kind?: MemoryKind
  /** 评分基准时间（默认 Date.now()）；同一基准下可复算 */
  now?: number
  /** 0.5.0：启用编辑距离 ≤1 变体容错检索（默认 true；仅精确零命中时以 0.5 折扣兜底） */
  fuzzy?: boolean
  /** 0.5.0：启用 MinHash 近似语义召回（默认 true；仅词面全零命中时按 Jaccard 阈值兜底） */
  semantic?: boolean
  /** 0.9.0：启用评分时间衰减（默认 true）。false 时「永不过期」语义真正成立——旧记忆与新记忆同分可召（主题 T3 双尺度时间语义） */
  decay?: boolean
  /** 0.9.0：评分衰减半衰期（ms，默认 7 天，见 engine.DECAY_HALF_LIFE_MS）。仅 decay !== false 时生效；与热度半衰期 heatHalfLifeMs 相互独立 */
  decayHalfLifeMs?: number
  /** 0.5.0：热度半衰期（ms，默认 7 天）；控制陈旧高频记忆的冷却速率，用于可复算评分 */
  heatHalfLifeMs?: number
  /** 0.5.0：BM25 参数 k1（默认 1.2）；评估/调参用，缺省保持既有语义 */
  k1?: number
  /** 0.5.0：BM25 参数 b（长度归一化系数，默认 0.75）；评估/调参用 */
  b?: number
  /** 0.5.0：记忆价值感知评分（默认 true）——指令/决策/显式记忆按显著性加权，避免被流水账事实淹没；评估/调参可关闭 */
  significance?: boolean
  /**
   * 1.0.0（DESIGN-1.0 模块 B）：语义线融合模式。
   * - 'interpolate'（默认，与 0.10.0 语义等价）：语义权重按 SEMANTIC_HIT_WEIGHT 线性插值；
   * - 'rrf'：三线（精确/模糊/语义）分别排序后按 Reciprocal Rank Fusion 融合，语义线可与词面线叠加贡献。
   */
  fusionMode?: 'interpolate' | 'rrf'
  /**
   * 1.0.0（DESIGN-1.0 模块 B2）：语义线是否在词面（含模糊）零命中之外也参与叠加（默认 false）。
   * false = 0.10.0 既有语义（仅零命中时兜底，逐字节等价）；true = 语义线与词面线叠加贡献，
   * 提升真实问句召回（eval G3/G6 验证开关开启增益）。
   */
  semanticBoost?: boolean
  /**
   * 1.0.0（DESIGN-1.0 模块 B1，评估网格用）：语义线权重（默认 SEMANTIC_HIT_WEIGHT=0.3）。
   * 仅语义线生效时参与（词面零命中兜底或 semanticBoost 叠加）；G5-1.0 四维网格调参维度。
   */
  semanticWeight?: number
  /** 1.0.0：按主题标签过滤召回（主题见 memory_status themes；可选） */
  theme?: string
  /**
   * 1.0.0（DESIGN-1.0 模块 A）：被取代记忆（tags 含 superseded-by:）的召回分数衰减系数
   * （默认 0.5）；仅对带 superseded-by tag 的旧记忆生效。undefined 时按默认衰减。
   */
  supersededPenalty?: number
  /**
   * 1.1.0（DESIGN-1.1 模块 C）：时序知识图谱召回线。
   * 传入只读图视图（TemporalGraph 实现）且 graphEnabled=true 时，图谱线作为第四召回线
   * 参与融合（rrf 模式按第四条秩 RRF 融合；interpolate 模式按 graphWeight 线性叠加）。
   * 默认 undefined → 图谱线不参与，召回结果与 1.0.0 逐字节一致。
   */
  graph?: GraphRecallSource
  /** 1.1.0：图谱召回线开关（默认 false；仅 graph 已注入且为 true 时启用） */
  graphEnabled?: boolean
  /** 1.1.0：图谱邻域扩展最大跳数（默认 2；仅图谱线启用时生效） */
  graphMaxHop?: number
  /** 1.1.0：图谱线叠加权重（interpolate 模式；默认 GRAPH_LINE_WEIGHT=0.35） */
  graphWeight?: number
}

/**
 * 1.1.0（DESIGN-1.1 模块 C）：图谱召回线只读接口。
 * types.ts 层以接口约束（不依赖 graph.ts，避免类型层循环依赖）；
 * TemporalGraph 结构实现该接口：查询实体邻域扩展拓扑得分 + 实体反查关联条目。
 */
export interface GraphRecallSource {
  /** 查询实体在图中邻域扩展后的拓扑得分（hop 惩罚 × 度数归一累积；纯函数可复算） */
  neighborEntityScores(queryEntities: readonly string[], now: number, maxHop?: number): Map<string, number>
  /** 反查：实体 → 提及该实体的条目 id 集（图谱线计分反查入口） */
  entryIdsByEntity(entity: string): readonly string[]
}

/**
 * 1.1.0（DESIGN-1.1 模块 C）：图谱写入侧最小接口。
 * 供 ingestCaptured / memory_store / importer 钩子注入（不依赖 TemporalGraph 具体类，
 * 保持管道层纯逻辑可单测）；TemporalGraph 结构兼容（add/remove 均有实现）。
 */
export interface GraphWriteSink {
  /** 增量写入条目（抽取三元组建边；superseded-by 条目的边标记失效时间线） */
  add(entry: MemoryEntry): unknown
  /** 软删除：移除条目在边上的引用；无引用边标记失效（asOf 时间线保留） */
  remove(entryId: string, now?: number): unknown
}

/** 记忆统计（byKind 为全量键、0 填充，对齐 schema 可预测性） */
export interface MemoryStats {
  total: number
  byKind: Record<MemoryKind, number>
  bySource: Record<MemorySource, number>
  bytes: number
  oldestAt?: number
  newestAt?: number
  /** 1.0.0：被取代记忆数（tags 含 superseded-by:，DESIGN-1.0 模块 A） */
  superseded?: number
  /** 1.0.0：主题数（仅 status 按需计算；absent = 未计算） */
  themes?: number
}
