/**
 * 口令轮换与解密回退（1.5.0，DESIGN-1.5 模块 K）行为锁定。
 *
 * 覆盖面：
 * - 加密库换新口令：全密文逐行原序重写（新盐头）、旧口令即刻失效、新口令 roundtrip、
 *   **深回放历史完整保留**（旧内容版本 / tombstone 删除时刻在轮换后仍可回放）；
 * - 同口令再轮换 = 密钥卫生（换新盐，条目不变）；
 * - 解密回退（空口令）：信封剥除回明文、无密钥记录头、无口令重开可用、encrypted 诊断缺席；
 * - 明文→明文 no-op（文件字节不变）；运行期明文→加密（不经 open 迁移路径）；
 * - 空库轮换：编解码器先行武装，首写按新形态落盘（头 + 信封）；
 * - closed store 拒绝；写锁被外部存活实例持有时拒绝（真子进程锁占用）；
 * - 轮换保留损坏行隔离语义（垃圾行轮换后仍按损坏行计数留证）；
 * - 插件入口接线：DSH_MEMORY_NEW_PASSPHRASE 启动期轮换（换口令 / 解密回退两臂）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../../src/config'
import * as plugin from '../../src/index'
import { parseKeyRecord } from '../../src/memory/crypto'
import { JsonlMemoryStore } from '../../src/memory/store'
import type { MemoryEntry } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const PW1 = 'first 口令 alpha'
const PW2 = 'second 口令 beta'

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `mh-rot-${name}-`)), 'memories.jsonl')
}

function e(id: string, content: string, at: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return freshEntry({ id, content, createdAt: at, updatedAt: at, ...overrides })
}

/** changePassphrase 失败的错误负载（code + message；eslint 安全：无 any 断言） */
async function rotateError(store: JsonlMemoryStore, pw: string): Promise<{ code?: string; message?: string }> {
  try {
    await store.changePassphrase(pw)
    return {}
  } catch (err) {
    return err as { code?: string; message?: string }
  }
}

