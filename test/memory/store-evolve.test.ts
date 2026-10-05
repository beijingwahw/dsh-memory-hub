import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlMemoryStore, contentHash } from '../../src/memory/store'
import type { MemoryEntry } from '../../src/memory/types'

function freshEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `test-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'fact',
    content: `content-${Math.random().toString(36).slice(2, 10)}`,
    tags: ['auto'],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}

describe('JsonlMemoryStore 0.2.0 演进', () => {
  it('兼容 0.1.0 旧格式（逐行整条目，无 tombstone）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-legacy-'))
    const file = join(dir, 'mem.jsonl')
    const a = freshEntry({ content: 'legacy-a', createdAt: 1000 })
    const b = freshEntry({ content: 'legacy-b', createdAt: 2000 })
    writeFileSync(file, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, 'utf8')

    const store = await JsonlMemoryStore.open(file)
    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(new Set(list.map((e) => e.content))).toEqual(new Set(['legacy-a', 'legacy-b']))
    await store.close()
  })

  it('tombstone 删除后，重开不再读取已删条目', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-tomb-'))
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const a = freshEntry()
    const b = freshEntry()
    await store.upsert(a)
    await store.upsert(b)
    expect(await store.remove(a.id)).toBe(true)
    await store.close()

    // tombstone 行已落到文件
    expect(readFileSync(file, 'utf8')).toContain('__tombstone__')

    const reopened = await JsonlMemoryStore.open(file)
    expect(await reopened.list()).toHaveLength(1)
    expect((await reopened.list())[0]!.id).toBe(b.id)
    await reopened.close()
  })

  it('append-only：覆盖写只追加不重写整文件（行数随写入累计）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-append-'))
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const a = freshEntry({ id: 'fixed-id' })
    await store.upsert(a)
    await store.upsert({ ...a, accessCount: 1 })
    await store.close()

    // 两次写入 = 两行（一次 upsert 追加一行，未全量重写）
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
  })

  it('compact：冗余行积累后触发，重开恢复为纯条目文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-compact-'))
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const base = freshEntry({ id: 'base-id', content: 'base' })
    // 写入 1 条 + 覆盖 70 次 → 71 行 >> 条目数 1，必触发 compact
    await store.upsert(base)
    for (let i = 0; i < 70; i++) {
      await store.upsert({ ...base, accessCount: i + 1 })
    }
    await store.close()

    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeLessThan(71) // compact 已收敛
    const reopened = await JsonlMemoryStore.open(file)
    expect(await reopened.list()).toHaveLength(1)
    await reopened.close()
  })

  it('并发写入不丢失（写链串行化）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-conc-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const entries = Array.from({ length: 30 }, (_, i) => freshEntry({ content: `parallel-${i}` }))
    await Promise.all(entries.map((e) => store.upsert(e)))

    const list = await store.list()
    expect(list).toHaveLength(30)
    expect(new Set(list.map((e) => e.content))).toEqual(new Set(entries.map((e) => e.content)))
    await store.close()
  })

  it('写失败回滚内存态（upsert 抛错后不残留半条）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-fail-'))
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(freshEntry({ content: 'ok-1' }))

    // 制造追加失败：删除目录 → appendFile 抛 ENOENT
    rmSync(dir, { recursive: true, force: true })
    await expect(store.upsert(freshEntry({ content: 'will-fail' }))).rejects.toThrow()

    // 失败条目不残留（内存仍只有成功写入的那条在尝试前被 set，
    // 但回滚逻辑会将其删除；ok-1 在 rm 前已落盘，此处聚焦内存一致）
    const list = await store.list()
    expect(list.some((e) => e.content === 'will-fail')).toBe(false)
  })

  it('非 ENOENT 读取错误不再吞没（指向目录时报错而非静默空库）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-eisdir-'))
    const dirAsFile = join(dir, 'sub')
    mkdirSync(dirAsFile)
    await expect(JsonlMemoryStore.open(dirAsFile)).rejects.toThrow()
  })

  it('contentHash 稳定且区分内容', () => {
    expect(contentHash('x')).toBe(contentHash('x'))
    expect(contentHash('x')).not.toBe(contentHash('y'))
  })
})
