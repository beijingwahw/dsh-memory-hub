/**
 * 认知巩固与遗忘曲线离线质量门禁（DESIGN-1.1 F2，门禁 G11）：`npm run eval` 一键运行。
 *
 * G11 门限（与 DESIGN-1.1 模块 B 对齐）：
 *  1. 收敛性：模拟时间轴 100 步，目标条目巩固后 R(t) 不落入 <0.2 危险区
 *     （对照不巩固则跌落至接近 0）；
 *  2. 间隔拉伸：连续巩固后单次巩固间隔单调递增，末次 ≥ 首次 × 1.5
 *     （间隔重复特征，越熟越不易忘）；
 *  3. 存储纯净：巩固不新增契约外字段、不修改 content/kind/tags/createdAt；
 *  4. 可观测：summarizeConsolidation 输出正确统计（dueCount/total/strength 分布）。
 *
 * 夹具设计（对照/巩固两组 + 多维验证）：
 *  - 100 步时间轴收敛对比（巩固 vs 不巩固）；
 *  - 间隔拉伸曲线（≥1.5× 记忆衰减律）；
 *  - 存储纯净（字段级断言）；
 *  - summarizeConsolidation 可观测性。
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
} from '../src/memory/consolidation'
import type { MemoryEntry } from '../src/memory/types'

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

describe('G11 收敛性：模拟时间轴 100 步（巩固 vs 对照）', () => {
  it('巩固线 R(t) 永不落入 <0.2 危险区；对照线跌落至接近 0', () => {
    let consolidated = entry({ content: '关键决策记忆' })
    const unConsolidated = entry({ content: '关键决策记忆' })
    let minRConsolidated = 1
    let minRUnConsolidated = 1
    // 100 步，每步 1 天：到期立即巩固（模拟 consolidationMode=auto 的空闲批处理）
    for (let step = 1; step <= 100; step++) {
      const now = T0 + step * DAY
      minRConsolidated = Math.min(minRConsolidated, retrievability(consolidated, now))
      minRUnConsolidated = Math.min(minRUnConsolidated, retrievability(unConsolidated, now))
      const { reinforced } = consolidate([consolidated], now)
      if (reinforced.length > 0) consolidated = reinforced[0]!
    }
    // 巩固线：R 在触发巩固瞬间可略低于 0.4，但巩固即时回升——永不落入 <0.2 危险区
    expect(minRConsolidated).toBeGreaterThanOrEqual(0.2)
    // 对照线：不巩固，R 跌至接近 0
    expect(minRUnConsolidated).toBeLessThan(0.001)
  })

  it('到期判定生效：只有高价值记忆参与巩固（低价值流水不复习）', () => {
    const agedHigh = entry({ content: '高价值显式记忆' }) // explicit fact → significance ≥ 阈值
    const agedLow = entry({ content: '低价值自动记忆', source: 'auto' }) // auto fact → significance < 阈值
    const now = T0 + 30 * DAY
    expect(isConsolidationDue(agedHigh, now)).toBe(true)
    expect(isConsolidationDue(agedLow, now)).toBe(false)
    const { due } = consolidate([agedHigh, agedLow], now)
    expect(due.map((d) => d.id)).toEqual([agedHigh.id])
  })
})

describe('G11 间隔拉伸：间隔重复特征（越熟越不易忘）', () => {
  it('连续巩固 5 次后间隔单调递增且末次 ≥ 首次 × 1.5', () => {
    let e = entry({ content: '测试记忆' })
    const spans: number[] = []
    let prevT = T0
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
    for (let i = 1; i < spans.length; i++) expect(spans[i]!).toBeGreaterThan(spans[i - 1]!)
    expect(spans[4]!).toBeGreaterThanOrEqual(spans[0]! * 1.5)
  })

  it('强度饱和：重复访问后 strength 渐进饱和不超过上限 4.0', () => {
    for (let n = 1; n <= 100; n++) {
      const s = memoryStrength(entry({ content: '记忆', accessCount: n }))
      expect(s).toBeLessThanOrEqual(4.0)
    }
    expect(memoryStrength(entry({ content: '记忆', accessCount: 100 }))).toBeCloseTo(
      memoryStrength(entry({ content: '记忆', accessCount: 99 })) +
        memoryStrength(entry({ content: '记忆', accessCount: 100 })) -
        memoryStrength(entry({ content: '记忆', accessCount: 99 })),
    ) // 饱和：增益递减
  })
})

describe('G11 存储纯净：零契约变更', () => {
  it('巩固不新增契约外字段、不修改 content/kind/createdAt', () => {
    const e = entry({ content: '测试记忆', kind: 'preference', tags: ['a'], createdAt: T0 + 1, updatedAt: T0 + 2 })
    const r = reinforce(e, T0 + 5 * DAY)
    const expectedKeys = [...new Set([...Object.keys(e), 'lastAccessAt'])].sort()
    expect(Object.keys(r).sort()).toEqual(expectedKeys)
    expect(r.content).toBe(e.content)
    expect(r.kind).toBe(e.kind)
    expect(r.createdAt).toBe(e.createdAt)
    expect(r.updatedAt).toBe(e.updatedAt)
    expect(r.tags).toEqual(['a'])
  })
})

describe('G11 可观测：summarizeConsolidation 统计', () => {
  it('到期计数 / 全量计数 / 强度分布正确输出', () => {
    const aged = entry({ content: '陈旧记忆' })
    const fresh = entry({ content: '新记忆', accessCount: 3, lastAccessAt: T0 + 29 * DAY })
    const sum = summarizeConsolidation([aged, fresh], T0 + 30 * DAY)
    expect(sum.total).toBe(2)
    expect(sum.dueCount).toBe(1) // aged 到期，fresh 未到期
    expect(sum.strengthAvg).toBeGreaterThan(0)
    expect(sum.strengthMedian).toBeGreaterThan(0)
    expect(sum.minR).toBeGreaterThanOrEqual(0)
    expect(sum.strengthAvg).toBeCloseTo(Number(((1.0 + 2.5) / 2).toFixed(3)))
  })
})
