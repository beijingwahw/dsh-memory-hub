/**
 * memory_store 工具：显式记忆。
 * Agent 或用户在需要持久化某项信息（决策、偏好、事实）时调用。
 *
 * 1.0.0（DESIGN-1.0）升维：
 * - 统一组装：makeEntry（id 规范 / tags 清洗 / 截断 / workspace 注入与捕获、导入三路径一致；
 *   id 前缀 '' 后缀 uuid8 —— 捕获/显式共用 contentHash 指纹，UF-1.0 跨路径互认）；
 * - UF-1.0 库内去重（可选 dedupWindowMs）：与既有库内（任意 id 前缀）同指纹或近重复（>0.92）
 *   命中时拒绝写入并计数 rejectedDuplicateCrossPath，返回已存在 id（幂等语义，不抛错）；
 * - supersede 协议（可选 supersedeMode='auto'）：对立信号 + 窗口内高相似旧条目 → 新条目打
 *   supersede:<旧id>、旧条目追加 superseded-by:<新id>，召回时旧条目降权（模块 A1）。
 */
import type { InferArgs } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ErrorCodes, MemoryHubError } from '../errors'
import { containsSensitive } from '../memory/capture'
import { detectContradiction, CONFLICTS_WITH_TAG_PREFIX, CONFLICT_OF_TAG_PREFIX } from '../memory/conflict'
import { detectDuplicate } from '../memory/engine'
import {
  makeEntry,
  SUPERSEDE_TAG_PREFIX,
  SUPERSEDED_BY_TAG_PREFIX,
  supersededByTargetId,
} from '../memory/entry-factory'
import { findSupersedeTarget } from '../memory/ingest'
import type { HubMetrics } from '../memory/metrics'
import type { GraphWriteSink, MemoryStore } from '../memory/types'

export const memoryStoreParams = {
  content: { type: 'string', required: true, description: '要记住的内容，一句完整自然语言' },
  kind: {
    type: 'string',
    enum: ['decision', 'fact', 'preference', 'instruction', 'generic'],
    description: '记忆类型（默认 generic）',
  },
  tags: { type: 'array', items: { type: 'string' }, description: '标签，便于检索' },
  workspace: { type: 'string', description: '所属工作区名称（用于隔离）' },
} as const

export type MemoryStoreArgs = InferArgs<typeof memoryStoreParams>

