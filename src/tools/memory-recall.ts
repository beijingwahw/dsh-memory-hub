/**
 * memory_recall 工具：按语义/关键词召回相关记忆。
 * 新会话开始、遇到与历史主题相关的问题时调用，避免重复询问与重复交代。
 */
import type { InferArgs } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ErrorCodes, MemoryHubError, errorMessage } from '../errors'
import { buildGraph, GRAPH_DEFAULT_MAX_ENTITIES } from '../memory/graph'
import { conflictAwareOrder, conflictPeerIds } from '../memory/conflict'
import { expandDistilled, isDistilled } from '../memory/distill'
import { isSuperseded, IndexCache, estimateTokens, recall } from '../memory/engine'
import type { HubMetrics } from '../memory/metrics'
import { buildVectorIndex, VectorIndexCache } from '../memory/vector'
import type { GraphRecallSource, MemoryEntry, MemoryStore, RecallOptions } from '../memory/types'

export const memoryRecallParams = {
  query: { type: 'string', required: true, description: '检索关键词或问题描述' },
  maxTokens: { type: 'number', description: '召回结果 token 预算上限（默认 800）' },
  limit: { type: 'number', description: '返回条数上限（默认 8）' },
  workspace: { type: 'string', description: '只召回指定工作区的记忆' },
  kind: {
    type: 'string',
    enum: ['decision', 'fact', 'preference', 'instruction', 'generic'],
    description: '只召回指定类型的记忆（decision/fact/preference/instruction/generic）',
  },
  // 1.0.0（DESIGN-1.0 模块 B2）：召回融合与过滤开关（可选；缺省用 config 默认）
  fusionMode: {
    type: 'string',
    enum: ['interpolate', 'rrf'],
    description: '语义线融合模式（interpolate=线性插值 / rrf=Reciprocal Rank Fusion；默认 interpolate）',
  },
  semanticBoost: {
    type: 'boolean',
    description: '语义线是否与词面线叠加贡献（默认 false = 仅词面零命中时语义兜底）',
  },
  theme: { type: 'string', description: '只召回指定主题的记忆（memory_status themes 中的主题标签）' },
  supersededPenalty: { type: 'number', description: '被取代记忆的召回降权系数（默认 0.5，1 = 不降权）' },
  // 1.1.0（DESIGN-1.1 模块 A3）：蒸馏命中向下展开源记忆证据链（可选；缺省不展开，输出与 1.0.0 逐字节一致）
  expand: {
    type: 'boolean',
    description: '蒸馏条目命中时向下展开源记忆（hits[].expanded 可选字段，含蒸馏来源内容）',
  },
  // 1.1.0（DESIGN-1.1 模块 C2）：图谱第四召回线显式开关（可选；需插件 graphEnabled 配置并注入图谱运行时）
  graphEnabled: {
    type: 'boolean',
    description: '启用时序知识图谱第四召回线（与词面/容错/语义三线融合；默认取插件配置，未开启时不生效）',
  },
  // 1.1.0（DESIGN-1.1 模块 B2）：显式巩固开关（可选；缺省保持 1.0.0 热度更新行为）
  reinforce: {
    type: 'boolean',
    description: 'true = 显式巩固命中记忆（模拟成功召回，更新访问历史）；false = 只读查看，不更新热度',
  },
  // 1.1.0（模块 C3）→ 1.3.0（DESIGN-1.3 模块 G）情景回放：从「图谱时间线回放」升维为
  // 「记忆库全量时序回放」——按该时刻的条目存在性/内容版本/取代与矛盾标注/访问热度
  // （JSONL 日志逐行回放）+ 图谱时间线（含 occurredAt 未到的边不穿越）+ 评分基准召回。
  asOf: {
    type: 'number',
    description:
      '情景回放时间戳（ms）：回到该时刻召回——只含当时存在的记忆、当时的内容版本与取代/矛盾状态；只读回放不更新热度',
  },
  // 1.2.0（DESIGN-1.2 模块 E）：激活扩散推理第五召回线显式开关（可选；需插件 inferEnabled 配置或图谱注入）
  infer: {
    type: 'boolean',
    description: '启用激活扩散推理第五召回线（沿图谱关系多跳推理，链证据可解释；默认取插件配置 inferEnabled）',
  },
  // 1.2.0（DESIGN-1.2 模块 F）：召回溯源（可选；缺省不输出，形状与 1.1.1 一致）
  explain: {
    type: 'boolean',
    description: '输出每条命中的召回溯源 why 字段（参与融合的召回线 / 各线贡献 / 权重因子 / 同源最终分）',
  },
  // 1.5.0（DESIGN-1.5 模块 M）：本地向量第六召回线显式开关（可选；缺省取插件配置 vectorEnabled）
  vector: {
    type: 'boolean',
    description:
      '启用本地 HNSW 向量第六召回线（零依赖近似最近邻——同特征空间 TF·IDF 余弦，与五线 RRF/插值融合；默认取插件配置 vectorEnabled）',
  },
} as const

