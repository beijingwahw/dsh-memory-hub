/**
 * 0.5.0 A3 记忆价值感知评分（significance-aware）测试。
 *
 * 验证点：
 *   1. significanceWeight 纯函数：kind × source 权重表逐值可复算
 *      （权重与 INNOVATION-0.5.md §3.3 设计稿一致；density 维度因与既有
 *      「精炼短记忆优先」断言冲突而移除，见 CHANGELOG 0.5.0 兼容性说明）；
 *   2. 召回排序：指令 > 决策 > 偏好 > 事实 > 泛化；显式记忆 > 自动捕获；
 *   3. `significance: false` 开关：关闭后权重失效、同词面同热度记忆回到并列（可关闭性）。
 */
import { describe, expect, it } from 'vitest'
import { recall, significanceWeight, SIGNIFICANCE_EXPLICIT, SIGNIFICANCE_KIND } from '../../src/memory/engine'
import type { MemoryEntry, MemoryKind } from '../../src/memory/types'

const NOW = Date.now()

function entry(id: string, kind: MemoryKind, source: MemoryEntry['source'] = 'auto'): MemoryEntry {
  return {
    id,
    kind,
    content: '数据库连接池大小配置value',
    tags: [],
    source,
    createdAt: NOW,
    updatedAt: NOW,
    accessCount: 0,
  }
}

describe('A3 记忆价值感知评分（significance-aware）', () => {
  it('权重表逐值可复算（与 INNOVATION-0.5 §3.3 设计稿一致）', () => {
    // kind 基础权重：instruction 1.25 > decision 1.15 > preference 1.05 > fact 1.0 > generic 0.95
    expect(SIGNIFICANCE_KIND.instruction).toBe(1.25)
    expect(SIGNIFICANCE_KIND.decision).toBe(1.15)
    expect(SIGNIFICANCE_KIND.preference).toBe(1.05)
    expect(SIGNIFICANCE_KIND.fact).toBe(1.0)
    expect(SIGNIFICANCE_KIND.generic).toBe(0.95)
    expect(SIGNIFICANCE_EXPLICIT).toBe(1.1)
    // 自动捕获无加成
    expect(significanceWeight('decision', 'auto')).toBe(1.15)
    expect(significanceWeight('fact', 'auto')).toBe(1.0)
    expect(significanceWeight('generic', 'auto')).toBeCloseTo(0.95, 10)
    // 显式记忆 ×1.1
    expect(significanceWeight('fact', 'explicit')).toBeCloseTo(1.1, 10)
    expect(significanceWeight('instruction', 'explicit')).toBeCloseTo(1.375, 10)
  })

  it('召回排序：同词面同热度下指令排在决策/偏好/事实/泛化之前（重要的事不被流水账淹没）', () => {
    const entries = [
      entry('fact', 'fact'),
      entry('decision', 'decision'),
      entry('generic', 'generic'),
      entry('instruction', 'instruction'),
      entry('preference', 'preference'),
    ]
    const hits = recall(entries, '数据库连接池 配置', { now: NOW, limit: 5 })
    const ids = hits.map((h) => h.id)
    const pos = (id: string): number => ids.indexOf(id)
    expect(pos('instruction')).toBeLessThan(pos('decision'))
    expect(pos('decision')).toBeLessThan(pos('preference'))
    expect(pos('preference')).toBeLessThan(pos('fact'))
    expect(pos('fact')).toBeLessThan(pos('generic'))
  })

  it('召回排序：显式记忆（用户主动说"记住"）排在自动捕获之前', () => {
    const entries = [entry('auto', 'fact', 'auto'), entry('explicit', 'fact', 'explicit')]
    const hits = recall(entries, '数据库连接池 配置', { now: NOW, limit: 2 })
    expect(hits[0]!.id).toBe('explicit')
  })

  it('significance: false 开关：关闭后权重失效，同词面同热度记忆回到并列', () => {
    const entries = [entry('decision', 'decision'), entry('fact', 'fact')]
    const on = recall(entries, '数据库连接池 配置', { now: NOW, limit: 2 })
    expect(on[0]!.id).toBe('decision')
    const off = recall(entries, '数据库连接池 配置', { now: NOW, limit: 2, significance: false })
    // 关闭后 bm25 × decay × heat 相同（同词面同长度同热度），score 完全相等
    expect(off[0]!.score).toBeCloseTo(off[1]!.score, 10)
  })

  it('value 感知不改变 MemoryEntry 契约：score 仍是运行时字段，不落盘', () => {
    const entries = [entry('decision', 'decision')]
    const hits = recall(entries, '数据库连接池 配置', { now: NOW, limit: 2 })
    expect(hits[0]!.kind).toBe('decision')
    expect(typeof hits[0]!.score).toBe('number')
    expect(hits[0]!.score).toBeGreaterThan(0)
  })
})
