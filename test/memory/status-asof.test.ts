/**
 * 时间分析视图（1.4.0，DESIGN-1.4 模块 J）行为锁定。
 *
 * 覆盖面：
 * - diffReplay 纯函数：新增/消失/内容变更/取代/矛盾/纯热度六类归因、计数、
 *   标题裁剪（>24 字符）、确定性、双侧空集；
 * - memory_status asOf 快照：只输出语料层字段（bytes/metrics/diagnostics/graph 不掺入）、
 *   以 asOf 为「现在」的冷热分层、asOf 回显、metrics.statusAsOf 计数、渲染含时刻；
 * - memory_status diff 视图：计数与手算一致、明细 ≤20 截断、diffSince > asOf 拒参、
 *   仅 diffSince（终点=现在）、渲染含 +/−/~ 摘要行；
 * - 降级 store（无 listAsOf）：按 createdAt 过滤近似、removed 恒空；
 * - workspace 过滤与时间视图叠加；非法 asOf（≤0/NaN）按缺省处理回落当前视图。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffReplay } from '../../src/memory/store'
import { createMetrics } from '../../src/memory/metrics'
import { JsonlMemoryStore } from '../../src/memory/store'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import type { MemoryEntry, MemoryStore } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function e(id: string, content: string, at: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return freshEntry({ id, content, createdAt: at, updatedAt: at, ...overrides })
}

/** 降级 store：无 listAsOf（接口可选扩展未实现时的近似路径） */
function degradedStore(initial: MemoryEntry[]): MemoryStore {
  let rows = [...initial]
  return {
    upsert: (x: MemoryEntry) => {
      rows = [...rows.filter((r) => r.id !== x.id), x]
      return Promise.resolve(x)
    },
    list: () => Promise.resolve([...rows].sort((a, b) => a.createdAt - b.createdAt)),
    get: (id: string) => Promise.resolve(rows.find((r) => r.id === id)),
    remove: (id: string) => {
      rows = rows.filter((r) => r.id !== id)
      return Promise.resolve(true)
    },
    close: () => Promise.resolve(),
  } as unknown as MemoryStore
}

type StatusTool = {
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
}

describe('diffReplay 纯函数（1.4.0 模块 J）', () => {
  it('六类归因：added/removed/content/supersede/conflict/heatOnly 各归其类', () => {
    const before = [
      e('kept', '保持不变 的条目', T0),
      e('gone', '被删除 的条目', T0),
      e('edited', '内容 旧版本', T0),
      e('suped', '缓存 使用 Redis', T0),
      e('conflicted', '测试框架 用 Jest', T0),
      e('hot', '仅热度变化 的条目', T0),
      e('tagged', '标签变化的条目', T0),
    ]
    const after = [
      before[0]!,
      // gone 消失（tombstone）
      { ...before[2]!, content: '内容 新版本', updatedAt: T0 + DAY },
      { ...before[3]!, tags: ['superseded-by:new1'], updatedAt: T0 + DAY },
      { ...before[4]!, tags: ['conflicts-with:peer'], updatedAt: T0 + DAY },
      { ...before[5]!, accessCount: 3, lastAccessAt: T0 + DAY },
      { ...before[6]!, tags: ['extra-tag'], updatedAt: T0 + DAY },
      e('new1', '缓存 使用 Valkey', T0 + 2 * DAY),
    ]
    const d = diffReplay(before, after, T0, T0 + 2 * DAY)
    expect(d.addedCount).toBe(1)
    expect(d.added[0]).toMatchObject({ id: 'new1', kind: 'fact', title: '缓存 使用 Valkey' })
    expect(d.removedCount).toBe(1)
    expect(d.removed[0]?.id).toBe('gone')
    expect(d.updatedCount).toBe(4)
    const byId = new Map(d.updated.map((u) => [u.id, u.change]))
    expect(byId.get('edited')).toBe('content')
    expect(byId.get('suped')).toBe('supersede')
    expect(byId.get('conflicted')).toBe('conflict')
    expect(byId.get('tagged')).toBe('tags')
    expect(d.heatOnly).toBe(1)
    expect(d.since).toBe(T0)
    expect(d.until).toBe(T0 + 2 * DAY)
  })

  it('标题裁剪：超 24 字符首行折叠空白并以 … 截断；多行取首行', () => {
    const before: MemoryEntry[] = []
    const after = [e('long', `第一行 很长的标题 ${'甲'.repeat(30)}\n第二行内容`, T0)]
    const d = diffReplay(before, after, T0, T0 + 1)
    expect(d.added[0]?.title.length).toBe(25) // 24 + …
    expect(d.added[0]?.title.endsWith('…')).toBe(true)
    expect(d.added[0]?.title).not.toContain('第二行')
  })

  it('确定性：同输入两次计算 deep-equal；双侧空集零差异', () => {
    const d1 = diffReplay([], [], T0, T0 + DAY)
    const d2 = diffReplay([], [], T0, T0 + DAY)
    expect(d1).toEqual({
      since: T0,
      until: T0 + DAY,
      addedCount: 0,
      removedCount: 0,
      updatedCount: 0,
      heatOnly: 0,
      added: [],
      removed: [],
      updated: [],
    })
    expect(d1).toEqual(d2)
  })
})

