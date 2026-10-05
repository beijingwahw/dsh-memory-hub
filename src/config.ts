/**
 * dsh-memory-hub 配置 Schema
 *
 * 使用 Cordis 生态的 schemastery 描述配置，插件在 cordis.patch.yml 中被安装后，
 * 用户可以通过 settings / profile patch 覆盖这些键。
 */
import Schema from '@deepseek-ai/schemastery'

/** 自动捕获的保守程度 */
export type CaptureMode = 'conservative' | 'balanced' | 'aggressive' | 'off'

/** 0.6.0：真实数据导入源（可选；未配置则插件行为与 0.5.0 完全一致） */
export interface ImportSources {
  /** Markdown / 纯文本记忆文件路径（AGENTS.md、MEMORY.md、USER.md 等），启动时导入为显式记忆 */
  documents?: string[]
  /** Harness 会话事件 JSONL 日志路径，启动时导入为自动记忆 */
  sessionLogs?: string[]
}

export interface MemoryHubConfig {
  /** 记忆存储目录（默认 ~/.dsh/memory-hub） */
  storageDir: string
  /** 单条记忆最大字符数 */
  maxEntryChars: number
  /** 召回默认 token 预算 */
  defaultRecallTokens: number
  /** 召回默认条数上限 */
  defaultRecallLimit: number
  /** 自动捕获模式（conservative/balanced/aggressive/off） */
  captureMode: CaptureMode
  /** 自动捕获时同上：是否把摘要写入 tags */
  autoTags: boolean
  /** 同一内容去重的时间窗口（ms）内视为重复 */
  dedupWindowMs: number
  /** 记忆过期天数（0 表示永不过期） */
  ttlDays: number
  /** 0.9.0：召回评分时间衰减半衰期天数（0 = 关闭评分衰减，与 ttlDays=0「永不过期」哲学一致；>0 按天指数冷却） */
  recallDecayHalfLifeDays: number
  /** 0.6.0：真实数据导入源（可选；缺失时行为与 0.5.0 完全一致） */
  importSources?: ImportSources
  /**
   * 1.0.0：被取代记忆识别（DESIGN-1.0 模块 A）。
   * 'off'（默认，零行为变化）：不识别取代关系；
   * 'auto'：写入显式/导入记忆时检测语义对立信号（改用/升级到/instead of 等词面），
   *   给新记忆打 supersede:<旧id>、旧记忆打 superseded-by:<新id>，召回时被取代记忆降权。
   */
  supersedeMode: 'off' | 'auto'
  /**
   * 1.0.0：语义线叠加融合（DESIGN-1.0 模块 B）。
   * false（默认）：语义线仅在词面（含模糊）零命中时兜底 = 0.10.0 既有语义；
   * true：语义线与词面线叠加贡献（fusionMode='rrf' 时按 RRF 融合），提升真实问句召回。
   */
  semanticBoost: boolean
  /** 1.0.0：语义线融合模式（默认 interpolate = 线性插值；rrf = Reciprocal Rank Fusion） */
  fusionMode: 'interpolate' | 'rrf'
  /** 1.0.0：记忆库条目上限（0 = 不限，默认）；超出时按价值分淘汰最低分非 instruction 记忆（需 autoEvict 开启） */
  maxEntries: number
  /** 1.0.0：是否启用价值感知自动淘汰（默认 false；仅在 maxEntries>0 且超出时生效，instruction 永不自动淘汰） */
  autoEvict: boolean
  /** 1.0.0：是否在 status/recall 输出主题聚类视图（默认 false，避免额外计算开销） */
  themes: boolean
  /**
   * 1.1.0：记忆层次蒸馏（DESIGN-1.1 模块 A）。
   * 'off'（默认，零行为变化）：不蒸馏；
   * 'auto'：空闲批处理把零散事实聚类蒸馏为抽象/程序性条目（distilled-layer 协议）。
   */
  distillMode: 'off' | 'auto'
  /**
   * 1.1.0：认知巩固与遗忘曲线（DESIGN-1.1 模块 B）。
   * 'off'（默认，零行为变化）：不巩固；
   * 'auto'：空闲窗口按 Ebbinghaus 遗忘曲线对到期高价值记忆执行巩固复习（仅更新访问历史）。
   */
  consolidationMode: 'off' | 'auto'
  /**
   * 1.1.0：时序知识图谱召回线（DESIGN-1.1 模块 C）。
   * false（默认，零行为变化）：图谱线不参与融合；
   * true：图谱作为第四召回线（邻域扩展 × 时效），配合 memory_recall graphEnabled 参数。
   */
  graphEnabled: boolean
  /**
   * 1.1.0：信念修正与矛盾共存（DESIGN-1.1 模块 D）。
   * 'off'（默认，零行为变化）：不识别矛盾；
   * 'auto'：写入时对「疑似反转 + 相近不可判取代」的旧条目建立 conflicts-with/conflict-of 双向标注。
   */
  conflictMode: 'off' | 'auto'
  /** 1.1.0：图谱实体上限（默认 2000；超限按时间戳淘汰最旧边，LRU 语义） */
  graphMaxEntities: number
  /** 1.1.0：蒸馏最小簇成员数（默认 3；低于该值的簇不产出，防单例噪音） */
  distillMinCluster: number
  /** 1.1.0：巩固可召回率阈值（默认 0.4；R(t) 低于该值且高价值 → 到期入巩固队列） */
  recallThreshold: number
}

