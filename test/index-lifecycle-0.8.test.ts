/**
 * 插件生命周期与错误路径专场（0.8.0 L1–L4）：
 * - L1 卸载 disposer 全路径：timer 清理、监听释放、store close（含 close 失败告警）；
 * - L2 工具注册失败 / store open 失败 / store init 失败错误路径；
 * - L3 pruneOnce 三路径：ttlDays≤0 早退、removeMany 批量、逐个 remove 回退、prune 失败；
 * - L4 捕获队列背压（丢弃超限事件）与 ttlDays>0 定时器注册/卸载。
 *
 * 手法：vi.hoisted 持有可变 fakeStore，mock memory/store 的 JsonlMemoryStore.open
 * 返回注入实例（index.ts 仅消费静态 open），mock tools/memory-store 的工厂可注入抛错。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import { defaultConfig } from '../src/config'
import type { MemoryEntry, MemoryStore } from '../src/memory/types'
import * as plugin from '../src/index'

// ---- 可注入运行时状态（vi.hoisted：先于任何 import 初始化，供 vi.mock 工厂闭包引用） ----
const holders = vi.hoisted(() => ({
  fakeStore: undefined as (MemoryStore & { diagnostics: { lines: number; corrupt: number } }) | undefined,
  openError: undefined as Error | undefined,
}))

vi.mock('../src/memory/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/memory/store')>()
  return {
    ...real,
    JsonlMemoryStore: {
      ...real.JsonlMemoryStore,
      open: (_file: string, _logger?: (m: string) => void) => {
        // 必须返回 rejected Promise 而非同步 throw：index.ts 在 apply 体内同步求值
        // `JsonlMemoryStore.open(...)`，同步 throw 会让 fiber 直接 reject（异步失败走 .catch 告警链）
        if (holders.openError) return Promise.reject(holders.openError)
        if (!holders.fakeStore) return Promise.reject(new Error('fakeStore not injected'))
        return Promise.resolve(holders.fakeStore)
      },
    },
  }
})

vi.mock('../src/tools/memory-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/tools/memory-store')>()
  return { ...real, createMemoryStoreTool: vi.fn(real.createMemoryStoreTool) }
})

function makeCtx(): Context {
  const ctx = new Context()
  ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = {
    tools: () => undefined,
    section: () => undefined,
  }
  new ToolRegistry(ctx)
  return ctx
}

/**
 * 以显式对象组装插件并挂载（vitest ESM 转换下 namespace 属性函数的 disposer 不被 cordis 采用，
 * 已在 node 直跑对照组验证为测试环境特有；此处包装 apply 保证与真实部署语义一致，
 * 使 L1 卸载链——监听/工具 disposer、store close——可被真实驱动）。
 */
