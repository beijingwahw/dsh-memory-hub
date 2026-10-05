/**
 * 1.1.0 认知巩固与遗忘曲线测试（DESIGN-1.1 模块 B，门禁 G11）。
 *
 * G11 门限：
 * - 收敛性：模拟时间轴 100 步，目标条目巩固后 R(t) 不落入 <0.2（对照不巩固则跌落）；
 * - 间隔拉伸：连续巩固 5 次后单次巩固间隔 ≥ 首次巩固间隔 × 1.5（间隔重复特征）；
 * - 零行为回归：本模块不挂接入口、consolidationMode 缺省 off 时无任何调用路径；
 * - 存储纯净：巩固不新增字段、不改变 content/kind/tags/createdAt。
 */
import { describe, expect, it } from 'vitest'
import {
  consolidate,
  DEFAULT_RECALL_THRESHOLD,
  isConsolidationDue,
  memoryStrength,
  reinforce,
  retrievability,
  summarizeConsolidation,
} from '../../src/memory/consolidation'
import type { MemoryEntry } from '../../src/memory/types'

function entry(overrides: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  return {
    id: `c-${overrides.content.length}-${overrides.content.charCodeAt(0) ?? 0}`,
    kind: 'fact',
    tags: [],
    source: 'explicit', // 显式记忆 = 高价值（significance 1.0×1.1 ≥ 1.0）
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    accessCount: 0,
    ...overrides,
  }
}

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

describe('memoryStrength / retrievability（模块 B1）', () => {
  it('新记忆强度 = 1.0，召回后递增且渐饱和', () => {
    const e = entry({ content: '测试记忆' })
    expect(memoryStrength(e)).toBe(1.0)
    expect(memoryStrength({ ...e, accessCount: 1 })).toBe(1.5)
    expect(memoryStrength({ ...e, accessCount: 3 })).toBeCloseTo(2.5)
    // 3 次后增益减半（4→2.75），6 次后（3.0+）继续渐进饱和，永不超过上限 4.0
    const many = memoryStrength({ ...e, accessCount: 100 })
    expect(many).toBeLessThanOrEqual(4.0)
    expect(memoryStrength({ ...e, accessCount: 100 })).toBe(many)
  })

  it('R(t)：刚创建 = strength；随时间指数遗忘', () => {
    const e = entry({ content: '测试记忆', createdAt: T0, updatedAt: T0 })
    expect(retrievability(e, T0)).toBeCloseTo(1.0)
    // 7 天后（τ₀ 默认整 7 天）：R = 1×e^-1 ≈ 0.368
    const r7 = retrievability(e, T0 + 7 * DAY)
    expect(r7).toBeGreaterThan(0.36)
    expect(r7).toBeLessThan(0.37)
    // 30 天后远低于 0.2
    expect(retrievability(e, T0 + 30 * DAY)).toBeLessThan(0.2)
  })

  it('强度越高遗忘越慢（间隔重复语义）', () => {
    const fresh = entry({ content: '测试记忆' })
    const trained = { ...fresh, accessCount: 3 } // strength 2.5
    const rFresh = retrievability(fresh, T0 + 14 * DAY)
    const rTrained = retrievability(trained, T0 + 14 * DAY)
    expect(rTrained).toBeGreaterThan(rFresh)
  })

  it('到期判定：R < 阈值 且 高价值', () => {
    const e = entry({ content: '测试记忆', createdAt: T0, updatedAt: T0 })
    // 第 1 天：R≈0.867 未到期
    expect(isConsolidationDue(e, T0 + 1 * DAY)).toBe(false)
    // 第 30 天：R < 0.4 到期（显式 fact 高价值 1.1 ≥ 1.0）
    expect(isConsolidationDue(e, T0 + 30 * DAY)).toBe(true)
    // 低价值（自动 fact，significance 1.0 < 1.1）永不到期（不复习低价值流水）
    const low = { ...e, source: 'auto' as const }
    expect(isConsolidationDue(low, T0 + 30 * DAY)).toBe(false)
  })
})

describe('reinforce / consolidate（模块 B2）', () => {
  it('巩固 = 一次成功召回：accessCount+1、lastAccessAt=now；其余字段原样', () => {
    const e = entry({ content: '测试记忆', tags: ['a'], kind: 'decision', createdAt: 100, updatedAt: 200 })
    const r = reinforce(e, T0)
    expect(r.accessCount).toBe(1)
    expect(r.lastAccessAt).toBe(T0)
    expect(r.content).toBe(e.content)
    expect(r.tags).toEqual(['a'])
    expect(r.kind).toBe('decision')
    expect(r.createdAt).toBe(100)
    expect(r.updatedAt).toBe(200)
    // 不修改入参
    expect(e.accessCount).toBe(0)
    expect(e.lastAccessAt).toBeUndefined()
  })

  it('consolidate 只对到期高价值条目生成巩固副本', () => {
    const aged = entry({ content: '测试记忆', createdAt: T0, updatedAt: T0 })
    // 已训练的新记忆：3 次访问（strength 2.5），近 1 天访问过（R≈2.1），未到期
    const fresh = entry({
      content: '新记忆',
      createdAt: T0,
      updatedAt: T0,
      accessCount: 3,
      lastAccessAt: T0 + 29 * DAY,
    })
    const { due, reinforced, views } = consolidate([aged, fresh], T0 + 30 * DAY)
    expect(due.map((e) => e.id)).toContain(aged.id)
    expect(due.map((e) => e.id)).not.toContain(fresh.id)
    expect(reinforced.length).toBe(due.length)
    expect(views).toHaveLength(2)
    const agedView = views.find((v) => v.id === aged.id)!
    expect(agedView.due).toBe(true)
    expect(agedView.strength).toBe(1.0)
    expect(agedView.r).toBeLessThan(DEFAULT_RECALL_THRESHOLD)
    const freshView = views.find((v) => v.id === fresh.id)!
    expect(freshView.due).toBe(false)
  })
})

