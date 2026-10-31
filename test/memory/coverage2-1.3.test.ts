async function rmRetry(dir: string): Promise<void> {
  // Windows：dispose 后 store.close() 异步落盘/句柄释放与 rmSync 竞态（ENOTEMPTY/EBUSY）——指数退避重试
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (i >= 5) throw err
      await new Promise((r) => setTimeout(r, 50 * 2 ** i))
    }
  }
}

/**
 * 覆盖率阈值回归修复二（1.3.0 工程纪律，续 coverage-1.3.test.ts）。
 *
 * 第二轮按未覆盖分支清单定向补测：
 * - 图谱：ruleExtractTriples 边界（短文本/裸是降噪/同实体/嵌套关系截断）、
 *   对齐/邻域/评分空态、reassertedAt 更新分支；
 * - 主题聚类：少于 2 条 / hub token 护栏 / minShared 门槛；
 * - 巩固摘要：空库分支；
 * - 引擎：semanticBoost 但覆盖率低于阈值不叠加；
 * - 存储：锁文件探测与抢占、关闭态防线、listAsOf 文件缺失回落；
 * - 条目工厂：脏 tags 清洗 / imp 幂等 id / sessionId+workspace；
 * - ingest：空候选 / 批内重复 / 图谱注入钩子；
 * - conflictAwareOrder：peer 缺席与等时分支；
 * - memory_status：空库渲染与缺省分支；
 * - 插件入口（load 冒烟）：importSources 成败两路、存储打开失败不崩、
 *   TTL 清理 + autoEvict 启动淘汰、distillMode auto 卸载维护。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import { defaultConfig } from '../../src/config'
import * as plugin from '../../src/index'
import { buildGraph, graphLineScores, queryEntities, ruleExtractTriples } from '../../src/memory/graph'
import { inferLineScores } from '../../src/memory/infer'
import type { GraphRecallSource } from '../../src/memory/types'
import { clusterThemes } from '../../src/memory/themes'
import { summarizeConsolidation } from '../../src/memory/consolidation'
import { buildIndex, queryIndex } from '../../src/memory/engine'
import { makeEntry } from '../../src/memory/entry-factory'
import { ingestCaptured } from '../../src/memory/ingest'
import { JsonlMemoryStore } from '../../src/memory/store'
import { conflictAwareOrder, CONFLICTS_WITH_TAG_PREFIX, CONFLICT_OF_TAG_PREFIX } from '../../src/memory/conflict'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import type { MemoryEntry } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** 最小内存存储（ingest/status 用） */
function memoryStore(initial: MemoryEntry[] = []): import('../../src/memory/types').MemoryStore {
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
  } as unknown as import('../../src/memory/types').MemoryStore
}

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