describe('口令轮换与解密回退（1.5.0 模块 K）', () => {
  it('加密库换新口令：旧口令即刻失效、新口令 roundtrip、深回放历史逐行保留、文件零明文', async () => {
    const file = tmpFile('swap')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      const v1 = e('e1', '部署用 Node 18', T0)
      await store.upsert(v1)
      await store.upsert(e('e2', '缓存 使用 Redis', T0))
      await store.upsert({ ...v1, content: '部署用 Node 20', updatedAt: T0 + DAY })
      await store.removeMany(['e2'], T0 + 2 * DAY)
      await store.close()
    }
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      await store.changePassphrase(PW2)
      await store.close()
    }
    const raw = readFileSync(file, 'utf8')
    const header = parseKeyRecord(raw.split('\n')[0]!)
    expect(header).toBeDefined()
    expect(raw).not.toContain('Node 18')
    expect(raw).not.toContain('Redis')
    // 旧口令即刻失效（新盐派生新密钥，全部信封认证失败 → 快速失败）
    await expect(JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })).rejects.toThrow('wrong passphrase')
    // 新口令：roundtrip + 深回放历史完整（v1 内容版本与 tombstone 前后存在性）
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW2 })
      expect((await store.list()).map((x) => x.id)).toEqual(['e1'])
      const atT0 = await store.listAsOf(T0 + 1000)
      expect(atT0.find((x) => x.id === 'e1')?.content).toBe('部署用 Node 18')
      const beforeDel = await store.listAsOf(T0 + DAY + 1000)
      expect(beforeDel.find((x) => x.id === 'e2')?.content).toBe('缓存 使用 Redis')
      const atDel = await store.listAsOf(T0 + 2 * DAY + 1000)
      expect(atDel.find((x) => x.id === 'e2')).toBeUndefined()
      await store.close()
    }
  })

  it('同口令再轮换 = 密钥卫生：头盐更换、条目不变、轮换前后两次读取一致', async () => {
    const file = tmpFile('same')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      await store.upsert(e('k1', '条目 内容 甲', T0))
      await store.changePassphrase(PW1)
      await store.close()
    }
    const salt2 = parseKeyRecord(readFileSync(file, 'utf8').split('\n')[0]!)!.salt
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      await store.changePassphrase(PW1)
      await store.close()
    }
    const salt3 = parseKeyRecord(readFileSync(file, 'utf8').split('\n')[0]!)!.salt
    expect(salt2.equals(salt3)).toBe(false) // 每次轮换换新盐
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      expect((await store.list()).map((x) => x.id)).toEqual(['k1'])
      await store.close()
    }
  })

  it('解密回退（空口令）：信封剥除回明文、无密钥记录头、无口令重开可用、encrypted 诊断缺席', async () => {
    const file = tmpFile('decrypt')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      await store.upsert(e('d1', '解密 回退 条目', T0))
      await store.changePassphrase('')
      await store.close()
    }
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('解密 回退 条目')
    expect(raw).not.toContain('__enc__')
    expect(parseKeyRecord(raw.split('\n')[0]!)).toBeUndefined()
    {
      const store = await JsonlMemoryStore.open(file)
      expect((await store.list()).map((x) => x.id)).toEqual(['d1'])
      expect(store.diagnostics.encrypted).toBeUndefined()
      await store.close()
    }
  })

  it('明文→明文 no-op：文件字节不变、不抛出', async () => {
    const file = tmpFile('noop')
    {
      const store = await JsonlMemoryStore.open(file)
      await store.upsert(e('n1', '明文 no-op 条目', T0))
      await store.close()
    }
    const before = readFileSync(file, 'utf8')
    {
      const store = await JsonlMemoryStore.open(file)
      await store.changePassphrase('')
      await store.close()
    }
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('运行期明文→加密（不经 open 迁移）：轮换后落盘全密文 + 头', async () => {
    const file = tmpFile('arm')
    {
      const store = await JsonlMemoryStore.open(file)
      await store.upsert(e('a1', '运行期 启用加密', T0))
      await store.changePassphrase(PW1)
      await store.close()
    }
    const raw = readFileSync(file, 'utf8')
    expect(parseKeyRecord(raw.split('\n')[0]!)).toBeDefined()
    expect(raw).not.toContain('运行期 启用加密')
  })

  it('空库轮换：编解码器先行武装，首写按新形态落盘（头 + 信封）', async () => {
    const file = tmpFile('empty')
    const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
    await store.changePassphrase(PW2)
    await store.upsert(e('z1', '空库 首写 条目', T0))
    await store.close()
    const raw = readFileSync(file, 'utf8')
    expect(parseKeyRecord(raw.split('\n')[0]!)).toBeDefined()
    expect(raw).not.toContain('空库 首写')
    await expect(JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })).rejects.toThrow('wrong passphrase')
  })

  it('轮换读失败（非 ENOENT）显式抛出 STORE_READ_FAILED，文件保持目录原状', async () => {
    const file = tmpFile('readdir')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      await store.upsert(e('r1', '读取失败 条目', T0))
      await store.close()
    }
    const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
    // 记忆文件路径换成目录：readFile 得 EISDIR（非 ENOENT）→ 轮换读失败显式抛出
    rmSync(file)
    mkdirSync(file)
    const err = await rotateError(store, PW2)
    expect(err.code).toBe('STORE_READ_FAILED')
    expect(err.message ?? '').toContain('passphrase rotation')
    rmSync(file, { recursive: true, force: true })
    await store.close()
  })

  it('加密库含损坏信封行时轮换：损坏行原样重写（不丢弃证据），轮换后仍隔离计数', async () => {
    const file = tmpFile('corrupt-enc')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      for (let i = 0; i < 4; i++) await store.upsert(e(`t${i}`, `损坏轮换 条目 ${i}`, T0 + i))
      await store.close()
    }
    // 篡改第 3 信封行（非首行）→ 解码失败行
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
    const obj = JSON.parse(lines[3]!) as { ct: string }
    lines[3] = JSON.stringify({ ...obj, ct: obj.ct.slice(0, 5) + (obj.ct[5] === 'A' ? 'B' : 'A') + obj.ct.slice(6) })
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      expect(store.diagnostics.corrupt).toBe(1)
      await store.changePassphrase(PW2)
      await store.close()
    }
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW2 })
      expect(store.diagnostics.corrupt).toBe(1) // 损坏行原样重写（换密钥外衣后仍是损坏行）
      expect(store.size).toBe(3)
      await store.close()
    }
  })

  it('closed store 拒绝轮换（STORE_CLOSED）', async () => {
    const file = tmpFile('closed')
    const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
    await store.close()
    const err = await rotateError(store, PW2)
    expect(err.code).toBe('STORE_CLOSED')
  })

  it('写锁被外部存活实例持有：整文件重写被拒绝（compact 同级多进程护栏）', async () => {
    const file = tmpFile('locked')
    // 先写条目并关闭（落一个真实加密库）
    {
      const seed = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      await seed.upsert(e('l1', '锁占用 条目', T0))
      await seed.close() // 释放本进程锁
    }
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 300))
      expect(child.pid).toBeGreaterThan(0)
      // 外部存活实例的锁先落位 → open 探测到后禁用 compact 与整文件重写
      writeFileSync(`${file}.lock`, `${child.pid}\n`, 'utf8')
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      const err = await rotateError(store, PW2)
      expect(err.code).toBe('STORE_WRITE_FAILED')
      expect(err.message ?? '').toContain('exclusive write lock')
      // 拒绝后库仍以原口令正常可用（文件未被触碰）
      expect((await store.list()).map((x) => x.id)).toEqual(['l1'])
      await store.close()
    } finally {
      child.kill()
    }
  })

  it('轮换保留损坏行隔离语义：明文垃圾行轮换加密后仍按损坏行计数留证', async () => {
    const file = tmpFile('corrupt')
    {
      const store = await JsonlMemoryStore.open(file)
      await store.upsert(e('c1', '轮换 含损坏行', T0))
      await store.close()
    }
    writeFileSync(file, `${readFileSync(file, 'utf8')}this is garbage {{{\n`, 'utf8')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
      expect(store.diagnostics.corrupt).toBe(1)
      await store.changePassphrase(PW2)
      await store.close()
    }
    expect(readFileSync(file, 'utf8')).not.toContain('garbage')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW2 })
      expect(store.diagnostics.corrupt).toBe(1)
      expect(store.size).toBe(1)
      await store.close()
    }
  })
})

