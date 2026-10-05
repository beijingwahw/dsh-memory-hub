/**
 * 工具输出契约专场（0.8.0 L5–L8）：把四个工具的 render 全分支与
 * memory_store 的 workspace/tags 清洗/截断边界直接单测，杜绝输出可观察性黑盒。
 * render 分支通过 defineTool 产物对象直接调用（dsh-tools 允许直调 render(args, value)）。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryStoreTool } from '../../src/tools/memory-store'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import { createMemoryForgetTool } from '../../src/tools/memory-forget'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import { createMetrics } from '../../src/memory/metrics'
import type { MemoryEntry, MemoryStore } from '../../src/memory/types'

/** 内存 MemoryStore 替身：真实行为 + 可注入覆盖 */
function mockStore(
  overrides: Partial<MemoryStore> & { diagnostics?: { lines: number; corrupt: number } } = {},
): MemoryStore {
  const entries = new Map<string, MemoryEntry>()
  const base: MemoryStore & { diagnostics?: unknown } = {
    upsert: (e) => {
      entries.set(e.id, e)
      return Promise.resolve(e)
    },
    remove: (id) => Promise.resolve(entries.delete(id)),
    removeMany: (ids) => {
      let n = 0
      for (const id of ids) if (entries.delete(id)) n++
      return Promise.resolve(n)
    },
    list: () => Promise.resolve([...entries.values()]),
    get: (id) => Promise.resolve(entries.get(id)),
    importAll: (es) => {
      let n = 0
      for (const e of es)
        if (!entries.has(e.id)) {
          entries.set(e.id, e)
          n++
        }
      return Promise.resolve(n)
    },
    close: () => Promise.resolve(),
    ...overrides,
  }
  return base
}