describe('覆盖率回归二：图谱分支', () => {
  it('ruleExtractTriples 边界：短文本/裸是降噪/同实体/嵌套关系截断', () => {
    expect(ruleExtractTriples('ab')).toEqual([])
    expect(ruleExtractTriples('今天是周三')).toEqual([]) // 裸「是」双侧纯 CJK 降噪
    expect(ruleExtractTriples('MySQL 使用 MySQL')).toEqual([]) // 主宾同实体
    const nested = ruleExtractTriples('主数据库 使用 缓存服务 依赖 Redis')
    expect(nested.some((t) => t.subject === '主数据库' && t.object === '缓存服务')).toBe(true)
    // 主语取句内最后分隔符后的整段（关系词不是分隔符）：依赖 的主语含上游片段
    expect(nested.some((t) => t.relation === '依赖' && t.object === 'redis')).toBe(true)
  })

  it('对齐/邻域/评分空态：无种子查询与关联条目缺失', () => {
    const entries = [freshEntry({ id: 'e1', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 })]
    const g = buildGraph(entries, 100)
    expect(g.alignByTokens([])).toEqual([])
    expect(g.neighborEntityScores(['不存在的实体'], T0).size).toBe(0)
    expect(graphLineScores(g, '？？？！！！', new Map(), T0).size).toBe(0)
    // 关联条目缺失于 entriesById → 无评分产出
    expect(graphLineScores(g, 'PostgreSQL', new Map(), T0).size).toBe(0)
    // queryEntities 空串
    expect(queryEntities('')).toEqual([])
  })

  it('最小图源（无对齐层/无活跃出边）零破坏：图谱线/推理线自动失效', () => {
    const minimal: GraphRecallSource = {
      neighborEntityScores: () => new Map(),
      entryIdsByEntity: () => [],
    }
    expect(graphLineScores(minimal, 'PostgreSQL', new Map(), T0).size).toBe(0)
    expect(inferLineScores(minimal, 'PostgreSQL', new Map(), T0).size).toBe(0)
  })

  it('reassertedAt 更新分支：复活后更晚的重断言刷新复活时刻', () => {
    const g = buildGraph([], 100)
    const e1 = freshEntry({ id: 'a', content: '服务A 依赖 服务B', createdAt: T0, updatedAt: T0 })
    g.add(e1)
    const sup = freshEntry({
      id: 'a2',
      content: '服务A 依赖 服务B',
      tags: ['superseded-by:a3'],
      createdAt: T0 + DAY,
      updatedAt: T0 + DAY,
    })
    g.add(sup) // 失效
    g.add(freshEntry({ id: 'a4', content: '服务A 依赖 服务B', createdAt: T0 + 2 * DAY, updatedAt: T0 + 2 * DAY }))
    g.add(freshEntry({ id: 'a5', content: '服务A 依赖 服务B', createdAt: T0 + 3 * DAY, updatedAt: T0 + 3 * DAY }))
    // 更晚的重断言刷新复活时刻（max 更新分支）：a5 把 reassertedAt 推到 T0+3d，
    // T0+2.5d 仍处失效期、T0+3.5d 复活活跃
    expect(g.activeOutEdges('服务a', T0 + 2.5 * DAY).length).toBe(0)
    expect(g.activeOutEdges('服务a', T0 + 3.5 * DAY).length).toBe(1)
    // 失效期间：不可穿越
    expect(g.activeOutEdges('服务a', T0 + 1.5 * DAY).length).toBe(0)
  })
})

describe('覆盖率回归二：主题/巩固/引擎分支', () => {
  it('clusterThemes 边界：少于 2 条 / hub token 护栏 / minShared 门槛', () => {
    expect(clusterThemes([])).toEqual([])
    expect(clusterThemes([freshEntry({ id: 'only', content: '孤独条目 postgresql' })])).toEqual([])
    const hubbed = Array.from({ length: 66 }, (_, i) =>
      freshEntry({ id: `h${i}`, content: `共享词条 hubtok 独有词${i} 说明`, createdAt: T0 + i, updatedAt: T0 + i }),
    )
    expect(clusterThemes(hubbed)).toEqual([])
    const pairable = [
      freshEntry({ id: 'p1', content: '部署流水线 使用 argocd 幂等', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'p2', content: '部署流水线 使用 argocd 多集群', createdAt: T0 + 1, updatedAt: T0 + 1 }),
    ]
    expect(clusterThemes(pairable).length).toBe(1)
    // 共享 token 为 部署/署流/流水/水线/使用/argocd 共 6 个（CJK 连续段 bigram 切分）：
    // minShared=7 超过实际共享数 → 不成簇
    expect(clusterThemes(pairable, 7)).toEqual([])
  })

  it('summarizeConsolidation 空库与常用条目', () => {
    expect(summarizeConsolidation([], T0)).toMatchObject({ dueCount: 0, total: 0, strengthAvg: 0, minR: 0 })
    const used = freshEntry({
      id: 'u1',
      content: '常用结论',
      createdAt: T0 - 90 * DAY,
      updatedAt: T0 - 90 * DAY,
      accessCount: 5,
      lastAccessAt: T0 - 40 * DAY,
    })
    const sum = summarizeConsolidation([used], T0)
    expect(sum.total).toBe(1)
  })

  it('semanticBoost 但覆盖率低于阈值：语义线不叠加（why 无 semantic 行）', () => {
    const entries = [freshEntry({ id: 'lex', content: 'postgresql 部署要点', createdAt: T0, updatedAt: T0 })]
    const byId = new Map(entries.map((e) => [e.id, e]))
    const hits = queryIndex(
      buildIndex(entries),
      'postgresql redis nginx kafka',
      { now: T0, decay: false, semanticBoost: true, explain: true },
      byId,
    )
    const lex = hits.find((h) => h.id === 'lex')
    expect(lex).toBeDefined()
    expect(lex?.why?.lines.some((l) => l.line === 'semantic')).toBe(false)
  })
})