export function createMemoryStoreTool(
  store: MemoryStore,
  maxChars: number,
  logger?: (msg: string) => void,
  metrics?: HubMetrics,
  opts?: {
    dedupWindowMs?: number
    supersedeMode?: 'off' | 'auto'
    supersedeSimilarity?: number
    supersedeSameKind?: boolean
    // 1.1.0（DESIGN-1.1 模块 D）：矛盾共存识别（默认 off；auto 时对 supersede 未命中的疑似反转建立双向标注）
    conflictMode?: 'off' | 'auto'
    conflictSimilarity?: number
    conflictSameKind?: boolean
    // 1.1.0（DESIGN-1.1 模块 C）：图谱写入钩子（入口注入 TemporalGraph；增量建边）
    graph?: GraphWriteSink
  },
) {
  return defineTool({
    name: 'memory_store',
    description:
      'Stores a memory entry. Use this when the user asks to remember something, or when preserving a decision, fact, or preference will help future sessions. Returns the stored entry id.',
    parameters: memoryStoreParams,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, content: { type: 'string' }, kind: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: `[memory stored] ${value.id} (${value.kind})` }],
    },
    async execute(args): Promise<{ id: string; content: string; kind: string }> {
      const kind = args.kind ?? 'generic'
      if (!args.content.trim()) {
        if (metrics) metrics.errors++
        throw new MemoryHubError(ErrorCodes.EMPTY_CONTENT, 'content must not be empty')
      }
      // 显式记忆同样拒绝敏感明文入库（防泄密；与自动捕获一致）
      if (containsSensitive(args.content)) {
        if (metrics) metrics.rejectedSensitive++
        throw new MemoryHubError(
          ErrorCodes.SENSITIVE_CONTENT,
          'content contains sensitive information and will not be stored',
        )
      }
      const existing = await store.list()
      const dedupWindowMs = opts?.dedupWindowMs ?? 0
      // 1.0.0 UF-1.0：库内内容级去重（跨 id 前缀互认；命中返回已存在条目，幂等不重复写入）
      if (dedupWindowMs > 0 && detectDuplicate(existing, args.content.trim(), dedupWindowMs)) {
        for (const e of existing) {
          if (e.content === args.content.trim()) {
            if (metrics) {
              metrics.rejectedDuplicate++
              metrics.rejectedDuplicateCrossPath = (metrics.rejectedDuplicateCrossPath ?? 0) + 1
            }
            logger?.(`[dsh-memory-hub] duplicate explicit store skipped: ${e.id}`)
            return { id: e.id, content: e.content, kind: e.kind }
          }
        }
      }

      const now = Date.now()
      let tags = (args.tags ?? []).filter((t): t is string => typeof t === 'string')
      // 1.0.0 supersede 协议（模块 A1）：对立信号 + 窗口内高相似旧条目 → 建立取代关系
      let target: (typeof existing)[number] | undefined
      if (opts?.supersedeMode === 'auto') {
        target = findSupersedeTarget(
          existing,
          { content: args.content, kind },
          {
            dedupWindowMs: Math.max(dedupWindowMs, 24 * 60 * 60 * 1000),
            ...(opts.supersedeSimilarity !== undefined ? { supersedeSimilarity: opts.supersedeSimilarity } : {}),
            ...(opts.supersedeSameKind !== undefined ? { supersedeSameKind: opts.supersedeSameKind } : {}),
          },
          now,
        )
        if (target !== undefined) tags = [...tags, `${SUPERSEDE_TAG_PREFIX}${target.id}`]
      }
      // 1.1.0（模块 D1）：矛盾共存判定——supersede 命中时打标互斥，不再重复判冲突
      // （与 ingestCaptured 同一判定级联，显式写入路径行为一致）
      let conflictTarget: (typeof existing)[number] | undefined
      if (target === undefined && opts?.conflictMode === 'auto') {
        conflictTarget = detectContradiction(
          existing,
          { content: args.content, kind },
          {
            dedupWindowMs: Math.max(dedupWindowMs, 24 * 60 * 60 * 1000),
            ...(opts.conflictSimilarity !== undefined ? { conflictSimilarity: opts.conflictSimilarity } : {}),
            ...(opts.conflictSameKind !== undefined ? { conflictSameKind: opts.conflictSameKind } : {}),
          },
          now,
        )
        if (conflictTarget !== undefined) tags = [...tags, `${CONFLICTS_WITH_TAG_PREFIX}${conflictTarget.id}`]
      }
      const entry = makeEntry({
        content: args.content,
        kind,
        tags,
        source: 'explicit',
        maxChars,
        now,
        ...(args.workspace ? { workspace: args.workspace } : {}),
      })
      await store.upsert(entry)
      // 1.1.0（模块 C）：图谱写入钩子（明确写入路径与自动捕获一致）
      if (opts?.graph) opts.graph.add(entry)
      if (target !== undefined && !supersededByTargetId(target)) {
        const updated = {
          ...target,
          tags: [...target.tags, `${SUPERSEDED_BY_TAG_PREFIX}${entry.id}`],
          updatedAt: now,
        }
        await store.upsert(updated)
        if (opts?.graph) opts.graph.add(updated)
        if (metrics) metrics.superseded = (metrics.superseded ?? 0) + 1
      }
      if (conflictTarget !== undefined && !supersededByTargetId(conflictTarget)) {
        const updated = {
          ...conflictTarget,
          tags: [...conflictTarget.tags, `${CONFLICT_OF_TAG_PREFIX}${entry.id}`],
          updatedAt: now,
        }
        await store.upsert(updated)
        if (opts?.graph) opts.graph.add(updated)
        if (metrics) metrics.conflictPairs = (metrics.conflictPairs ?? 0) + 1
      }
      if (metrics) metrics.explicitStored++
      logger?.(`[dsh-memory-hub] stored ${kind}: ${entry.content.slice(0, 60)}`)
      return { id: entry.id, content: entry.content, kind: entry.kind }
    },
  })
}