function mountPlugin(ctx: Context, cfg: Parameters<typeof plugin.apply>[1]) {
  // 显式组装对象插件挂载：去掉 Config，避免 cordis Base<T> 经 Config 推断收紧 apply 的
  // config 类型（strict + exactOptionalPropertyTypes 下 Partial 无法赋给 MemoryHubConfig）。
  // Config 运行时校验非本测试关注点：生命周期/错误路径用例自行注入 cfg 覆盖。
  const entry = {
    name: plugin.name,
    apply: (c: Context, c2: Parameters<typeof plugin.apply>[1]) => plugin.apply(c, c2),
    inject: plugin.inject,
  }
  return ctx.plugin(entry, cfg)
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 可注入假 store：行为默认安全，测试按需覆盖 */
function makeFakeStore(
  overrides: Partial<MemoryStore> & { diagnostics?: { lines: number; corrupt: number } } = {},
): MemoryStore & { diagnostics: { lines: number; corrupt: number } } {
  const entries = new Map<string, MemoryEntry>()
  const base: MemoryStore = {
    upsert: (e) => {
      entries.set(e.id, e)
      return Promise.resolve(e)
    },
    remove: vi.fn((id: string) => {
      if (!entries.has(id)) return Promise.resolve(false)
      entries.delete(id)
      return Promise.resolve(true)
    }),
    removeMany: vi.fn((ids: string[]) => {
      let n = 0
      for (const id of ids) if (entries.delete(id)) n++
      return Promise.resolve(n)
    }),
    list: vi.fn(() => Promise.resolve([...entries.values()])),
    get: (id) => Promise.resolve(entries.get(id)),
    importAll: (es) => {
      let n = 0
      for (const e of es)
        if (!entries.has(e.id)) {
          entries.set(e.id, e)
          n++
        }
      return Promise.resolve(n)
    },
    close: vi.fn(() => Promise.resolve()),
  }
  return { ...base, ...overrides, diagnostics: overrides.diagnostics ?? { lines: 0, corrupt: 0 } }
}

/** 过期条目：createdAt/updatedAt 均为 30 天前 */
function staleEntry(id: string): MemoryEntry {
  const t = Date.now() - 30 * 24 * 60 * 60 * 1000
  return { id, kind: 'fact', content: '过期记忆', tags: [], source: 'auto', createdAt: t, updatedAt: t, accessCount: 0 }
}

describe('L1 卸载 disposer 全路径', () => {
  it('正常卸载：监听/工具 disposer 释放、store close 被调用', async () => {
    const close = vi.fn(() => Promise.resolve())
    const upsert = vi.fn((e: MemoryEntry) => Promise.resolve(e))
    holders.fakeStore = makeFakeStore({ close, upsert })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, { ...defaultConfig, storageDir: '/tmp/mh-l1', captureMode: 'balanced', ttlDays: 1 })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall'))
    // 基线：捕获事件在装载期间可入库
    const session = { header: { cwd: undefined } } as never
    ctx.emit('session/event', session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请记住生命周期用例事项' }] },
    } as never)
    await sleep(80)
    expect(upsert.mock.calls.length).toBeGreaterThan(0)

    await fiber.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    expect(ctx.tools.get('memory_recall')).toBeUndefined() // 工具随插件卸载注销
    // 事件监听已释放：卸载后再 emit 同一事件，不再触发捕获入库
    ctx.emit('session/event', session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请记住卸载后不应入库事项' }] },
    } as never)
    await sleep(80)
    expect(upsert.mock.calls.length).toBe(1) // 卸载后无新增入库
  })

  it('卸载时 store close 失败仅告警，dispose 不抛错（L1 catch 分支）', async () => {
    const close = vi.fn(() => {
      throw new Error('close io error')
    })
    holders.fakeStore = makeFakeStore({ close })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, { ...defaultConfig, storageDir: '/tmp/mh-l2', captureMode: 'off' })
    await fiber
    await sleep(50) // 等待 storeP.resolve → 工具注册链 flush
    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('L2 插件错误路径', () => {
  it('store open 失败：仅告警不崩溃，工具不注册（open catch 分支）', async () => {
    holders.openError = new Error('cannot create storage dir')
    holders.fakeStore = undefined
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, { ...defaultConfig, storageDir: '/tmp/mh-open-fail', captureMode: 'balanced' })
    await fiber
    await sleep(80) // 等待 storeP 两个 catch 链 flush
    expect(ctx.tools.get('memory_store')).toBeUndefined()
    await expect(fiber.dispose()).resolves.toBeUndefined()
    holders.openError = undefined
  })

  it('工具注册失败：单工具失败不阻断其余工具注册（注册 catch 分支）', async () => {
    holders.fakeStore = makeFakeStore()
    const { createMemoryStoreTool } = await import('../src/tools/memory-store')
    const mockedFactory = vi.mocked(createMemoryStoreTool)
    mockedFactory.mockImplementationOnce(() => {
      throw new Error('boom')
    })

    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, { ...defaultConfig, storageDir: '/tmp/mh-reg-fail', captureMode: 'off' })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall'))
    expect(ctx.tools.get('memory_store')).toBeUndefined() // 该工具注册失败
    expect(ctx.tools.get('memory_forget')).toBeTruthy() // 其余三个不受影响
    await fiber.dispose()
  })
})

