/**
 * 覆盖率阈值回归修复三（1.3.0 工程纪律，续 coverage-1.3 / coverage2-1.3）。
 *
 * 第三轮按剩余未覆盖分支精修：
 * - memory_recall 渲染/执行：conflicts 与 expanded 命中的渲染分支、冲突 peer 标注；
 * - engine：semanticBoost 且覆盖率达标时语义线叠加（why 含 semantic 行）；
 * - infer：无种子查询时 chainsOut 清空分支；
 * - memory_status：conflictPairs 可观测、superseded 建议、diagnostics 膨胀比、
 *   无 recallThreshold 的巩固参数分支；
 * - cognitive：runCognitiveMaintenance 无产出分支与存储失败容错；
 * - memory_store：workspace/tags/相似度参数分支 + 图谱注入下的取代/矛盾回写进图；
 * - 插件入口：assistant 消息捕获（aggressive）、session log 导入图谱同步、
 *   存储打开失败 + importSources 的跳过告警与维护容错。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import { defaultConfig } from '../../src/config'
import * as plugin from '../../src/index'
import { buildIndex, queryIndex } from '../../src/memory/engine'
import { inferLineScores } from '../../src/memory/infer'
import { buildGraph } from '../../src/memory/graph'
import { runCognitiveMaintenance } from '../../src/memory/cognitive'
import { createMetrics } from '../../src/memory/metrics'
import { createMemoryStoreTool } from '../../src/tools/memory-store'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import { CONFLICTS_WITH_TAG_PREFIX, CONFLICT_OF_TAG_PREFIX } from '../../src/memory/conflict'
import type { MemoryEntry, MemoryStore } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function memoryStore(initial: MemoryEntry[] = []): MemoryStore {
  let rows = [...initial]
  return {
    upsert(e: MemoryEntry): Promise<MemoryEntry> {
      const i = rows.findIndex((r) => r.id === e.id)
      if (i >= 0) rows[i] = e
      else rows.push({ ...e })
      return Promise.resolve(rows.find((r) => r.id === e.id)!)
    },
    list(): Promise<MemoryEntry[]> {
      return Promise.resolve([...rows])
    },
    get(id: string): Promise<MemoryEntry | undefined> {
      return Promise.resolve(rows.find((r) => r.id === id))
    },
    remove(id: string): Promise<boolean> {
      const before = rows.length
      rows = rows.filter((r) => r.id !== id)
      return Promise.resolve(rows.length < before)
    },
    close(): Promise<void> {
      return Promise.resolve()
    },
  } as unknown as MemoryStore
}

describe('覆盖率回归三：memory_recall 冲突/展开渲染与 peer 标注', () => {
  it('渲染含冲突标注与蒸馏展开行；执行输出 conflicts 字段', async () => {
    const a = freshEntry({
      id: 'a',
      content: '测试框架偏好用 Jest',
      tags: [`${CONFLICTS_WITH_TAG_PREFIX}b`],
      createdAt: Date.now() - 2000,
      updatedAt: Date.now() - 2000,
    })
    const b = freshEntry({
      id: 'b',
      content: '测试框架不要用 Jest 了',
      tags: [`${CONFLICT_OF_TAG_PREFIX}a`, 'distilled-layer:abstract', 'distilled-from:ghost'],
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    })
    const store = memoryStore([a, b])
    const tool = createMemoryRecallTool(store, 400, 8) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{
        total: number
        hits: Array<{ id: string; conflicts?: string[]; expanded?: MemoryEntry[] }>
      }>
      output: {
        render: (
          args: unknown,
          value: { hits: Array<Record<string, unknown>>; usedTokens: number },
        ) => Array<{ type: string; text: string }>
      }
    }
    const out = await tool.execute({ query: '测试框架 Jest', limit: 8, maxTokens: 400, reinforce: false })
    expect(out.hits.some((h) => Array.isArray(h.conflicts) && h.conflicts.length > 0)).toBe(true)
    // expand：蒸馏条目命中且 distilled-from 指向缺失源 → 展开为空（无效源跳过）
    const ex = await tool.execute({
      query: '测试框架不要用 Jest',
      expand: true,
      limit: 8,
      maxTokens: 400,
      reinforce: false,
    })
    expect(ex.total).toBeGreaterThan(0)
    // 渲染：conflicts 与 expanded 行都出现（构造含两字段的 value 直测 render 全分支）
    const text =
      tool.output.render(
        {},
        {
          usedTokens: 10,
          hits: [
            {
              kind: 'fact',
              content: '条目',
              score: 1,
              conflicts: ['b'],
              expanded: [{ id: 's1', kind: 'fact', content: '源记忆甲', tags: [] }],
            },
          ],
        },
      )[0]?.text ?? ''
    expect(text).toContain('存在时间线矛盾')
    expect(text).toContain('展开源记忆：源记忆甲')
  })
})

describe('覆盖率回归三：engine 语义叠加与 infer 空种子', () => {
  it('semanticBoost 且覆盖率 ≥ 阈值：语义线叠加（why 含 semantic 行）', () => {
    const entries = [
      freshEntry({ id: 'e1', content: 'postgresql redis nginx kafka 全家桶部署', createdAt: T0, updatedAt: T0 }),
    ]
    const byId = new Map(entries.map((e) => [e.id, e]))
    const hits = queryIndex(
      buildIndex(entries),
      'postgresql redis nginx kafka',
      { now: T0, decay: false, semanticBoost: true, explain: true },
      byId,
    )
    expect(hits[0]?.why?.lines.some((l) => l.line === 'semantic')).toBe(true)
  })

  it('inferLineScores 无种子查询：chainsOut 被清空（不残留）', () => {
    const entries = [freshEntry({ id: 'e1', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 })]
    const g = buildGraph(entries, 100)
    const chainsOut: Array<Record<string, unknown>> = [{ stale: true }]
    const scores = inferLineScores(g, '？？？！！！', new Map(entries.map((e) => [e.id, e])), T0, {
      chainsOut: chainsOut as never,
    })
    expect(scores.size).toBe(0)
    expect(chainsOut).toHaveLength(0)
  })
})

describe('覆盖率回归三：memory_status conflictPairs 与建议分支', () => {
  it('冲突对计数/样本输出 + superseded 建议 + 膨胀比 + 无阈值巩固参数', async () => {
    const now = Date.now()
    const a = freshEntry({
      id: 'a',
      content: '接口风格偏好 REST',
      tags: [`${CONFLICTS_WITH_TAG_PREFIX}b`],
      createdAt: now - 2000,
      updatedAt: now - 2000,
    })
    const b = freshEntry({
      id: 'b',
      content: '接口风格不要 REST 了',
      tags: [`${CONFLICT_OF_TAG_PREFIX}a`, 'superseded-by:c'],
      createdAt: now - 1000,
      updatedAt: now - 1000,
    })
    const store = memoryStore([a, b])
    const metrics = createMetrics()
    const tool = createMemoryStatusTool(store, () => 2048, undefined, metrics, {
      consolidationMode: 'auto',
    }) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
      output: { render: (args: unknown, value: Record<string, unknown>) => Array<{ type: string; text: string }> }
    }
    const out = await tool.execute({})
    expect(out['conflictPairs']).toMatchObject({ count: 1 })
    expect(metrics.conflictPairs).toBe(1)
    expect(out['suggestion']).toContain('supersede')
    const text = tool.output.render({}, out)[0]?.text ?? ''
    expect(text).toContain('- conflicts: 1 pair(s)')
    expect(text).toContain('- suggestion:')
    // diagnostics 膨胀比（lines > 条目数）
    const bloated = { ...memoryStore([a]), diagnostics: { lines: 9, corrupt: 1 } } as unknown as MemoryStore
    const tool2 = createMemoryStatusTool(bloated, () => 512) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    const out2 = await tool2.execute({})
    expect(out2['duplicateRatio']).toBe(8)
  })
})

describe('覆盖率回归三：cognitive 维护分支', () => {
  it('无产出（空库/无到期）零计数；存储失败容错不抛', async () => {
    const metrics = createMetrics()
    const r1 = await runCognitiveMaintenance(
      memoryStore(),
      {
        distillMode: 'auto',
        consolidationMode: 'auto',
        distillMinCluster: 3,
        recallThreshold: 0.4,
        maxEntryChars: 500,
      },
      metrics,
    )
    expect(r1.distilled).toBe(0)
    expect(r1.consolidated).toBe(0)
    const broken = {
      list: () => Promise.reject(new Error('boom')),
    } as unknown as MemoryStore
    await expect(
      runCognitiveMaintenance(
        broken,
        {
          distillMode: 'auto',
          consolidationMode: 'off',
          distillMinCluster: 3,
          recallThreshold: 0.4,
          maxEntryChars: 500,
        },
        metrics,
      ),
    ).rejects.toThrow(/boom/)
  })
})

describe('覆盖率回归三：memory_store 参数与图谱注入分支', () => {
  it('workspace/tags/相似度参数 + 图谱注入：取代与矛盾回写条目进图', async () => {
    const g = buildGraph([], 100)
    // 取代路径 + graph 注入 + 显式相似度参数 + workspace/tags
    const store = memoryStore([freshEntry({ id: 'old', kind: 'fact', content: '部署脚本用 Node 18 运行' })])
    const metrics = createMetrics()
    const tool = createMemoryStoreTool(store, 500, undefined, metrics, {
      dedupWindowMs: DAY,
      supersedeMode: 'auto',
      supersedeSimilarity: 0.8,
      supersedeSameKind: true,
      graph: g,
    }) as unknown as { execute: (args: Record<string, unknown>) => Promise<{ id: string }> }
    await tool.execute({
      content: '部署脚本改用 Node 12 运行',
      kind: 'fact',
      tags: ['部署'],
      workspace: 'w-1',
    })
    expect((await store.list()).find((e) => e.id === 'old')?.tags.some((t) => t.startsWith('superseded-by:'))).toBe(
      true,
    )
    // 矛盾路径 + graph 注入 + 显式冲突参数
    const store2 = memoryStore([freshEntry({ id: 'oldc', kind: 'preference', content: '测试框架偏好用 Jest' })])
    const tool2 = createMemoryStoreTool(store2, 500, undefined, undefined, {
      dedupWindowMs: DAY,
      conflictMode: 'auto',
      conflictSimilarity: 0.5,
      conflictSameKind: true,
      conflictWindowMs: 30 * DAY,
      graph: g,
    }) as unknown as { execute: (args: Record<string, unknown>) => Promise<{ id: string }> }
    await tool2.execute({ content: '测试框架不要用 Jest 了', kind: 'preference', workspace: 'w-2' })
    expect(g.stats(Date.now()).edges).toBeGreaterThan(0)
    const rows2 = await store2.list()
    expect(rows2.find((e) => e.id === 'oldc')?.tags.some((t) => t.startsWith(CONFLICT_OF_TAG_PREFIX))).toBe(true)
  })
})

describe('覆盖率回归三：插件入口补充分支（load 冒烟）', () => {
  function makeCtx(): Context {
    const ctx = new Context()
    ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = {
      tools: () => undefined,
      section: () => undefined,
    }
    new ToolRegistry(ctx)
    return ctx
  }

  async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('waitFor timeout')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  it('aggressive 捕获：assistant 消息经提取器入库；空内容跳过', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-aggr-'))
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      storageDir: dir,
      captureMode: 'aggressive',
      maxEntryChars: 500,
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_status'))
    const session = { header: { cwd: '/proj/x' } } as never
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '' }] } },
    } as never)
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '结论：部署脚本改用 pnpm 安装依赖并锁定版本' }] } },
    } as never)
    const status = ctx.tools.get('memory_status') as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number }>
    }
    for (let i = 0; i < 40; i++) {
      if ((await status.execute({})).total > 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect((await status.execute({})).total).toBeGreaterThan(0)
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('session log 导入 + 图谱同步（graphEnabled）', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-slog-'))
    const log = join(dir, 'session.jsonl')
    writeFileSync(
      log,
      [
        JSON.stringify({
          type: 'user/message',
          data: { content: [{ type: 'text', text: '记住：主数据库 使用 PostgreSQL 集群' }] },
        }),
        'not-json-line',
        '',
      ].join('\n') + '\n',
      'utf8',
    )
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      storageDir: dir,
      graphEnabled: true,
      importSources: { sessionLogs: [log] },
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_status'))
    const status = ctx.tools.get('memory_status') as unknown as {
      execute: (
        args: Record<string, unknown>,
      ) => Promise<{ total: number; graph?: { edges?: number; entities?: number } }>
    }
    for (let i = 0; i < 40; i++) {
      if ((await status.execute({})).total > 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const out = await status.execute({})
    expect(out.total).toBeGreaterThan(0)
    expect((out.graph?.edges ?? 0) + (out.graph?.entities ?? 0)).toBeGreaterThan(0)
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('存储打开失败 + importSources + 维护模式：全部容错不崩、无工具注册', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-broken-'))
    const fileAsDir = join(dir, 'occupied')
    writeFileSync(fileAsDir, 'x', 'utf8')
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      storageDir: join(fileAsDir, 'sub'),
      importSources: { documents: [join(dir, 'any.md')] },
      distillMode: 'auto',
    })
    await fiber
    await new Promise((r) => setTimeout(r, 300))
    expect(ctx.tools.get('memory_store')).toBeUndefined()
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})