export const defaultConfig: MemoryHubConfig = {
  storageDir: '',
  maxEntryChars: 1000,
  defaultRecallTokens: 800,
  defaultRecallLimit: 8,
  captureMode: 'balanced',
  autoTags: true,
  dedupWindowMs: 24 * 60 * 60 * 1000, // 24h
  ttlDays: 0, // 永不过期（由用户显式开启清理）
  recallDecayHalfLifeDays: 0, // 0.9.0：默认关闭评分时间衰减——长期记忆真正可召回（Q 薄弱项修复）
  importSources: { documents: [], sessionLogs: [] }, // 0.6.0：默认不导入任何真实数据（行为与 0.5.0 完全一致）
  supersedeMode: 'off', // 1.0.0：默认不识别取代关系（零行为变化；auto 开启后新记忆识别对立信号）
  semanticBoost: false, // 1.0.0：默认语义线仅零命中兜底 = 0.10.0 语义
  fusionMode: 'interpolate', // 1.0.0：默认线性插值融合
  maxEntries: 0, // 1.0.0：默认不设上限
  autoEvict: false, // 1.0.0：默认不自动淘汰
  themes: false, // 1.0.0：默认不计算主题视图
  distillMode: 'off', // 1.1.0：默认不蒸馏（零行为变化）
  consolidationMode: 'off', // 1.1.0：默认不巩固（零行为变化）
  graphEnabled: false, // 1.1.0：默认图谱线不参与召回（零行为变化）
  conflictMode: 'off', // 1.1.0：默认不识别矛盾（零行为变化）
  graphMaxEntities: 2000, // 1.1.0：图谱实体上限
  distillMinCluster: 3, // 1.1.0：蒸馏最小簇成员数
  recallThreshold: 0.4, // 1.1.0：巩固可召回率阈值
}

