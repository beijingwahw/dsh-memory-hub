import { describe, expect, it } from 'vitest'
import { HEAT_HALF_LIFE_MS, heatScore, recall } from '../../src/memory/engine'
import type { MemoryEntry } from '../../src/memory/types'

const DAY = 24 * 60 * 60 * 1000

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `hl-${content.length}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'fact',
    content,
    tags: [],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}

describe('heatScore 生命周期热度（0.5.0 A4）', () => {
  it('accessCount=0 恒为 1（新记忆不衰减）', () => {
    const old = entry('很久前创建但从没被访问的记忆', { accessCount: 0 })
    expect(heatScore(old, Date.now())).toBe(1)
  })
  it('lastAccessAt 缺失时与 0.4.0 公式一致（log1p 单调）', () => {
    const a = entry('记忆', { accessCount: 10 })
    const b = entry('记忆', { accessCount: 0 })
    expect(heatScore(a)).toBe(1 + Math.log1p(10) * 0.1)
    expect(heatScore(a)).toBeGreaterThan(heatScore(b))
  })
  it('刚访问过的高频记忆热度最高（复活状态）', () => {
    const now = Date.now()
    const hot = entry('高频且刚被访问', { accessCount: 100, lastAccessAt: now })
    const cold = entry('高频但已冷却', { accessCount: 100, lastAccessAt: now - 30 * DAY })
    expect(heatScore(hot, now)).toBe(1 + Math.log1p(100) * 0.1) // Δ=0 无衰减
    expect(heatScore(cold, now)).toBeLessThan(heatScore(hot, now))
  })
  it('半衰期可达：Δ=halfLife 时 temporalDecay=e^-1，热度减至约 1.368（100 次访问）', () => {
    const now = Date.now()
    const e = entry('冷却中的记忆', { accessCount: 100, lastAccessAt: now - HEAT_HALF_LIFE_MS })
    const base = 1 + Math.log1p(100) * 0.1 // ≈ 1 + 4.615*0.1 = 1.4615
    const half = 1 + Math.log1p(100) * 0.1 * Math.exp(-1)
    expect(heatScore(e, now)).toBeCloseTo(half, 10)
    expect(heatScore(e, now)).toBeLessThan(base)
    expect(heatScore(e, now)).toBeGreaterThan(1)
  })
  it('heatHalfLifeMs 可注入（半衰期越短冷却越快）', () => {
    const now = Date.now()
    const e = entry('同一条记忆', { accessCount: 50, lastAccessAt: now - 7 * DAY })
    const shortHL = heatScore(e, now, 1 * DAY)
    const longHL = heatScore(e, now, 30 * DAY)
    expect(shortHL).toBeLessThan(longHL)
    // 与默认值一致：不传时用 7 天
    expect(heatScore(e, now)).toBeCloseTo(heatScore(e, now, HEAT_HALF_LIFE_MS), 12)
  })
  it('temporalDecay 对 accessCount 的抑制不改变单调性（冷却下高频仍 > 低频）', () => {
    const now = Date.now()
    const high = entry('高频冷却', { accessCount: 100, lastAccessAt: now - 7 * DAY })
    const low = entry('低频冷却', { accessCount: 5, lastAccessAt: now - 7 * DAY })
    expect(heatScore(high, now)).toBeGreaterThan(heatScore(low, now))
  })
})

describe('召回中的生命周期热度（0.5.0 A4）', () => {
  it('陈旧高频不再霸榜：新相关记忆胜出（问题场景修复）', () => {
    const now = Date.now()
    // 3 个月前高频访问的旧记忆（曾是热点）
    const stale = entry('数据库连接池大小配置value', {
      accessCount: 200,
      lastAccessAt: now - 90 * DAY,
      createdAt: now - 95 * DAY,
    })
    // 今日刚存的零访问相关记忆
    const fresh = entry('数据库连接池大小配置value', { accessCount: 0, createdAt: now })
    const hits = recall([stale, fresh], '数据库连接池 配置', { limit: 2, now })
    expect(hits[0]!.id).toBe(fresh.id)
  })
  it('近期验证过的记忆热度保持（复活）', () => {
    const now = Date.now()
    const verified = entry('部署流程页的命令写入路径', {
      accessCount: 150,
      lastAccessAt: now - 2 * DAY,
      createdAt: now,
    })
    const newOne = entry('部署流程页的命令写入路径', { accessCount: 0, createdAt: now })
    const hits = recall([newOne, verified], '部署流程 命令', { limit: 2, now })
    // 同创建时间下：2 天前尚在使用的高频记忆 heat 仍高于零访问新记忆（decay 相同、heat 决定）
    expect(hits[0]!.id).toBe(verified.id)
  })
  it('冷却可用 heatHalfLifeMs 关闭场景：半衰期极大 ≈ 0.4.0 单调热度', () => {
    const now = Date.now()
    const old = entry('同一关键词记忆', { accessCount: 30, lastAccessAt: now - 60 * DAY })
    const fresh = entry('同一关键词记忆', { accessCount: 0 })
    const hits = recall([fresh, old], '同一关键词', { limit: 2, now, heatHalfLifeMs: 3650 * DAY })
    expect(hits[0]!.id).toBe(old.id) // 半衰期 10 年：heat 几乎无衰减，高频仍占先
  })
})
