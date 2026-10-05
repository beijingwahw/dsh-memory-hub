/**
 * 信念修正与矛盾共存离线质量门禁（DESIGN-1.1 F2，门禁 G12）：`npm run eval` 一键运行。
 *
 * G12 门限（与 DESIGN-1.1 模块 D 对齐）：
 *  1. 矛盾检出：疑似反转 + 相近（sim > 0.55）→ 命中旧条目；无对立信号 / 低相似 → 不命中；
 *  2. 与 supersede 区分（打标互斥）：「改用 X」类只走 supersede 不标 conflict；
 *  3. 强指令排除：kind=instruction 且含 必须/务必 → 止损指令不判矛盾；
 *  4. 并存语义：冲突对双方在召回中同时出现（不剔除），新者序先（conflictAwareOrder）；
 *  5. 可观测：summarizeConflictPairs 计数与最近样本正确；
 *  6. 零行为回归：conflictMode 缺省 off 时入库不产生任何矛盾标注（与 1.0.0 一致）。
 *
 * 夹具设计（4 组，覆盖 G12-F2 全部冲突场景）：
 *  - 对立重建：不再使用的疑似反转 → conflicts-with 双向标注；
 *  - 数据更新：改用/升级到 → 只 supersede、无冲突（互斥）；
 *  - 指令止损：必须/务必类指令 → 不判矛盾；
 *  - 真假矛盾：无对立信号的相似陈述、低相似对立 → 均不误报。
 */
import { describe, expect, it } from 'vitest'
import {
  conflictAwareOrder,
  conflictPeerIds,
  CONFLICT_SIMILARITY_THRESHOLD,
  detectContradiction,
  hasConflictSignal,
  summarizeConflictPairs,
} from '../src/memory/conflict'
import { ingestCaptured, type IngestOptions } from '../src/memory/ingest'
import type { HubMetrics } from '../src/memory/metrics'
import type { MemoryEntry, MemoryHit, MemoryStore } from '../src/memory/types'

const DAY = 24 * 60 * 60 * 1000
// ingestCaptured 内部用真实 Date.now() 判窗口（30 天），夹具时间基准必须贴近当前，
// 否则旧条目 createdAt 落在窗口外被判「失去冲突资格」。
const NOW = Date.now()

function entry(content: string, overrides: Partial<MemoryEntry> & { content?: string } = {}): MemoryEntry {
  return {
    id: `e-${content.length}-${content.charCodeAt(0) ?? 0}`,
    kind: 'fact',
    tags: [],
    source: 'auto',
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    accessCount: 0,
    content,
    ...overrides,
  }
}

/** 内存版 MemoryStore（满足 ingestCaptured 最小接口） */
function memoryStore(initial: MemoryEntry[] = []): MemoryStore {
  let rows = [...initial]
  return {
    upsert(e: MemoryEntry): Promise<MemoryEntry> {
      const i = rows.findIndex((r) => r.id === e.id)
      if (i >= 0) rows[i] = e
      else rows.push({ ...e })
      return Promise.resolve(rows.find((r) => r.id === e.id)!)
    },
    list(): Promise<MemoryEntry[]> {
      return Promise.resolve([...rows])
    },
    get(id: string): Promise<MemoryEntry | undefined> {
      return Promise.resolve(rows.find((r) => r.id === id))
    },
    remove(id: string): Promise<boolean> {
      const before = rows.length
      rows = rows.filter((r) => r.id !== id)
      return Promise.resolve(rows.length < before)
    },
    close(): Promise<void> {
      return Promise.resolve()
    },
  } as unknown as MemoryStore
}

function hit(e: MemoryEntry): MemoryHit {
  return { ...e, score: 1 }
}

const noopMetrics: HubMetrics = {
  capturedTotal: 0,
  explicitStored: 0,
  recallCalls: 0,
  recallHits: 0,
  forgotten: 0,
  rejectedSensitive: 0,
  rejectedDuplicate: 0,
  pruned: 0,
  dropped: 0,
  errors: 0,
}
const recordMetrics = () => {
  const metrics: HubMetrics = { ...noopMetrics }
  return {
    metrics,
    counts: () => ({ captured: metrics.capturedTotal, rejected: metrics.rejectedDuplicate }),
  }
}

