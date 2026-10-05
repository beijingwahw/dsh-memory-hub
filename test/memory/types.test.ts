import { describe, expect, it } from 'vitest'
import { isMemoryEntry, parseMemoryEntry, toMemoryEntry } from '../../src/memory/types'
import type { MemoryEntry } from '../../src/memory/types'

function validEntry(): MemoryEntry {
  const now = Date.now()
  return {
    id: 'abc',
    kind: 'fact',
    content: 'hello',
    tags: ['a'],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
  }
}

describe('isMemoryEntry', () => {
  it('合法条目通过', () => {
    expect(isMemoryEntry(validEntry())).toBe(true)
  })

  it('可选字段合法', () => {
    expect(isMemoryEntry({ ...validEntry(), sessionId: 's1', workspace: 'w', lastAccessAt: 1 })).toBe(true)
  })

  it('缺字段 / 类型错误拒绝', () => {
    const base = validEntry()
    expect(isMemoryEntry({ ...base, id: 1 })).toBe(false)
    expect(isMemoryEntry({ ...base, kind: 'unknown-kind' })).toBe(false)
    expect(isMemoryEntry({ ...base, content: 42 })).toBe(false)
    expect(isMemoryEntry({ ...base, tags: 'not-array' })).toBe(false)
    expect(isMemoryEntry({ ...base, source: 'other' })).toBe(false)
    expect(isMemoryEntry({ ...base, createdAt: '12' })).toBe(false)
    expect(isMemoryEntry({ ...base, accessCount: undefined })).toBe(false)
    expect(isMemoryEntry(null)).toBe(false)
    expect(isMemoryEntry('string')).toBe(false)
  })

  it('未知额外字段被忽略（向前兼容）', () => {
    expect(isMemoryEntry({ ...validEntry(), futureField: { nested: true } })).toBe(true)
  })
})

describe('parseMemoryEntry', () => {
  it('解析合法行', () => {
    const entry = parseMemoryEntry(JSON.stringify(validEntry()))
    expect(entry).toBeDefined()
    expect(entry!.id).toBe('abc')
  })

  it('非法 JSON 返回 undefined', () => {
    expect(parseMemoryEntry('{broken json}')).toBeUndefined()
    expect(parseMemoryEntry('')).toBeUndefined()
  })

  it('形状不符返回 undefined', () => {
    expect(parseMemoryEntry(JSON.stringify({ foo: 1 }))).toBeUndefined()
  })
})

describe('toMemoryEntry', () => {
  it('规整未知字段并保留可选字段', () => {
    const raw = { ...validEntry(), workspace: 'w', score: 0.9, extra: 1 }
    const out = toMemoryEntry(raw)
    expect(out).toBeDefined()
    expect(out).not.toHaveProperty('score')
    expect(out).not.toHaveProperty('extra')
    expect(out!.workspace).toBe('w')
  })
})
