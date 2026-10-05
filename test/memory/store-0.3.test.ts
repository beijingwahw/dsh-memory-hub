import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorCodes } from '../../src/errors'
import { IndexCache, isDuplicate } from '../../src/memory/engine'
import { JsonlMemoryStore } from '../../src/memory/store'
import type { MemoryEntry } from '../../src/memory/types'

function freshEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `t-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'fact',
    content: `content-${Math.random().toString(36).slice(2, 10)}`,
    tags: [],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}

async function openStore(dir: string) {
  return JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
}

describe('removeMany 批量删除（0.3.0）', () => {
  it('单批 tombstone 落盘，内存与重开后一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-rmmany-'))
    const store = await openStore(dir)
    const a = freshEntry({ content: 'rm-a' })
    const b = freshEntry({ content: 'rm-b' })
    const c = freshEntry({ content: 'rm-c' })
    await store.upsert(a)
    await store.upsert(b)
    await store.upsert(c)

    const removed = await (store as unknown as { removeMany(ids: string[]): Promise<number> }).removeMany([
      a.id,
      b.id,
      'no-such-id',
    ])
    expect(removed).toBe(2)

    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(c.id)

    // 两行 tombstone 同批落盘
    const fileText = readFileSync(join(dir, 'mem.jsonl'), 'utf8')
    expect((fileText.match(/__tombstone__/g) ?? []).length).toBe(2)

    await store.close()
    const reopened = await openStore(dir)
    const relist = await reopened.list()
    expect(relist).toHaveLength(1)
    expect(relist[0]!.id).toBe(c.id)
    await reopened.close()
  })

  it('revision 版本号：结构性写入递增，无变更不递增', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-rev-'))
    const store = await openStore(dir)
    expect(store.revision).toBe(0)
    const a = freshEntry()
    await store.upsert(a)
    expect(store.revision).toBe(1)
    await store.upsert({ ...a, accessCount: 1 })
    expect(store.revision).toBe(2)
    await (store as unknown as { removeMany(ids: string[]): Promise<number> }).removeMany(['no-such'])
    expect(store.revision).toBe(2) // 无实际变更不递增
    const b = freshEntry()
    await (store as unknown as { importAll(es: MemoryEntry[]): Promise<number> }).importAll([b])
    expect(store.revision).toBe(3)
    await store.upsert(b) // 已存在 id，仍追加新行 → 变更
    expect(store.revision).toBe(4)
    await store.close()
  })

  it('写失败抛 STORE_WRITE_FAILED 且内存无残留（先落盘后入内存）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-wfail-'))
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(freshEntry({ content: 'ok' }))
    const before = await store.list()

    rmSync(dir, { recursive: true, force: true })
    await expect(store.upsert(freshEntry({ content: 'fail-me' }))).rejects.toMatchObject({
      code: ErrorCodes.STORE_WRITE_FAILED,
    })

    // 失败条目未入内存
    const after = await store.list()
    expect(after.length).toBe(before.length)
    expect(after.some((e) => e.content === 'fail-me')).toBe(false)
  })
})

describe('IndexCache 索引缓存（0.3.0）', () => {
  it('revision 未变则复用索引（新增语料不触发重建）', () => {
    const cache = new IndexCache()
    const base = [freshEntry({ content: 'alpha 项目部署' })]
    const r1 = cache.query(base, 1, 'alpha')
    expect(r1).toHaveLength(1)

    // 同 revision 下语料变化（不应发生）也复用旧索引 —— 上层保证 revision 语义正确即可
    const r2 = cache.query([freshEntry({ content: 'beta 全新内容' })], 1, 'alpha')
    expect(r2).toHaveLength(1)
    expect(r2[0]!.content).toContain('alpha')
  })

  it('revision 变化后重建索引并反映新语料', () => {
    const cache = new IndexCache()
    const a = freshEntry({ content: '旧方案 TypeScript' })
    expect(cache.query([a], 1, 'TypeScript')[0]!.content).toContain('旧方案')

    const b = freshEntry({ content: '新方案 Rust' })
    const hits = cache.query([a, b], 2, 'Rust')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.content).toContain('新方案')
  })

  it('clear 后即使 revision 相同也强制重建', () => {
    const cache = new IndexCache()
    const a = freshEntry({ content: '初始内容 记忆' })
    cache.query([a], 5, '初始')
    cache.clear()
    const b = freshEntry({ content: '重建后 新的' })
    const hits = cache.query([b], 5, '新的')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.content).toContain('重建后')
  })

  it('revision 缺省按 0 处理，与显式 0 等价（复用同一索引）', () => {
    const cache = new IndexCache()
    const a = freshEntry({ content: '缺省版本 内容' })
    expect(cache.query([a], undefined, '缺省')).toHaveLength(1)
    // 仍按 0 处理 → 与上一步同 revision，复用旧索引（不因缺省而强制重建）
    const b = freshEntry({ content: '下一轮 全新' })
    expect(cache.query([b], 0, '下一轮')).toHaveLength(0)
  })
})

describe('isDuplicate 长度预筛（0.3.0）', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.now()

  function existing(content: string): MemoryEntry {
    return freshEntry({ content, createdAt: now - 1000 })
  }

  it('精确命中 O(1) 短路', () => {
    expect(isDuplicate([existing('完全一样的文本内容')], '完全一样的文本内容', DAY, now)).toBe(true)
  })

  it('长度差超过阈值直接跳过编辑距离（语义等价于相似度判定）', () => {
    // longA: 80 字符；shortA: 58 字符，长度差 22 > 0.08*80+1=7.4 → 预筛跳过
    // 长度差 22/80=27.5%，与 similarity 判定语义一致 → 不判重
    const longA = '记忆'.repeat(40)
    const shortA = '记忆'.repeat(26) + '完全不同的尾巴'
    expect(isDuplicate([existing(longA)], shortA, DAY, now)).toBe(false)
  })

  it('长度接近且相似度高仍判重（预筛不误杀）', () => {
    const longB = '今天是晴朗的一天我们计划去郊外野餐带上帐篷和食物还有相机记录美好瞬间'
    const nearB = '今天是晴朗的一天我们计划去郊外野餐带上帐篷和饮料还有相机记录美好瞬间'
    // 长度差 0 → 进入编辑距离，编辑距离 2/56 ≈ 0.96 > 0.92 → 判重
    expect(isDuplicate([existing(longB)], nearB, DAY, now)).toBe(true)
  })

  it('窗口外不判重', () => {
    const old = freshEntry({ content: '很久之前的内容', createdAt: now - 2 * DAY })
    expect(isDuplicate([old], '很久之前的内容', DAY, now)).toBe(false)
  })
})