type RenderableTool = {
  output: {
    render: (args: unknown, value: Record<string, unknown>) => Array<{ type: string; text: string }>
  }
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

describe('memory_store 守卫分支（L8）', () => {
  it('workspace 注入：有则写入、无则不携带', async () => {
    const store = mockStore()
    const tool = createMemoryStoreTool(store, 1000) as unknown as RenderableTool
    await tool.execute({ content: '记住用 pnpm', kind: 'preference', workspace: 'w-1' })
    const stored = await store.list()
    expect(stored[0]!.workspace).toBe('w-1')

    await tool.execute({ content: '统一格式用 prettier', kind: 'preference' })
    const all = await store.list()
    expect(all[1]!.workspace).toBeUndefined()
  })

  it('tags 清洗：去空格、去重、空串丢弃（schema 已保证元素为 string）', async () => {
    const store = mockStore()
    const tool = createMemoryStoreTool(store, 1000) as unknown as RenderableTool
    await tool.execute({ content: '记住测试事项', tags: [' a ', 'a', '', '  ', 'b'] })
    const stored = await store.list()
    expect(stored[0]!.tags).toEqual(['a', 'b'])
  })

  it('超长内容按 maxChars 截断边界', async () => {
    const store = mockStore()
    const tool = createMemoryStoreTool(store, 10) as unknown as RenderableTool
    await tool.execute({ content: '一二三四五六七八九十一二三四五', kind: 'fact' })
    const stored = await store.list()
    expect(stored[0]!.content).toHaveLength(10)
  })

  it('空 content 抛 EMPTY_CONTENT；敏感内容抛 SENSITIVE_CONTENT', async () => {
    const store = mockStore()
    const tool = createMemoryStoreTool(store, 1000) as unknown as RenderableTool
    await expect(tool.execute({ content: '   ' })).rejects.toMatchObject({ code: 'EMPTY_CONTENT' })
    await expect(tool.execute({ content: '我的 token 是 sk-abcdef1234567890abcdef12' })).rejects.toMatchObject({
      code: 'SENSITIVE_CONTENT',
    })
  })

  it('render 分支：输出 id 与 kind', () => {
    const tool = createMemoryStoreTool(mockStore(), 1000) as unknown as RenderableTool
    const blocks = tool.output.render({}, { id: 'abc', content: 'x', kind: 'fact' })
    expect(blocks[0]!.text).toContain('[memory stored] abc (fact)')
  })
})

describe('memory_status 渲染全形态（L5）', () => {
  it('空库渲染：total 缺省 0、无 oldestAt、无 diagnostics、无 metrics', () => {
    const tool = createMemoryStatusTool(mockStore(), () => 0) as unknown as RenderableTool
    const blocks = tool.output.render({}, {})
    const text = blocks[0]!.text
    expect(text).toContain('0 entries')
    expect(text).not.toContain('\n- from') // oldestAt 缺省分支
    expect(text).not.toContain('\n- storage:') // diagnostics 缺省分支
    expect(text).toContain('metrics: {}')
  })

  it('全形态渲染：oldestAt/newestAt、metrics、diagnostics 全部呈现', () => {
    const metrics = createMetrics()
    metrics.recallCalls = 5
    const store = mockStore({ diagnostics: { lines: 3, corrupt: 1 } })
    const tool = createMemoryStatusTool(store, () => 42, undefined, metrics) as unknown as RenderableTool
    const blocks = tool.output.render(
      {},
      {
        total: 2,
        bytes: 42,
        byKind: { decision: 0, fact: 2, preference: 0, instruction: 0, generic: 0 },
        bySource: { auto: 2, explicit: 0 },
        oldestAt: 1000,
        newestAt: 2000,
        metrics: { recallCalls: 5 },
        diagnostics: { lines: 3, corrupt: 1 },
      },
    )
    const text = blocks[0]!.text
    expect(text).toContain('2 entries, 42 bytes')
    expect(text).toContain('\n- from 1970-01-01T00:00:01.000Z')
    expect(text).toContain('recallCalls')
    expect(text).toContain('\n- storage: {"lines":3,"corrupt":1}')
  })

  it('execute 的 workspace 过滤分支', async () => {
    const store = mockStore()
    const tool = createMemoryStatusTool(store, () => 0) as unknown as RenderableTool
    const seed = {
      id: 's1',
      kind: 'fact' as const,
      content: 'x',
      tags: [],
      source: 'auto' as const,
      createdAt: 1,
      updatedAt: 1,
      accessCount: 0,
      workspace: 'w-1',
    }
    const seed2 = {
      id: 's2',
      kind: 'fact' as const,
      content: 'y',
      tags: [],
      source: 'auto' as const,
      createdAt: 2,
      updatedAt: 2,
      accessCount: 0,
    } // 无 workspace
    await store.upsert(seed)
    await store.upsert(seed2)

    const filtered = await tool.execute({ workspace: 'w-1' })
    // 0.9.0 J 语义升级：无 workspace = 全局共享记忆，指定工作区统计一并计入（与检索引擎语义统一）
    expect(filtered['total']).toBe(2)
    const all = await tool.execute({})
    expect(all['total']).toBe(2)
  })
})

describe('memory_recall 渲染分支（L6）', () => {
  it('零命中渲染：无相关记忆提示', () => {
    const tool = createMemoryRecallTool(mockStore(), 800, 8) as unknown as RenderableTool
    const blocks = tool.output.render({}, { hits: [], total: 0, usedTokens: 0 })
    expect(blocks[0]!.text).toContain('[memory recall] no relevant memories found.')
  })

  it('多命中渲染：条目列表 + token 预算', () => {
    const tool = createMemoryRecallTool(mockStore(), 800, 8) as unknown as RenderableTool
    const blocks = tool.output.render(
      {},
      {
        hits: [
          { id: 'h1', kind: 'fact', content: '第一条记忆', tags: [], score: 0.9 },
          { id: 'h2', kind: 'preference', content: '第二条记忆', tags: [], score: 0.8 },
        ],
        total: 2,
        usedTokens: 42,
      },
    )
    const text = blocks[0]!.text
    expect(text).toContain('2 hit(s), 42 tokens')
    expect(text).toContain('(fact) 第一条记忆')
    expect(text).toContain('(preference) 第二条记忆')
  })

  it('execute 空 query 抛 EMPTY_CONTENT', async () => {
    const tool = createMemoryRecallTool(mockStore(), 800, 8) as unknown as RenderableTool
    await expect(tool.execute({ query: '   ' })).rejects.toMatchObject({ code: 'EMPTY_CONTENT' })
  })
})

describe('memory_forget 渲染分支（L7）', () => {
  it('删除成功渲染 removed；条目不存在渲染 not found', async () => {
    const store = mockStore()
    const tool = createMemoryForgetTool(store) as unknown as RenderableTool
    await store.upsert({
      id: 'f1',
      kind: 'fact',
      content: 'x',
      tags: [],
      source: 'auto',
      createdAt: 1,
      updatedAt: 1,
      accessCount: 0,
    })

    const removed = await tool.execute({ id: 'f1' })
    expect(removed['removed']).toBe(true)
    expect(tool.output.render({}, removed)[0]!.text).toContain('[memory forgotten] f1')

    const missed = await tool.execute({ id: 'f1' })
    expect(missed['removed']).toBe(false)
    expect(tool.output.render({}, missed)[0]!.text).toContain('[memory not found] f1')
  })
})
