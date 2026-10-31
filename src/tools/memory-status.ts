/**
 * memory_status 工具：查看记忆库概览。
 * 统计条目数、类型分布、来源分布、存储占用、时间范围，
 * 以及运行指标（metrics）与存储诊断（lines/corrupt）——生产可观测性。
 *
 * 1.0.0（DESIGN-1.0）升维：
 * - superseded：被取代记忆计数（模块 A1，summarize 统计）；
 * - themes：主题自动聚类视图（模块 A2，clusterThemes；按 createMemoryStatusTool
 *   的 themes 开关计算，默认 false 不计算避免 O(N·tokens) 额外开销）；
 * - hot/cold：冷热分层（模块 A3 概念层）——hot = 未被取代且访问过/近期活跃，
 *   cold = 被取代或冷条目（未访问且超时）的近似分层；
 * - suggestion：诊断建议文本（如存在被取代记忆提示清理）；compactStats 上报冗余比。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InferArgs } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { summarizeConflictPairs } from '../memory/conflict'
import { summarizeConsolidation } from '../memory/consolidation'
import { distilledLayer } from '../memory/distill'
import { clusterThemes, isSuperseded, summarize } from '../memory/engine'
import { diffGraphs, type GraphStats, type TemporalGraph } from '../memory/graph'
import type { HubMetrics } from '../memory/metrics'
import { renderMemoryHtml } from '../memory/html-export'
import { diffReplay } from '../memory/store'
import type { MemoryEntry, MemoryStore, MemoryTimeline } from '../memory/types'
import { ErrorCodes, MemoryHubError } from '../errors'

export const memoryStatusParams = {
  workspace: { type: 'string', description: '只统计指定工作区（可选）' },
  withThemes: {
    type: 'boolean',
    description: '1.0.0：是否计算主题聚类视图（themes 数组；默认 false 省计算）',
  },
  verbose: {
    type: 'boolean',
    description: '1.1.1：输出完整运行指标观测面（默认仅核心计数，节省上下文 token）',
  },
  asOf: {
    type: 'number',
    description:
      '1.4.0：情景回放时刻（ms）——统计该时刻的记忆库（只含当时存在的记忆/当时内容版本与取代矛盾状态），与 memory_recall asOf 同源',
  },
  diffSince: {
    type: 'number',
    description:
      '1.4.0：diff 视图起点（ms，需 ≤ asOf；asOf 缺省时终点=现在）——报告 (diffSince, asOf] 期间记忆库发生了什么：新增/消失/内容变更/取代矛盾/纯热度',
  },
  graphDiff: {
    type: 'boolean',
    description: '1.5.0：diff 视图附带图维对账（T1↔T2 图视图的实体/关系级边变化；需 diffSince，缺省不计算）',
  },
  timeline: {
    type: 'boolean',
    description: '1.5.0：输出记忆时间轴（按天分桶的新增/删除/更新/热度事件流 + 存活总量走势）',
  },
  exportHtml: {
    type: 'boolean',
    description:
      '1.5.1：导出自包含 HTML 可视化页（记忆时间轴柱状视图 + 检索页——浏览器本地即时评分排序），零依赖静态文件写入存储目录并返回路径',
  },
} as const

export type MemoryStatusArgs = InferArgs<typeof memoryStatusParams>

/** 存储诊断提供者（MemoryStore 可选扩展，未实现时返回 null；0.8.0 去掉双断言取值） */
export interface DiagnosticsProvider {
  readonly diagnostics?: {
    lines: number
    corrupt: number
    encrypted?: boolean
    compact?: { reclaimed: number; ratio: number; at: number }
  }
}

/** 冷热分层的「活跃窗口」：accessCount>0 或最近访问/更新在 7 天内 */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 1.4.0（模块 J）：diff 视图明细数组输出上限（计数完整，明细只列代表样本） */
const DIFF_SAMPLE_CAP = 20

/** 1.5.0（模块 L）：图维 diff 边样本输出上限（计数完整，明细只列代表样本） */
const GRAPH_DIFF_SAMPLE_CAP = 10

/** 1.5.0（模块 O）：时间轴渲染的柱宽上限（按当桶事件数相对最大桶缩放） */
const TIMELINE_BAR_MAX = 12

