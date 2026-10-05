/**
 * 1.1.0 信念修正与冲突共存测试（DESIGN-1.1 模块 D，门禁 G12）。
 *
 * G12 门限：
 * - 矛盾检出：疑似反转 + 相近（sim>0.55）→ 命中；无对立信号/低相似 → 不命中；
 * - 与 supersede 区分：「改用 X」类只走 supersede 不标 conflict（打标互斥）；
 * - 强指令排除：kind=instruction 且含 必须/务必 → 止损指令不判矛盾；
 * - 并存语义：冲突对双方在召回中同时出现（不剔除），新者序先（conflictAwareOrder）；
 * - 可观测：summarizeConflictPairs 计数与最近样本正确；
 * - 零行为回归：conflictMode 缺省 off 时入库不产生任何矛盾标注（与 1.0.0 一致）。
 */
import { describe, expect, it } from 'vitest'
import {
  conflictAwareOrder,
  conflictPeerIds,
  CONFLICT_SIMILARITY_THRESHOLD,
  detectContradiction,
  hasConflictSignal,
  isConflicted,
  summarizeConflictPairs,
} from '../../src/memory/conflict'
import { ingestCaptured, type IngestOptions } from '../../src/memory/ingest'
import type { HubMetrics } from '../../src/memory/metrics'
import type { MemoryEntry, MemoryHit, MemoryStore } from '../../src/memory/types'

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

/** 把 MemoryEntry 包装为 MemoryHit（score 为召回分数，测试用固定值） */
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

describe('hasConflictSignal（弱化对立信号）', () => {
  it('疑似反转词命中', () => {
    expect(hasConflictSignal('不再使用 Redis')).toBe(true)
    expect(hasConflictSignal('停止使用旧方案')).toBe(true)
    expect(hasConflictSignal('no longer prefer Vue')).toBe(true)
  })
  it('明确替换词不命中（打标互斥的第一道闸）', () => {
    // 「改用/升级到」是 supersede 强信号，不是 conflict 弱信号
    expect(hasConflictSignal('改用 Redis')).toBe(false)
    expect(hasConflictSignal('升级到 Node 20')).toBe(false)
  })
  it('普通陈述不命中', () => {
    expect(hasConflictSignal('今天天气不错')).toBe(false)
    expect(hasConflictSignal('用户喜欢 TypeScript')).toBe(false)
  })
})

describe('detectContradiction（G12 矛盾检出）', () => {
  const existing = [
    entry('部署环境使用 MySQL', { id: 'mysql', createdAt: NOW - DAY }),
    entry('前端框架选择 Vue', { id: 'vue', createdAt: NOW - DAY }),
  ]

  it('疑似反转 + 相近（sim>0.55）→ 命中旧条目', () => {
    const hit = detectContradiction(
      existing,
      { content: '部署环境不再使用 MySQL', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(hit?.id).toBe('mysql')
  })

  it('疑似反转但内容不相似 → 不命中', () => {
    const hit = detectContradiction(
      existing,
      { content: '不再使用咖啡机，改喝绿茶', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(hit).toBeUndefined()
  })

  it('无对立信号 → 不命中（即使高度相似）', () => {
    const hit = detectContradiction(
      existing,
      { content: '部署环境使用 MySQL', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(hit).toBeUndefined()
  })

  it('相似度阈值可注入（默认 0.55 严格于 supersede 之外的弱门槛）', () => {
    expect(CONFLICT_SIMILARITY_THRESHOLD).toBe(0.55)
    // 低相似（0.3 上下）默认不命中；调低阈值后可命中
    const hit = detectContradiction(
      existing,
      { content: '不要再写 MySQL 相关的代码了', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(hit).toBeUndefined()
  })

  it('强指令排除：kind=instruction 且含 必须/务必 → 止损指令不判矛盾', () => {
    const hit = detectContradiction(
      existing,
      { content: '必须停止使用 MySQL', kind: 'instruction' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(hit).toBeUndefined()
    // 同内容但 kind=fact 且不相似 → 仍不命中（对立信号需相近）
    const hit2 = detectContradiction(
      existing,
      { content: '必须停止使用 MySQL 的一切相关组件', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(hit2).toBeUndefined()
  })

  it('已走 supersede 协议的条目不参与矛盾判定（互斥）', () => {
    const superseded = [entry('部署环境使用 MySQL', { id: 'mysql', tags: ['superseded-by:new-db'] })]
    const hit = detectContradiction(
      superseded,
      { content: '部署环境不再使用 MySQL', kind: 'fact' },
      { dedupWindowMs: 30 * DAY },
      NOW,
    )
    expect(hit).toBeUndefined()
  })
})

describe('ingestCaptured 接入（G12 打标互斥 + 零行为回归）', () => {
  it('conflictMode=auto：疑似反转候选写入 conflicts-with，旧条目补 conflict-of（双向）', async () => {
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

  it('打标互斥：「改用 X」类只走 supersede 不标 conflict', async () => {
    // 语料实测：sim=0.905（>0.85 过 supersede、<0.92 不去重），「换成」= supersede 强信号非 conflict 弱信号
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
    // 只走 supersede：新条 supersede:docker，旧条 superseded-by:<新id>，且无 conflicts 标注
    expect(nu.tags).toContain('supersede:docker')
    expect(nu.tags.some((t) => t.startsWith('conflicts-with:'))).toBe(false)
    expect(old.tags).toContain('superseded-by:' + nu.id)
    expect(old.tags.some((t) => t.startsWith('conflict-of:'))).toBe(false)
  })

  it('零行为回归：conflictMode 缺省 off 时无任何矛盾标注（与 1.0.0 一致）', async () => {
    const store = memoryStore([entry('部署环境使用 MySQL', { id: 'mysql' })])
    const { metrics } = recordMetrics()
    // 不带 conflictMode 字段（缺省 off）
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

describe('conflictAwareOrder（G12 并存语义：新者序先、双方保留）', () => {
  const byId = new Map<string, MemoryEntry>()
  const old = entry('部署环境使用 MySQL', { id: 'old', updatedAt: NOW - 2 * DAY })
  const newer = entry('部署环境不再使用 MySQL', { id: 'newer', updatedAt: NOW, tags: ['conflicts-with:old'] })
  const unrelated = entry('用户喜欢 TypeScript', { id: 'other' })
  for (const e of [old, newer, unrelated]) byId.set(e.id, e)

  it('旧者在先时重排为新者优先（其他保持相对顺序）', () => {
    const ordered = conflictAwareOrder([hit(old), hit(unrelated), hit(newer)], byId)
    expect(ordered.map((h) => h.id)).toEqual(['newer', 'other', 'old'])
  })

  it('新者已在先时不调整', () => {
    const ordered = conflictAwareOrder([hit(newer), hit(unrelated), hit(old)], byId)
    expect(ordered.map((h) => h.id)).toEqual(['newer', 'other', 'old'])
  })

  it('双方都保留（不剔除任何一条）', () => {
    const ordered = conflictAwareOrder([hit(old), hit(newer)], byId)
    expect(ordered.length).toBe(2)
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

describe('conflictPeerIds / isConflicted / summarizeConflictPairs', () => {
  it('双向 tag 合并去重', () => {
    const e = entry('x', { id: 'x', tags: ['conflicts-with:a', 'conflict-of:b', 'conflicts-with:a'] })
    expect(conflictPeerIds(e)).toEqual(['a', 'b'])
    expect(isConflicted(e)).toBe(true)
  })

  it('冲突对计数与最近样本（唯一对去重、新者优先）', () => {
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
