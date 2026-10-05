/**
 * 加载冒烟测试：在真实 dsh 运行时（cordis Context + dsh-tools ToolRegistry）中
 * 加载插件，验证 4 个工具注册、事件监听挂载、随插件卸载清理。
 *
 * 注：ToolRegistry 构造依赖 systemPrompt 服务（dsh-system-prompt），
 * 本测试以最小桩替身替代，聚焦验证插件自身的注册/捕获/卸载链路。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index'
import { defaultConfig } from '../src/config'

function makeCtx(): Context {
  const ctx = new Context()
  // 最小 systemPrompt 桩（真实部署由 dsh-system-prompt 提供）
  ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = {
    tools: () => undefined,
    section: () => undefined,
  }
  new ToolRegistry(ctx) // 注册 tools 服务
  return ctx
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('dsh-memory-hub 加载', () => {
  it('在 dsh 运行时中加载并注册 4 个工具', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-load-'))
    const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: dir, captureMode: 'balanced' })
    await fiber // 等待插件启动完成
    await waitFor(() => !!ctx.tools.get('memory_store')) // 存储打开后工具异步注册

    expect(ctx.tools.get('memory_store')).toBeTruthy()
    expect(ctx.tools.get('memory_recall')).toBeTruthy()
    expect(ctx.tools.get('memory_forget')).toBeTruthy()
    expect(ctx.tools.get('memory_status')).toBeTruthy()

    // 存储目录已创建
    const { access } = await import('node:fs/promises')
    await expect(access(dir)).resolves.toBeUndefined()

    await fiber.dispose()
    // 卸载后工具注销
    expect(ctx.tools.get('memory_store')).toBeUndefined()
  })

  it('tools/result 事件可自动捕获事实记忆', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-cap-'))
    const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: dir, captureMode: 'balanced', maxEntryChars: 500 })
    await fiber

    // 模拟一次工具结果事件（比如 run_code 成功执行）
    const exec = {
      callId: 'call-1',
      name: 'run_code',
      arguments: { code: 'console.log(1)' },
      agent: undefined,
      signal: new AbortController().signal,
    } as never
    const result = {
      isError: false,
      content: [{ type: 'text', text: '成功生成了 42 个测试用例并全部通过' }],
    } as never
    ctx.emit('tools/result', exec, result)
    await new Promise((r) => setTimeout(r, 120))

    const recallTool = ctx.tools.get('memory_recall')
    expect(recallTool).toBeTruthy()
    const recalled = await (
      recallTool as unknown as { execute: (a: unknown) => Promise<{ hits?: Array<{ content: string }> }> }
    ).execute({
      query: '测试用例 通过',
    })
    expect((recalled.hits ?? []).length).toBeGreaterThan(0)
    expect(recalled.hits![0]!.content).toContain('run_code')

    await fiber.dispose()
  })

  it('串行捕获队列：高并发事件不风暴、不丢失（全部入库）', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-queue-'))
    const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: dir, captureMode: 'aggressive' })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_store'))

    // 一次性爆发 12 个用户消息事件（模拟密集会话）
    const session = { header: { cwd: undefined } } as never
    for (let i = 0; i < 12; i++) {
      ctx.emit('session/event', session, {
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `请记住测试事项 ${i}` }] },
      } as never)
    }
    // 队列串行消化后全部可见
    const waitTotal = async (cond: number) => {
      const start = Date.now()
      for (;;) {
        const t = ctx.tools.get('memory_status') as unknown as { execute: (a: unknown) => Promise<{ total?: number }> }
        const s = await t.execute({})
        if ((s.total ?? 0) >= cond) return
        if (Date.now() - start > 5000) throw new Error('capture queue timeout')
        await new Promise((r) => setTimeout(r, 40))
      }
    }
    await waitTotal(12)

    const t = ctx.tools.get('memory_status') as unknown as { execute: (a: unknown) => Promise<{ total?: number }> }
    const s = await t.execute({})
    expect(s.total).toBe(12)
    await fiber.dispose()
  })

  it('assistant 消息在 aggressive 模式下经 extractFromAssistant 入库', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-asst-'))
    const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: dir, captureMode: 'aggressive' })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_store'))

    const session = { header: { cwd: undefined } } as never
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: '总结：本次调研的核心结论是成本可降 30%' }] },
      },
    } as never)
    await new Promise((r) => setTimeout(r, 150))

    const recallTool = ctx.tools.get('memory_recall')
    const recalled = await (
      recallTool as unknown as { execute: (a: unknown) => Promise<{ hits?: Array<{ content: string }> }> }
    ).execute({
      query: '调研 结论',
    })
    expect((recalled.hits ?? []).length).toBeGreaterThan(0)
    expect(recalled.hits![0]!.content).toContain('总结')

    await fiber.dispose()
  })

  it('真实数据接入：启动时导入 Markdown 记忆文件与会话 JSONL（0.6.0）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-import-'))
    const doc = join(dir, 'AGENTS.md')
    const log = join(dir, 'session.jsonl')
    writeFileSync(doc, '# 项目约定\n\n记住包管理统一用 pnpm。\n\n- 发布前必须跑全量测试\n- 数据库连接池大小配置为 8')
    writeFileSync(
      log,
      [
        JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '记住日志保留 30 天' }] } }),
        'corrupt-line-should-be-skipped',
        JSON.stringify({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '结论：推荐 8 线程池' }] } },
        }),
      ].join('\n'),
    )

    const ctx = makeCtx()
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      storageDir: dir,
      captureMode: 'balanced',
      importSources: { documents: [doc], sessionLogs: [log] },
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall'))

    // 等待异步导入完成（幂等规划后入库）
    await new Promise((r) => setTimeout(r, 200))
    const recallTool = ctx.tools.get('memory_recall') as unknown as {
      execute: (a: unknown) => Promise<{ hits?: Array<{ content: string }> }>
    }
    // 真实文档内容可被召回（文档来源 exposure）
    const docHit = await recallTool.execute({ query: 'pnpm' })
    expect((docHit.hits ?? []).some((h) => h.content.includes('pnpm'))).toBe(true)
    // 会话日志内容可被召回（自动来源）
    const logHit = await recallTool.execute({ query: '线程池' })
    expect((logHit.hits ?? []).length).toBeGreaterThan(0)
    // 损坏行被跳过：不影响其它真实内容入库
    const docHit2 = await recallTool.execute({ query: '全量测试' })
    expect((docHit2.hits ?? []).length).toBeGreaterThan(0)

    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('真实数据接入：导入源路径不存在时仅告警、不阻断插件启动（0.6.0）', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-import-miss-'))
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      storageDir: dir,
      captureMode: 'balanced',
      importSources: { documents: [join(dir, 'no-such-file.md')], sessionLogs: [join(dir, 'no-such.log')] },
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_recall')) // 工具照常注册
    const statusTool = ctx.tools.get('memory_status') as unknown as {
      execute: (a: unknown) => Promise<{ total?: number }>
    }
    const s = await statusTool.execute({})
    expect(s.total).toBe(0) // 无内容被错误导入
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})