/** schemastery Schema：供 Cordis 配置系统生成配置面板与校验 */
export const MemoryHubConfigSchema: Schema<MemoryHubConfig> = Schema.object({
  storageDir: Schema.string()
    .description('记忆存储目录（留空则使用 ~/.dsh/memory-hub）')
    .default(defaultConfig.storageDir),
  maxEntryChars: Schema.number()
    .description('单条记忆最大字符数')
    .min(10)
    .max(10000)
    .default(defaultConfig.maxEntryChars),
  defaultRecallTokens: Schema.number()
    .description('memory_recall 默认 token 预算')
    .min(100)
    .max(100000)
    .default(defaultConfig.defaultRecallTokens),
  defaultRecallLimit: Schema.number()
    .description('memory_recall 默认条数上限')
    .min(1)
    .max(100)
    .default(defaultConfig.defaultRecallLimit),
  captureMode: Schema.union([
    Schema.const('off').description('关闭自动捕获'),
    Schema.const('conservative').description('仅捕获高置信规则'),
    Schema.const('balanced').description('平衡模式（默认）'),
    Schema.const('aggressive').description('激进捕获，更多入库'),
  ])
    .description('自动捕获模式')
    .default(defaultConfig.captureMode),
  autoTags: Schema.boolean().description('自动为捕获内容打标签').default(defaultConfig.autoTags),
  dedupWindowMs: Schema.number().description('去重时间窗口（ms）').min(0).default(defaultConfig.dedupWindowMs),
  ttlDays: Schema.number().description('记忆过期天数（0 永不过期）').min(0).default(defaultConfig.ttlDays),
  recallDecayHalfLifeDays: Schema.number()
    .description('召回评分时间衰减半衰期天数（0 关闭衰减 = 长期记忆可召回；>0 按天指数冷却）')
    .min(0)
    .default(defaultConfig.recallDecayHalfLifeDays),
  importSources: Schema.object({
    documents: Schema.array(Schema.string())
      .description('Markdown/纯文本记忆文件路径（AGENTS.md、MEMORY.md、USER.md 等）')
      .default([]),
    sessionLogs: Schema.array(Schema.string()).description('Harness 会话事件 JSONL 日志路径').default([]),
  })
    .description('0.6.0：真实数据导入源（未配置则插件行为与 0.5.0 完全一致）')
    .default({ documents: [], sessionLogs: [] }),
  supersedeMode: Schema.union([
    Schema.const('off').description('不识别取代关系（默认，零行为变化）'),
    Schema.const('auto').description('自动识别语义对立信号，新记忆取代旧记忆'),
  ])
    .description('1.0.0：被取代记忆识别（DESIGN-1.0 模块 A）')
    .default(defaultConfig.supersedeMode),
  semanticBoost: Schema.boolean()
    .description('1.0.0：语义线与词面线叠加融合（默认 false = 0.10.0 兜底语义；true 提升真实问句召回）')
    .default(defaultConfig.semanticBoost),
  fusionMode: Schema.union([
    Schema.const('interpolate').description('线性插值融合（默认）'),
    Schema.const('rrf').description('Reciprocal Rank Fusion 融合'),
  ])
    .description('1.0.0：语义线融合模式')
    .default(defaultConfig.fusionMode),
  maxEntries: Schema.number()
    .description('1.0.0：记忆库条目上限（0 = 不限；超出时结合 autoEvict 按价值淘汰）')
    .min(0)
    .default(defaultConfig.maxEntries),
  autoEvict: Schema.boolean()
    .description('1.0.0：价值感知自动淘汰（默认 false；仅 maxEntries>0 且超出时生效，instruction 永不自动淘汰）')
    .default(defaultConfig.autoEvict),
  themes: Schema.boolean()
    .description('1.0.0：status/recall 输出主题聚类视图（默认 false）')
    .default(defaultConfig.themes),
  distillMode: Schema.union([
    Schema.const('off').description('不蒸馏（默认，零行为变化）'),
    Schema.const('auto').description('空闲批处理蒸馏零散事实为抽象/程序性条目'),
  ])
    .description('1.1.0：记忆层次蒸馏（DESIGN-1.1 模块 A）')
    .default(defaultConfig.distillMode),
  consolidationMode: Schema.union([
    Schema.const('off').description('不巩固（默认，零行为变化）'),
    Schema.const('auto').description('按遗忘曲线巩固到期高价值记忆'),
  ])
    .description('1.1.0：认知巩固与遗忘曲线（DESIGN-1.1 模块 B）')
    .default(defaultConfig.consolidationMode),
  graphEnabled: Schema.boolean()
    .description('1.1.0：时序知识图谱第四召回线（默认 false；true 时图谱线参与融合）')
    .default(defaultConfig.graphEnabled),
  conflictMode: Schema.union([
    Schema.const('off').description('不识别矛盾（默认，零行为变化）'),
    Schema.const('auto').description('疑似反转 + 相近不可判取代 → 双向矛盾共存标注'),
  ])
    .description('1.1.0：信念修正与矛盾共存（DESIGN-1.1 模块 D）')
    .default(defaultConfig.conflictMode),
  graphMaxEntities: Schema.number()
    .description('1.1.0：图谱实体上限（超限按时间戳淘汰最旧边）')
    .min(10)
    .max(100000)
    .default(defaultConfig.graphMaxEntities),
  distillMinCluster: Schema.number()
    .description('1.1.0：蒸馏最小簇成员数（低于该值的簇不产出）')
    .min(2)
    .max(20)
    .default(defaultConfig.distillMinCluster),
  recallThreshold: Schema.number()
    .description('1.1.0：巩固可召回率阈值（R(t) 低于该值且高价值 → 到期）')
    .min(0)
    .max(1)
    .default(defaultConfig.recallThreshold),
})

/** 解析用户配置，回填默认值 */
export function normalizeConfig(partial: Partial<MemoryHubConfig> = {}): MemoryHubConfig {
  return { ...defaultConfig, ...partial }
}