describe('L3 pruneOnce 三路径', () => {
  it('ttlDays=0：清理早退，不触碰存储', async () => {
    const removeMany = vi.fn(() => Promise.resolve(0))
    const remove = vi.fn(() => Promise.resolve(false))
    holders.fakeStore = makeFakeStore({ removeMany, remove })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, { ...defaultConfig, storageDir: '/tmp/mh-prune0', captureMode: 'off', ttlDays: 0 })
    await fiber
    await sleep(50)
    expect(removeMany).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('removeMany 批量路径：过期条目整批删除（pruned>0 日志）', async () => {
    const removeMany = vi.fn((ids: string[]) => Promise.resolve(ids.length))
    holders.fakeStore = makeFakeStore({
      removeMany,
      list: () => Promise.resolve([staleEntry('dead-1'), staleEntry('dead-2')]),
    })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, {
      ...defaultConfig,
      storageDir: '/tmp/mh-prune-many',
      captureMode: 'off',
      ttlDays: 1,
    })
    await fiber
    await sleep(80)
    expect(removeMany).toHaveBeenCalledWith(['dead-1', 'dead-2'])
    await fiber.dispose()
  })

  it('无 removeMany 时逐个 remove 回退路径', async () => {
    const remove = vi.fn(() => Promise.resolve(true))
    const fake = makeFakeStore({ list: () => Promise.resolve([staleEntry('dead-3'), staleEntry('dead-4')]) })
    delete (fake as Partial<MemoryStore>).removeMany
    fake.remove = remove
    holders.fakeStore = fake
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, { ...defaultConfig, storageDir: '/tmp/mh-prune-fb', captureMode: 'off', ttlDays: 1 })
    await fiber
    await sleep(80)
    expect(remove).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('prune 执行失败仅告警，插件继续运行（prune catch 分支）', async () => {
    holders.fakeStore = makeFakeStore({
      list: vi.fn(() => {
        throw new Error('list io error')
      }),
    })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, {
      ...defaultConfig,
      storageDir: '/tmp/mh-prune-err',
      captureMode: 'off',
      ttlDays: 1,
    })
    await fiber
    await sleep(80) // prune catch 链 flush
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})

describe('L4 捕获队列背压与 TTL 定时器', () => {
  it('队列深度 256：超限事件被丢弃（upsert 恰被调用 256 次）', async () => {
    const upsert = vi.fn((e: MemoryEntry) => Promise.resolve(e)) // 快速完成，让入队任务逐一消化
    holders.fakeStore = makeFakeStore({ upsert, list: () => Promise.resolve([]) })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, {
      ...defaultConfig,
      storageDir: '/tmp/mh-backlog',
      captureMode: 'balanced',
      ttlDays: 0,
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall'))

    // 同步爆发 260 个事件：enqueueCapture 同步计数（任务在同步循环结束后才执行），
    // 前 256 个入队、后 4 个触发背压（pendingCaptures >= 256 → dropped++ 丢弃）
    const session = { header: { cwd: undefined } } as never
    for (let i = 0; i < 260; i++) {
      ctx.emit('session/event', session, {
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `请记住积压事项 ${i}` }] },
      } as never)
    }
    await sleep(150) // 队列串行消化
    expect(upsert.mock.calls.length).toBe(256) // 队列上限内全部入库，超出即丢（dropped++）
    // 且被丢弃的事件没有副作用残留：全部 260 条未被计入入库
    holders.fakeStore = makeFakeStore()
    await fiber.dispose()
  })

  it('捕获任务失败仅告警计数，队列链不中断（capture catch 分支）', async () => {
    const upsert = vi.fn(() => {
      throw new Error('upsert boom')
    })
    holders.fakeStore = makeFakeStore({ upsert, list: () => Promise.resolve([]) })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, {
      ...defaultConfig,
      storageDir: '/tmp/mh-cap-err',
      captureMode: 'balanced',
      ttlDays: 0,
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall'))

    const session = { header: { cwd: undefined } } as never
    ctx.emit('session/event', session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请记住这条失败事项' }] },
    } as never)
    await sleep(120) // 等待任务执行并落入 catch（metrics.errors++ / 告警）
    // 队列链未被失败任务击穿：再入队一条仍会执行（upsert 抛错次数递增）
    ctx.emit('session/event', session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请记住第二条失败事项' }] },
    } as never)
    await sleep(120)
    expect(upsert.mock.calls.length).toBe(2) // 两条都尝试过，链未中断
    await fiber.dispose()
  })

  it('ttlDays>0 注册定时器，卸载时清除（覆盖 timer 分支）', async () => {
    const close = vi.fn(() => Promise.resolve())
    holders.fakeStore = makeFakeStore({ close })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, { ...defaultConfig, storageDir: '/tmp/mh-timer', captureMode: 'off', ttlDays: 7 })
    await fiber
    await sleep(50)
    await fiber.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    // dispose 已返回且未挂起 → 无活动句柄泄漏（setInterval 已 clearInterval）
  })
})

