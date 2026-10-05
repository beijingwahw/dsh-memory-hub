/**
 * memory_forget 工具：遗忘指定记忆。
 * 用户删除某条记住的内容时调用。
 */
import type { InferArgs } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ErrorCodes, MemoryHubError } from '../errors'
import type { HubMetrics } from '../memory/metrics'
import type { GraphWriteSink, MemoryStore } from '../memory/types'

export const memoryForgetParams = {
  id: { type: 'string', required: true, description: '要删除的记忆条目 id（来自 memory_recall / memory_status）' },
  strict: {
    type: 'boolean',
    description: '严格模式：目标不存在时抛 NOT_FOUND 错误（默认 false 返回 removed:false，兼容软删除语义）',
  },
} as const

export type MemoryForgetArgs = InferArgs<typeof memoryForgetParams>

export function createMemoryForgetTool(
  store: MemoryStore,
  logger?: (msg: string) => void,
  metrics?: HubMetrics,
  // 1.1.0（DESIGN-1.1 模块 C3）：图谱运行时注入（入口构建 TemporalGraph；删除时同步软删图边）
  graph?: GraphWriteSink,
) {
  return defineTool({
    name: 'memory_forget',
    description:
      'Forgets (deletes) a stored memory entry by id. Use this when the user asks to remove a remembered item.',
    parameters: memoryForgetParams,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { removed: { type: 'boolean' }, id: { type: 'string' } },
      },
      render: (_args, value) => [
        { type: 'text', text: value.removed ? `[memory forgotten] ${value.id}` : `[memory not found] ${value.id}` },
      ],
    },
    async execute(args): Promise<{ removed: boolean; id: string }> {
      const id = args.id.trim()
      const removed = await store.remove(id)
      // 0.9.0 H：strict 模式消费 NOT_FOUND 错误码（0.8.0 定义后从未使用）；
      // 默认模式保持软删除语义（removed:false 不抛错），渲染文本逐字节不变
      if (!removed && args.strict === true) {
        if (metrics) metrics.errors++
        throw new MemoryHubError(ErrorCodes.NOT_FOUND, `memory not found: ${id}`)
      }
      if (metrics && removed) metrics.forgotten++
      // 1.1.0（模块 C3）：图谱软删同步——删除条目在边上的引用，无引用边失效（asOf 时间线保留）
      if (removed && graph) graph.remove(id)
      logger?.(`[dsh-memory-hub] forgot ${id} (${removed ? 'removed' : 'not found'})`)
      return { removed, id }
    },
  })
}
