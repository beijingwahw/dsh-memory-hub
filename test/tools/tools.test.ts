import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlMemoryStore } from '../../src/memory/store'
import { createMemoryForgetTool } from '../../src/tools/memory-forget'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import { createMemoryStoreTool } from '../../src/tools/memory-store'

type Toolish = { name: string; execute: (args: never) => Promise<Record<string, unknown>> }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-tools-'))
  const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
  return {
    store,
    storeTool: createMemoryStoreTool(store, 1000) as unknown as Toolish,
    recallTool: createMemoryRecallTool(store, 800, 8) as unknown as Toolish,
    forgetTool: createMemoryForgetTool(store) as unknown as Toolish,
    statusTool: createMemoryStatusTool(store, () => Promise.resolve(0)) as unknown as Toolish,
  }
}

describe('memory 工具链', () => {
  it('store → recall → status → forget 全流程', async () => {
    const { storeTool, recallTool, forgetTool, statusTool, store } = await setup()

    // 1. 显式记忆
    const stored = (await storeTool.execute({
      content: '用户偏好使用 pnpm 管理依赖',
      kind: 'preference',
      tags: ['node'],
    } as never)) as {
      id: string
      kind: string
      content?: string
    }
    expect(stored.id).toBeTypeOf('string')
    expect(stored.kind).toBe('preference')

    // 2. 召回
    const recalled = (await recallTool.execute({ query: 'pnpm 依赖' } as never)) as {
      hits?: Array<{ content: string; score: number }>
    }
    const hits = recalled.hits ?? []
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toContain('pnpm')
    expect(hits[0]!.score).toBeGreaterThan(0)

    // 3. 状态统计
    const status = (await statusTool.execute({} as never)) as { total?: number; bySource?: Record<string, number> }
    expect(status.total).toBe(1)
    expect(status.bySource!['explicit']).toBe(1)

    // 4. 遗忘
    const forgotten = (await forgetTool.execute({ id: stored.id } as never)) as { removed?: boolean }
    expect(forgotten.removed).toBe(true)
    expect(await store.list()).toHaveLength(0)

    // 5. 再次遗忘返回 not found
    const again = (await forgetTool.execute({ id: stored.id } as never)) as { removed?: boolean }
    expect(again.removed).toBe(false)
  })

  it('store 截断超长内容并清洗 tags', async () => {
    const { storeTool, store } = await setup()
    const long = 'x'.repeat(2000)
    const stored = (await storeTool.execute({ content: long, tags: ['  a  ', '', 'a', 'b'] } as never)) as {
      content?: string
    }
    expect(stored.content!.length).toBeLessThanOrEqual(1000)
    const list = await store.list()
    expect(list[0]!.tags.sort()).toEqual(['a', 'b'])
  })

  it('空内容拒绝写入', async () => {
    const { storeTool } = await setup()
    await expect(storeTool.execute({ content: '   ' } as never)).rejects.toThrow()
  })

  it('recall 命中后访问热度递增', async () => {
    const { storeTool, recallTool, store } = await setup()
    await storeTool.execute({ content: '记住以后汇报用中文' } as never)
    const recalled = (await recallTool.execute({ query: '汇报 中文' } as never)) as {
      hits?: Array<{ content: string; score: number }>
    }
    expect(recalled.hits!.length).toBe(1)
    // 等后台热度更新完成
    await new Promise((r) => setTimeout(r, 50))
    const list = await store.list()
    expect(list[0]!.accessCount).toBeGreaterThanOrEqual(1)
  })
})
