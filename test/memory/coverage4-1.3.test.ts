/**
 * 覆盖率阈值回归修复四（1.3.0 工程纪律，终轮）。
 *
 * 按剩余未覆盖分支的逐行清单精修（多为复合条件守卫的第二/三臂与关闭态防线）：
 * - engine：RRF 图谱/推理补录循环的 workspace/kind/theme/entry 缺失/gs≤0 各臂、
 *   rrf raw 记录各线臂、sampleQueryFeatures/sampleCoverage 空入参、evict 并列 id 序；
 * - graph：抽取守卫各臂与空图对齐；
 * - store：关闭态全防线（upsertMany/removeMany/importAll/get/exportAll）与垃圾锁抢占；
 * - memory_recall：非法 asOf 钳制臂、defaults 注入臂、metrics 各计数臂；
 * - memory_status：渲染全字段/零字段两态与 workspace 过滤臂；
 * - memory_store：无去重窗口/无矛盾窗口缺省臂；
 * - 插件入口：工具结果 isError 跳过、非用户源跳过、导入空产出（added=0）臂。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import { defaultConfig } from '../../src/config'
import * as plugin from '../../src/index'
import { buildIndex, evictLowestValue, queryIndex, sampleCoverage, sampleQueryFeatures } from '../../src/memory/engine'
import { buildGraph } from '../../src/memory/graph'
import { JsonlMemoryStore } from '../../src/memory/store'
import { createMetrics } from '../../src/memory/metrics'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import { createMemoryStoreTool } from '../../src/tools/memory-store'
import type { MemoryEntry, MemoryStore } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000

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

describe('覆盖率回归四：engine 补录过滤与辅助函数臂', () => {
  it('RRF 图谱补录：workspace/kind/theme 过滤与关联缺失各臂', () => {
    const mk = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry =>
      freshEntry({ id, createdAt: T0, updatedAt: T0, ...over })
    const entries = [
      mk('lex', { content: '主数据库 部署说明文档' }),
      mk('gw', { content: '主数据库 使用 PostgreSQL 集群A', workspace: 'other-ws' }),
      mk('gk', { content: '主数据库 使用 PostgreSQL 集群B', kind: 'preference' }),
      mk('gt', { content: '主数据库 使用 PostgreSQL 集群C', tags: ['theme-x'] }),
      mk('ok', { content: '主数据库 使用 PostgreSQL 集群D' }),
    ]
    const g = buildGraph(entries, 100)
    const byId = new Map(entries.map((e) => [e.id, e]))
    // workspace 过滤：gw 被补录循环剔除；ok 正常进入
    const ws = queryIndex(
      buildIndex(entries.filter((e) => e.id !== 'gw')),
      '主数据库',
      { fusionMode: 'rrf', now: T0, decay: false, graph: g, graphEnabled: true, workspace: 'this-ws' },
      byId,
    )
    expect(ws.some((h) => h.id === 'gw')).toBe(false)
    // kind 过滤：gk（preference）被剔除
    const kd = queryIndex(
      buildIndex(entries.filter((e) => e.id !== 'gk')),
      '主数据库',
      { fusionMode: 'rrf', now: T0, decay: false, graph: g, graphEnabled: true, kind: 'fact' },
      byId,
    )
    expect(kd.some((h) => h.id === 'gk')).toBe(false)
    // theme 过滤：无该 tag 的图可达条目被剔除
    const th = queryIndex(
      buildIndex(entries.filter((e) => e.id !== 'gt')),
      '主数据库',
      { fusionMode: 'rrf', now: T0, decay: false, graph: g, graphEnabled: true, theme: 'theme-y' },
      byId,
    )
    expect(th.some((h) => h.id === 'gt')).toBe(false)
    // 关联条目缺失于 entriesBy：图反查 id 无条目 → 跳过（不抛）
    expect(() =>
      queryIndex(
        buildIndex(entries.slice(0, 1)),
        '主数据库',
        { fusionMode: 'rrf', now: T0, decay: false, graph: g, graphEnabled: true },
        new Map<string, MemoryEntry>(),
      ),
    ).not.toThrow()
  })

  it('RRF raw 记录：fuzzy/semantic/graph/infer 各线入臂 + 空样本辅助函数', () => {
    const entries = [
      freshEntry({ id: 'fz', content: 'postgersql deploymnet nodes', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'sm', content: 'postgresql redis nginx kafka 全家桶', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'gr', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 }),
    ]
    const g = buildGraph([entries[2]!], 100)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const hits = queryIndex(
      buildIndex(entries),
      'postgresql 主数据库',
      {
        fusionMode: 'rrf',
        now: T0,
        decay: false,
        graph: g,
        graphEnabled: true,
        inferEnabled: true,
        explain: true,
      },
      byId,
    )
    expect(hits.length).toBeGreaterThan(0)
    // 空入参辅助函数
    expect(sampleQueryFeatures(new Set<string>())).toEqual([])
    expect(sampleCoverage([], new Set(['a']))).toBe(0)
  })

  it('evictLowestValue 并列分 + 同取代态：按 id 字典序确定性淘汰', () => {
    const entries = [
      freshEntry({ id: 'bb', kind: 'fact', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'aa', kind: 'fact', createdAt: T0, updatedAt: T0 }),
    ]
    expect(evictLowestValue(entries, 1)).toEqual(['aa'])
  })
})

describe('覆盖率回归四：store 关闭态全防线与垃圾锁', () => {
  it('关闭态：upsertMany/removeMany/importAll/get 全部拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-guards-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.close()
    await expect(store.upsertMany([freshEntry({ id: 'x' })])).rejects.toThrow(/closed/)
    await expect(store.removeMany(['x'])).rejects.toThrow(/closed/)
    await expect(store.importAll([freshEntry({ id: 'y' })])).rejects.toThrow(/closed/)
    await expect(store.get('x')).resolves.toBeUndefined()
    await expect(store.remove('x')).rejects.toThrow(/closed/)
  })

  it('垃圾锁内容（pid 不可解析）与死 pid：抢占重写后正常持有', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-badlock-'))
    const file = join(dir, 'mem.jsonl')
    writeFileSync(`${file}.lock`, 'not-a-pid\n', 'utf8')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(freshEntry({ id: 'e1', content: '锁抢占', createdAt: T0, updatedAt: T0 }))
    expect(await store.list()).toHaveLength(1)
    await store.close()
    const dir2 = mkdtempSync(join(tmpdir(), 'mh-deadpid-'))
    const file2 = join(dir2, 'mem.jsonl')
    writeFileSync(`${file2}.lock`, '999999999\n', 'utf8') // 不存活 pid → 陈旧锁抢占
    const store2 = await JsonlMemoryStore.open(file2)
    await store2.upsert(freshEntry({ id: 'e1', content: '死锁抢占', createdAt: T0, updatedAt: T0 }))
    expect(await store2.list()).toHaveLength(1)
    await store2.close()
  })
})

describe('覆盖率回归四：memory_recall 钳制与计数臂', () => {
  it('非法 asOf（负数/NaN）钳制为缺省：走当前语料 + 正常热度回写', async () => {
    const store = memoryStore([freshEntry({ id: 'e1', content: '部署用 Node 18' })])
    const metrics = createMetrics()
    const tool = createMemoryRecallTool(store, 400, 8, undefined, metrics, undefined, {
      fusionMode: 'rrf',
    }) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number; hits: Array<{ id: string }> }>
      output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
    }
    const out = await tool.execute({ query: 'Node 部署', asOf: -5, limit: 8, maxTokens: 400, reinforce: false })
    expect(out.total).toBeGreaterThan(0)
    expect(metrics.asOfRecalls).toBeUndefined() // 非法 asOf（NaN 被 schema 前置拦截）不计数
    // rrf 模式命中计数（fusionHits 臂）
    expect(metrics.fusionHits).toBeGreaterThanOrEqual(out.total)
    // 渲染：非法 asOf 不产生回放前缀
    const text = tool.output.render({ query: 'Node 部署', asOf: -5 }, { hits: [], usedTokens: 0 })[0]?.text ?? ''
    expect(text).toContain('[memory recall] no relevant')
  })

  it('graph/infer 命中计数臂：graphEnabled + inferEnabled 经 defaults 注入', async () => {
    const entries = [
      freshEntry({ id: 'e1', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'e2', content: 'PostgreSQL 依赖 MVCC', createdAt: T0, updatedAt: T0 }),
    ]
    const store = memoryStore(entries)
    const g = buildGraph(entries, 100)
    const metrics = createMetrics()
    const tool = createMemoryRecallTool(
      store,
      400,
      8,
      undefined,
      metrics,
      undefined,
      { graphEnabled: true, inferEnabled: true },
      g,
    ) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number }>
    }
    const out = await tool.execute({ query: 'PostgreSQL', limit: 8, maxTokens: 400, reinforce: false })
    expect(out.total).toBeGreaterThan(0)
    expect(metrics.graphHits).toBeGreaterThanOrEqual(out.total)
    expect(metrics.inferHits).toBeGreaterThanOrEqual(out.total)
  })
})

describe('覆盖率回归四：memory_status 渲染两态与过滤臂', () => {
  it('渲染全字段（oldestAt/superseded/hot/themes/duplicateRatio/distilled）与零字段', () => {
    const tool = createMemoryStatusTool(memoryStore(), () => 0) as unknown as {
      output: {
        render: (args: unknown, value: Record<string, unknown>) => Array<{ type: string; text: string }>
      }
    }
    const full =
      tool.output.render(
        {},
        {
          total: 3,
          bytes: 99,
          byKind: {},
          bySource: { auto: 1, explicit: 2 },
          oldestAt: T0,
          superseded: 1,
          hot: 2,
          cold: 1,
          themes: [{ label: '部署', memberCount: 2 }],
          duplicateRatio: 0.5,
          distilled: { abstract: 1, procedural: 2 },
          graph: { entities: 5, edges: 6, activeEdges: 4, evicted: 1 },
          dueCount: 2,
          strengthSummary: { strengthAvg: 0.7, minR: 0.2 },
          conflictPairs: { count: 1, samples: ['a', 'b'] },
          suggestion: '可清理',
          metrics: {},
          diagnostics: { lines: 9, corrupt: 0 },
        },
      )[0]?.text ?? ''
    for (const frag of [
      '- from ',
      '- superseded: 1',
      '- layering: hot=2',
      '- themes: 部署(2)',
      '- duplicateRatio: 0.50',
      '- distilled: abstract=1',
      '- graph: entities=5',
      '- consolidation: due=2',
      '- conflicts: 1 pair(s) a | b',
      '- suggestion: 可清理',
      '- storage: ',
    ]) {
      expect(full).toContain(frag)
    }
    const bare = tool.output.render({}, { total: 0, bytes: 0 })[0]?.text ?? ''
    expect(bare).toContain('[memory status] 0 entries')
    expect(bare).not.toContain('- layering:')
  })

  it('workspace 过滤：指定工作区时全局条目（无 workspace）计入、异区剔除', async () => {
    const now = Date.now()
    const entries = [
      freshEntry({ id: 'global', content: '全局记忆甲', createdAt: now, updatedAt: now }),
      freshEntry({ id: 'other', content: '别区记忆乙', workspace: 'elsewhere', createdAt: now, updatedAt: now }),
    ]
    const tool = createMemoryStatusTool(memoryStore(entries), () => 0) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number; byKind: Record<string, number> }>
    }
    expect((await tool.execute({ workspace: 'w-1' })).total).toBe(1)
    expect((await tool.execute({})).total).toBe(2)
  })
})

describe('覆盖率回归四：memory_store 缺省臂与插件入口残余臂', () => {
  it('无 dedupWindowMs/无 conflictWindowMs 的缺省路径', async () => {
    const store = memoryStore()
    const tool = createMemoryStoreTool(store, 200, undefined, undefined, {
      conflictMode: 'auto',
    }) as unknown as { execute: (args: Record<string, unknown>) => Promise<{ id: string }> }
    const out = await tool.execute({ content: '无窗口缺省路径记忆', kind: 'fact' })
    expect(out.id).toBeTruthy()
    expect(await store.list()).toHaveLength(1)
  })

  it('插件入口：isError 工具结果跳过、非用户源跳过、空产出导入（added=0）不进图', async () => {
    const ctx = new Context()
    ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = {
      tools: () => undefined,
      section: () => undefined,
    }
    new ToolRegistry(ctx)
    const dir = mkdtempSync(join(tmpdir(), 'mh-arms-'))
    const emptyDoc = join(dir, 'empty.md')
    writeFileSync(emptyDoc, 'x\n', 'utf8') // 过短 → plan.entries 为空 → added=0 臂
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      storageDir: dir,
      captureMode: 'balanced',
      graphEnabled: true,
      importSources: { documents: [emptyDoc] },
    })
    await fiber
    const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
      const start = Date.now()
      while (!cond()) {
        if (Date.now() - start > ms) throw new Error('waitFor timeout')
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    await waitFor(() => !!ctx.tools.get('memory_status'))
    // isError 工具结果不捕获
    ctx.emit(
      'tools/result',
      { callId: 'c1', name: 'run_code', arguments: {}, agent: undefined } as never,
      {
        isError: true,
        content: [{ type: 'text', text: '失败输出包含 postgresql 结论' }],
      } as never,
    )
    // 非用户源（合成消息）不捕获
    ctx.emit(
      'session/event',
      { header: { cwd: '/p' } } as never,
      {
        type: 'user/message',
        data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '合成消息偏好用 vim' }] },
      } as never,
    )
    await new Promise((r) => setTimeout(r, 200))
    const status = ctx.tools.get('memory_status') as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number }>
    }
    expect((await status.execute({})).total).toBe(0)
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})
