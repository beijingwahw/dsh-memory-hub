/**
 * 加密存储集成（1.4.0，DESIGN-1.4 模块 I）行为锁定。
 *
 * 覆盖面：
 * - 新库开加密：首行密钥记录头、落盘无明文、同口令重开 roundtrip、diagnostics.encrypted；
 * - 错口令：加载期快速失败（STORE_READ_FAILED），绝不表现为空库；
 * - 加密库漏配口令：显式失败并指引进错误信息；
 * - 明文库原位加密迁移：迁移后文件全密文、条目相等、**深回放历史逐行保留**
 *   （旧内容版本/tombstone 删除时刻在迁移后仍可回放）；
 * - compact 与加密共存：触发重建后重开条目完整、文件仍全密文；
 * - 单行篡改：非首行的认证失败 → 损坏行隔离留证（.corrupt 增长、其余条目完好）；
 * - 混合文件（密文信封 + 明文行）：可正常加载；
 * - listAsOf 在加密库上回放语义与明文库一致；exportAll 保持明文 JSON（迁移工具语义）。
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const PW = 'correct horse battery staple 眼镜蛇'

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `mh-enc-${name}-`)), 'memories.jsonl')
}

function e(id: string, content: string, at: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return freshEntry({ id, content, createdAt: at, updatedAt: at, ...overrides })
}

/** open 失败的错误负载（code + message；eslint 安全：无 any 断言） */
async function openError(file: string, opts?: { passphrase?: string }): Promise<{ code?: string; message?: string }> {
  try {
    await JsonlMemoryStore.open(file, undefined, opts)
    return {}
  } catch (err) {
    return err as { code?: string; message?: string }
  }
}

/** 向文件尾追加一行明文垃圾（模拟历史损坏行） */
function appendGarbage(file: string, line: string): void {
  appendFileSync(file, line + '\n', 'utf8')
}

