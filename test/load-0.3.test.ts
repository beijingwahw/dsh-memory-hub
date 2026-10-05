/**
 * 0.3.0 加载层演进测试：有界背压队列（>256 事件丢弃计数）、
 * status 工具输出 metrics/diagnostics、优雅关闭后队列任务不悬挂。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index'
import { defaultConfig } from '../src/config'

function makeCtx(): Context {
  const ctx = new Context()
  ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = {
    tools: () => undefined,
    section: () => undefined,
  }
  new ToolRegistry(ctx)
  return ctx
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('dsh-memory-hub 0.3.0 演进（背压 / 可观测性）', () => {
  it('超量事件触发背压丢弃并计数（dropped > 0，其余全部入库）', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-bp-'))
    const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: dir, captureMode: 'aggressive' })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_status'))

    // 一次性爆发 300 个事件（队列上限 256）
    const session = { header: { cwd: undefined } } as never
    for (let i = 0; i < 300; i++) {
      ctx.emit('session/event', session, {
        type: 'user/message',
        data: {
          source: { kind: 'user' },
          content: [{ type: 'text', text: `请记住背压测试项 ${i} 的事件内容` }],
        },
      } as never)
    }

    // 等待所有 300 个事件处理完（captured + dropped + rejected 合计 = 300 即队列耗尽）
    const statusTool = ctx.tools.get('memory_status') as unknown as {
      execute: (a: unknown) => Promise<{ metrics?: Record<string, number>; total?: number }>
    }
    let out: { metrics?: Record<string, number>; total?: number } = {}
    let done = false
    for (let i = 0; i < 200 && !done; i++) {
      out = await statusTool.execute({})
      const processed =
        (out.metrics?.['capturedTotal'] ?? 0) +
        (out.metrics?.['rejectedDuplicate'] ?? 0) +
        (out.metrics?.['dropped'] ?? 0)
      done = processed >= 300
      if (!done) await new Promise((r) => setTimeout(r, 30))
    }

    expect(out.metrics).toBeDefined()
    expect(out.metrics!['dropped']).toBeGreaterThan(0)
    // 队列上限 256：入队成功部分必然 ≤ 256 且 > 0
    expect(out.metrics!['capturedTotal']! + out.metrics!['rejectedDuplicate']!).toBeGreaterThan(0)
    expect(out.metrics!['capturedTotal']! + out.metrics!['rejectedDuplicate']!).toBeLessThanOrEqual(256)

    await fiber.dispose()
    // 卸载正常完成（优雅关闭不悬挂）
    expect(ctx.tools.get('memory_status')).toBeUndefined()
  })

  it('status 工具输出运行时 metrics（含背压计数）', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-stat3-'))
    const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: dir, captureMode: 'off' })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_status'))

    const storeTool = ctx.tools.get('memory_store') as unknown as {
      execute: (a: unknown) => Promise<Record<string, unknown>>
    }
    await storeTool.execute({ content: 'stat-3 度量条目' })
    const statusTool = ctx.tools.get('memory_status') as unknown as {
      execute: (a: unknown) => Promise<{ metrics?: Record<string, number>; total?: number; diagnostics?: unknown }>
    }
    const out = await statusTool.execute({})
    expect(out.total).toBe(1)
    expect(out.metrics).toBeDefined()
    expect(out.metrics!['explicitStored']).toBe(1)

    await fiber.dispose()
  })
})