describe('覆盖率回归二：存储与条目工厂分支', () => {
  it('锁文件探测与抢占：已存在自身 pid 的锁被重写持有', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-lock-'))
    const file = join(dir, 'mem.jsonl')
    writeFileSync(`${file}.lock`, `${process.pid}\n`, 'utf8')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(freshEntry({ id: 'e1', content: '锁测试', createdAt: T0, updatedAt: T0 }))
    expect(await store.list()).toHaveLength(1)
    await store.close()
  })

  it('关闭态写入/导出拒绝；listAsOf 文件缺失回落空数组', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-closed-'))
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.close()
    await expect(store.upsert(freshEntry({ id: 'x' }))).rejects.toThrow(/closed/)
    await expect(store.exportAll()).rejects.toThrow(/closed/)
    const store2 = await JsonlMemoryStore.open(join(dir, 'ghost.jsonl'))
    expect(await store2.listAsOf(T0)).toEqual([])
    await store2.close()
  })

  it('makeEntry：脏 tags 清洗 / imp 幂等 id / sessionId+workspace 注入', () => {
    const e = makeEntry({
      content: '工厂分支',
      kind: 'fact',
      tags: [1 as unknown as string, '  ', 'x', 'x'],
      source: 'auto',
      maxChars: 100,
      now: T0,
      idPrefix: 'imp',
      idSuffix: false,
      sessionId: 's-1',
      workspace: 'w-1',
    })
    expect(e.tags).toEqual(['x'])
    expect(e.id.startsWith('imp-')).toBe(true)
    expect(e.sessionId).toBe('s-1')
    expect(e.workspace).toBe('w-1')
  })
})

describe('覆盖率回归二：ingest 钩子与 conflictAwareOrder', () => {
  it('空候选零副作用；批内重复只入库 1 条；图谱注入时取代回写进图', async () => {
    const metrics = { capturedTotal: 0, rejectedSensitive: 0, rejectedDuplicate: 0 } as never
    await ingestCaptured(memoryStore(), [], { maxEntryChars: 500, dedupWindowMs: DAY }, metrics, undefined)
    const store = memoryStore()
    await ingestCaptured(
      store,
      [
        { kind: 'fact', content: '批内重复条目 alpha', tags: [] },
        { kind: 'fact', content: '批内重复条目 alpha', tags: [] },
      ],
      { maxEntryChars: 500, dedupWindowMs: DAY },
      metrics,
      undefined,
    )
    expect(await store.list()).toHaveLength(1)
    const g = buildGraph([], 100)
    const store2 = memoryStore([freshEntry({ id: 'old', kind: 'fact', content: '主数据库使用 MySQL' })])
    await ingestCaptured(
      store2,
      [{ kind: 'fact', content: '主数据库改用 MySQL', tags: [] }],
      { maxEntryChars: 500, dedupWindowMs: DAY, supersedeMode: 'auto', supersedeSimilarity: 0.8 },
      metrics,
      undefined,
      g,
    )
    expect(g.stats(Date.now()).edges).toBeGreaterThan(0)
  })

  it('conflictAwareOrder：新者优先 / peer 缺席 / byId 缺失保持原序', () => {
    const mk = (id: string, tags: string[], updatedAt: number): MemoryEntry =>
      freshEntry({ id, tags, createdAt: T0, updatedAt })
    const a = mk('a', [`${CONFLICTS_WITH_TAG_PREFIX}b`], T0 + DAY)
    const b = mk('b', [`${CONFLICT_OF_TAG_PREFIX}a`], T0 + 2 * DAY)
    const byId = new Map([
      ['a', a],
      ['b', b],
    ])
    const hit = (e: MemoryEntry) => ({ ...e, score: 1 })
    const both = conflictAwareOrder([hit(a), hit(b)], byId)
    expect(both.map((h) => h.id)).toEqual(['b', 'a'])
    expect(conflictAwareOrder([hit(a)], byId).map((h) => h.id)).toEqual(['a'])
    expect(conflictAwareOrder([hit(a), hit(b)], new Map()).map((h) => h.id)).toEqual(['a', 'b'])
  })
})