describe('加密存储集成（1.4.0 模块 I）', () => {
  it('新库开加密：首行密钥记录头、落盘无明文、同口令重开 roundtrip、encrypted 诊断', async () => {
    const file = tmpFile('new')
    const a = freshEntry({ id: 'a1', content: '数据库 连接串 postgres:// 内部凭据' })
    const b = freshEntry({ id: 'b1', content: '部署脚本 使用 Node 18' })
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      await store.upsert(a)
      await store.upsert(b)
      expect(store.diagnostics.encrypted).toBe(true)
      await store.close()
    }
    const raw = readFileSync(file, 'utf8')
    const first = raw.split('\n')[0]!
    expect(parseKeyRecord(first)).toBeDefined()
    expect(raw).not.toContain('数据库')
    expect(raw).not.toContain('postgres')
    expect(raw).not.toContain('Node 18')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      const list = await store.list()
      expect(list.map((x) => x.id).sort()).toEqual(['a1', 'b1'])
      expect(list.find((x) => x.id === 'a1')?.content).toBe(a.content)
      await store.close()
    }
  })

  it('错口令：加载期快速失败（STORE_READ_FAILED + 口令指引进信息），不表现为空库', async () => {
    const file = tmpFile('wrong')
    const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
    await store.upsert(e('x1', '内容 甲', T0))
    await store.close()
    const err = await openError(file, { passphrase: '错误口令' })
    expect(err.code).toBe('STORE_READ_FAILED')
    expect(err.message ?? '').toContain('passphrase')
  })

  it('加密库漏配口令：显式失败（不把密文行静默清空成空库）', async () => {
    const file = tmpFile('missing')
    const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
    await store.upsert(e('x1', '内容 甲', T0))
    await store.close()
    const err = await openError(file)
    expect(err.code).toBe('STORE_READ_FAILED')
    expect(err.message ?? '').toContain('requires a passphrase')
  })

  it('明文库原位迁移：全密文、条目相等、深回放历史逐行保留（旧版本/删除时刻仍在）', async () => {
    const file = tmpFile('migrate')
    // 明文库：e1 两版（T0 v1 → T0+1d v2）+ e2（T0）+ e2 tombstone（T0+2d，带 at）
    {
      const store = await JsonlMemoryStore.open(file)
      const v1 = e('e1', '部署用 Node 18', T0)
      await store.upsert(v1)
      await store.upsert(e('e2', '缓存 使用 Redis', T0))
      await store.upsert({ ...v1, content: '部署用 Node 20', updatedAt: T0 + DAY })
      await store.removeMany(['e2'], T0 + 2 * DAY)
      await store.close()
    }
    // 带口令重开 → 触发原位加密迁移
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      const list = await store.list()
      expect(list.map((x) => x.id)).toEqual(['e1'])
      expect(list[0]?.content).toBe('部署用 Node 20')
      await store.close()
    }
    const raw = readFileSync(file, 'utf8')
    expect(parseKeyRecord(raw.split('\n')[0]!)).toBeDefined()
    expect(raw).not.toContain('Node 18')
    expect(raw).not.toContain('Node 20')
    expect(raw).not.toContain('Redis')
    // 迁移不合并历史：深回放仍能看到 v1 内容版本与 tombstone 前后的存在性
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      const atT0 = await store.listAsOf(T0 + 1000)
      expect(atT0.find((x) => x.id === 'e1')?.content).toBe('部署用 Node 18')
      const atDel = await store.listAsOf(T0 + 2 * DAY + 1000)
      expect(atDel.find((x) => x.id === 'e2')).toBeUndefined()
      const beforeDel = await store.listAsOf(T0 + DAY + 1000)
      expect(beforeDel.find((x) => x.id === 'e2')?.content).toBe('缓存 使用 Redis')
      await store.close()
    }
  })

  it('compact 与加密共存：触发重建后重开条目完整、文件仍全密文、头保留', async () => {
    const file = tmpFile('compact')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      // 30 条目 + 40 次同 id 重写 = 70 行 ≥ 64 且 > 30×2 → 触发 compact
      for (let i = 0; i < 30; i++) await store.upsert(e(`s${i}`, `条目 ${i} 内容`, T0 + i))
      for (let i = 0; i < 40; i++) await store.upsert({ ...e('s0', `条目 0 重写 ${i}`, T0), updatedAt: T0 + 100 + i })
      expect(store.size).toBe(30)
      const raw = readFileSync(file, 'utf8')
      expect(parseKeyRecord(raw.split('\n')[0]!)).toBeDefined()
      expect(store.diagnostics.compact).toBeDefined()
      await store.close()
    }
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      expect(store.size).toBe(30)
      expect((await store.get('s0'))?.content).toBe('条目 0 重写 39')
      const raw = readFileSync(file, 'utf8')
      expect(raw).not.toContain('条目 1')
      expect(raw).not.toContain('重写 39')
      await store.close()
    }
  })

  it('单行篡改（非首行）：损坏行隔离留证、其余条目完好、corrupt 计数上报', async () => {
    const file = tmpFile('tamper')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      for (let i = 0; i < 5; i++) await store.upsert(e(`t${i}`, `篡改测试 条目 ${i}`, T0 + i))
      await store.close()
    }
    // 翻转第 3 个信封行（非首行 → 首行认证成功，判损坏而非错口令）
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
    const obj = JSON.parse(lines[3]!) as { ct: string }
    lines[3] = JSON.stringify({ ...obj, ct: obj.ct.slice(0, 5) + (obj.ct[5] === 'A' ? 'B' : 'A') + obj.ct.slice(6) })
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      expect(store.size).toBe(4)
      expect(store.diagnostics.corrupt).toBe(1)
      // 损坏密文行留证（.corrupt 审计文件增长）
      expect(existsSync(`${file}.corrupt`)).toBe(true)
      expect(readFileSync(`${file}.corrupt`, 'utf8')).toContain('__enc__')
      await store.close()
    }
  })

  it('混合文件（密文信封 + 明文行）可加载：迁移中间态与外部追加共存', async () => {
    // 先产出一个真实加密库（取密钥记录头 + 一条密文行）
    const src = tmpFile('mixed-src')
    {
      const store = await JsonlMemoryStore.open(src, undefined, { passphrase: PW })
      await store.upsert(e('c1', '密文行 条目', T0))
      await store.close()
    }
    const encLines = readFileSync(src, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
    expect(encLines.length).toBe(2) // 头 + 1 条目
    // 混合文件：头 + 密文行 + 明文行（模拟迁移中断/外部明文追加）
    const file = tmpFile('mixed')
    writeFileSync(
      file,
      [encLines[0], encLines[1], JSON.stringify(e('p1', '明文行 条目', T0))].join('\n') + '\n',
      'utf8',
    )
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      const ids = (await store.list()).map((x) => x.id).sort()
      expect(ids).toEqual(['c1', 'p1'])
      await store.close()
    }
  })

  it('listAsOf 回放语义与明文库一致（asOf 时间线在密文库上逐项正确）', async () => {
    const file = tmpFile('asof')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      const v1 = e('a1', '配置 副本数 3', T0)
      await store.upsert(v1)
      await store.upsert(e('a2', '配置 池化 连接', T0))
      await store.upsert({ ...v1, content: '配置 副本数 5', updatedAt: T0 + DAY })
      await store.close()
    }
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      const early = await store.listAsOf(T0 + 1000)
      expect(early.find((x) => x.id === 'a1')?.content).toBe('配置 副本数 3')
      const late = await store.listAsOf(T0 + DAY + 1000)
      expect(late.find((x) => x.id === 'a1')?.content).toBe('配置 副本数 5')
      // 只读：回放不改变 revision
      const rev = store.revision
      await store.listAsOf(T0)
      expect(store.revision).toBe(rev)
      await store.close()
    }
  })

  it('listAsOf 跳过篡改行：解密失败的行不进回放（其余条目完好）', async () => {
    const file = tmpFile('asof-tamper')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      await store.upsert(e('k1', '回放 条目 1', T0))
      await store.upsert(e('k2', '回放 条目 2', T0 + 1000))
      await store.close()
    }
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
    const obj = JSON.parse(lines[2]!) as { ct: string }
    lines[2] = JSON.stringify({ ...obj, ct: obj.ct.slice(0, 4) + (obj.ct[4] === 'A' ? 'B' : 'A') + obj.ct.slice(5) })
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      const replayed = await store.listAsOf(Number.MAX_SAFE_INTEGER)
      expect(replayed.map((x) => x.id)).toEqual(['k1']) // k2 解密失败被跳过
      await store.close()
    }
  })

  it('迁移含损坏行：明文垃圾行原样加密，迁移后仍按损坏行隔离留证', async () => {
    const file = tmpFile('migrate-corrupt')
    {
      const store = await JsonlMemoryStore.open(file)
      await store.upsert(e('m1', '迁移 前条目', T0))
      await store.close()
    }
    // 明文库手工追加一行垃圾（模拟历史损坏行）
    appendGarbage(file, 'this is definitely not json {{{')
    {
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      expect(store.size).toBe(1) // 垃圾行不计入条目
      await store.close()
    }
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('not json') // 垃圾行也已加密
    {
      // 再次重开：垃圾行解密后仍是垃圾 → 损坏行隔离计数 1
      const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
      expect(store.diagnostics.corrupt).toBe(1)
      expect(existsSync(`${file}.corrupt`)).toBe(true)
      expect(store.size).toBe(1)
      await store.close()
    }
  })

  it('exportAll 保持明文 JSON 数组（跨设备迁移闭环不受加密影响）', async () => {
    const file = tmpFile('export')
    const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
    await store.upsert(e('q1', '导出测试 内容', T0))
    const exported = await store.exportAll()
    const parsed = JSON.parse(exported) as MemoryEntry[]
    expect(parsed.map((x) => x.id)).toEqual(['q1'])
    expect(exported).toContain('导出测试')
    await store.close()
  })
})

