/**
 * 存储容错路径专场（0.8.0 L10）：把 JsonlMemoryStore 的「优化/隐私路径失败仅告警」
 * 全部闭合——compact 写失败、compact 自检不一致、自检读失败、secure 目录 chmod 失败。
 *
 * 手法：vi.mock('node:fs/promises') 用 vi.fn 包装真实实现（默认委托真实行为），
 * 用例内以 mockRejectedValueOnce / mockImplementationOnce 精确注入单点故障，
 * 验证「已成功落盘的数据绝不因优化失败而丢失、告警可观测」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlMemoryStore } from '../../src/memory/store'
import type { MemoryEntry } from '../../src/memory/types'

// 默认实现 = 真实 fs；单个用例用 *Once 注入故障，随后自动回落真实行为
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const appendFileMock = vi.fn((...args: Parameters<typeof real.appendFile>) => real.appendFile(...args))
  // 部分平台/转译下模块 namespace 的 appendFile 可能未随动态 import 暴露包装实例
  // （writeFile 等均正常，实测 appendFile 偶发）：经 globalThis 直取同实例注入故障
  ;(globalThis as { __mhAppendFileMock?: typeof appendFileMock }).__mhAppendFileMock = appendFileMock
  return {
    ...real,
    appendFile: appendFileMock,
    chmod: vi.fn(real.chmod),
    mkdir: vi.fn(real.mkdir),
    readFile: vi.fn(real.readFile),
    rename: vi.fn(real.rename),
    writeFile: vi.fn(real.writeFile),
  }
})

const mocked = {
  readFile: vi.mocked(readFile),
  /** appendFile 包装实例（globalThis 直取；避免 namespace 属性暴露不一致） */
  appendFile: (globalThis as { __mhAppendFileMock?: ReturnType<typeof vi.fn> }).__mhAppendFileMock as ReturnType<
    typeof vi.fn
  >,
}

let dirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh0.8f-'))
  dirs.push(dir)
  return dir
}
function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `f-${Math.random().toString(36).slice(2, 8)}`,
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
  vi.clearAllMocks() // 仅清空调用记录；默认实现保持真实
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

/** 触发一次 compact：保留 1 条 + 70 次「写入再删除」拉高冗余行数 */
async function forceCompact(store: JsonlMemoryStore, keep: MemoryEntry): Promise<void> {
  await store.upsert(keep)
  for (let i = 0; i < 70; i++) {
    const e = entry(`冗余 ${i}`)
    await store.upsert(e)
    await store.remove(e.id)
  }
}

describe('compact 容错（L10）', () => {
  it('compact 写盘失败仅告警：已落盘条目完好，调用不抛错', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const logs: string[] = []
    const store = await JsonlMemoryStore.open(file, (m) => logs.push(m))
    const keep = entry('核心数据', { id: 'keep-f1' })
    const fsmod = await import('node:fs/promises')
    vi.mocked(fsmod.writeFile).mockRejectedValueOnce(new Error('disk full')) // compact 的 writeFile 注入故障

    await expect(forceCompact(store, keep)).resolves.toBeUndefined() // 成功写入不因优化失败而失败
    const list = await store.list()
    expect(list.map((e) => e.id)).toContain('keep-f1')
    expect(logs.some((l) => l.includes('compact failed'))).toBe(true)
    await store.close()
  })

  it('compact 自检行数不一致仅告警，不影响数据与调用', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const logs: string[] = []
    const store = await JsonlMemoryStore.open(file, (m) => logs.push(m))
    // open 阶段的 readFile（文件不存在 → 真实抛 ENOENT 已被 open 吞掉）已消耗；
    // 下一个 readFile 即 verifyCompact 自检读 → 注入与内存不符的内容，触发 mismatch 告警
    mocked.readFile.mockImplementationOnce(() => Promise.resolve('{"unexpected":true}\n'))

    await forceCompact(store, entry('保留条目', { id: 'keep-f2' }))
    expect(logs.some((l) => l.includes('compact self-check mismatch'))).toBe(true)
    expect((await store.list()).map((e) => e.id)).toContain('keep-f2')
    await store.close()
  })

  it('compact 自检读盘失败仅告警，数据不受影响', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const logs: string[] = []
    const store = await JsonlMemoryStore.open(file, (m) => logs.push(m))
    mocked.readFile.mockRejectedValueOnce(new Error('io error')) // verifyCompact 读盘失败

    await forceCompact(store, entry('保留条目', { id: 'keep-f3' }))
    expect(logs.some((l) => l.includes('compact self-check read failed'))).toBe(true)
    expect((await store.list()).map((e) => e.id)).toContain('keep-f3')
    await store.close()
  })
})

describe('secure 隐私权限容错（L10）', () => {
  it('新建目录的 chmod 失败仅静默吞掉，插件仍可正常打开', async () => {
    const dir = freshDir()
    const nested = join(dir, 'new-sub') // 目录尚不存在 → mkdir recursive 创建 → createdDir 非空 → strictDir=true
    const fsmod = await import('node:fs/promises')
    const chmod = vi.mocked(fsmod.chmod)
    const firstCall = chmod.mock.calls.length
    chmod.mockRejectedValueOnce(new Error('permission denied')) // 目录 0700 收紧失败

    const store = await JsonlMemoryStore.open(join(nested, 'mem.jsonl'))
    expect(await store.list()).toHaveLength(0) // 打开不受影响
    // 文件权限收紧仍被尝试（第二次 chmod 走真实实现，新文件不存在 → ENOENT 被静默吞掉）
    expect(chmod.mock.calls.length).toBeGreaterThan(firstCall)
    await store.close()
  })
})

