/**
 * 覆盖率阈值回归修复（1.3.0 工程纪律）。
 *
 * 背景：0.8.0 冻结的覆盖率阈值（lines ≥96.5 / branches ≥95）自 1.1.1 大规模加固后
 * 未再实测（`check` 链不含 coverage，仅 CI 覆盖率任务执行），1.1.1→1.2.0 的新增
 * 分支（工具取代/矛盾路径、入口维护调度、config 运行时钳制、status 可观测面等）
 * 累积欠账至 94.65/86.98。本文件按未覆盖清单定向补测，不改变任何生产行为：
 * - config.normalizeConfig 全字段运行时钳制（非法类型/越界/枚举外/脏数组）；
 * - metrics.formatMetrics 全量可选计数输出（含 1.3.0 asOfRecalls）；
 * - engine.evictLowestValue 价值淘汰语义（instruction 永不淘汰/被取代优先/确定性）；
 * - entry-factory 取代协议取值器；store.listAsOf 关闭态防线；
 * - infer.inferLineScores chainsOut 空种子清空；graph 软删分支与查询实体兜底；
 * - conflict 矛盾判定分支（同 kind/阈值/窗口/双向标注/样本摘要）；
 * - ingest 敏感拒绝与取代/矛盾回写；memory_store 工具取代/矛盾显式路径；
 * - memory_recall 热度回写失败上浮；memory_status 可观测全分支（verbose/graph/
 *   consolidation/themes/suggestion/duplicateRatio）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, normalizeConfig } from '../../src/config'
import { createMetrics, formatMetrics } from '../../src/memory/metrics'
import { evictLowestValue, pruneExpired } from '../../src/memory/engine'
import { inferLineScores } from '../../src/memory/infer'
import { buildGraph, TemporalGraph, queryEntities } from '../../src/memory/graph'
import {
  CONFLICTS_WITH_TAG_PREFIX,
  CONFLICT_OF_TAG_PREFIX,
  conflictPeerIds,
  detectContradiction,
  hasConflictSignal,
  summarizeConflictPairs,
} from '../../src/memory/conflict'
import { makeEntry, supersedeTargetId, supersededByTargetId } from '../../src/memory/entry-factory'
import { ingestCaptured } from '../../src/memory/ingest'
import { JsonlMemoryStore } from '../../src/memory/store'
import { createMemoryStoreTool } from '../../src/tools/memory-store'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import type { MemoryEntry, MemoryStore } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** 最小内存存储（工具面测试用；可注入失败以覆盖错误上浮分支） */
function memoryStore(initial: MemoryEntry[] = [], failWrites = false): MemoryStore {
  let rows = [...initial]
  const maybeFail = (): Promise<void> => (failWrites ? Promise.reject(new Error('write boom')) : Promise.resolve())
  return {
    upsert(e: MemoryEntry): Promise<MemoryEntry> {
      const i = rows.findIndex((r) => r.id === e.id)
      if (i >= 0) rows[i] = e
      else rows.push({ ...e })
      return maybeFail().then(() => rows.find((r) => r.id === e.id)!)
    },
    async upsertMany(entries: MemoryEntry[]): Promise<number> {
      await maybeFail()
      for (const e of entries) {
        const i = rows.findIndex((r) => r.id === e.id)
        if (i >= 0) rows[i] = e
        else rows.push({ ...e })
      }
      return entries.length
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

describe('覆盖率阈值回归：config 运行时钳制全字段', () => {
  it('非法类型回落默认、越界钳到边界、枚举外回落（normalizeConfig 最终防线）', () => {
    const cfg = normalizeConfig({
      storageDir: 42 as unknown as string,
      captureMode: 'foo' as unknown as never,
      autoTags: 'yes' as unknown as boolean,
      maxEntryChars: Number.NaN,
      defaultRecallTokens: -1,
      defaultRecallLimit: 99999,
      dedupWindowMs: -5,
      conflictWindowMs: -5,
      ttlDays: -1,
      recallDecayHalfLifeDays: -2,
      supersedeMode: 'sometimes' as unknown as never,
      semanticBoost: 1 as unknown as boolean,
      fusionMode: 'vector' as unknown as never,
      maxEntries: -3,
      autoEvict: 0 as unknown as boolean,
      themes: null as unknown as boolean,
      distillMode: 'always' as unknown as never,
      consolidationMode: 1 as unknown as never,
      graphEnabled: 'on' as unknown as boolean,
      conflictMode: 'maybe' as unknown as never,
      graphMaxEntities: 1,
      inferEnabled: 1 as unknown as boolean,
      inferMaxHops: 99,
      distillMinCluster: 1,
      recallThreshold: 5,
      importSources: {
        documents: [1, 'a.md', null, 'b.md'] as unknown as string[],
        sessionLogs: 'not-array' as unknown as string[],
      },
    })
    expect(cfg.storageDir).toBe('')
    expect(cfg.captureMode).toBe(defaultConfig.captureMode)
    expect(cfg.autoTags).toBe(defaultConfig.autoTags)
    expect(cfg.maxEntryChars).toBe(defaultConfig.maxEntryChars) // NaN → 默认
    expect(cfg.defaultRecallTokens).toBe(100) // 负数钳到下界
    expect(cfg.defaultRecallLimit).toBe(100) // 超限钳到上界
    expect(cfg.dedupWindowMs).toBe(0)
    expect(cfg.conflictWindowMs).toBe(0)
    expect(cfg.ttlDays).toBe(0)
    expect(cfg.recallDecayHalfLifeDays).toBe(0)
    expect(cfg.supersedeMode).toBe('off')
    expect(cfg.semanticBoost).toBe(defaultConfig.semanticBoost)
    expect(cfg.fusionMode).toBe('interpolate')
    expect(cfg.maxEntries).toBe(0)
    expect(cfg.autoEvict).toBe(defaultConfig.autoEvict)
    expect(cfg.themes).toBe(defaultConfig.themes)
    expect(cfg.distillMode).toBe('off')
    expect(cfg.consolidationMode).toBe('off')
    expect(cfg.graphEnabled).toBe(defaultConfig.graphEnabled)
    expect(cfg.conflictMode).toBe('off')
    expect(cfg.graphMaxEntities).toBe(10) // 钳到下界
    expect(cfg.inferEnabled).toBe(false)
    expect(cfg.inferMaxHops).toBe(3) // 钳到上界
    expect(cfg.distillMinCluster).toBe(2)
    expect(cfg.recallThreshold).toBe(1)
    const imp = cfg.importSources
    expect(imp?.documents).toEqual(['a.md', 'b.md'])
    expect(imp?.sessionLogs).toEqual([])
  })

  it('合法显式值原样通过（钳制不误伤）', () => {
    const cfg = normalizeConfig({
      captureMode: 'aggressive',
      maxEntryChars: 500,
      inferMaxHops: 1,
      graphMaxEntities: 50,
      fusionMode: 'rrf',
      distillMode: 'auto',
      importSources: { documents: ['x.md'], sessionLogs: ['y.jsonl'] },
    })
    expect(cfg.captureMode).toBe('aggressive')
    expect(cfg.maxEntryChars).toBe(500)
    expect(cfg.inferMaxHops).toBe(1)
    expect(cfg.graphMaxEntities).toBe(50)
    expect(cfg.fusionMode).toBe('rrf')
    expect(cfg.distillMode).toBe('auto')
    expect(cfg.importSources?.documents).toEqual(['x.md'])
  })
})

describe('覆盖率阈值回归：metrics 与 engine 生命周期', () => {
  it('formatMetrics 输出全部可选计数（含 1.3.0 asOfRecalls）', () => {
    const m = createMetrics()
    Object.assign(m, {
      superseded: 1,
      rejectedDuplicateCrossPath: 2,
      fusionHits: 3,
      themeBuilds: 4,
      distilled: 5,
      distilledAbstract: 6,
      distilledProcedural: 7,
      distillSkips: 8,
      consolidated: 9,
      consolidationDue: 10,
      graphEdges: 11,
      graphHits: 12,
      inferHits: 13,
      asOfRecalls: 14,
      conflictPairs: 15,
    })
    const text = formatMetrics(m)
    for (const frag of [
      'superseded=1',
      'dupCrossPath=2',
      'fusionHits=3',
      'themeBuilds=4',
      'distilled=5',
      'distilledAbstract=6',
      'distilledProcedural=7',
      'distillSkips=8',
      'consolidated=9',
      'consolidationDue=10',
      'graphEdges=11',
      'graphHits=12',
      'inferHits=13',
      'asOfRecalls=14',
      'conflictPairs=15',
    ]) {
      expect(text).toContain(frag)
    }
    // 缺省（无可选计数）不追加尾巴
    expect(formatMetrics(createMetrics())).not.toContain('superseded=')
  })

  it('evictLowestValue：instruction 永不淘汰、被取代优先、并列按 id 确定性、不超限不淘汰', () => {
    expect(evictLowestValue([], 0)).toEqual([])
    const base = [
      freshEntry({ id: 'a', kind: 'fact', createdAt: T0, updatedAt: T0, accessCount: 0 }),
      freshEntry({ id: 'b', kind: 'fact', createdAt: T0, updatedAt: T0, accessCount: 0 }),
      freshEntry({ id: 'c', kind: 'instruction', createdAt: T0, updatedAt: T0, accessCount: 0 }),
      freshEntry({ id: 'd', kind: 'fact', createdAt: T0, updatedAt: T0, tags: ['superseded-by:x'] }),
    ]
    // 不超限：零输出
    expect(evictLowestValue(base, 10)).toEqual([])
    // 超限 1：被取代的 d 最先淘汰（同分下 superseded 在前）
    expect(evictLowestValue(base, 3)).toEqual(['d'])
    // 超限 3：instruction c 保留，其余按价值（低热度优先）确定性淘汰
    const victims = evictLowestValue(base, 1)
    expect(victims).not.toContain('c')
    expect(victims.length).toBe(3)
    expect(victims[0]).toBe('d')
    // 确定性：重复调用一致
    expect(evictLowestValue(base, 1)).toEqual(victims)
  })

  it('pruneExpired：ttlDays≤0 永不过期', () => {
    const old = freshEntry({ createdAt: T0, updatedAt: T0 })
    expect(pruneExpired([old], 0, T0 + 365 * DAY)).toEqual([])
    expect(pruneExpired([old], 1, T0 + 2 * DAY)).toEqual([old])
  })
})

describe('覆盖率阈值回归：entry-factory / store / infer / graph 分支', () => {
  it('取代协议取值器：supersede:/superseded-by: 前缀解析与缺失回落', () => {
    const e = makeEntry({
      content: '新方案',
      kind: 'decision',
      tags: ['supersede:old-1', 'superseded-by:new-2', 'plain'],
      source: 'explicit',
      maxChars: 100,
      now: T0,
    })
    expect(supersedeTargetId(e)).toBe('old-1')
    expect(supersededByTargetId(e)).toBe('new-2')
    const plain = makeEntry({ content: '无标记', kind: 'fact', source: 'auto', maxChars: 100, now: T0 })
    expect(supersedeTargetId(plain)).toBeUndefined()
    expect(supersededByTargetId(plain)).toBeUndefined()
  })

  it('listAsOf 关闭态防线：closed store 抛 STORE_CLOSED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-cov-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.upsert(freshEntry({ id: 'e1', createdAt: T0, updatedAt: T0 }))
    await store.close()
    await expect(store.listAsOf(T0 + 1000)).rejects.toThrow(/closed/)
  })

  it('inferLineScores chainsOut：查询无种子时收集器清空（不残留上一轮）', () => {
    const entries = [freshEntry({ id: 'e1', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 })]
    const g = buildGraph(entries, 100)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const chainsOut: unknown[] = [{ stale: true }]
    const scores = inferLineScores(g, '???！！！', byId, T0, { chainsOut: chainsOut as never })
    expect(scores.size).toBe(0)
    expect(chainsOut).toHaveLength(0)
  })

  it('graph.remove：已失效边失去最后引用者时整边移除（asOf 历史保留的补充分支）', () => {
    const g = new TemporalGraph(100)
    const sup = freshEntry({
      id: 'e1',
      content: '主数据库 使用 PostgreSQL',
      tags: ['superseded-by:e2'],
      createdAt: T0,
      updatedAt: T0,
    })
    g.add(sup) // 边带 invalidAt（条目被取代）
    expect(g.stats(T0).edges).toBe(2) // 双向
    const touched = g.remove('e1', T0 + DAY)
    expect(touched).toBe(2) // 引用清零且 invalidAt 已设 → 直接删除
    expect(g.stats(T0 + DAY).edges).toBe(0)
  })

  it('queryEntities：引号实体 + 英文关系词主语 + 短整句兜底', () => {
    const q1 = queryEntities('"PostgreSQL 集群" 怎么部署')
    expect(q1.some((e) => e.includes('postgresql'))).toBe(true)
    const q2 = queryEntities('koa uses mysql')
    expect(q2.some((e) => e === 'koa')).toBe(true)
    const q3 = queryEntities('mysql')
    expect(q3).toContain('mysql')
    expect(queryEntities('')).toEqual([])
  })
})

describe('覆盖率阈值回归：conflict 矛盾判定分支', () => {
  it('hasConflictSignal + detectContradiction 阈值/同kind/窗口分支', () => {
    expect(hasConflictSignal('主数据库不要用 MySQL 了')).toBe(true)
    expect(hasConflictSignal('今天天气不错')).toBe(false)
    const existing = [
      freshEntry({ id: 'old', kind: 'fact', content: '主数据库使用 MySQL', createdAt: T0, updatedAt: T0 }),
      freshEntry({
        id: 'old-pref',
        kind: 'preference',
        content: '主数据库使用 MySQL 啊',
        createdAt: T0,
        updatedAt: T0,
      }),
    ]
    // 弱对立信号（不要）：detectContradiction 入口排除强对立（改用/不用了）候选
    const cand = { content: '主数据库不要用 MySQL 了', kind: 'fact' as const }
    // 默认同 kind：命中 old（fact）
    expect(detectContradiction(existing, cand, { dedupWindowMs: DAY, conflictWindowMs: 30 * DAY }, T0 + 1000)?.id).toBe(
      'old',
    )
    // 同 kind 关闭：preference 旧条目也可命中（相似度足够时）
    const anyKind = detectContradiction(
      existing,
      cand,
      { dedupWindowMs: DAY, conflictWindowMs: 30 * DAY, conflictSameKind: false },
      T0 + 1000,
    )
    expect(anyKind).toBeDefined()
    // 窗口外：不检测
    expect(
      detectContradiction(existing, cand, { dedupWindowMs: DAY, conflictWindowMs: DAY }, T0 + 10 * DAY),
    ).toBeUndefined()
    // 相似度不足：不检测
    expect(
      detectContradiction(
        existing,
        { content: '前端不要用 jQuery 了', kind: 'fact' },
        { dedupWindowMs: DAY, conflictWindowMs: 30 * DAY },
        T0 + 1000,
      ),
    ).toBeUndefined()
  })

  it('conflictPeerIds 双向标注 + summarizeConflictPairs 样本 + isConflicted', () => {
    const a = freshEntry({ id: 'a', tags: [`${CONFLICTS_WITH_TAG_PREFIX}b`], createdAt: T0, updatedAt: T0 })
    const b = freshEntry({ id: 'b', tags: [`${CONFLICT_OF_TAG_PREFIX}a`], createdAt: T0, updatedAt: T0 })
    const half = freshEntry({ id: 'c', tags: [`${CONFLICTS_WITH_TAG_PREFIX}nowhere`], createdAt: T0, updatedAt: T0 })
    expect(conflictPeerIds(a)).toEqual(['b'])
    expect(conflictPeerIds(b)).toEqual(['a'])
    expect(conflictPeerIds(half)).toEqual(['nowhere'])
    expect(conflictPeerIds(freshEntry({ id: 'd' }))).toEqual([])
    const sum = summarizeConflictPairs([a, b, half])
    expect(sum.count).toBe(1) // 双向完备的唯一对
    expect(sum.samples.length).toBeGreaterThan(0)
  })
})

describe('覆盖率阈值回归：ingest 敏感拒绝与取代/矛盾回写', () => {
  it('敏感内容拒绝计数、不入库', async () => {
    const store = memoryStore()
    const metrics = createMetrics()
    await ingestCaptured(
      store,
      [{ kind: 'fact', content: '我的密码是 sk-1234567890abcdef', tags: [] }],
      { maxEntryChars: 500, dedupWindowMs: DAY },
      metrics,
      undefined,
    )
    expect(metrics.rejectedSensitive).toBe(1)
    expect((await store.list()).length).toBe(0)
  })

  it('supersede auto：对立信号 + 高相似 → 旧条目补 superseded-by；重复标记守卫幂等', async () => {
    const existing = [freshEntry({ id: 'old', kind: 'fact', content: '主数据库使用 MySQL' })]
    const store = memoryStore(existing)
    const metrics = createMetrics()
    const opts = { maxEntryChars: 500, dedupWindowMs: DAY, supersedeMode: 'auto' as const, supersedeSimilarity: 0.8 }
    await ingestCaptured(store, [{ kind: 'fact', content: '主数据库改用 MySQL', tags: [] }], opts, metrics, undefined)
    const rows = await store.list()
    const old = rows.find((r) => r.id === 'old')
    expect(old?.tags.some((t) => t.startsWith('superseded-by:'))).toBe(true)
    // 再来一条同指向取代：守卫「已被本条目标记才跳过」→ 第二个标记也保留
    await ingestCaptured(store, [{ kind: 'fact', content: '主数据库换成 MySQL', tags: [] }], opts, metrics, undefined)
    const oldAfter = (await store.list()).find((r) => r.id === 'old')
    expect(oldAfter?.tags.filter((t) => t.startsWith('superseded-by:')).length).toBe(2)
  })

  it('conflict auto：supersede 未命中且疑似反转 → 双向矛盾标注回写', async () => {
    const existing = [freshEntry({ id: 'old', kind: 'preference', content: '测试框架偏好用 Jest' })]
    const store = memoryStore(existing)
    const metrics = createMetrics()
    await ingestCaptured(
      store,
      [{ kind: 'preference', content: '测试框架不要用 Jest 了', tags: [] }],
      { maxEntryChars: 500, dedupWindowMs: DAY, conflictMode: 'auto', conflictWindowMs: 30 * DAY },
      metrics,
      undefined,
    )
    const rows = await store.list()
    const old = rows.find((r) => r.id === 'old')
    const newbie = rows.find((r) => r.id !== 'old')
    expect(old?.tags.some((t) => t.startsWith(CONFLICT_OF_TAG_PREFIX))).toBe(true)
    expect(newbie?.tags.some((t) => t.startsWith(CONFLICTS_WITH_TAG_PREFIX))).toBe(true)
  })
})

describe('覆盖率阈值回归：memory_store 工具显式取代/矛盾路径', () => {
  it('supersedeMode auto：显式存储命中取代 → 旧条目回写标记 + metrics.superseded', async () => {
    const existing = [freshEntry({ id: 'old', kind: 'fact', content: '部署脚本用 Node 18 运行' })]
    const store = memoryStore(existing)
    const metrics = createMetrics()
    const tool = createMemoryStoreTool(store, 500, undefined, metrics, {
      dedupWindowMs: DAY,
      supersedeMode: 'auto',
    }) as unknown as { execute: (args: Record<string, unknown>) => Promise<{ id: string }> }
    const out = await tool.execute({ content: '部署脚本改用 Node 12 运行', kind: 'fact' })
    expect(out.id).toBeTruthy()
    const old = (await store.list()).find((r) => r.id === 'old')
    expect(old?.tags.some((t) => t.startsWith('superseded-by:'))).toBe(true)
    expect(metrics.superseded).toBe(1)
    // 同一新条目再次触发：守卫跳过（metrics 不再增长）
    await tool.execute({ content: '部署脚本改用 Node 12 运行', kind: 'fact' })
    expect(metrics.superseded).toBe(1)
  })

  it('conflictMode auto：显式存储疑似反转 → conflict-of 回写 + metrics.conflictPairs', async () => {
    const existing = [freshEntry({ id: 'old', kind: 'preference', content: '测试框架偏好用 Jest' })]
    const store = memoryStore(existing)
    const metrics = createMetrics()
    const tool = createMemoryStoreTool(store, 500, undefined, metrics, {
      dedupWindowMs: DAY,
      conflictMode: 'auto',
      conflictWindowMs: 30 * DAY,
    }) as unknown as { execute: (args: Record<string, unknown>) => Promise<{ id: string }> }
    await tool.execute({ content: '测试框架不要用 Jest 了', kind: 'preference' })
    const old = (await store.list()).find((r) => r.id === 'old')
    expect(old?.tags.some((t) => t.startsWith(CONFLICT_OF_TAG_PREFIX))).toBe(true)
    expect(metrics.conflictPairs).toBe(1)
  })
})

describe('覆盖率阈值回归：memory_recall 热度回写失败上浮', () => {
  it('upsertMany 拒绝 → metrics.errors 递增（异步 flush 容错）', async () => {
    const store = memoryStore([freshEntry({ id: 'e1', content: '部署用 Node 18' })], true)
    const metrics = createMetrics()
    const tool = createMemoryRecallTool(store, 400, 8, (m) => void m, metrics) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number }>
    }
    const out = await tool.execute({ query: 'Node 部署', limit: 8, maxTokens: 400 })
    expect(out.total).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 120))
    expect(metrics.errors).toBeGreaterThanOrEqual(1)
  })

  it('无 upsertMany 实现时回退逐条 upsert（失败同样上浮）', async () => {
    const failing = memoryStore([freshEntry({ id: 'e1', content: '部署用 Node 18' })], true)
    delete (failing as unknown as { upsertMany?: unknown }).upsertMany
    const metrics = createMetrics()
    const tool = createMemoryRecallTool(failing, 400, 8, undefined, metrics) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ total: number }>
    }
    await tool.execute({ query: 'Node 部署', limit: 8, maxTokens: 400 })
    await new Promise((r) => setTimeout(r, 120))
    expect(metrics.errors).toBeGreaterThanOrEqual(1)
  })
})

