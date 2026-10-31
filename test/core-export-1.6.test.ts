/**
 * 1.6.0（DESIGN-1.6）：`./core` 子路径导出面锁定。
 *
 * core.ts 是 dsh-memory-hub-gui 桌面端消费的纯库 API 出口——零逻辑、纯 re-export。
 * 本测试锁定「GUI 依赖的每个名字都必须存在且形态正确」，防止重构时静默漂移。
 */
import { describe, expect, it } from 'vitest'
import * as core from '../src/core'

describe('core 子路径导出面（1.6.0）', () => {
  it('存储与工厂：类/函数形态', () => {
    expect(typeof core.JsonlMemoryStore).toBe('function')
    expect(typeof core.makeEntry).toBe('function')
    expect(typeof core.safeSlice).toBe('function')
  })

  it('检索与统计：函数形态', () => {
    expect(typeof core.recall).toBe('function')
    expect(typeof core.summarize).toBe('function')
    expect(typeof core.clusterThemes).toBe('function')
    expect(typeof core.findDuplicate).toBe('function')
  })

  it('导入/导出/探测：函数形态', () => {
    expect(typeof core.planImport).toBe('function')
    expect(typeof core.splitDocument).toBe('function')
    expect(typeof core.extractSessionText).toBe('function')
    expect(typeof core.inferKind).toBe('function')
    expect(typeof core.renderMemoryHtml).toBe('function')
    expect(typeof core.parseKeyRecord).toBe('function')
    expect(typeof core.isEncryptedEnvelope).toBe('function')
    expect(typeof core.containsSensitive).toBe('function')
  })

  it('取代/矛盾协议：常量与判定函数', () => {
    expect(core.SUPERSEDE_TAG_PREFIX).toBe('supersede:')
    expect(core.SUPERSEDED_BY_TAG_PREFIX).toBe('superseded-by:')
    expect(core.CONFLICTS_WITH_TAG_PREFIX).toBe('conflicts-with:')
    expect(core.CONFLICT_OF_TAG_PREFIX).toBe('conflict-of:')
    expect(typeof core.isSuperseded).toBe('function')
    expect(typeof core.supersedeTargetId).toBe('function')
    expect(typeof core.supersededByTargetId).toBe('function')
    expect(typeof core.isConflicted).toBe('function')
    expect(typeof core.conflictPeerIds).toBe('function')
  })

  it('数据模型守卫与错误基础设施', () => {
    expect(typeof core.isMemoryEntry).toBe('function')
    expect(typeof core.parseMemoryEntry).toBe('function')
    expect(typeof core.toMemoryEntry).toBe('function')
    expect(typeof core.MemoryHubError).toBe('function')
    expect(typeof core.ErrorCodes).toBe('object')
  })

  it('类型面（编译期）：makeEntry → upsert → recall → summarize 全链可用', () => {
    // 运行期最小闭环：纯内存路径验证导出面的类型契约没有与实现脱节
    const entry = core.makeEntry({
      content: 'core-export 契约锁定样例：导出面与实现不脱节',
      kind: 'fact',
      source: 'explicit',
      tags: ['core-export', 'contract'],
      maxChars: 1000,
      now: 1_700_000_000_000,
    })
    expect(core.isMemoryEntry(entry)).toBe(true)
    expect(entry.id).toContain('-')
    const hit = core.recall([entry], 'core-export 契约', { now: 1_700_000_100_000 })
    expect(hit.length).toBeGreaterThanOrEqual(1)
    const stats = core.summarize([entry], entry.content.length)
    expect(stats.total).toBe(1)
    expect(stats.byKind.fact).toBe(1)
  })
})