describe('memory_status 时间视图（1.4.0 模块 J）', () => {
  /** 分阶段语料：T0 建 a/b；T1 a 内容改写；T2 b 被取代（标记）+ successor；T3 新条目 c；T4 删 b */
  async function stagedStore(): Promise<{
    file: string
    store: JsonlMemoryStore
    tool: StatusTool
    metrics: ReturnType<typeof createMetrics>
  }> {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-asof-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const a1 = e('a', '部署用 Node 18', T0)
    await store.upsert(a1)
    await store.upsert(e('b', '缓存 使用 Redis', T0))
    await store.upsert({ ...a1, content: '部署用 Node 20', updatedAt: T0 + DAY })
    await store.upsert({ ...e('b', '缓存 使用 Redis', T0), tags: ['superseded-by:succ'], updatedAt: T0 + 2 * DAY })
    await store.upsert(e('succ', '缓存 使用 Valkey', T0 + 2 * DAY))
    await store.upsert(e('c', '网关 使用 Nginx', T0 + 3 * DAY))
    await store.removeMany(['b'], T0 + 4 * DAY)
    const metrics = createMetrics()
    const tool = createMemoryStatusTool(store, () => 0, undefined, metrics) as unknown as StatusTool
    return { file, store, tool, metrics }
  }

  it('asOf 快照：只输出语料层字段（无 bytes/metrics/diagnostics/graph）、冷热以 asOf 为现在、渲染含时刻', async () => {
    const { tool, metrics } = await stagedStore()
    const out = await tool.execute({ asOf: T0 + 3 * DAY + 1000 })
    expect(out['asOf']).toBe(T0 + 3 * DAY + 1000)
    expect(out['total']).toBe(4) // a/succ/b(已被取代但 T3 时刻仍存在)/c
    expect(out['superseded']).toBe(1)
    expect(out['hot']).toBeDefined()
    expect(out['cold']).toBeDefined()
    // 语料层字段封闭：不得掺入运行时观测
    expect(out['bytes']).toBeUndefined()
    expect(out['metrics']).toBeUndefined()
    expect(out['diagnostics']).toBeUndefined()
    expect(out['graph']).toBeUndefined()
    expect(metrics.statusAsOf).toBe(1)
    const rendered = tool.output.render({ asOf: T0 + 3 * DAY + 1000 }, out)
    expect(rendered[0]?.text).toContain(`@${new Date(T0 + 3 * DAY + 1000).toISOString()}`)
    expect(rendered[0]?.text).toContain('4 entries')
    expect(rendered[0]?.text).not.toContain('bytes')
  })

  it('diff 视图：计数与手算一致（+succ+c ~a·b −b），渲染含 +/−/~ 摘要', async () => {
    const { tool } = await stagedStore()
    const T1 = T0 + DAY + 1000 // a 已改写
    const T4 = T0 + 4 * DAY + 1000 // b 已删除
    const out = await tool.execute({ diffSince: T1, asOf: T4 })
    const d = out['diff'] as Record<string, unknown>
    expect(out['asOf']).toBe(T4)
    expect(out['diffSince']).toBe(T1)
    expect(out['total']).toBe(3) // a/succ/c
    expect(d['addedCount']).toBe(2) // succ + c
    expect(d['removedCount']).toBe(1) // b（T2 打取代标记、T4 被删除 → 终态是消失，不报 updated）
    expect(d['updatedCount']).toBe(0)
    expect(d['updated']).toEqual([])
    const rendered = tool.output.render({ diffSince: T1, asOf: T4 }, out)
    expect(rendered[0]?.text).toContain('[memory status diff')
    expect(rendered[0]?.text).toContain('+2 -1 ~0')
  })

  it('纯热度区间：访问巩固只进 heatOnly 计数，不列明细', async () => {
    const { store, tool } = await stagedStore()
    const a2 = (await store.get('a'))!
    await store.upsertMany([{ ...a2, accessCount: 5, lastAccessAt: T0 + 5 * DAY }])
    const T4 = T0 + 4 * DAY + 1000
    const T5 = T0 + 5 * DAY + 1000
    const out = await tool.execute({ diffSince: T4, asOf: T5 })
    const d = out['diff'] as { addedCount: number; removedCount: number; updatedCount: number; heatOnly: number }
    expect(d.addedCount).toBe(0)
    expect(d.removedCount).toBe(0)
    expect(d.updatedCount).toBe(0)
    expect(d.heatOnly).toBe(1)
  })

  it('明细 ≤20 截断而计数完整；diffSince > asOf 拒参；仅 diffSince 时终点=现在', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-cap-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const now = Date.now()
    await store.upsertMany(Array.from({ length: 25 }, (_, i) => e(`n${i}`, `批量 条目 ${i}`, now - 1000 + i)))
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const out = await tool.execute({ diffSince: now - 2000, asOf: now + 2000 })
    const d = out['diff'] as { addedCount: number; added: unknown[] }
    expect(d.addedCount).toBe(25)
    expect(d.added.length).toBe(20)
    await expect(tool.execute({ diffSince: now + 1000, asOf: now })).rejects.toThrow('must be ≤ asOf')
    // 仅 diffSince（asOf 缺省 → 终点=现在）：能看到全部条目
    const onlySince = await tool.execute({ diffSince: now - 2000 })
    expect((onlySince['diff'] as { addedCount: number }).addedCount).toBe(25)
    await store.close()
  })

  it('降级 store：按 createdAt 过滤近似、removed 恒空（看不见 tombstone）', async () => {
    const store = degradedStore([e('d1', '降级 条目 1', T0), e('d2', '未来的条目', T0 + 10 * DAY)])
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const snap = await tool.execute({ asOf: T0 + DAY })
    expect(snap['total']).toBe(1)
    const diff = await tool.execute({ diffSince: T0 - 1, asOf: T0 + DAY })
    const d = diff['diff'] as { addedCount: number; removedCount: number }
    expect(d.addedCount).toBe(1)
    expect(d.removedCount).toBe(0)
  })

  it('workspace 过滤叠加时间视图；非法 asOf（0/NaN）按缺省回落当前视图', async () => {
    const store = degradedStore([e('w1', '工作区 条目', T0, { workspace: 'proj-a' }), e('g1', '全局 条目', T0)])
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const scoped = (await tool.execute({ asOf: T0 + DAY, workspace: 'proj-a' })) as { total: number }
    expect(scoped.total).toBe(2) // 统一隔离语义：全局共享 + 指定工作区
    // asOf 非法值：0 是合法 JSON 数 → 按缺省回落当前视图；NaN 在 dsh-tools schema 层即拒收
    const current = await tool.execute({ asOf: 0 })
    expect(current['asOf']).toBeUndefined()
    await expect(tool.execute({ asOf: Number.NaN })).rejects.toThrow('finite JSON number')
  })

  it('asOf 快照含蒸馏分层与矛盾对：时间视图输出 distilled/conflictPairs', async () => {
    const store = degradedStore([
      e('d1', '蒸馏 抽象层 条目', T0, { tags: ['distilled-layer:abstract', 'distilled-from:x'] }),
      e('d2', '蒸馏 程序层 条目', T0, { tags: ['distilled-layer:procedural', 'distilled-from:y'] }),
      e('ca', '测试框架 用 Jest', T0, { tags: ['conflicts-with:cb'] }),
      e('cb', '测试框架不再用 Jest', T0, { tags: ['conflict-of:ca'] }),
    ])
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const out = (await tool.execute({ asOf: T0 + DAY })) as {
      distilled?: { abstract: number; procedural: number }
      conflictPairs?: { count: number }
      superseded: number
    }
    expect(out.distilled).toEqual({ abstract: 1, procedural: 1 })
    expect(out.conflictPairs?.count).toBeGreaterThanOrEqual(1)
    // 渲染：asOf 视图带蒸馏与矛盾行
    const rendered = tool.output.render({ asOf: T0 + DAY }, out)
    expect(rendered[0]?.text).toContain('distilled: abstract=1, procedural=1')
    expect(rendered[0]?.text).toContain('conflicts: 1 pair')
  })

  it('空 diff 渲染臂：全零计数 + 空样本数组', async () => {
    const store = degradedStore([e('s1', '稳定 条目', T0)])
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    // 起点含该条目（T0 时已存在）→ 窗口内零变化
    const out = await tool.execute({ diffSince: T0, asOf: T0 + DAY })
    const d = out['diff'] as { addedCount: number; removedCount: number; updatedCount: number }
    expect(d.addedCount + d.removedCount + d.updatedCount).toBe(0)
    const rendered = tool.output.render({ diffSince: T0, asOf: T0 + DAY }, out)
    expect(rendered[0]?.text).toContain('+0 -0 ~0')
  })
})