describe('插件入口口令接线（1.4.0 模块 I）', () => {
  /** 预置明文库 → 以指定口令挂载插件 → 等工具注册（open 完成即迁移完成）→ 断言密文 */
  async function mountWithPassphrase(passphrase: string | undefined, envPw?: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'mh-pw-'))
    const file = join(dir, 'memories.jsonl')
    writeFileSync(file, JSON.stringify(e('seed', '预置明文 条目内容', T0)) + '\n', 'utf8')
    const ctx = new Context()
    ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = { tools: () => undefined, section: () => undefined }
    new ToolRegistry(ctx)
    const prevEnv = process.env['DSH_MEMORY_PASSPHRASE']
    if (envPw === undefined) delete process.env['DSH_MEMORY_PASSPHRASE']
    else process.env['DSH_MEMORY_PASSPHRASE'] = envPw
    try {
      const fiber = ctx.plugin(plugin, {
        ...defaultConfig,
        storageDir: dir,
        captureMode: 'off',
        ...(passphrase !== undefined ? { passphrase } : {}),
      })
      await fiber
      const deadline = Date.now() + 5000
      while (!ctx.tools.get('memory_status') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(ctx.tools.get('memory_status')).toBeTruthy()
      await fiber.dispose()
    } finally {
      if (prevEnv === undefined) delete process.env['DSH_MEMORY_PASSPHRASE']
      else process.env['DSH_MEMORY_PASSPHRASE'] = prevEnv
    }
    return file
  }

  it('config 显式口令：预置明文库启动即原位加密迁移', async () => {
    const file = await mountWithPassphrase('config-口令')
    const raw = readFileSync(file, 'utf8')
    expect(parseKeyRecord(raw.split('\n')[0]!)).toBeDefined()
    expect(raw).not.toContain('预置明文')
  })

  it('DSH_MEMORY_PASSPHRASE 环境变量同效（config 未设口令时生效）', async () => {
    const file = await mountWithPassphrase(undefined, 'env-口令')
    const raw = readFileSync(file, 'utf8')
    expect(parseKeyRecord(raw.split('\n')[0]!)).toBeDefined()
    expect(raw).not.toContain('预置明文')
  })
})