export type MemoryRecallArgs = InferArgs<typeof memoryRecallParams>

/** memory_recall 输出契约：execute 返回与 output.schema 共用同一形状（0.8.0 消除重复内联类型） */
export interface RecallOutput {
  hits: {
    id: string
    kind: string
    content: string
    tags: string[]
    score: number
    superseded?: boolean
    // 1.1.0（DESIGN-1.1 模块 D3）：与命中条目构成矛盾共存的对方条目 id（仅冲突标注存在时输出）
    conflicts?: string[]
    // 1.1.0（DESIGN-1.1 模块 A3）：蒸馏条目向下展开的源记忆（仅 expand=true 且命中蒸馏条目时输出）
    expanded?: MemoryEntry[]
    // 1.2.0（DESIGN-1.2 模块 F）：召回溯源（仅 explain=true 时输出；缺省不产生）
    why?: {
      fusion: string
      lines: Array<{ line: string; value: number }>
      lineBase: number
      score: number
      // 1.3.0（DESIGN-1.3 模块 H）：推理证据链（仅 why 含 infer 线时输出；至多 3 条）
      chains?: Array<{
        path: Array<{ from: string; relation: string; to: string; confidence: number; occurredAt: number }>
        terminal: string
        score: number
      }>
    }
  }[]
  total: number
  usedTokens: number
}

/**
 * 热度更新：显式 pick MemoryEntry 契约字段重建条目
 * （不含 RecallHit 的 score 等派生字段），杜绝把 score 写进持久化存储。
 */
function bumped(entry: MemoryEntry, now = Date.now()): MemoryEntry {
  const out: MemoryEntry = {
    id: entry.id,
    kind: entry.kind,
    content: entry.content,
    tags: [...entry.tags],
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    accessCount: entry.accessCount + 1,
    lastAccessAt: now,
  }
  if (entry.sessionId !== undefined) out.sessionId = entry.sessionId
  if (entry.workspace !== undefined) out.workspace = entry.workspace
  return out
}