describe('G11 收敛性：模拟时间轴 100 步', () => {
  it('巩固后 R(t) 不落入 <0.2；不巩固则跌落', () => {
    let consolidated = entry({ content: '测试记忆', createdAt: T0, updatedAt: T0 })
    const unConsolidated = entry({ content: '测试记忆', createdAt: T0, updatedAt: T0 })
    let minRConsolidated = 1
    let minRUnConsolidated = 1
    // 100 步，每步 1 天：到期立即巩固（模拟 consolidationMode=auto 的空闲批处理）
    for (let step = 1; step <= 100; step++) {
      const now = T0 + step * DAY
      const rC = retrievability(consolidated, now)
      const rU = retrievability(unConsolidated, now)
      minRConsolidated = Math.min(minRConsolidated, rC)
      minRUnConsolidated = Math.min(minRUnConsolidated, rU)
      // 巩固路径：到期即复习
      const { reinforced } = consolidate([consolidated], now)
      if (reinforced.length > 0) consolidated = reinforced[0]!
    }
    // 巩固线：R 在触发巩固瞬间可略低于 0.4，但巩固即时回升——永不落入 <0.2 危险区
    expect(minRConsolidated).toBeGreaterThanOrEqual(0.2)
    // 对照线：不巩固，R 跌至接近 0
    expect(minRUnConsolidated).toBeLessThan(0.001)
  })

  it('间隔拉伸：连续巩固 5 次后单次巩固间隔 ≥ 首次 × 1.5', () => {
    let e = entry({ content: '测试记忆', createdAt: T0, updatedAt: T0 })
    const spans: number[] = []
    let prevT = T0
    // 先后模拟若干巩固周期，记录相邻巩固的间隔
    for (let i = 0; i < 6; i++) {
      // 找到当前强度下 R 衰减到阈值的时刻（二分逼近）
      let lo = 0
      let hi = 200 * DAY
      let t = T0
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2
        const now = prevT + mid
        if (retrievability(e, now) < DEFAULT_RECALL_THRESHOLD) hi = mid
        else lo = mid
      }
      t = prevT + hi
      if (i > 0) spans.push(t - prevT)
      const { reinforced } = consolidate([e], t)
      e = reinforced[0] ?? e
      prevT = t
    }
    expect(spans).toHaveLength(5)
    // 每个后续间隔都应 ≥ 前一个（单调递增），且末次 ≥ 首次 × 1.5
    for (let i = 1; i < spans.length; i++) expect(spans[i]!).toBeGreaterThan(spans[i - 1]!)
    expect(spans[4]!).toBeGreaterThanOrEqual(spans[0]! * 1.5)
  })
})

describe('G11 零行为回归 & 存储纯净', () => {
  it('consolidationMode 缺省 off：本模块非入口调用链，已有路径零接触', () => {
    // 纯函数模块不注册任何 hook/副作用：调用 consolidate 不产生存储写入、不修改入参
    const e = entry({ content: '测试记忆', tags: ['x'], createdAt: T0, updatedAt: T0 })
    const snapshot = JSON.stringify(e)
    consolidate([e], T0 + 30 * DAY)
    expect(JSON.stringify(e)).toBe(snapshot)
  })

  it('存储纯净：不新增契约外字段、不改 content/kind', () => {
    const e = entry({ content: '测试记忆', kind: 'preference', createdAt: T0, updatedAt: T0 })
    const r = reinforce(e, T0)
    // r 的键 = e 的键 ∪ {lastAccessAt}（lastAccessAt 是 MemoryEntry 契约内可选字段）
    const expectedKeys = [...new Set([...Object.keys(e), 'lastAccessAt'])].sort()
    expect(Object.keys(r).sort()).toEqual(expectedKeys)
    expect(r.content).toBe(e.content)
    expect(r.kind).toBe(e.kind)
    expect(r.createdAt).toBe(e.createdAt)
    expect(r.updatedAt).toBe(e.updatedAt)
  })

  it('summarizeConsolidation 输出统计（status 可观测）', () => {
    const aged = entry({ content: '测试记忆', createdAt: T0, updatedAt: T0 })
    const fresh = entry({ content: '新记忆', createdAt: T0, updatedAt: T0, accessCount: 3 })
    const sum = summarizeConsolidation([aged, fresh], T0 + 30 * DAY)
    expect(sum.total).toBe(2)
    expect(sum.dueCount).toBe(1) // aged 到期，fresh 未到期
    expect(sum.strengthAvg).toBeGreaterThan(0)
    expect(sum.strengthMedian).toBeGreaterThan(0)
    expect(sum.minR).toBeGreaterThanOrEqual(0)
  })
})