describe('覆盖率回归二：memory_status 空态', () => {
  it('空库渲染省略可选行；无 recallThreshold 的巩固输出零到期', async () => {
    const tool = createMemoryStatusTool(memoryStore(), () => 0, undefined, undefined, {
      consolidationMode: 'auto',
    }) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
      output: { render: (args: unknown, value: Record<string, unknown>) => Array<{ type: string; text: string }> }
    }
    const out = await tool.execute({})
    expect(out['duplicateRatio']).toBeUndefined()
    expect(out['dueCount']).toBe(0)
    const text = tool.output.render({}, out)[0]?.text ?? ''
    expect(text).toContain('[memory status] 0 entries')
    expect(text).not.toContain('- graph:')
  })
})

describe('覆盖率回归二：插件入口分支（load 冒烟）', () => {
  it('importSources：失败源仅告警不阻断，成功源正常导入（含图谱同步）', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-imp-'))
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, '# 约定\n主数据库 使用 PostgreSQL 集群\n', 'utf8')
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      storageDir: dir,
      graphEnabled: true,
      importSources: { documents: [join(dir, 'missing.md'), doc], sessionLogs: [join(dir, 'missing-log.jsonl')] },
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_status'))
    const status = ctx.tools.get('memory_status') as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number }>
    }
    // 启动导入是异步链（storeP 就绪后 readFile→planImport→importAll），
    // 工具注册与之并发——轮询等待导入落地（至多 5s）而非依赖微任务时序
    let total = 0
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      total = (await status.execute({})).total
      if (total > 0) break
      await new Promise((res) => setTimeout(res, 25))
    }
    expect(total).toBeGreaterThan(0)
    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 50))
    await rmRetry(dir)
  })

  it('存储打开失败（目录路径是文件）：不注册工具、不崩溃', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-fail-'))
    const fileAsDir = join(dir, 'not-a-dir')
    writeFileSync(fileAsDir, 'occupied', 'utf8')
    const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: join(fileAsDir, 'sub') })
    await fiber
    await new Promise((r) => setTimeout(r, 250))
    expect(ctx.tools.get('memory_store')).toBeUndefined()
    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 50))
    await rmRetry(dir)
  })

  it('TTL 清理 + autoEvict 启动淘汰：超限与过期在启动时收敛', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-evict-'))
    const file = join(dir, 'memories.jsonl')
    const now = Date.now()
    const mk = (id: string, ageDays: number, kind: MemoryEntry['kind'] = 'fact'): MemoryEntry => ({
      ...freshEntry({ id, kind }),
      createdAt: now - ageDays * DAY,
      updatedAt: now - ageDays * DAY,
    })
    const seeded = [mk('old1', 30), mk('old2', 30), mk('fresh1', 0), mk('fresh2', 0), mk('fresh3', 0)]
    writeFileSync(file, seeded.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    const fiber = ctx.plugin(plugin, {
      ...defaultConfig,
      storageDir: dir,
      ttlDays: 7,
      autoEvict: true,
      maxEntries: 2,
      captureMode: 'off',
    })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_status'))
    const status = ctx.tools.get('memory_status') as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number }>
    }
    let total = 0
    for (let i = 0; i < 40; i++) {
      total = (await status.execute({})).total
      if (total <= 2) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(total).toBeLessThanOrEqual(2)
    await fiber.dispose()
    // TTL：两条 30 天前的过期条目已 tombstone（重开存储按加载语义排除）
    const reopened = await JsonlMemoryStore.open(file)
    const ids = (await reopened.list()).map((e) => e.id)
    expect(ids).not.toContain('old1')
    expect(ids).not.toContain('old2')
    await reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('distillMode auto：卸载维护栅栏产出蒸馏条目（dispose 路径确定性）', async () => {
    const ctx = makeCtx()
    const dir = mkdtempSync(join(tmpdir(), 'mh-distill-'))
    const file = join(dir, 'memories.jsonl')
    const now = Date.now()
    const mk = (id: string, w: string): MemoryEntry => ({
      ...freshEntry({ id }),
      kind: 'preference',
      content: `偏好用 ${w} 编辑器写前端代码`,
      createdAt: now,
      updatedAt: now,
    })
    writeFileSync(
      file,
      [mk('d1', 'VSCode'), mk('d2', 'VSCode'), mk('d3', 'WebStorm')].map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )
    const fiber = ctx.plugin(plugin, { ...defaultConfig, storageDir: dir, distillMode: 'auto', captureMode: 'off' })
    await fiber
    await waitFor(() => !!ctx.tools.get('memory_status'))
    await fiber.dispose()
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('distilled-layer:')
    rmSync(dir, { recursive: true, force: true })
  })
})