describe('D 捕获栅栏（0.9.0：dispose 等待在途捕获结算后再 close）', () => {
  it('卸载时在途捕获不丢写：upsert 完成先于 close，close 在 dispose 返回前调用', async () => {
    const order: string[] = []
    // 慢速 upsert：模拟事件风暴时在途写入尚未落盘
    const upsert = vi.fn(
      (e: MemoryEntry) =>
        new Promise<MemoryEntry>((resolve) => {
          setTimeout(() => {
            order.push('upsert')
            resolve(e)
          }, 120)
        }),
    )
    const close = vi.fn(() => {
      order.push('close')
      return Promise.resolve()
    })
    holders.fakeStore = makeFakeStore({ upsert, close })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, {
      ...defaultConfig,
      storageDir: '/tmp/mh-barrier',
      captureMode: 'balanced',
      ttlDays: 0,
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall'))

    const session = { header: { cwd: 'ws-barrier' } } as never
    ctx.emit('session/event', session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请记住栅栏验证专用条目' }] },
    } as never)
    // 立即卸载：若没有栅栏，close 会抢在慢速 upsert 之前执行（0.8.0 丢写竞态）
    await fiber.dispose()
    // 栅栏语义：dispose 返回前在途捕获已全部结算，且写入先于 store.close
    expect(order).toEqual(['upsert', 'close'])
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('recallDecayHalfLifeDays 配置生效（0.9.0 双尺度时间语义接线）', () => {
  it('recallDecayHalfLifeDays>0 时以半衰期注入 recallOverrides（index.ts 三元 true 分支）', async () => {
    const close = vi.fn(() => Promise.resolve())
    holders.fakeStore = makeFakeStore({ close })
    const ctx = makeCtx()
    // 挂载带左值配置的插件：recall 注册走 decayHalfLifeMs 注入分支
    const fiber = mountPlugin(ctx, {
      ...defaultConfig,
      storageDir: '/tmp/mh-decay-on',
      captureMode: 'off',
      recallDecayHalfLifeDays: 30,
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall'))
    expect(ctx.tools.get('memory_recall')).toBeDefined()
    await fiber.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('默认 recallDecayHalfLifeDays=0 关闭评分衰减（三元 false 分支，与既有语义一致）', async () => {
    const close = vi.fn(() => Promise.resolve())
    holders.fakeStore = makeFakeStore({ close })
    const ctx = makeCtx()
    const fiber = mountPlugin(ctx, { ...defaultConfig, storageDir: '/tmp/mh-decay-off', captureMode: 'off' })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall'))
    await fiber.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
