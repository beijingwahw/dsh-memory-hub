/**
 * memory_recall 工具：按语义/关键词召回相关记忆。
 * 新会话开始、遇到与历史主题相关的问题时调用，避免重复询问与重复交代。
 */
import type { InferArgs } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ErrorCodes, MemoryHubError, errorMessage } from '../errors'
import { conflictAwareOrder, conflictPeerIds } from '../memory/conflict'
import { expandDistilled, isDistilled } from '../memory/distill'
import { isSuperseded, IndexCache, estimateTokens } from '../memory/engine'
import type { HubMetrics } from '../memory/metrics'
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
  // 1.1.0（DESIGN-1.1 模块 C3）：图谱时间线回放（可选；缺省取当前时间）
  asOf: {
    type: 'number',
    description: '图谱时间线回放时间戳（ms）：按该时刻的图谱状态（被取代边失效）与评分基准召回；只读回放不更新热度',
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
  recallDefaults?: Readonly<Pick<RecallOptions, 'fusionMode' | 'semanticBoost'>>,
  // 1.1.0（DESIGN-1.1 模块 C2）：图谱运行时注入（入口构建 TemporalGraph；未注入时 graphEnabled 参数不生效）
  graph?: GraphRecallSource,
) {
  // 索引缓存：按 store.revision 复用倒排索引，语料未变时召回免全量重建
  const indexCache = new IndexCache()
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
        const settled = await Promise.allSettled(batch.map((e) => store.upsert(e)))
        for (const r of settled) {
          if (r.status === 'rejected') {
            if (metrics) metrics.errors++
            logger?.(`heat flush failed: ${errorMessage(r.reason)}`)
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
              },
            },
          },
          total: { type: 'number' },
          usedTokens: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const hits = value.hits ?? []
        return [
          {
            type: 'text',
            text: hits.length
              ? `[memory recall] ${hits.length} hit(s), ${value.usedTokens ?? 0} tokens:\n` +
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
                    return `- (${h.kind}) ${h.content}${flag}${conflictNote}${expandedNote}`
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
      const entries = await store.list()
      const options: RecallOptions = {
        maxTokens: args.maxTokens ?? defaultTokens,
        limit: args.limit ?? defaultLimit,
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
      if (args.supersededPenalty !== undefined) options.supersededPenalty = args.supersededPenalty
      // 1.1.0（模块 C2）：图谱第四召回线——入口注入 graph 且参数显式开启（或 config graphEnabled 时由入口注入
      // defaultGraphEnabled）才生效；graph 未注入时保持 1.0.0 三线行为，逐字节不变
      if (graph !== undefined) {
        options.graph = graph
        if (args.graphEnabled === true) options.graphEnabled = true
      }
      // 1.1.0（模块 C3）：图谱时间线回放——asOf 覆盖评分基准时间（图谱失效判定 + 时效衰减）
      // 1.1.0（模块 B2）：reinforce=false 显式只读（查看不强化）；缺省/true 保持 1.0.0 热度更新
      const readOnly = args.asOf !== undefined || args.reinforce === false
      if (args.asOf !== undefined) options.now = args.asOf
      const hits = indexCache.query(entries, store.revision, query, options)
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
        // 1.0.0：RRF/语义叠加生效时计数（模块 D 可观测性——融合模式实际产出命中数）
        if (options.fusionMode === 'rrf' || options.semanticBoost === true) {
          metrics.fusionHits = (metrics.fusionHits ?? 0) + ordered.length
        }
        // 1.1.0（模块 C4）：图谱线启用时召回命中计数（图线生效观测；缺省不计数）
        if (options.graphEnabled === true) metrics.graphHits = (metrics.graphHits ?? 0) + ordered.length
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
          return out
        }),
        total: ordered.length,
        usedTokens,
      }
    },
  })
}
