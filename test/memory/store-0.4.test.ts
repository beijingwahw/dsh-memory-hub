import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlMemoryStore } from '../../src/memory/store'
import type { MemoryEntry } from '../../src/memory/types'
import { isMemoryEntry } from '../../src/memory/types'

let dirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh0.4-'))
  dirs.push(dir)
  return dir
}
function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now() + Math.floor(Math.random() * 1000)
  return {
    id: `s4-${Math.random().toString(36).slice(2, 8)}`,
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
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('损坏行隔离留证（0.4.0 存储自愈）', () => {
  it('损坏行被跳过且原文备份到 <file>.corrupt，主文件数据不受影响', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const good = entry('正常记忆', { id: 'good-1' })
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(good)
    await store.close()

    const corrupt1 = '{broken json] 违法内容'
    const corrupt2 = 'definitely not json'
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n${corrupt1}\n${corrupt2}\n`, 'utf8')

    const reopened = await JsonlMemoryStore.open(file)
    const list = await reopened.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('good-1')
    expect(reopened.diagnostics.corrupt).toBe(2)
    expect(reopened.diagnostics.lines).toBe(3) // 1 正常 + 2 损坏，语义与 0.3 兼容

    const backup = readFileSync(`${file}.corrupt`, 'utf8')
    expect(backup).toContain(corrupt1)
    expect(backup).toContain(corrupt2)
    await reopened.close()
  })

  it('损坏行隔离后 compact 可恢复行数一致性，二次打开无积累', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(entry('保留数据', { id: 'keep-1' }))
    await store.close()

    writeFileSync(file, `${readFileSync(file, 'utf8')}\n{corrupt}\n`, 'utf8')
    const reopened = await JsonlMemoryStore.open(file)
    expect(reopened.diagnostics.corrupt).toBe(1)
    await reopened.upsert(entry('新增数据', { id: 'keep-2' }))
    // 触发 compact：tombstone + 持有条目数 >= 16 或持有行数 > 64
    const dropped = Array.from({ length: 70 }, (_, i) => entry(`丢弃 ${i}`, { id: `drop-${i}` }))
    for (const e of dropped) {
      await reopened.upsert(e)
      await reopened.remove(e.id)
    }
    const after = await reopened.list()
    expect(after.map((e) => e.id)).toEqual(expect.arrayContaining(['keep-1', 'keep-2']))
    expect(after).toHaveLength(2)
    // compact 自检通过：compact 触发后重写文件已清除损坏行；数据完好
    await reopened.close()
    const final = await JsonlMemoryStore.open(file)
    expect(await final.list()).toHaveLength(2)
    expect(final.diagnostics.corrupt).toBe(0)
    expect(final.diagnostics.lines).toBeGreaterThanOrEqual(2)
    await final.close()
  })
})

describe('exportAll 完整迁移闭环（0.4.0）', () => {
  it('exportAll → importAll 跨库往返无损，MemoryEntry 契约可校验', async () => {
    const dirA = freshDir()
    const dirB = freshDir()
    const a = await JsonlMemoryStore.open(join(dirA, 'mem.jsonl'))
    const b = await JsonlMemoryStore.open(join(dirB, 'mem.jsonl'))
    const e1 = entry('导出第一条', { id: 'export-1', tags: ['迁移', '测试'] })
    const e2 = entry('导出第二条', { id: 'export-2', workspace: 'w-arch' })
    await a.upsert(e1)
    await a.upsert(e2)

    const exported = await a.exportAll()
    const parsed = JSON.parse(exported) as unknown[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    for (const item of parsed) expect(isMemoryEntry(item)).toBe(true)

    const added = await b.importAll(parsed as MemoryEntry[])
    expect(added).toBe(2)
    const inB = await b.list()
    expect(inB.map((e) => e.id)).toEqual(expect.arrayContaining(['export-1', 'export-2']))
    expect(inB.find((e) => e.id === 'export-1')!.content).toBe('导出第一条')
    expect(inB.find((e) => e.id === 'export-1')!.tags).toEqual(['迁移', '测试'])
    // 原库数据未被副作用污染
    expect(await a.list()).toHaveLength(2)
    await a.close()
    await b.close()
  })

  it('exportAll 在空库上返回空数组 JSON', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    expect(JSON.parse(await store.exportAll())).toEqual([])
    await store.close()
  })

  it('closed 后 exportAll 抛 STORE_CLOSED', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.close()
    await expect(store.exportAll()).rejects.toMatchObject({ code: 'STORE_CLOSED' })
  })

  it('损坏行隔离失败仅告警，加载不受影响（.corrupt 路径被目录占用）', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    writeFileSync(file, '{broken}\n', 'utf8')
    mkdirSync(`${file}.corrupt`) // 占用备份路径 → appendFile 将失败
    const logs: string[] = []
    const store = await JsonlMemoryStore.open(file, (m) => logs.push(m))
    expect(store.diagnostics.corrupt).toBe(1)
    expect(await store.list()).toHaveLength(0)
    expect(logs.some((l) => l.includes('corrupt isolation failed'))).toBe(true)
    await store.close()
  })

  it('无损坏行时不写备份文件也不产生告警', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const logs: string[] = []
    const store = await JsonlMemoryStore.open(file, (m) => logs.push(m))
    await store.upsert(entry('干净数据', { id: 'clean-1' }))
    await store.close()
    expect(logs.some((l) => l.includes('isolated'))).toBe(false)
  })

  it('size getter 反映内存条目数', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    expect(store.size).toBe(0)
    await store.upsert(entry('尺寸一', { id: 'sz-1' }))
    await store.upsert(entry('尺寸二', { id: 'sz-2' }))
    expect(store.size).toBe(2)
    await store.remove('sz-1')
    expect(store.size).toBe(1)
    await store.close()
  })
})