describe('closed 状态错误路径（L10 补充锚点）', () => {
  it('close 后 upsert 抛 STORE_CLOSED', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.close()
    await expect(store.upsert(entry('晚到数据', { id: 'late-1' }))).rejects.toMatchObject({ code: 'STORE_CLOSED' })
  })
})

describe('0.9.0 质量门补位：compact/corrupt/closed 剩余分支', () => {
  it('compact 空库重建（snapshots 为空的 body 侧分支）', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    // 全部条目写后即删：entries 空、行数拉高 → compact 时序列化 body 为空串
    for (let i = 0; i < 70; i++) {
      const e = entry(`临时 ${i}`)
      await store.upsert(e)
      await store.remove(e.id)
    }
    expect(await store.list()).toHaveLength(0)
    await store.close()
    // 重建后文件为纯空（body='' 分支），重开仍是空库
    const reopened = await JsonlMemoryStore.open(file)
    expect(await reopened.list()).toHaveLength(0)
    await reopened.close()
  })

  it('compact 写盘失败且 err 非 Error：String(err) 告警分支', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const logs: string[] = []
    const store = await JsonlMemoryStore.open(file, (m) => logs.push(m))
    const fsmod = await import('node:fs/promises')
    vi.mocked(fsmod.writeFile).mockRejectedValueOnce('disk full (string)')
    await forceCompact(store, entry('保留条目', { id: 'keep-s1' }))
    expect(logs.some((l) => l.includes('compact failed') && l.includes('disk full (string)'))).toBe(true)
    expect((await store.list()).map((e) => e.id)).toContain('keep-s1')
    await store.close()
  })

  it('compact 自检读盘失败且 err 非 Error：String(err) 告警分支', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const logs: string[] = []
    const store = await JsonlMemoryStore.open(file, (m) => logs.push(m))
    mocked.readFile.mockRejectedValueOnce('io error (string)')
    await forceCompact(store, entry('保留条目', { id: 'keep-s2' }))
    expect(logs.some((l) => l.includes('compact self-check read failed') && l.includes('io error (string)'))).toBe(true)
    await store.close()
  })

  it('损坏行隔离写盘失败仅告警（err 为 Error 与 String 两分支）', async () => {
    // 用例一：Error 实例 → err.message 分支
    const dir1 = freshDir()
    const file1 = join(dir1, 'mem.jsonl')
    await writeFileSyncSafe(
      file1,
      '{"id":"ok-1","kind":"fact","content":"合法条目","tags":[],"source":"explicit","createdAt":1,"updatedAt":1,"accessCount":0}\n{corrupt1}\n',
    )
    mocked.appendFile.mockRejectedValueOnce(new Error('eacces'))
    const logs1: string[] = []
    const s1 = await JsonlMemoryStore.open(file1, (m) => logs1.push(m))
    expect(s1.diagnostics.corrupt).toBe(1) // 数据可读
    expect(logs1.some((l) => l.includes('corrupt isolation failed') && l.includes('eacces'))).toBe(true)
    await s1.close()

    // 用例二：非 Error → String(err) 分支
    const dir2 = freshDir()
    const file2 = join(dir2, 'mem.jsonl')
    await writeFileSyncSafe(
      file2,
      '{"id":"ok-2","kind":"fact","content":"合法条目二","tags":[],"source":"explicit","createdAt":1,"updatedAt":1,"accessCount":0}\n{corrupt2}\n',
    )
    mocked.appendFile.mockRejectedValueOnce('denied (string)')
    const logs2: string[] = []
    const s2 = await JsonlMemoryStore.open(file2, (m) => logs2.push(m))
    expect(s2.diagnostics.corrupt).toBe(1)
    expect(logs2.some((l) => l.includes('corrupt isolation failed') && l.includes('denied (string)'))).toBe(true)
    await s2.close()
  })

  it('closed 后 remove/removeMany/importAll 抛 STORE_CLOSED', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.close()
    await expect(store.remove('anything')).rejects.toMatchObject({ code: 'STORE_CLOSED' })
    await expect(store.removeMany(['a', 'b'])).rejects.toMatchObject({ code: 'STORE_CLOSED' })
    await expect(store.importAll([])).rejects.toMatchObject({ code: 'STORE_CLOSED' })
  })

  it('get 不存在条目返回 undefined（快照拷贝 else 分支）', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.upsert(entry('存在条目', { id: 'exists-1' }))
    expect(await store.get('exists-1')).toMatchObject({ id: 'exists-1' })
    expect(await store.get('missing-zzz')).toBeUndefined()
    await store.close()
  })
})

/** 同步写文件（freshDir 保证目录新；避免 open 阶段 ENOENT 干扰） */
async function writeFileSyncSafe(file: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, content, 'utf8')
}