describe('覆盖率阈值回归：memory_status 可观测全分支', () => {
  it('verbose/graph/consolidation/themes/suggestion/duplicateRatio 全产出', async () => {
    const entries = [
      freshEntry({
        id: 'a',
        kind: 'fact',
        content: '主数据库 使用 PostgreSQL',
        createdAt: T0,
        updatedAt: T0,
        accessCount: 3,
        lastAccessAt: T0,
      }),
      freshEntry({
        id: 'b',
        kind: 'fact',
        content: '主数据库 使用 PostgreSQL 备份',
        tags: ['superseded-by:c'],
        createdAt: T0,
        updatedAt: T0,
      }),
      freshEntry({ id: 'c', kind: 'instruction', content: '部署前必须跑 npm test', createdAt: T0, updatedAt: T0 }),
    ]
    const store = memoryStore(entries)
    const metrics = createMetrics()
    const g = buildGraph(entries, 100)
    const tool = createMemoryStatusTool(store, () => 4096, undefined, metrics, {
      themesDefault: true,
      graph: g,
      consolidationMode: 'auto',
      recallThreshold: 0.5,
    }) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
      output: { render: (args: unknown, value: Record<string, unknown>) => Array<{ type: string; text: string }> }
    }
    const out = await tool.execute({ verbose: true, withThemes: true })
    expect(out['hot']).toBeDefined()
    expect(out['cold']).toBeDefined()
    expect(out['themes']).toBeDefined()
    const graphView = out['graph'] as { entities?: number; edges?: number }
    expect(typeof graphView.entities).toBe('number')
    expect(typeof graphView.edges).toBe('number')
    expect(out['dueCount']).toBeDefined()
    expect(out['strengthSummary']).toBeDefined()
    expect(out['suggestion']).toContain('supersede')
    expect(out['metrics']).toMatchObject({ recallCalls: 0 })
    expect(metrics.themeBuilds).toBeGreaterThanOrEqual(1)
    expect(metrics.consolidationDue).toBeGreaterThanOrEqual(0)
    // 渲染：全可观测字段在文本中出现
    const text = tool.output.render({ verbose: true }, out)[0]?.text ?? ''
    for (const frag of ['- kinds:', '- layering:', '- graph:', '- consolidation:', '- suggestion:', '- metrics:']) {
      expect(text).toContain(frag)
    }
    // 缺省（无 verbose）：metrics 只保留核心计数（不含可观测扩展键）
    const plain = await tool.execute({})
    const m = plain['metrics'] as Record<string, unknown>
    expect(m).toBeDefined()
    expect(m['distilled']).toBeUndefined()
    expect(m['recallCalls']).toBe(0)
  })

  it('duplicateRatio：行数 > 条目数时输出膨胀信号', async () => {
    const entries = [freshEntry({ id: 'a', content: '一条记忆', createdAt: T0, updatedAt: T0 })]
    const store = memoryStore(entries)
    const fakeDiag = { diagnostics: { lines: 5, corrupt: 0 } }
    const tool = createMemoryStatusTool({ ...store, ...fakeDiag }, () => 128) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    const out = await tool.execute({})
    expect(out['duplicateRatio']).toBe(4) // 5/1 - 1
  })
})
