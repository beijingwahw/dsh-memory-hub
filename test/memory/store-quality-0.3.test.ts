import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorCodes } from '../../src/errors'
import { JsonlMemoryStore } from '../../src/memory/store'
import { freshEntry } from './utils'

const MASK = 0o777

/**
 * 1.1.1：POSIX 权限位断言仅在非 Windows 平台执行——win32 的 statSync().mode 只区分
 * 读写（0666/0444），0600/0700 等 chmod 位不可观测，断言必假失败（属存量平台限制，
 * 非 0.3.0 行为回归；Linux CI 矩阵仍强制执行本组门禁）。
 */
const itPosix = process.platform === 'win32' ? it.skip : it

describe('存储健壮性边界强化（0.3.0 quality）', () => {
  it('mkdir 失败统一包装为 STORE_WRITE_FAILED（P1-2）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-mkdir-fail-'))
    // 用一个普通文件充当"目录"，mkdir recursive 必然失败（ENOTDIR）
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    await expect(JsonlMemoryStore.open(join(blocker, 'mem.jsonl'))).rejects.toMatchObject({
      code: ErrorCodes.STORE_WRITE_FAILED,
    })
  })

  itPosix('既有共享目录不被收紧权限（P1-3：仅新建目录 0700，文件仍 0600）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-shared-'))
    chmodSync(dir, 0o755)
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(freshEntry({ content: 'ok' }))

    // 既有目录权限原样保留（0o755 未被 chmod 为 0o700）
    expect(statSync(dir).mode & MASK).toBe(0o755)
    // 文件始终 0600（首次创建即生效）
    expect(statSync(file).mode & MASK).toBe(0o600)
    await store.close()

    // 重开后同样不收紧既有目录
    const reopened = await JsonlMemoryStore.open(file)
    expect(statSync(dir).mode & MASK).toBe(0o755)
    await reopened.close()
  })

  itPosix('新建目录收紧为 0700，文件 0600（P1-3）', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mh-newdir-'))
    const dir = join(parent, 'plugin-owned') // 本插件新建的路径
    rmSync(dir, { recursive: true, force: true })
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(freshEntry({ content: 'owned' }))

    expect(statSync(dir).mode & MASK).toBe(0o700)
    expect(statSync(file).mode & MASK).toBe(0o600)
    await store.close()
  })

  itPosix('首次写入即 0600，不依赖 umask（appendFile mode）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-umask-'))
    // 去掉当前进程 umask 对默认权限位的影响：
    // 若缺省 mode，appendFile 新建文件为 0666 & ~umask（通常 0644）——必须显式 0600
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(freshEntry({ content: 'first-line' }))
    expect(statSync(file).mode & MASK).toBe(0o600)
    await store.close()
  })
})