/**
 * 1.5.0（模块 O）：降级 store（无 timeline 能力）的近似时间轴——按 createdAt 日分桶，
 * 只能观测新增事件（无删除/更新/热度历史），总量按当前快照存活数正向累加。
 */
function degradedTimeline(entries: readonly MemoryEntry[]): MemoryTimeline {
  const byDay = new Map<string, number>()
  let firstAt = 0
  let lastAt = 0
  for (const e of entries) {
    const day = new Date(e.createdAt).toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
    if (firstAt === 0 || e.createdAt < firstAt) firstAt = e.createdAt
    if (e.createdAt > lastAt) lastAt = e.createdAt
  }
  const days = [...byDay.keys()].sort()
  let running = 0
  const buckets = days.map((day) => {
    const added = byDay.get(day) ?? 0
    running += added
    return { day, added, removed: 0, updated: 0, heat: 0, total: running }
  })
  const truncated = buckets.length > 31
  return {
    firstAt,
    lastAt,
    events: [...byDay.values()].reduce((a, b) => a + b, 0),
    truncated,
    buckets: truncated ? buckets.slice(-31) : buckets,
  }
}

export function createMemoryStatusTool(
  store: MemoryStore,
  fileBytes: () => number | Promise<number>,
  logger?: (msg: string) => void,
  metrics?: HubMetrics,
  opts?: {
    themesDefault?: boolean
    // 1.1.0（模块 C4）：图谱运行时注入（入口构建 TemporalGraph；注入时输出 graph 可观测字段）
    graph?: TemporalGraph
    // 1.1.0（模块 B3）：巩固状态可观测开关（入口按 config.consolidationMode 注入；缺省 off 不输出）
    consolidationMode?: 'off' | 'auto'
    // 1.1.0（模块 B3）：巩固可召回率阈值（默认 0.4，与 config.recallThreshold 一致）
    recallThreshold?: number
    /**
     * 1.5.1（DESIGN-1.5 模块 P）：HTML 可视化导出目录（插件入口注入存储目录；
     * exportHtml 请求时写入 `memories-view.html`，0600，与记忆库同权限保护）
     */
    htmlDir?: string
  },
) {
  // 诊断信息（存储实现可能不提供，缺省时为 null）：运行时探测 + 一次窄化，杜绝盲目双重断言
  const diagnostics = (): {
    lines: number
    corrupt: number
    encrypted?: boolean
    compact?: { reclaimed: number; ratio: number; at: number }
  } | null => {
    if (!('diagnostics' in store)) return null
    return (store as MemoryStore & DiagnosticsProvider).diagnostics ?? null
  }
  return defineTool({
    name: 'memory_status',
    description:
      'Shows memory hub statistics: total entries, kind/source distribution, storage bytes, time range, runtime metrics, storage diagnostics, superseded count, hot/cold layering and (optional) theme clusters.',
    parameters: memoryStatusParams,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          asOf: { type: 'number', description: '1.4.0：情景回放时刻（asOf/diffSince 任一存在时输出）' },
          diffSince: { type: 'number', description: '1.4.0：diff 视图起点时刻（diffSince 存在时输出）' },
          diff: {
            type: 'object',
            additionalProperties: false,
            description: '1.4.0：T1↔T2 回放差异视图（diffSince 存在时输出；计数完整，明细 ≤20 样本）',
            properties: {
              addedCount: { type: 'number' },
              removedCount: { type: 'number' },
              updatedCount: { type: 'number' },
              heatOnly: { type: 'number', description: '仅有访问热度变化的条目数（不列明细）' },
              added: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { id: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' } },
                },
              },
              removed: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { id: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' } },
                },
              },
              updated: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    kind: { type: 'string' },
                    title: { type: 'string' },
                    change: { type: 'string', description: 'content | tags | supersede | conflict' },
                  },
                },
              },
              graph: {
                type: 'object',
                additionalProperties: false,
                description: '1.5.0：图维对账（diffSince + graphDiff=true 时输出；计数完整，边明细 ≤10 样本）',
                properties: {
                  beforeEntities: { type: 'number' },
                  afterEntities: { type: 'number' },
                  addedEdgeCount: { type: 'number' },
                  removedEdgeCount: { type: 'number' },
                  addedEdges: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: { from: { type: 'string' }, relation: { type: 'string' }, to: { type: 'string' } },
                    },
                  },
                  removedEdges: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: { from: { type: 'string' }, relation: { type: 'string' }, to: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          htmlPath: {
            type: 'string',
            description: '1.5.1：可视化页导出路径（exportHtml=true 时输出；自包含静态 HTML）',
          },
          htmlBytes: { type: 'number', description: '1.5.1：导出文件字节数' },
          timeline: {
            type: 'object',
            additionalProperties: false,
            description: '1.5.0：记忆时间轴（timeline=true 时输出；按天分桶，≤31 桶 + truncated 标记）',
            properties: {
              firstAt: { type: 'number', description: '首个时间锚定事件的时刻（空库为 0）' },
              lastAt: { type: 'number', description: '最后时间锚定事件的时刻（空库为 0）' },
              events: { type: 'number', description: '时间锚定事件总数（新增+删除+更新+热度）' },
              truncated: { type: 'boolean', description: '分桶超出上限时仅保留最近的桶' },
              buckets: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    day: { type: 'string', description: 'UTC 日（yyyy-mm-dd）' },
                    added: { type: 'number' },
                    removed: { type: 'number' },
                    updated: { type: 'number' },
                    heat: { type: 'number', description: '仅访问热度回写的事件数' },
                    total: { type: 'number', description: '当日终态存活条目数' },
                  },
                },
              },
            },
          },
          byKind: {
            type: 'object',
            additionalProperties: false,
            properties: {
              decision: { type: 'number' },
              fact: { type: 'number' },
              preference: { type: 'number' },
              instruction: { type: 'number' },
              generic: { type: 'number' },
            },
          },
          bySource: {
            type: 'object',
            additionalProperties: false,
            properties: { auto: { type: 'number' }, explicit: { type: 'number' } },
          },
          bytes: { type: 'number' },
          oldestAt: { type: 'number' },
          newestAt: { type: 'number' },
          superseded: { type: 'number', description: '1.0.0：被取代记忆数（supersede 协议）' },
          hot: { type: 'number', description: '1.0.0：活跃层条目数（未取代且近期活跃）' },
          cold: { type: 'number', description: '1.0.0：候选层条目数（被取代或冷条目）' },
          themes: {
            type: 'array',
            description: '1.0.0：主题聚类视图（withThemes=true 时返回）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                memberCount: { type: 'number' },
                topKinds: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          duplicateRatio: { type: 'number', description: '1.0.0：文件冗余行占比（lines/entries-1，诊断可用时）' },
          suggestion: { type: 'string', description: '1.0.0：维护建议（如清理被取代记忆）' },
          distilled: {
            type: 'object',
            additionalProperties: false,
            description: '1.1.0：蒸馏分层计数（abstract/procedural；库中存在蒸馏条目时输出）',
            properties: { abstract: { type: 'number' }, procedural: { type: 'number' } },
          },
          graph: {
            type: 'object',
            additionalProperties: false,
            description: '1.1.0：时序知识图谱可观测（entities/edges/activeEdges/…；图谱运行时注入时输出）',
            properties: {
              entities: { type: 'number' },
              edges: { type: 'number' },
              activeEdges: { type: 'number' },
              supersededEdges: { type: 'number' },
              evicted: { type: 'number' },
            },
          },
          conflictPairs: {
            type: 'object',
            additionalProperties: false,
            description: '1.1.0：矛盾共存对可观测（count + 最近样本；存在冲突对时输出）',
            properties: { count: { type: 'number' }, samples: { type: 'array', items: { type: 'string' } } },
          },
          dueCount: { type: 'number', description: '1.1.0：到期应巩固的条目数（consolidationMode=auto 时输出）' },
          strengthSummary: {
            type: 'object',
            additionalProperties: false,
            description: '1.1.0：记忆强度与可召回率摘要（均值/中位/最低可召回率；consolidationMode=auto 时输出）',
            properties: {
              total: { type: 'number' },
              strengthAvg: { type: 'number' },
              strengthMedian: { type: 'number' },
              minR: { type: 'number' },
            },
          },
          metrics: {
            type: 'object',
            additionalProperties: false,
            description: '运行时指标（自插件加载以来累计）',
            properties: {
              capturedTotal: { type: 'number' },
              explicitStored: { type: 'number' },
              recallCalls: { type: 'number' },
              recallHits: { type: 'number' },
              forgotten: { type: 'number' },
              rejectedSensitive: { type: 'number' },
              rejectedDuplicate: { type: 'number' },
              pruned: { type: 'number' },
              dropped: { type: 'number' },
              errors: { type: 'number' },
              superseded: { type: 'number' },
              rejectedDuplicateCrossPath: { type: 'number' },
              fusionHits: { type: 'number' },
              themeBuilds: { type: 'number' },
              distilled: { type: 'number' },
              distilledAbstract: { type: 'number' },
              distilledProcedural: { type: 'number' },
              distillSkips: { type: 'number' },
              consolidated: { type: 'number' },
              consolidationDue: { type: 'number' },
              graphEdges: { type: 'number' },
              graphHits: { type: 'number' },
              conflictPairs: { type: 'number' },
              asOfRecalls: { type: 'number', description: '1.3.0：情景回放召回计数' },
              statusAsOf: { type: 'number', description: '1.4.0：status 时间视图计数' },
              vectorHits: { type: 'number', description: '1.5.0：向量第六线召回命中计数' },
              statusTimeline: { type: 'number', description: '1.5.0：status 时间轴视图计数' },
              htmlExports: { type: 'number', description: '1.5.1：可视化 HTML 页导出计数' },
            },
          },
          diagnostics: {
            type: 'object',
            additionalProperties: false,
            description: '存储健康诊断（行数/损坏行/加密形态/最近 compact 回收；未提供时为 null）',
            properties: {
              lines: { type: 'number' },
              corrupt: { type: 'number' },
              encrypted: { type: 'boolean', description: '1.4.0：逐行加密存储形态（仅加密库输出）' },
              compact: {
                type: 'object',
                additionalProperties: false,
                description: '1.0.0：最近一次 compact 回收统计',
                properties: { reclaimed: { type: 'number' }, ratio: { type: 'number' }, at: { type: 'number' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // 1.5.1（模块 P）：可视化页导出——路径 + 字节数（exportHtml=true 时输出）
        if (value.htmlPath !== undefined) {
          return [
            {
              type: 'text',
              text: `[memory status html] exported ${value.total ?? 0} entries → ${value.htmlPath} (${
                value.htmlBytes ?? 0
              } bytes, self-contained, offline-ready)`,
            },
          ]
        }
        // 1.5.0（模块 O）：记忆时间轴——按天分桶的事件流 + 存活总量走势（timeline=true 时输出）
        if (value.timeline !== undefined) {
          const t = value.timeline as MemoryTimeline
          if (t.buckets.length === 0) {
            return [{ type: 'text', text: '[memory timeline] empty (no time-anchored events)' }]
          }
          const maxEvents = Math.max(1, ...t.buckets.map((b) => b.added + b.removed + b.updated + b.heat))
          const lines = t.buckets.map((b) => {
            const width = Math.max(
              1,
              Math.round((TIMELINE_BAR_MAX * (b.added + b.removed + b.updated + b.heat)) / maxEvents),
            )
            return `${b.day} │ ${'█'.repeat(width)} +${b.added} −${b.removed} ~${b.updated} (h${b.heat}) = ${b.total}`
          })
          const days = t.buckets.length
          return [
            {
              type: 'text',
              text:
                `[memory timeline] ${t.buckets[0]?.day ?? ''} → ${t.buckets[days - 1]?.day ?? ''}` +
                ` · ${days} 天${t.truncated ? '+' : ''} · 事件 ${t.events}` +
                (t.truncated ? '（仅保留最近 31 天）' : '') +
                `\n${lines.join('\n')}`,
            },
          ]
        }
        // 1.4.0（模块 J）：diff 视图——T1→T2 期间记忆库发生了什么（计数 + 代表样本）
        if (value.diff !== undefined) {
          const d = value.diff as {
            addedCount: number
            removedCount: number
            updatedCount: number
            heatOnly: number
            added?: Array<{ title?: string; kind?: string }>
            removed?: Array<{ title?: string }>
            updated?: Array<{ title?: string; change?: string }>
            graph?: unknown
          }
          const sample = (items: Array<{ title?: string }> | undefined, n: number, mark: string) =>
            (items ?? [])
              .slice(0, n)
              .map((it) => `\n  ${mark} ${it.title ?? ''}`)
              .join('')
          const updatedSample = (d.updated ?? [])
            .slice(0, 3)
            .map((it) => `\n  ~ ${it.title ?? ''} [${it.change ?? ''}]`)
            .join('')
          // 1.5.0（模块 L）：图维对账行——实体/关系级边变化（graphDiff=true 时输出）
          const gd = d.graph as
            | {
                beforeEntities: number
                afterEntities: number
                addedEdgeCount: number
                removedEdgeCount: number
                addedEdges?: Array<{ from?: string; relation?: string; to?: string }>
                removedEdges?: Array<{ from?: string; relation?: string; to?: string }>
              }
            | undefined
          const graphNote =
            gd !== undefined
              ? `\n  graph: entities ${gd.beforeEntities}→${gd.afterEntities}, +${gd.addedEdgeCount} −${gd.removedEdgeCount} edge(s)` +
                (gd.addedEdges ?? [])
                  .slice(0, 3)
                  .map((x) => `\n    + ${x.from ?? ''} —${x.relation ?? ''}→ ${x.to ?? ''}`)
                  .join('') +
                (gd.removedEdges ?? [])
                  .slice(0, 3)
                  .map((x) => `\n    − ${x.from ?? ''} —${x.relation ?? ''}→ ${x.to ?? ''}`)
                  .join('')
              : ''
          return [
            {
              type: 'text',
              text:
                `[memory status diff ${new Date(value.diffSince ?? 0).toISOString()} → ${new Date(
                  value.asOf ?? 0,
                ).toISOString()}]` +
                ` +${d.addedCount} -${d.removedCount} ~${d.updatedCount} (heat ${d.heatOnly})` +
                sample(d.added, 3, '+') +
                sample(d.removed, 3, '-') +
                updatedSample +
                graphNote,
            },
          ]
        }
        // 1.4.0（模块 J）：asOf 快照视图——该时刻的记忆库概览（运行时字段不掺入）
        const asOfNote = typeof value.asOf === 'number' ? ` @${new Date(value.asOf).toISOString()}` : ''
        return [
          {
            type: 'text',
            text:
              `[memory status${asOfNote}] ${value.total ?? 0} entries` +
              (typeof value.asOf === 'number' ? '' : `, ${value.bytes ?? 0} bytes`) +
              `\n- kinds: ${JSON.stringify(value.byKind ?? {})}` +
              `\n- sources: auto=${value.bySource?.auto ?? 0}, explicit=${value.bySource?.explicit ?? 0}` +
              (value.oldestAt ? `\n- from ${new Date(value.oldestAt).toISOString()}` : '') +
              (value.superseded !== undefined ? `\n- superseded: ${value.superseded}` : '') +
              (value.hot !== undefined ? `\n- layering: hot=${value.hot}, cold=${value.cold ?? 0}` : '') +
              (Array.isArray(value.themes) && value.themes.length > 0
                ? `\n- themes: ${(value.themes as Array<{ label?: string; memberCount?: number }>)
                    .map((t) => `${t.label ?? ''}(${t.memberCount ?? 0})`)
                    .join(', ')}`
                : '') +
              (value.duplicateRatio !== undefined
                ? `\n- duplicateRatio: ${Number(value.duplicateRatio).toFixed(2)}`
                : '') +
              (value.distilled
                ? `\n- distilled: abstract=${(value.distilled as { abstract?: number }).abstract ?? 0}, procedural=${(value.distilled as { procedural?: number }).procedural ?? 0}`
                : '') +
              (value.graph
                ? `\n- graph: entities=${(value.graph as { entities?: number }).entities ?? 0}, edges=${(value.graph as { edges?: number }).edges ?? 0}, active=${(value.graph as { activeEdges?: number }).activeEdges ?? 0}, evicted=${(value.graph as { evicted?: number }).evicted ?? 0}`
                : '') +
              (value.dueCount !== undefined
                ? `\n- consolidation: due=${value.dueCount}${value.strengthSummary ? `, strengthAvg=${Number((value.strengthSummary as { strengthAvg?: number }).strengthAvg ?? 0).toFixed(2)}, minR=${Number((value.strengthSummary as { minR?: number }).minR ?? 0).toFixed(3)}` : ''}`
                : '') +
              (value.conflictPairs
                ? `\n- conflicts: ${(value.conflictPairs as { count?: number }).count ?? 0} pair(s) ${((value.conflictPairs as { samples?: string[] }).samples ?? []).join(' | ')}`
                : '') +
              (typeof value.suggestion === 'string' && value.suggestion ? `\n- suggestion: ${value.suggestion}` : '') +
              `\n- metrics: ${JSON.stringify(value.metrics ?? {})}` +
              (value.diagnostics ? `\n- storage: ${JSON.stringify(value.diagnostics)}` : ''),
          },
        ]
      },
    },
    async execute(args: MemoryStatusArgs): Promise<Record<string, unknown>> {
      // -------------------------------------------------------------------------
      // 1.5.1（DESIGN-1.5 模块 P）：可视化检索页导出——自包含 HTML（记忆时间轴柱状
      // 视图 + 浏览器本地即时评分检索页），零依赖静态文件写入存储目录并返回路径。
      // 导出为明文观看工件（与加密存储正交）：0600 落盘、与记忆库同权限保护。
      // -------------------------------------------------------------------------
      if (args.exportHtml === true) {
        if (opts?.htmlDir === undefined) {
          throw new MemoryHubError(
            ErrorCodes.INTERNAL,
            'exportHtml requires htmlDir to be configured (the plugin entry injects the storage directory)',
          )
        }
        if (metrics) metrics.htmlExports = (metrics.htmlExports ?? 0) + 1
        const allEntries = await store.list()
        // 与普通视图一致的统一隔离语义（未标注 workspace = 全局共享）
        const filtered = args.workspace
          ? allEntries.filter((e) => e.workspace === undefined || e.workspace === args.workspace)
          : allEntries
        const t: MemoryTimeline =
          typeof store.timeline === 'function' ? await store.timeline(90) : degradedTimeline(filtered)
        const html = renderMemoryHtml({ entries: filtered, timeline: t, generatedAt: Date.now() })
        const htmlPath = join(opts.htmlDir, 'memories-view.html')
        const bytes = Buffer.byteLength(html, 'utf8')
        try {
          await writeFile(htmlPath, html, { encoding: 'utf8', mode: 0o600 })
        } catch (err) {
          throw new MemoryHubError(ErrorCodes.STORE_WRITE_FAILED, `failed to write memory view html: ${htmlPath}`, err)
        }
        logger?.(`[dsh-memory-hub] html view exported: ${filtered.length} entries -> ${htmlPath}`)
        return { total: filtered.length, htmlPath, htmlBytes: bytes }
      }
      // -------------------------------------------------------------------------
      // 1.5.0（DESIGN-1.5 模块 O）：记忆时间轴——独立视图（timeline=true 时输出）。
      // append-only 日志单遍回放出「按天分桶的新增/删除/更新/热度事件流 + 存活总量走势」；
      // 支持回放的存储（JSONL）逐行精确分桶，降级 store 按 createdAt 近似（只有新增事件）。
      // -------------------------------------------------------------------------
      if (args.timeline === true) {
        if (metrics) metrics.statusTimeline = (metrics.statusTimeline ?? 0) + 1
        const t: MemoryTimeline =
          typeof store.timeline === 'function' ? await store.timeline() : degradedTimeline(await store.list())
        logger?.(`[dsh-memory-hub] timeline: ${t.events} event(s) over ${t.buckets.length} day(s)`)
        return { timeline: t }
      }
      // -------------------------------------------------------------------------
      // 1.4.0（DESIGN-1.4 模块 J）：时间分支——asOf 快照视图 / diffSince↔asOf diff 视图。
      // 与 memory_recall asOf 同源（listAsOf 优先，降级 store 按 createdAt 过滤当前快照）；
      // 时间视图只输出**语料层**字段（运行时 metrics/diagnostics/graph/巩固属于「现在」，
      // 不掺入历史快照）；workspace 过滤语义与当前视图一致。
      // -------------------------------------------------------------------------
      const validAsOf = args.asOf !== undefined && Number.isFinite(args.asOf) && args.asOf > 0 ? args.asOf : undefined
      const validSince =
        args.diffSince !== undefined && Number.isFinite(args.diffSince) && args.diffSince > 0
          ? args.diffSince
          : undefined
      if (validAsOf !== undefined || validSince !== undefined) {
        if (metrics) metrics.statusAsOf = (metrics.statusAsOf ?? 0) + 1
        const until = validAsOf ?? Date.now()
        const applyWorkspace = (list: MemoryEntry[]): MemoryEntry[] =>
          args.workspace ? list.filter((e) => e.workspace === undefined || e.workspace === args.workspace) : list
        const replayAt = async (t: number): Promise<MemoryEntry[]> => {
          if (typeof store.listAsOf === 'function') return applyWorkspace(await store.listAsOf(t))
          // 降级 store：无回放能力，按 createdAt 近似（删除不可见 → diff removed 恒空，README 已声明）
          return applyWorkspace((await store.list()).filter((e) => e.createdAt <= t))
        }
        if (validSince !== undefined) {
          if (validSince > until) {
            throw new Error(`diffSince (${validSince}) must be ≤ asOf (${until})`)
          }
          const [before, after] = await Promise.all([replayAt(validSince), replayAt(until)])
          const d = diffReplay(before, after, validSince, until)
          // 1.5.0（模块 L）：图维对账（graphDiff=true 时计算；缺省不计算，输出形状与 1.4.0 一致）
          let graph: Record<string, unknown> | undefined
          if (args.graphDiff === true) {
            const g = diffGraphs(before, after, until)
            graph = {
              beforeEntities: g.beforeEntities,
              afterEntities: g.afterEntities,
              addedEdgeCount: g.addedEdgeCount,
              removedEdgeCount: g.removedEdgeCount,
              addedEdges: g.addedEdges.slice(0, GRAPH_DIFF_SAMPLE_CAP),
              removedEdges: g.removedEdges.slice(0, GRAPH_DIFF_SAMPLE_CAP),
            }
          }
          return {
            asOf: until,
            diffSince: validSince,
            total: after.length,
            diff: {
              addedCount: d.addedCount,
              removedCount: d.removedCount,
              updatedCount: d.updatedCount,
              heatOnly: d.heatOnly,
              added: d.added.slice(0, DIFF_SAMPLE_CAP),
              removed: d.removed.slice(0, DIFF_SAMPLE_CAP),
              updated: d.updated.slice(0, DIFF_SAMPLE_CAP),
              ...(graph !== undefined ? { graph } : {}),
            },
          }
        }
        // asOf 快照视图：语料层字段 + 以 asOf 为「现在」的冷热分层
        const entriesAt = await replayAt(until)
        const stats = summarize(entriesAt, 0)
        const out: Record<string, unknown> = { asOf: until, ...stats }
        delete out['bytes']
        let hot = 0
        for (const e of entriesAt) {
          const active = e.accessCount > 0 || Math.max(e.createdAt, e.updatedAt) >= until - ACTIVE_WINDOW_MS
          if (!isSuperseded(e) && active) hot++
        }
        out['hot'] = hot
        out['cold'] = entriesAt.length - hot
        let distilledAbstract = 0
        let distilledProcedural = 0
        for (const e of entriesAt) {
          const layer = distilledLayer(e)
          if (layer === 'abstract') distilledAbstract++
          else if (layer === 'procedural') distilledProcedural++
        }
        if (distilledAbstract + distilledProcedural > 0) {
          out['distilled'] = { abstract: distilledAbstract, procedural: distilledProcedural }
        }
        const conflictSummary = summarizeConflictPairs(entriesAt)
        if (conflictSummary.count > 0) {
          out['conflictPairs'] = { count: conflictSummary.count, samples: conflictSummary.samples }
        }
        logger?.(`[dsh-memory-hub] status @${new Date(until).toISOString()}: ${stats.total} entries`)
        return out
      }
      const entries = await store.list()
      // 0.9.0：统一隔离语义（与检索引擎一致）——未标注 workspace 的记忆 = 全局共享，
      // 指定工作区统计时一并计入；修复 0.8.0 两工具语义相反（J 薄弱项）
      const filtered = args.workspace
        ? entries.filter((e) => e.workspace === undefined || e.workspace === args.workspace)
        : entries
      const stats = summarize(filtered, await fileBytes())
      const out: Record<string, unknown> = { ...stats }
      // 1.0.0（模块 A3）：冷热分层——hot = 未取代且（访问过或 7 天内创建/更新）
      const now = Date.now()
      let hot = 0
      for (const e of filtered) {
        const active = e.accessCount > 0 || Math.max(e.createdAt, e.updatedAt) >= now - ACTIVE_WINDOW_MS
        if (!isSuperseded(e) && active) hot++
      }
      out['hot'] = hot
      out['cold'] = filtered.length - hot
      // 1.0.0（模块 A2）：主题聚类视图（按参/配置开关；默认由入口 opts.themesDefault 决定）
      const wantThemes = args.withThemes === true || (args.withThemes === undefined && opts?.themesDefault === true)
      if (wantThemes) {
        const themes = clusterThemes(filtered)
        if (metrics) metrics.themeBuilds = (metrics.themeBuilds ?? 0) + 1
        if (themes.length > 0) out['themes'] = themes
      }
      const diag = diagnostics()
      if (diag) {
        out['diagnostics'] = diag
        // 1.0.0（模块 D）：冗余行占比 = 行数/条目数 - 1（append-only + tombstone 的膨胀信号）
        if (filtered.length > 0 && diag.lines > filtered.length) {
          out['duplicateRatio'] = diag.lines / filtered.length - 1
        }
      }
      // 1.1.0（模块 A5）：蒸馏分层可观测——库中存在蒸馏条目时输出 abstract/procedural 计数
      let distilledAbstract = 0
      let distilledProcedural = 0
      for (const e of filtered) {
        const layer = distilledLayer(e)
        if (layer === 'abstract') distilledAbstract++
        else if (layer === 'procedural') distilledProcedural++
      }
      if (distilledAbstract + distilledProcedural > 0) {
        out['distilled'] = { abstract: distilledAbstract, procedural: distilledProcedural }
      }
      // 1.1.0（模块 C4）：图谱可观测——图谱运行时注入时输出统计并同步 metrics.graphEdges
      if (opts?.graph) {
        const g: GraphStats = opts.graph.stats()
        out['graph'] = {
          entities: g.entities,
          edges: g.edges,
          activeEdges: g.activeEdges,
          supersededEdges: g.supersededEdges,
          evicted: g.evicted,
        }
        if (metrics) metrics.graphEdges = g.activeEdges
      }
      // 1.1.0（模块 B3）：巩固状态可观测——consolidationMode=auto 时输出到期数与强度/可召回率摘要
      if (opts?.consolidationMode === 'auto') {
        // exactOptionalPropertyTypes：仅当阈值显式配置时才传，缺省走 consolidate 内部默认（0.4）
        const consolidationParms = opts.recallThreshold !== undefined ? { recallThreshold: opts.recallThreshold } : {}
        const sum = summarizeConsolidation(filtered, Date.now(), consolidationParms)
        out['dueCount'] = sum.dueCount
        out['strengthSummary'] = {
          total: sum.total,
          strengthAvg: sum.strengthAvg,
          strengthMedian: sum.strengthMedian,
          minR: sum.minR,
        }
        if (metrics) metrics.consolidationDue = sum.dueCount
      }
      // 1.1.0（模块 D4）：矛盾共存可观测——冲突对计数 + 最近样本（仅存在冲突对时输出）
      const conflictSummary = summarizeConflictPairs(filtered)
      if (conflictSummary.count > 0) {
        out['conflictPairs'] = { count: conflictSummary.count, samples: conflictSummary.samples }
        if (metrics) metrics.conflictPairs = conflictSummary.count
      }
      // 1.0.0（模块 D）：维护建议（被取代记忆可清理）
      const supersededCount = stats.superseded ?? 0
      if (supersededCount > 0) {
        const maybeCompact =
          diag && filtered.length > 0 && diag.lines > filtered.length * 2
            ? '；另检测到旧行冗余较高，可导出后重建文件压缩'
            : ''
        out['suggestion'] =
          `检测到 ${supersededCount} 条被取代记忆（supersede 协议），可用 memory_forget 清理旧版本${maybeCompact}`
      }
      // 1.1.1：metrics 分层输出——全量 23 键的 JSON.stringify 对模型决策价值低且 token 昂贵，
      // 缺省只保留核心计数（读写通路健康度），verbose=true 时才输出完整观测面。
      if (metrics) {
        if (args.verbose === true) {
          out['metrics'] = { ...metrics }
        } else {
          const {
            capturedTotal,
            explicitStored,
            recallCalls,
            recallHits,
            rejectedSensitive,
            rejectedDuplicate,
            dropped,
            errors,
          } = metrics
          out['metrics'] = {
            capturedTotal,
            explicitStored,
            recallCalls,
            recallHits,
            rejectedSensitive,
            rejectedDuplicate,
            dropped,
            errors,
          }
        }
      }
      logger?.(`[dsh-memory-hub] status: ${stats.total} entries`)
      return out
    },
  })
}
