import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlMemoryStore } from '../../src/memory/store'
import { createMetrics } from '../../src/memory/metrics'
import { createMemoryForgetTool } from '../../src/tools/memory-forget'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import { createMemoryStoreTool } from '../../src/tools/memory-store'

type Toolish = { name: string; execute: (args: never) => Promise<Record<string, unknown>> }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-tools3-'))
  const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
  const metrics = createMetrics()
  return {
    store,
    metrics,
    storeTool: createMemoryStoreTool(store, 1000, undefined, metrics) as unknown as Toolish,
    recallTool: createMemoryRecallTool(store, 800, 8, undefined, metrics) as unknown as Toolish,
    forgetTool: createMemoryForgetTool(store, undefined, metrics) as unknown as Toolish,
    statusTool: createMemoryStatusTool(store, () => Promise.resolve(0), undefined, metrics) as unknown as Toolish,
  }
}

describe('memory 工具 0.3.0 演进（metrics 注入 / kind 过滤 / diagnostics）', () => {
  it('store 工具递增 explicitStored，recall 递增 recallCalls/hits，forget 递增 forgotten', async () => {
    const { storeTool, recallTool, forgetTool, metrics, store } = await setup()
    await storeTool.execute({ content: '记住默认分支是 main' } as never)
    expect(metrics.explicitStored).toBe(1)

    await recallTool.execute({ query: '默认分支' } as never)
    expect(metrics.recallCalls).toBe(1)
    expect(metrics.recallHits).toBeGreaterThanOrEqual(1)

    const list = await store.list()
    const id = list[0]!.id
    await forgetTool.execute({ id } as never)
    expect(metrics.forgotten).toBe(1)
  })

  it('空内容与敏感内容分别递增 errors / rejectedSensitive，且不入库', async () => {
    const { storeTool, metrics } = await setup()
    await expect(storeTool.execute({ content: '   ' } as never)).rejects.toThrow()
    expect(metrics.errors).toBe(1)

    await expect(storeTool.execute({ content: 'login password: sk-secret-abc' } as never)).rejects.toThrow()
    expect(metrics.rejectedSensitive).toBe(1)
    expect(metrics.explicitStored).toBe(0)
  })

  it('recall 支持 kind 过滤（只返回指定类型）', async () => {
    const { storeTool, recallTool } = await setup()
    await storeTool.execute({ content: '偏好简洁的代码风格', kind: 'preference' } as never)
    await storeTool.execute({ content: '用户今天完成了登录模块', kind: 'fact' } as never)

    const onlyPref = (await recallTool.execute({ query: '代码 风格', kind: 'preference' } as never)) as {
      hits: Array<{ content: string }>
    }
    expect(onlyPref.hits.length).toBeGreaterThan(0)
    for (const h of onlyPref.hits) expect(h.content).toContain('偏好')

    const onlyFact = (await recallTool.execute({ query: '登录 模块', kind: 'fact' } as never)) as {
      hits: Array<{ content: string }>
    }
    for (const h of onlyFact.hits) expect(h.content).toContain('登录')
  })

  it('recall kind 非法值由 schema 前置拦截（ToolArgsError，与 memory_store 错误形态统一）', async () => {
    // 0.9.0 A'：kind 参数加 enum 后非法值在 execute 前被 dsh-tools schema 拦截，
    // 与 memory_store 抛同形态 ToolArgsError（0.8.0 recall 用 EMPTY_CONTENT 码包装属错误码误用）
    const { recallTool } = await setup()
    await expect(recallTool.execute({ query: '任何', kind: 'bogus' } as never)).rejects.toThrow(/must be one of/)
  })

  it('status 输出 metrics 快照与 diagnostics（lines/corrupt）', async () => {
    const { statusTool, storeTool, metrics } = await setup()
    await storeTool.execute({ content: '状态检查用记忆' } as never)
    const out = (await statusTool.execute({} as never)) as {
      total?: number
      metrics?: Record<string, number>
      diagnostics?: { lines: number; corrupt: number }
    }
    expect(out.total).toBe(1)
    expect(out.metrics).toBeDefined()
    expect(out.metrics!['explicitStored']).toBe(1)
    // 快照为拷贝：工具后续累加不影响已返回快照
    expect(out.metrics!['capturedTotal']).toBe(0)
    expect(out.diagnostics).toEqual({ lines: 1, corrupt: 0 })
    metrics.capturedTotal = 5
    expect(out.metrics!['capturedTotal']).toBe(0)
  })

  it('status 无 metrics 时不输出 metrics 键（向后兼容）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-tools3b-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const plain = createMemoryStatusTool(store, () => Promise.resolve(0)) as unknown as Toolish
    const out = await plain.execute({} as never)
    expect(out['metrics']).toBeUndefined()
    expect(out['diagnostics']).toEqual({ lines: 0, corrupt: 0 })
    await store.close()
  })

  it('recall 走索引缓存且结果与直接 recall 一致（无 metrics 退化）', async () => {
    const { storeTool, recallTool, store } = await setup()
    await storeTool.execute({ content: '架构采用事件溯源模式' } as never)
    const toolOut = (await recallTool.execute({ query: '事件溯源' } as never)) as {
      hits: Array<{ content: string }>
    }
    const list = await store.list()
    const direct = toolOut
    expect(direct.hits.length).toBeGreaterThan(0)
    for (const h of direct.hits) {
      expect(list.some((e) => e.content === h.content)).toBe(true)
    }
  })
})
