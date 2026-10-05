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
import type { InferArgs } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { summarizeConflictPairs } from '../memory/conflict'
import { summarizeConsolidation } from '../memory/consolidation'
import { distilledLayer } from '../memory/distill'
import { clusterThemes, isSuperseded, summarize } from '../memory/engine'
import type { GraphStats, TemporalGraph } from '../memory/graph'
import type { HubMetrics } from '../memory/metrics'
import type { MemoryStore } from '../memory/types'

export const memoryStatusParams = {
  workspace: { type: 'string', description: '只统计指定工作区（可选）' },
  withThemes: {
    type: 'boolean',
    description: '1.0.0：是否计算主题聚类视图（themes 数组；默认 false 省计算）',
  },
} as const

export type MemoryStatusArgs = InferArgs<typeof memoryStatusParams>

/** 存储诊断提供者（MemoryStore 可选扩展，未实现时返回 null；0.8.0 去掉双断言取值） */
export interface DiagnosticsProvider {
  readonly diagnostics?: { lines: number; corrupt: number; compact?: { reclaimed: number; ratio: number; at: number } }
}

/** 冷热分层的「活跃窗口」：accessCount>0 或最近访问/更新在 7 天内 */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

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
  },
) {
  // 诊断信息（存储实现可能不提供，缺省时为 null）：运行时探测 + 一次窄化，杜绝盲目双重断言
  const diagnostics = (): {
    lines: number
    corrupt: number
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
            },
          },
          diagnostics: {
            type: 'object',
            additionalProperties: false,
            description: '存储健康诊断（行数/损坏行/最近 compact 回收；未提供时为 null）',
            properties: {
              lines: { type: 'number' },
              corrupt: { type: 'number' },
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
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `[memory status] ${value.total ?? 0} entries, ${value.bytes ?? 0} bytes` +
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
      ],
    },
    async execute(args: MemoryStatusArgs): Promise<Record<string, unknown>> {
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
      if (metrics) out['metrics'] = { ...metrics }
      logger?.(`[dsh-memory-hub] status: ${stats.total} entries`)
      return out
    },
  })
}
