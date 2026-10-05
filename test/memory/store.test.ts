import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlMemoryStore, contentHash } from '../../src/memory/store'
import type { MemoryEntry } from '../../src/memory/types'

function freshEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `test-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'fact',
    content: 'the quick brown fox',
    tags: ['auto', 'fact'],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}

describe('JsonlMemoryStore', () => {
  it('contentHash 稳定且区分内容', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'))
    expect(contentHash('hello')).not.toBe(contentHash('world'))
    expect(contentHash('中文内容')).toHaveLength(16)
  })

  it('写入后可读、可删、可查', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const a = freshEntry()
    await store.upsert(a)
    expect(await store.get(a.id)).toMatchObject({ id: a.id, content: a.content })
    expect((await store.list()).length).toBe(1)

    expect(await store.remove(a.id)).toBe(true)
    expect(await store.remove(a.id)).toBe(false)
    expect(await store.list()).toHaveLength(0)
    await store.close()
  })

  it('持久化后可重新打开读到同样数据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const file = join(dir, 'mem.jsonl')
    const entries = [freshEntry({ content: 'first' }), freshEntry({ content: 'second' })]
    const store = await JsonlMemoryStore.open(file)
    for (const e of entries) await store.upsert(e)
    await store.close()

    const reopened = await JsonlMemoryStore.open(file)
    const list = await reopened.list()
    expect(list).toHaveLength(2)
    expect(new Set(list.map((e) => e.content))).toEqual(new Set(['first', 'second']))
    await reopened.close()
  })

  it('损坏行自动跳过，不阻断加载', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const file = join(dir, 'mem.jsonl')
    const good = freshEntry({ content: 'good' })
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(good)
    await store.close()
    writeFileSync(file, readFileSync(file, 'utf8') + '\n{broken json}\n', 'utf8')

    const reopened = await JsonlMemoryStore.open(file)
    expect(await reopened.list()).toHaveLength(1)
    await reopened.close()
  })

  it('importAll 只新增不覆盖已有 id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const a = freshEntry()
    await store.upsert(a)
    const added = await store.importAll([a, freshEntry({ content: 'new' })])
    expect(added).toBe(1)
    expect(await store.list()).toHaveLength(2)
    await store.close()
  })

  it('closed 后拒绝写入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.close()
    await expect(store.upsert(freshEntry())).rejects.toThrow('closed')
  })
})