export function createMemoryRecallTool(
  store: MemoryStore,
  defaultTokens: number,
  defaultLimit: number,
  logger?: (msg: string) => void,
  metrics?: HubMetrics,
  recallOverrides?: Readonly<Pick<RecallOptions, 'decay' | 'decayHalfLifeMs'>>,
  recallDefaults?: Readonly<
    Pick<
      RecallOptions,
      'fusionMode' | 'semanticBoost' | 'graphEnabled' | 'inferEnabled' | 'inferMaxHops' | 'vectorEnabled'
    >
  >,
  // 1.1.0（DESIGN-1.1 模块 C2）：图谱运行时注入（入口构建 TemporalGraph；未注入时 graphEnabled 参数不生效）
  graph?: GraphRecallSource,
  // 1.3.0（DESIGN-1.3 模块 G）：图谱实体上限（情景回放重建 T 时刻图视图用；缺省 GRAPH_DEFAULT_MAX_ENTITIES）
  graphMaxEntities?: number,
) {
  // 索引缓存：按 store.revision 复用倒排索引，语料未变时召回免全量重建
  const indexCache = new IndexCache()
  // 1.5.0（DESIGN-1.5 模块 M）：向量索引缓存——按 (revision, 内容指纹) 复用 HNSW 索引
  //（构建 O(N·efConstruct) 远贵于查询；语料未变时不重建，与 IndexCache 同失效语义）
  const vectorCache = new VectorIndexCache()
  // 0.9.0 N：热度合并回写（coalesced heat flush）——
  // 同一 id 在 flush 窗口内多次 recall 只写一次（抗刷，杜绝 JSONL 行数随命中次数膨胀）；
  // flush 错误上浮 metrics.errors + logger（0.8.0 的 allSettled 静默吞错问题修复）。
  const heatDirty = new Map<string, MemoryEntry>()
  let heatChain: Promise<void> = Promise.resolve()

  function scheduleHeatFlush(): void {
    heatChain = heatChain.then(async () => {
      try {
        if (heatDirty.size === 0) return
        const batch = [...heatDirty.values()]
        heatDirty.clear()
        // 1.1.1：批量回写迁移到 store.upsertMany——该 API 的文档明确写着「热度合并回写等
        // 高频小写场景」（单次 appendRaw 落盘多行 + 单次 version++）。此前的逐条 upsert
        // 是 N-1 次多余系统调用 + N-1 次 revision 递增，后者还放大 IndexCache 的全量
        // 指纹重算成本。接口可选（部分测试 fakeStore 未实现），能力探测回退逐条路径。
        if (typeof store.upsertMany === 'function') {
          await store.upsertMany(batch)
        } else {
          const settled = await Promise.allSettled(batch.map((e) => store.upsert(e)))
          for (const r of settled) {
            if (r.status === 'rejected') {
              if (metrics) metrics.errors++
              logger?.(`heat flush failed: ${errorMessage(r.reason)}`)
            }
          }
        }
      } catch (err) {
        if (metrics) metrics.errors++
        logger?.(`heat flush failed: ${errorMessage(err)}`)
      }
    })
  }
  return defineTool({
    name: 'memory_recall',
    description:
      'Recalls relevant memories from previous sessions by query. Call this at the start of a new session or when the user asks about something that may have been discussed before. Returns scored memory hits with kind, content, and tags.',
    parameters: memoryRecallParams,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                content: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
                superseded: { type: 'boolean', description: '1.0.0：是否已被更新版本取代（supersede 协议标记）' },
                conflicts: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '1.1.0：与命中条目构成矛盾共存的对方条目 id（仅冲突标注存在时输出）',
                },
                expanded: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      kind: { type: 'string' },
                      content: { type: 'string' },
                      tags: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  description: '1.1.0：蒸馏条目向下展开的源记忆（仅 expand=true 且命中蒸馏条目时输出）',
                },
                why: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    fusion: { type: 'string', description: '融合模式（interpolate/rrf）' },
                    lines: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          line: { type: 'string', description: '召回线（bm25/fuzzy/semantic/graph/infer/vector）' },
                          value: {
                            type: 'number',
                            description: '该线贡献（interpolate=加权项系数；rrf=倒数秩贡献 1/(60+rank)）',
                          },
                        },
                      },
                      description: '实际参与融合的召回线及贡献（召回线固定序）',
                    },
                    lineBase: { type: 'number', description: '公共权重因子 decay×heat×significance×supersededFactor' },
                    score: { type: 'number', description: '最终分（与 hits[].score 同源，非重算）' },
                    chains: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          path: {
                            type: 'array',
                            items: {
                              type: 'object',
                              additionalProperties: false,
                              properties: {
                                from: { type: 'string', description: '起点实体' },
                                relation: { type: 'string', description: '关系词' },
                                to: { type: 'string', description: '终点实体' },
                                confidence: { type: 'number', description: '关系置信度 ∈(0,1]' },
                                occurredAt: { type: 'number', description: '关系发生时刻（ms）' },
                              },
                            },
                            description: '证据路径（A—使用→B—依赖→C；path[0].from 为查询种子实体）',
                          },
                          terminal: { type: 'string', description: '终结实体（关联到本命中条目）' },
                          score: { type: 'number', description: '链强度（∏置信度 × 跳衰减 × 保守时效）' },
                        },
                      },
                      description: '1.3.0：支撑该命中的推理证据链（仅 infer 线参与融合时输出，至多 3 条）',
                    },
                  },
                  description: '1.2.0：召回溯源（仅 explain=true 时输出）',
                },
              },
            },
          },
          total: { type: 'number' },
          usedTokens: { type: 'number' },
        },
      },
      render: (args, value) => {
        const hits = value.hits ?? []
        // 1.3.0（DESIGN-1.3 模块 G）：情景回放标注（仅 asOf 参数存在时前缀时刻，缺省逐字节不变）
        const asOfNote =
          typeof args.asOf === 'number' && Number.isFinite(args.asOf) && args.asOf > 0
            ? ` @${new Date(args.asOf).toISOString()}`
            : ''
        return [
          {
            type: 'text',
            text: hits.length
              ? `[memory recall${asOfNote}] ${hits.length} hit(s), ${value.usedTokens ?? 0} tokens:\n` +
                hits
                  .map((h) => {
                    const flag = h.superseded === true ? '（已被更新版本取代）' : ''
                    // 1.1.0（模块 D3）：冲突并存显式标注（渲染仅在有冲突标注时追加，缺省逐字节不变）
                    const conflictNote =
                      Array.isArray(h.conflicts) && h.conflicts.length > 0
                        ? `（与 ${h.conflicts.join(', ')} 存在时间线矛盾，双方并存）`
                        : ''
                    // 1.1.0（模块 A3）：蒸馏展开的证据链（渲染仅在 expand 产出时追加）
                    const expandedNote =
                      Array.isArray(h.expanded) && h.expanded.length > 0
                        ? `\n    ↳ 展开源记忆：${h.expanded.map((e) => e.content).join('；')}`
                        : ''
                    // 1.2.0（DESIGN-1.2 模块 F）：召回溯源（渲染仅在 explain 产出 why 时追加；
                    // 各线贡献保留 4 位有效数字，人读友好且不暴露全精度浮点噪声）
                    // 1.3.0（模块 H）：推理证据链回放（A —使用→ B —依赖→ C (强度)），
                    // 仅 why.chains 存在时追加，至多渲染 2 条
                    const chainNote =
                      h.why !== undefined && Array.isArray(h.why.chains) && h.why.chains.length > 0
                        ? `（推理: ${h.why.chains
                            .slice(0, 2)
                            .map(
                              (c) =>
                                `${(c?.path ?? [])
                                  .map((e) => `${e?.from ?? ''} —${e?.relation ?? ''}→ ${e?.to ?? ''}`)
                                  .join('')} (${Number((c?.score ?? 0).toPrecision(2))})`,
                            )
                            .join('；')}）`
                        : ''
                    const whyNote =
                      h.why !== undefined
                        ? `（溯源: ${h.why.fusion} ← ${(h.why.lines ?? [])
                            .map((l) => `${l?.line}=${Number((l?.value ?? 0).toPrecision(4))}`)
                            .join(' + ')}）${chainNote}`
                        : ''
                    return `- (${h.kind}) ${h.content}${flag}${conflictNote}${whyNote}${expandedNote}`
                  })
                  .join('\n')
              : '[memory recall] no relevant memories found.',
          },
        ]
      },
    },
    async execute(args): Promise<RecallOutput> {
      const query = args.query.trim()
      if (!query) throw new MemoryHubError(ErrorCodes.EMPTY_CONTENT, 'query must not be empty')
      // 1.1.1：数值参数防御性钳制——此前 limit:0/负数 → 永远返回空（静默）；
      // 负 supersededPenalty → 被取代条目 score 变负被「静默剔除」（与降权语义相反）；
      // 巨值 maxTokens → 无上限输出。与 config 侧 Schema 边界同构（两层防御）。
      const clamp = (v: number | undefined, min: number, max: number, fallback: number): number =>
        v === undefined || !Number.isFinite(v) ? fallback : Math.max(min, Math.min(max, v))
      const clampedAsOf = args.asOf !== undefined && Number.isFinite(args.asOf) && args.asOf > 0 ? args.asOf : undefined
      // 1.3.0（DESIGN-1.3 模块 G）：情景回放——asOf 存在时语料不再是「当前快照」而是
      // 「该时刻的精确知识状态」：支持回放的存储（JSONL append-only）逐行回放日志；
      // 不支持 listAsOf 的实现降级为 createdAt 过滤（存在性近似，无内容版本回溯）。
      // 回放语料与当前库不同，不能进 IndexCache（会驱逐热缓存的当前语料指纹）——
      // 直接走 engine.recall 全量构建（时序回放是低频操作，O(N) 构建可接受）。
      const replaying = clampedAsOf !== undefined
      const asOfTime = clampedAsOf ?? Date.now()
      const entries = replaying
        ? typeof store.listAsOf === 'function'
          ? await store.listAsOf(asOfTime)
          : (await store.list()).filter((e) => e.createdAt <= asOfTime)
        : await store.list()
      const options: RecallOptions = {
        maxTokens: clamp(args.maxTokens, 100, 100000, defaultTokens),
        limit: Math.round(clamp(args.limit, 1, 100, defaultLimit)),
        ...(args.supersededPenalty !== undefined && Number.isFinite(args.supersededPenalty)
          ? { supersededPenalty: Math.max(0, Math.min(1, args.supersededPenalty)) }
          : {}),
        ...(clampedAsOf !== undefined ? { now: clampedAsOf } : {}),
        // 0.9.0：可配置时间衰减（双尺度时间语义）——插件入口按 config.recallDecayHalfLifeDays 注入
        ...(recallOverrides ?? {}),
        // 1.0.0（模块 B2）：融合模式与语义叠加默认由 config 注入，参数显式传入时覆盖
        ...(recallDefaults ?? {}),
      }
      if (args.workspace !== undefined) options.workspace = args.workspace
      // 0.9.0 A'：非法 kind 由 schema enum 前置拦截（与 memory_store 同形态 ToolArgsError），
      // 手工校验分支删除——0.8.0 用 EMPTY_CONTENT 码包装 kind 错误属错误码误用
      if (args.kind !== undefined) options.kind = args.kind
      // 1.0.0（模块 B2/模块 A1）：显式参数覆盖默认值
      if (args.fusionMode !== undefined) options.fusionMode = args.fusionMode
      if (args.semanticBoost !== undefined) options.semanticBoost = args.semanticBoost
      if (args.theme !== undefined) options.theme = args.theme
      // 1.1.1：supersededPenalty 已在 options 初始化处钳制到 [0,1]，此处不再覆盖
      // 1.1.0（模块 C2）+ 1.1.1 修复：图谱第四召回线——入口注入 graph 且（参数显式传入
      // 或 config graphEnabled=true 经 recallDefaults 注入）时生效。原实现只认
      // args.graphEnabled === true，配置开关实际上从不生效（参数描述「默认取插件配置」
      // 与实现不符）；显式传参仍可逐次覆盖配置默认。
      if (graph !== undefined) {
        // 1.3.0（DESIGN-1.3 模块 G）：情景回放时图谱按**回放语料**全量重建——T 时刻的
        // 精确图视图（未来条目的边不存在；取代/复活状态即 T 时刻快照；运行时图的
        // occurredAt 会被取代标记回写推高，深回放下不可靠——见 graph.ts 注释）。
        // 缺省（无 asOf）沿用运行时图（当前视图），行为与 1.2.0 逐字节一致。
        options.graph = replaying ? buildGraph(entries, graphMaxEntities ?? GRAPH_DEFAULT_MAX_ENTITIES) : graph
        if (args.graphEnabled !== undefined) options.graphEnabled = args.graphEnabled
        else if (recallDefaults?.graphEnabled === true) options.graphEnabled = true
        // 1.2.0（DESIGN-1.2 模块 E）：推理线开关——与 graphEnabled 同形态（参数显式传入
        // 覆盖配置默认；缺省回落 config.inferEnabled 经 recallDefaults 注入）
        if (args.infer !== undefined) options.inferEnabled = args.infer
        else if (recallDefaults?.inferEnabled === true) options.inferEnabled = true
        if (recallDefaults?.inferMaxHops !== undefined) options.inferMaxHops = recallDefaults.inferMaxHops
      }
      // 1.2.0（DESIGN-1.2 模块 F）：召回溯源开关（纯读侧注记，缺省不产生 why 字段）
      if (args.explain === true) options.explain = true
      // 1.5.0（DESIGN-1.5 模块 M）：向量第六召回线——参数显式传入覆盖配置默认（与
      // infer 同形态）；启用时注入向量源（回放语料一次性现建，当前语料走缓存复用）。
      const vectorOn = args.vector !== undefined ? args.vector : recallDefaults?.vectorEnabled === true
      if (vectorOn) {
        options.vector = replaying ? buildVectorIndex(entries) : vectorCache.acquire(entries, store.revision)
        options.vectorEnabled = true
      }
      // 1.1.0（模块 C3）→ 1.3.0（模块 G）：情景回放——asOf（已钳校）已作为 options.now 注入，
      // 语料为回放快照；缓存路径仅用于当前语料（回放语料绕过，见 entries 装配处）
      // 1.1.0（模块 B2）：reinforce=false 显式只读（查看不强化）；缺省/true 保持 1.0.0 热度更新
      const readOnly = clampedAsOf !== undefined || args.reinforce === false
      const hits = replaying
        ? recall(entries, query, options)
        : indexCache.query(entries, store.revision, query, options)
      // 1.1.0（模块 D3）：矛盾共存排序——冲突对双方都保留（不剔除），新者优先稳定重排；
      // 无冲突标注时稳定保持原序（缺省零行为变化）
      const byId = new Map(entries.map((e) => [e.id, e]))
      const ordered = conflictAwareOrder(hits, byId)
      // 0.9.0 N：热度更新改为合并回写（同 id 抗刷；异步 flush 不阻塞响应；错误上浮 metrics/日志）；
      // 1.1.0：时间线回放 / reinforce=false 为只读，不写热度（查看不污染状态）
      if (!readOnly) {
        for (const h of ordered) heatDirty.set(h.id, bumped(h))
        scheduleHeatFlush()
      }
      if (metrics) {
        metrics.recallCalls++
        metrics.recallHits += ordered.length
        // 1.3.0（DESIGN-1.3 模块 G）：情景回放调用计数（时序回放使用度量）
        if (clampedAsOf !== undefined) metrics.asOfRecalls = (metrics.asOfRecalls ?? 0) + 1
        // 1.0.0：RRF/语义叠加生效时计数（模块 D 可观测性——融合模式实际产出命中数）
        if (options.fusionMode === 'rrf' || options.semanticBoost === true) {
          metrics.fusionHits = (metrics.fusionHits ?? 0) + ordered.length
        }
        // 1.1.0（模块 C4）：图谱线启用时召回命中计数（图线生效观测；缺省不计数）
        if (options.graphEnabled === true) metrics.graphHits = (metrics.graphHits ?? 0) + ordered.length
        // 1.2.0（DESIGN-1.2 模块 E4）：推理线启用时召回命中计数（推理线生效观测）
        if (options.inferEnabled === true) metrics.inferHits = (metrics.inferHits ?? 0) + ordered.length
        // 1.5.0（DESIGN-1.5 模块 M4）：向量线启用时召回命中计数（向量线生效观测）
        if (options.vectorEnabled === true) metrics.vectorHits = (metrics.vectorHits ?? 0) + ordered.length
      }
      const usedTokens = ordered.reduce((acc, h) => acc + estimateTokens(`${h.kind} ${h.content}`), 0)
      logger?.(`[dsh-memory-hub] recall "${args.query}" -> ${ordered.length} hit(s)`)
      return {
        hits: ordered.map((h) => {
          const out: RecallOutput['hits'][number] = {
            id: h.id,
            kind: h.kind,
            content: h.content,
            tags: h.tags,
            score: h.score,
            // 1.0.0（模块 A1）：被取代记忆标记——渲染层显示「已被新版本取代」，供 Agent 判断是否仍需引用
            superseded: isSuperseded(h),
          }
          // 1.1.0（模块 D3）：冲突并存显式标注（对方 id 列表）
          const peers = conflictPeerIds(h)
          if (peers.length > 0) out.conflicts = peers
          // 1.1.0（模块 A3）：蒸馏命中向下展开源记忆证据链（无效源自动跳过）
          if (args.expand === true && isDistilled(h)) out.expanded = expandDistilled(h, byId)
          // 1.2.0（DESIGN-1.2 模块 F）：召回溯源注记（仅 explain=true 且引擎产出 why 时透传）
          // 1.3.0（模块 H）：推理证据链 why.chains 一并透传（仅 infer 线参与融合的命中携带）
          if (h.why !== undefined)
            out.why = {
              fusion: h.why.fusion,
              lines: h.why.lines.map((l) => ({ line: l.line, value: l.value })),
              lineBase: h.why.lineBase,
              score: h.why.score,
              ...(h.why.chains !== undefined
                ? {
                    chains: h.why.chains.map((c) => ({
                      path: c.path.map((e) => ({
                        from: e.from,
                        relation: e.relation,
                        to: e.to,
                        confidence: e.confidence,
                        occurredAt: e.occurredAt,
                      })),
                      terminal: c.terminal,
                      score: c.score,
                    })),
                  }
                : {}),
            }
          return out
        }),
        total: ordered.length,
        usedTokens,
      }
    },
  })
}
