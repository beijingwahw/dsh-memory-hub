/**
 * 记忆时间轴（1.5.0，DESIGN-1.5 模块 O）行为锁定。
 *
 * 覆盖面：
 * - timelineFromRaw 纯函数：新增/删除/更新/纯热度四类事件分桶、复活、
 *   旧格式 tombstone（无时间锚）不计事件但作用于存活集、损坏行跳过、
 *   UTC 日边界、总量走势（running + added − removed）、cap 截断 + truncated、
 *   确定性、空库；
 * - JsonlMemoryStore.timeline：真实落盘路径 + 加密库时间轴（解码后分桶一致）+ 只读性；
 * - 工具面 timeline 参数：输出形状、渲染（标题行 + 柱状行）、metrics.statusTimeline、
 *   降级 store（无 timeline 成员）按 createdAt 近似、缺省零回归。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseKeyRecord } from '../../src/memory/crypto'
import { createMetrics } from '../../src/memory/metrics'
import { JsonlMemoryStore, timelineFromRaw } from '../../src/memory/store'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import type { MemoryEntry, MemoryStore } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000 // 2023-11-14（UTC）
const DAY = 24 * 60 * 60 * 1000
const PW = 'timeline 口令'

const DAY0 = new Date(T0).toISOString().slice(0, 10)
const DAY1 = new Date(T0 + DAY).toISOString().slice(0, 10)
const DAY2 = new Date(T0 + 2 * DAY).toISOString().slice(0, 10)

function e(id: string, content: string, at: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return freshEntry({ id, content, createdAt: at, updatedAt: at, ...overrides })
}

function rawLine(x: MemoryEntry): string {
  return JSON.stringify(x)
}

type StatusTool = {
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
}

describe('timelineFromRaw 纯函数（1.5.0 模块 O）', () => {
  it('四类事件分桶：新增/删除/内容更新/纯热度各归其类，总量走势正确', () => {
    const a1 = e('a', '条目 甲', T0)
    const b = e('b', '条目 乙', T0)
    const a2 = { ...a1, content: '条目 甲 改写', updatedAt: T0 + DAY }
    const heat = { ...b, accessCount: 3, lastAccessAt: T0 + DAY + 1000 }
    const c = e('c', '条目 丙', T0 + 2 * DAY)
    const raw = [rawLine(a1), rawLine(b), rawLine(a2), rawLine(heat), rawLine(c)].join('\n') + '\n'
    const t = timelineFromRaw(raw)
    expect(t.events).toBe(5)
    expect(t.truncated).toBe(false)
    expect(t.firstAt).toBe(T0)
    expect(t.lastAt).toBe(T0 + 2 * DAY)
    const byDay = new Map(t.buckets.map((x) => [x.day, x]))
    expect(byDay.get(DAY0)).toEqual({ day: DAY0, added: 2, removed: 0, updated: 0, heat: 0, total: 2 })
    expect(byDay.get(DAY1)).toEqual({ day: DAY1, added: 0, removed: 0, updated: 1, heat: 1, total: 2 })
    expect(byDay.get(DAY2)).toEqual({ day: DAY2, added: 1, removed: 0, updated: 0, heat: 0, total: 3 })
  })

  it('tombstone 删除计事件；删除后复活计 added；旧格式 tombstone 不计事件但作用于存活集', () => {
    const a = e('a', '删除 复活 条目', T0)
    const raw =
      [rawLine(a), JSON.stringify({ __tombstone__: 'a', at: T0 + DAY })].join('\n') +
      '\n' +
      rawLine({ ...a, content: '删除 复活 条目 复活版', updatedAt: T0 + 2 * DAY }) +
      '\n'
    const t = timelineFromRaw(raw)
    expect(t.events).toBe(3) // added + removed + added(复活)
    const byDay = new Map(t.buckets.map((x) => [x.day, x]))
    expect(byDay.get(DAY1)).toMatchObject({ removed: 1, total: 0 })
    expect(byDay.get(DAY2)).toMatchObject({ added: 1, total: 1 })
    // 旧格式（无 at）：不计事件、不影响 firstAt/lastAt，但存活集立即生效
    const rawOld = [rawLine(a), JSON.stringify({ __tombstone__: 'a' })].join('\n') + '\n'
    const tOld = timelineFromRaw(rawOld)
    expect(tOld.events).toBe(1)
    expect(tOld.lastAt).toBe(T0)
    expect(tOld.buckets[0]?.total).toBe(0)
  })

  it('时钟偏斜钳制：删除时刻早于写入时刻时总量钳 0 不为负；ghost tombstone 不计事件', () => {
    const a = e('a', '偏斜 条目', T0 + DAY)
    const raw =
      [
        rawLine(a),
        JSON.stringify({ __tombstone__: 'a', at: T0 }),
        JSON.stringify({ __tombstone__: 'ghost', at: T0 + 2 * DAY }),
      ].join('\n') + '\n'
    const t = timelineFromRaw(raw)
    const byDay = new Map(t.buckets.map((x) => [x.day, x]))
    expect(byDay.get(DAY0)?.total).toBe(0) // max(0, 0-1) 钳制不为负
    expect(byDay.get(DAY0)?.removed).toBe(1)
    expect(byDay.get(DAY1)?.total).toBe(1)
    expect(t.events).toBe(2) // added + removed；ghost（从未存活）不计事件
  })

  it('cap 截断：仅保留最近 cap 桶，truncated=true，events 计数完整', () => {
    const lines: string[] = []
    for (let i = 0; i < 40; i++) lines.push(rawLine(e(`n${i}`, `批量 条目 ${i}`, T0 + i * DAY)))
    const t = timelineFromRaw(lines.join('\n') + '\n', 31)
    expect(t.truncated).toBe(true)
    expect(t.buckets.length).toBe(31)
    expect(t.buckets[0]?.day).toBe(new Date(T0 + 9 * DAY).toISOString().slice(0, 10))
    expect(t.buckets[30]?.total).toBe(40)
    expect(t.events).toBe(40)
  })
})

describe('JsonlMemoryStore.timeline（1.5.0 模块 O）', () => {
  it('真实落盘路径：与 timelineFromRaw 同语义；只读不改 revision', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-tl-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(e('a', '时间轴 条目 甲', T0))
    await store.upsert(e('b', '时间轴 条目 乙', T0 + DAY))
    await store.removeMany(['a'], T0 + 2 * DAY)
    const rev = store.revision
    const t = await store.timeline()
    expect(store.revision).toBe(rev) // 只读
    expect(t.events).toBe(3)
    expect(t.buckets.map((x) => x.day)).toEqual([DAY0, DAY1, DAY2])
    expect(t.buckets[2]?.total).toBe(1)
    await store.close()
  })

  it('加密库时间轴：解码后分桶与明文历史逐项一致', async () => {
    const plain = join(mkdtempSync(join(tmpdir(), 'mh-tl-p-')), 'memories.jsonl')
    {
      const store = await JsonlMemoryStore.open(plain)
      await store.upsert(e('a', '加密 时间轴 甲', T0))
      await store.upsert({ ...e('a', '加密 时间轴 甲', T0), content: '加密 时间轴 甲 v2', updatedAt: T0 + DAY })
      await store.removeMany(['a'], T0 + 2 * DAY)
      await store.close()
    }
    // 对含完整历史行（含 tombstone）的明文库带口令重开 → 原位加密迁移后时间轴语义不变
    const migrated = await JsonlMemoryStore.open(plain, undefined, { passphrase: PW })
    expect(parseKeyRecord(readFileSync(plain, 'utf8').split('\n')[0]!)).toBeDefined()
    const tEnc = await migrated.timeline()
    expect(tEnc.events).toBe(3) // added + updated + removed
    expect(tEnc.buckets.map((x) => x.day)).toEqual([DAY0, DAY1, DAY2])
    await migrated.close()
  })
})

describe('memory_status timeline 参数（1.5.0 模块 O）', () => {
  it('输出形状 + 渲染（标题行 + 柱状行）+ metrics.statusTimeline 计数', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-tl-tool-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(e('a', '工具 时间轴 甲', T0))
    await store.upsert(e('b', '工具 时间轴 乙', T0))
    await store.upsert({ ...e('a', '工具 时间轴 甲', T0), content: '工具 时间轴 甲 v2', updatedAt: T0 + DAY })
    const metrics = createMetrics()
    const tool = createMemoryStatusTool(store, () => 0, undefined, metrics) as unknown as StatusTool
    const out = await tool.execute({ timeline: true })
    const t = out['timeline'] as { events: number; buckets: Array<{ day: string; total: number }> }
    expect(t.events).toBe(3)
    expect(t.buckets.map((b) => b.day)).toEqual([DAY0, DAY1])
    expect(t.buckets[1]?.total).toBe(2)
    expect(metrics.statusTimeline).toBe(1)
    const rendered = tool.output.render({ timeline: true }, out)
    expect(rendered[0]?.text).toContain(`[memory timeline] ${DAY0} → ${DAY1} · 2 天 · 事件 3`)
    expect(rendered[0]?.text).toContain(`${DAY1} │`)
    expect(rendered[0]?.text).toContain('= 2')
    await store.close()
  })

  it('空库渲染臂：无时间锚事件时输出 empty 提示', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-tl-empty-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const out = await tool.execute({ timeline: true })
    const rendered = tool.output.render({ timeline: true }, out)
    expect(rendered[0]?.text).toContain('[memory timeline] empty')
    await store.close()
  })

  it('降级 store（无 timeline 成员）：按 createdAt 近似（只有新增事件）', async () => {
    let rows = [e('d1', '降级 时间轴 甲', T0), e('d2', '降级 时间轴 乙', T0 + DAY)]
    const store = {
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
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const out = await tool.execute({ timeline: true })
    const t = out['timeline'] as {
      events: number
      truncated: boolean
      buckets: Array<{ day: string; added: number; removed: number; total: number }>
    }
    expect(t.events).toBe(2)
    expect(t.truncated).toBe(false)
    expect(t.buckets.map((b) => b.day)).toEqual([DAY0, DAY1])
    expect(t.buckets.every((b) => b.removed === 0)).toBe(true)
    expect(t.buckets[1]?.total).toBe(2)
  })

  it('降级 store 超过 31 天：truncated=true 仅保留最近 31 桶', async () => {
    let rows = Array.from({ length: 35 }, (_, i) => e(`d${i}`, `降级 长时间轴 ${i}`, T0 + i * DAY))
    const store = {
      upsert: (x: MemoryEntry) => Promise.resolve(x),
      list: () => Promise.resolve([...rows].sort((a, b) => a.createdAt - b.createdAt)),
      get: (id: string) => Promise.resolve(rows.find((r) => r.id === id)),
      remove: (id: string) => {
        rows = rows.filter((r) => r.id !== id)
        return Promise.resolve(true)
      },
      close: () => Promise.resolve(),
    } as unknown as MemoryStore
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const out = await tool.execute({ timeline: true })
    const t = out['timeline'] as { truncated: boolean; events: number; buckets: Array<{ day: string; total: number }> }
    expect(t.truncated).toBe(true)
    expect(t.buckets.length).toBe(31)
    expect(t.buckets[30]?.total).toBe(35)
    expect(t.events).toBe(35)
  })

  it('渲染臂补全：truncated 时间轴渲染含截断标记；graph 维度 fabricated 值渲染含 +/− 边样本', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-tl-r-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    // fabricated truncated 时间轴（渲染为纯函数，直测截断标记臂）
    const buckets = Array.from({ length: 3 }, (_, i) => ({
      day: `2026-10-2${i}`,
      added: i + 1,
      removed: 0,
      updated: 0,
      heat: 0,
      total: i + 1,
    }))
    const rendered = tool.output.render(
      { timeline: true },
      { timeline: { firstAt: 1, lastAt: 2, events: 6, truncated: true, buckets } },
    )
    expect(rendered[0]?.text).toContain('3 天+ · 事件 6（仅保留最近 31 天）')
    // fabricated graph 维 diff（>3 边样本截断 + 无边数组臂）
    const gd = tool.output.render(
      { diffSince: 1, asOf: 2, graphDiff: true },
      {
        diffSince: 1,
        asOf: 2,
        diff: {
          addedCount: 0,
          removedCount: 0,
          updatedCount: 0,
          heatOnly: 0,
          graph: {
            beforeEntities: 3,
            afterEntities: 4,
            addedEdgeCount: 5,
            removedEdgeCount: 5,
            addedEdges: Array.from({ length: 4 }, (_, i) => ({ from: `a${i}`, relation: 'uses', to: `b${i}` })),
            removedEdges: Array.from({ length: 4 }, (_, i) => ({ from: `c${i}`, relation: 'uses', to: `d${i}` })),
          },
        },
      },
    )
    expect(gd[0]?.text).toContain('graph: entities 3→4, +5 −5 edge(s)')
    // graph 键存在但无边明细数组（?? [] 兜底臂）：只渲染计数行
    const gdBare = tool.output.render(
      { diffSince: 1, asOf: 2, graphDiff: true },
      {
        diff: {
          addedCount: 0,
          removedCount: 0,
          updatedCount: 0,
          heatOnly: 0,
          graph: { beforeEntities: 1, afterEntities: 2, addedEdgeCount: 7, removedEdgeCount: 0 },
        },
      },
    )
    expect(gdBare[0]?.text).toContain('graph: entities 1→2, +7 −0 edge(s)')
    expect(gd[0]?.text).toContain('+ a2 —uses→ b2') // 4 边样本只渲染前 3
    expect(gd[0]?.text).not.toContain('+ a3 —uses→ b3')
    await store.close()
  })

  it('普通视图渲染全分支直测（0.8.0 render 白盒传统）：全字段在场 / 最小字段两臂', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-tl-full-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    // 全字段在场：每个可选行都渲染
    const full = tool.output.render(
      {},
      {
        total: 3,
        byKind: { decision: 1, fact: 1, preference: 0, instruction: 0, generic: 1 },
        bySource: { auto: 2, explicit: 1 },
        bytes: 42,
        oldestAt: T0,
        newestAt: T0 + DAY,
        superseded: 1,
        hot: 2,
        cold: 1,
        themes: [{ id: 'th1', label: '部署', memberCount: 2, topKinds: ['fact'] }],
        duplicateRatio: 0.5,
        distilled: { abstract: 1, procedural: 2 },
        graph: { entities: 5, edges: 6, activeEdges: 4, supersededEdges: 2, evicted: 1 },
        dueCount: 2,
        strengthSummary: { total: 3, strengthAvg: 0.7, strengthMedian: 0.6, minR: 0.3 },
        conflictPairs: { count: 1, samples: ['a|b'] },
        suggestion: '清理被取代记忆',
        metrics: { recallCalls: 1 },
        diagnostics: { lines: 9, corrupt: 0, encrypted: true, compact: { reclaimed: 2, ratio: 0.2, at: 7 } },
      },
    )
    const text = full[0]?.text ?? ''
    expect(text).toContain('- from ')
    expect(text).toContain('- superseded: 1')
    expect(text).toContain('- layering: hot=2, cold=1')
    expect(text).toContain('- themes: 部署(2)')
    expect(text).toContain('- duplicateRatio: 0.50')
    expect(text).toContain('- distilled: abstract=1, procedural=2')
    expect(text).toContain('- graph: entities=5, edges=6, active=4, evicted=1')
    expect(text).toContain('- consolidation: due=2, strengthAvg=0.70, minR=0.300')
    expect(text).toContain('- conflicts: 1 pair(s) a|b')
    expect(text).toContain('- suggestion: 清理被取代记忆')
    expect(text).toContain('- metrics: {"recallCalls":1}')
    expect(text).toContain('- storage: ')
    // 最小字段：可选行全部缺席（each 可选行 false 臂）
    const bare = tool.output.render({}, { total: 0, byKind: {}, bySource: {}, bytes: 0 })
    const bareText = bare[0]?.text ?? ''
    expect(bareText).not.toContain('- from ')
    expect(bareText).not.toContain('- superseded')
    expect(bareText).not.toContain('- layering')
    expect(bareText).not.toContain('- themes')
    expect(bareText).not.toContain('- duplicateRatio')
    expect(bareText).not.toContain('- distilled')
    expect(bareText).not.toContain('- graph')
    expect(bareText).not.toContain('- consolidation')
    expect(bareText).not.toContain('- conflicts')
    expect(bareText).not.toContain('- suggestion')
    await store.close()
  })

  it('渲染容错臂直测：缺字段的样本对象安全渲染（?? 兜底）+ logger 在场计时臂', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-tl-tolerant-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const logged: string[] = []
    const metrics = createMetrics()
    const tool = createMemoryStatusTool(
      store,
      () => 0,
      (m) => logged.push(m),
      metrics,
    ) as unknown as StatusTool
    // timeline 视图 + logger 在场：渲染与日志计时臂
    await tool.execute({ timeline: true })
    expect(logged.some((m) => m.includes('[dsh-memory-hub] timeline:'))).toBe(true)
    // diff 视图：样本对象缺字段（title/change/from/relation/to 均缺席 → ?? '' 兜底不崩）
    const out = await tool.execute({ diffSince: T0 - 1, asOf: T0 + DAY, graphDiff: true })
    const patched = {
      ...out,
      diff: {
        ...(out['diff'] as object),
        added: [{}],
        removed: [{}],
        updated: [{}],
        graph: {
          beforeEntities: 0,
          afterEntities: 0,
          addedEdgeCount: 1,
          removedEdgeCount: 1,
          addedEdges: [{}],
          removedEdges: [{}],
        },
      },
    }
    const rendered = tool.output.render({ diffSince: T0 - 1, asOf: T0 + DAY, graphDiff: true }, patched)
    expect(rendered[0]?.text).toContain('+0 -0 ~0')
    expect(rendered[0]?.text).toContain('+  —→')
    expect(rendered[0]?.text).toContain('~  []')
    // 普通视图：主题缺 label/memberCount 的 ?? 0 兜底
    const plain = tool.output.render({}, { themes: [{}] })
    expect(plain[0]?.text).toContain('- themes: (0)')
    await store.close()
  })

  it('降级 store 普通视图：无 diagnostics 成员（in 探测为 false）+ 蒸馏分层计数臂', async () => {
    let rows = [
      e('d1', '降级 普通 视图', T0, { tags: ['distilled-layer:abstract', 'distilled-from:x'] }),
      e('d2', '降级 普通 视图 乙', T0, { tags: ['distilled-layer:procedural', 'distilled-from:y'] }),
      e('d3', '降级 普通 视图 丙', T0),
    ]
    const store = {
      upsert: (x: MemoryEntry) => Promise.resolve(x),
      list: () => Promise.resolve([...rows]),
      get: (id: string) => Promise.resolve(rows.find((r) => r.id === id)),
      remove: (id: string) => {
        rows = rows.filter((r) => r.id !== id)
        return Promise.resolve(true)
      },
      close: () => Promise.resolve(),
    } as unknown as MemoryStore
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const out = (await tool.execute({})) as {
      diagnostics?: unknown
      distilled?: { abstract: number; procedural: number }
    }
    expect(out.diagnostics).toBeUndefined() // 'diagnostics' in store 为 false 臂
    expect(out.distilled).toEqual({ abstract: 1, procedural: 1 })
  })

  it('缺省零回归：timeline 参数缺席时输出形状与 1.4.0 一致（无 timeline 键）', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-tl-def-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(e('a', '缺省 形状 条目', T0))
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const out = await tool.execute({})
    expect(out['timeline']).toBeUndefined()
    expect(out['total']).toBe(1)
    await store.close()
  })
})