describe('DSH_MEMORY_NEW_PASSPHRASE 启动期轮换接线（1.5.0 模块 K）', () => {
  /** 预置库 → 设环境变量挂载插件 → 等工具注册（open + 轮换完成后注册）→ 返回文件路径 */
  async function mountWithRotation(initial: { passphrase?: string }, rotate: { next: string }): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'mh-rotw-'))
    const file = join(dir, 'memories.jsonl')
    {
      const store = await JsonlMemoryStore.open(
        file,
        undefined,
        initial.passphrase !== undefined ? { passphrase: initial.passphrase } : undefined,
      )
      await store.upsert(e('seed', '预置 轮换 条目', T0))
      await store.close()
    }
    const ctx = new Context()
    ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = { tools: () => undefined, section: () => undefined }
    new ToolRegistry(ctx)
    const prevOld = process.env['DSH_MEMORY_PASSPHRASE']
    const prevNew = process.env['DSH_MEMORY_NEW_PASSPHRASE']
    if (initial.passphrase === undefined) delete process.env['DSH_MEMORY_PASSPHRASE']
    else process.env['DSH_MEMORY_PASSPHRASE'] = initial.passphrase
    process.env['DSH_MEMORY_NEW_PASSPHRASE'] = rotate.next
    try {
      const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: dir, captureMode: 'off' })
      await fiber
      const deadline = Date.now() + 5000
      while (!ctx.tools.get('memory_status') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(ctx.tools.get('memory_status')).toBeTruthy()
      await fiber.dispose()
    } finally {
      if (prevOld === undefined) delete process.env['DSH_MEMORY_PASSPHRASE']
      else process.env['DSH_MEMORY_PASSPHRASE'] = prevOld
      if (prevNew === undefined) delete process.env['DSH_MEMORY_NEW_PASSPHRASE']
      else process.env['DSH_MEMORY_NEW_PASSPHRASE'] = prevNew
    }
    return file
  }

  it('换口令臂：启动即轮换到新口令（旧口令失效）', async () => {
    const file = await mountWithRotation({ passphrase: PW1 }, { next: PW2 })
    await expect(JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })).rejects.toThrow('wrong passphrase')
    const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW2 })
    expect((await store.list()).map((x) => x.id)).toEqual(['seed'])
    await store.close()
  })

  it('解密回退臂：NEW_PASSPHRASE 空串 → 启动即解密回明文', async () => {
    const file = await mountWithRotation({ passphrase: PW1 }, { next: '' })
    expect(readFileSync(file, 'utf8')).toContain('预置 轮换 条目')
    const store = await JsonlMemoryStore.open(file)
    expect((await store.list()).map((x) => x.id)).toEqual(['seed'])
    await store.close()
  })

  it('明文库启用加密臂：无当前口令 + NEW 非空 → 启动即原位加密', async () => {
    const file = await mountWithRotation({}, { next: PW2 })
    const raw = readFileSync(file, 'utf8')
    expect(parseKeyRecord(raw.split('\n')[0]!)).toBeDefined()
    expect(raw).not.toContain('预置 轮换 条目')
  })
})