const baseOpts: IngestOptions = {
  maxEntryChars: 600,
  dedupWindowMs: 30 * DAY,
  conflictMode: 'auto',
  conflictSameKind: true,
}

describe('G12 对立重建：疑似反转命中矛盾共存', () => {
  it('不再使用 X → conflicts-with 双向标注（新条 + 旧条）', async () => {
    const store = memoryStore([entry('部署环境使用 MySQL', { id: 'mysql' })])
    const { metrics, counts } = recordMetrics()
    await ingestCaptured(
      store,
      [{ content: '部署环境不再使用 MySQL', kind: 'fact', tags: [] }],
      baseOpts,
      metrics,
      undefined,
    )
    const rows = await store.list()
    const nu = rows.find((r) => r.content.includes('不再使用'))!
    const old = rows.find((r) => r.id === 'mysql')!
    expect(nu.tags).toContain('conflicts-with:mysql')
    expect(old.tags).toContain('conflict-of:' + nu.id)
    expect(counts().captured).toBe(1)
  })

  it('detectContradiction：疑似反转 + 相近 → 命中旧条目', () => {
    const existing = [entry('部署环境使用 MySQL', { id: 'mysql' })]
    const found = detectContradiction(
      existing,
      { content: '部署环境不再使用 MySQL', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(found?.id).toBe('mysql')
    expect(CONFLICT_SIMILARITY_THRESHOLD).toBe(0.55)
  })
})

describe('G12 数据更新：与 supersede 打标互斥', () => {
  it('「改用 X」只走 supersede、零 conflict 标注', async () => {
    const store = memoryStore([entry('部署方案使用 docker compose', { id: 'docker' })])
    const { metrics } = recordMetrics()
    await ingestCaptured(
      store,
      [{ content: '部署方案换成 docker compose', kind: 'fact', tags: [] }],
      { ...baseOpts, supersedeMode: 'auto' },
      metrics,
      undefined,
    )
    const rows = await store.list()
    const nu = rows.find((r) => r.content.includes('换成'))!
    const old = rows.find((r) => r.id === 'docker')!
    expect(nu.tags).toContain('supersede:docker')
    expect(nu.tags.some((t) => t.startsWith('conflicts-with:'))).toBe(false)
    expect(old.tags).toContain('superseded-by:' + nu.id)
    expect(old.tags.some((t) => t.startsWith('conflict-of:'))).toBe(false)
  })

  it('「升级到」是 supersede 强信号不是 conflict 弱信号', () => {
    expect(hasConflictSignal('升级到 Node 20')).toBe(false)
    expect(hasConflictSignal('改用 Redis')).toBe(false)
    expect(hasConflictSignal('不再使用 Redis')).toBe(true)
    expect(hasConflictSignal('停止使用旧方案')).toBe(true)
  })
})

describe('G12 指令止损：强指令不判矛盾', () => {
  it('kind=instruction 且含 必须/务必 → 止损指令排除', () => {
    const existing = [entry('部署环境使用 MySQL', { id: 'mysql' })]
    const found = detectContradiction(
      existing,
      { content: '必须停止使用 MySQL', kind: 'instruction' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(found).toBeUndefined()
  })
})

describe('G12 真假矛盾：不误报', () => {
  it('无对立信号即使高度相似 → 不命中', () => {
    const existing = [entry('部署环境使用 MySQL', { id: 'mysql' })]
    const found = detectContradiction(
      existing,
      { content: '部署环境使用 MySQL', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(found).toBeUndefined()
  })

  it('疑似反转但内容不相似 → 不命中', () => {
    const existing = [entry('部署环境使用 MySQL', { id: 'mysql' })]
    const found = detectContradiction(
      existing,
      { content: '不再使用咖啡机，改喝绿茶', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(found).toBeUndefined()
  })

  it('已走 supersede 协议的条目不参与矛盾判定（互斥）', () => {
    const superseded = [entry('部署环境使用 MySQL', { id: 'mysql', tags: ['superseded-by:new-db'] })]
    const found = detectContradiction(
      superseded,
      { content: '部署环境不再使用 MySQL', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(found).toBeUndefined()
  })
})

describe('G12 并存语义：conflictAwareOrder 新者序先、双方保留', () => {
  const byId = new Map<string, MemoryEntry>()
  const old = entry('部署环境使用 MySQL', { id: 'old', updatedAt: NOW - 2 * DAY })
  const newer = entry('部署环境不再使用 MySQL', { id: 'newer', updatedAt: NOW, tags: ['conflicts-with:old'] })
  const unrelated = entry('用户喜欢 TypeScript', { id: 'other' })
  for (const e of [old, newer, unrelated]) byId.set(e.id, e)

  it('旧者在先时重排为新者优先（其他保持相对顺序）', () => {
    const ordered = conflictAwareOrder([hit(old), hit(unrelated), hit(newer)], byId)
    expect(ordered.map((h) => h.id)).toEqual(['newer', 'other', 'old'])
  })

  it('双方都保留（不剔除任何一条）', () => {
    const ordered = conflictAwareOrder([hit(old), hit(newer)], byId)
    expect(ordered.map((h) => h.id)).toEqual(['newer', 'old'])
  })

  it('无冲突标注的命中保持原序（稳定）', () => {
    const a = entry('A 记录', { id: 'a' })
    const b = entry('B 记录', { id: 'b' })
    const by = new Map([
      [a.id, a],
      [b.id, b],
    ])
    expect(conflictAwareOrder([hit(a), hit(b)], by).map((h) => h.id)).toEqual(['a', 'b'])
  })
})

describe('G12 零行为回归：conflictMode 缺省 off 无任何矛盾标注', () => {
  it('与 1.0.0 行为一致（不带 conflictMode 字段）', async () => {
    const store = memoryStore([entry('部署环境使用 MySQL', { id: 'mysql' })])
    const { metrics } = recordMetrics()
    await ingestCaptured(
      store,
      [{ content: '部署环境不再使用 MySQL', kind: 'fact', tags: [] }],
      { maxEntryChars: 600, dedupWindowMs: 30 * DAY },
      metrics,
      undefined,
    )
    const rows = await store.list()
    const nu = rows.find((r) => r.content.includes('不再使用'))!
    expect(nu.tags).toEqual([]) // 无 conflicts-with、无 supersede
  })
})

describe('G12 可观测：conflictPeerIds / summarizeConflictPairs', () => {
  it('双向 tag 合并去重', () => {
    const e = entry('x', { id: 'x', tags: ['conflicts-with:a', 'conflict-of:b', 'conflicts-with:a'] })
    expect(conflictPeerIds(e)).toEqual(['a', 'b'])
  })

  it('冲突对计数与最近样本（唯一对去重）', () => {
    const e1 = entry('旧 1', { id: 'o1', updatedAt: NOW - 3 * DAY, tags: ['conflicts-with:n1'] })
    const n1 = entry('新 1', { id: 'n1', updatedAt: NOW - DAY })
    const e2 = entry('旧 2', { id: 'o2', updatedAt: NOW - 2 * DAY, tags: ['conflicts-with:n2'] })
    const n2 = entry('新 2', { id: 'n2', updatedAt: NOW })
    const s = summarizeConflictPairs([e1, n1, e2, n2], 10)
    expect(s.count).toBe(2)
    expect(s.samples[0]).toEqual({ newerId: 'n2', olderId: 'o2', updatedAt: NOW })
    expect(s.samples[1]).toEqual({ newerId: 'n1', olderId: 'o1', updatedAt: NOW - DAY })
  })

  it('无标注时计数为零', () => {
    expect(summarizeConflictPairs([entry('普通记录', { id: 'a' })], 3).count).toBe(0)
  })
})
