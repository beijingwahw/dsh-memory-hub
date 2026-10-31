/**
 * 测试共享工具（1.1.1）：收编此前在 4 个 store 测试文件中逐字复制的 freshEntry
 * 辅助函数——单一事实源，消除多副本漂移风险。
 */
import type { MemoryEntry } from '../../src/memory/types'

/** 构造测试条目（随机 id/content，可覆写任意字段） */
export function freshEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `t-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'fact',
    content: `entry-${Math.random().toString(36).slice(2, 10)}`,
    tags: [],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}
