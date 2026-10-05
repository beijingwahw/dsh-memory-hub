import { describe, expect, it } from 'vitest'
import { createMetrics, formatMetrics, type HubMetrics } from '../../src/memory/metrics'

describe('HubMetrics 运行指标（0.3.0）', () => {
  it('createMetrics 返回全 0 快照（幂等序列化，纯数字字段）', () => {
    const m: HubMetrics = createMetrics()
    expect(m).toEqual({
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
    })
    // JSON 序列化往返无损（供 memory_status / 监控管道直接消费）
    expect(JSON.parse(JSON.stringify(m))).toEqual(m)
  })

  it('formatMetrics 汇总所有关键计数', () => {
    const m = createMetrics()
    m.capturedTotal = 12
    m.explicitStored = 3
    m.recallCalls = 5
    m.recallHits = 9
    m.forgotten = 2
    m.rejectedSensitive = 1
    m.rejectedDuplicate = 4
    m.pruned = 7
    m.dropped = 1
    m.errors = 2
    const s = formatMetrics(m)
    expect(s).toContain('captured=12')
    expect(s).toContain('explicit=3')
    expect(s).toContain('recalls=5 (hits=9)')
    expect(s).toContain('forgotten=2')
    expect(s).toContain('rejected(sensitive=1, duplicate=4)')
    expect(s).toContain('pruned=7')
    expect(s).toContain('dropped=1')
    expect(s).toContain('errors=2')
  })

  it('快照拷贝：status 返回展开副本，后续累加不影响已返回快照', () => {
    const m = createMetrics()
    const snapshot = { ...m }
    m.capturedTotal = 99
    expect(snapshot.capturedTotal).toBe(0)
  })
})
