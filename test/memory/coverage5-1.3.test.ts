/**
 * 覆盖率阈值回归修复五（1.3.0 工程纪律，收尾轮）。
 *
 * 针对逐行清单中仍可达的分支臂：
 * - engine：graphMaxHop 注入臂 / interpolate 容错线词面命中（bm25=0,fuzzy>0）/
 *   RRF 补录去重臂（图/推理可达 id 已在候选集）/ 推理补录过滤臂 / chains≥3 截断臂；
 * - graph：裸「是」含拉丁侧产出 / 超长主语拒收 / 同文重复三元组去重 / 归一后同实体 /
 *   英文实体非法字符拒收 / 空图对齐；
 * - memory_recall：降级存储（无 listAsOf）+ workspace/kind 过滤 + 无 maxHops 默认臂；
 * - cognitive/distill/infer：维护空扫臂、蒸馏跳过臂、inferChains 边界臂。
 */
import { describe, expect, it } from 'vitest'
import { buildIndex, queryIndex } from '../../src/memory/engine'
import { buildGraph, ruleExtractTriples } from '../../src/memory/graph'
import { runCognitiveMaintenance } from '../../src/memory/cognitive'
import { distillBatch } from '../../src/memory/distill'
import { createMetrics } from '../../src/memory/metrics'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
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

describe('覆盖率回归五：engine 余留臂', () => {
  it('graphMaxHop 注入：1 跳截断邻域', () => {
    const entries = [
      freshEntry({ id: 'e1', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'e2', content: 'PostgreSQL 依赖 MVCC', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'e3', content: 'MVCC 属于 事务机制', createdAt: T0, updatedAt: T0 }),
    ]
    const g = buildGraph(entries, 100)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const one = queryIndex(
      buildIndex(entries),
      '主数据库',
      { now: T0, decay: false, graph: g, graphEnabled: true, graphMaxHop: 1 },
      byId,
    )
    const two = queryIndex(
      buildIndex(entries),
      '主数据库',
      { now: T0, decay: false, graph: g, graphEnabled: true, graphMaxHop: 2 },
      byId,
    )
    // 1 跳截断：事务机制（2 跳）只在两跳配置下经图线可达
    expect(two.some((h) => h.id === 'e3')).toBe(true)
    expect(one.some((h) => h.id === 'e3')).toBe(false)
  })

  it('interpolate 容错线：精确零命中时 fuzzy 词面计分（why 首线为 fuzzy）', () => {
    const entries = [freshEntry({ id: 'fz', content: 'postgresql deploymnet guide', createdAt: T0, updatedAt: T0 })]
    const hits = queryIndex(
      buildIndex(entries),
      'postgersql',
      { now: T0, decay: false, explain: true },
      new Map(entries.map((e) => [e.id, e])),
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.why?.lines[0]?.line).toBe('fuzzy')
  })

  it('RRF 补录去重臂：图/推理可达 id 同时词面命中 → 不重复补录，infer 就地合并', () => {
    const entries = [
      freshEntry({ id: 'e1', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'e2', content: 'PostgreSQL 依赖 MVCC', createdAt: T0, updatedAt: T0 }),
    ]
    const g = buildGraph(entries, 100)
    const byId = new Map(entries.map((e) => [e.id, e]))
    // 'PostgreSQL' 词面命中 e1/e2，同时是图/推理种子 → 补录循环遇到已在候选集的 id（去重臂），
    // e2 的 infer 分在主循环入候选后在补录段就地合并（同值不覆盖臂）
    const hits = queryIndex(
      buildIndex(entries),
      'PostgreSQL',
      { fusionMode: 'rrf', now: T0, decay: false, graph: g, graphEnabled: true, inferEnabled: true, explain: true },
      byId,
    )
    expect(hits.map((h) => h.id).sort()).toEqual(['e1', 'e2'])
    const e2 = hits.find((h) => h.id === 'e2')
    expect(e2?.why?.lines.some((l) => l.line === 'infer')).toBe(true)
  })

  it('推理补录过滤臂：workspace/kind/theme 过滤后的推理可达候选不进入', () => {
    const mk = (id: string, over: Partial<MemoryEntry>): MemoryEntry =>
      freshEntry({ id, createdAt: T0, updatedAt: T0, content: 'x', ...over })
    const chain = [
      mk('seed', { content: '主数据库 使用 PostgreSQL' }),
      mk('iw', { content: 'PostgreSQL 依赖 MVCC', workspace: 'other-ws' }),
      mk('ik', { content: 'PostgreSQL 偏好 MVCC', kind: 'preference' }),
      mk('it', { content: 'PostgreSQL 位于 MVCC', tags: ['theme-x'] }),
    ]
    const g = buildGraph(chain, 100)
    // 词面零命中 + 过滤器生效：推理可达但被 workspace 剔除 → 空结果
    const ws = queryIndex(
      buildIndex([chain[0]!]),
      '主数据库',
      { fusionMode: 'rrf', now: T0, decay: false, graph: g, graphEnabled: true, inferEnabled: true, workspace: 'w-1' },
      new Map(chain.map((e) => [e.id, e])),
    )
    expect(ws.every((h) => h.id !== 'iw')).toBe(true)
    const kd = queryIndex(
      buildIndex([chain[0]!]),
      '主数据库',
      { fusionMode: 'rrf', now: T0, decay: false, graph: g, graphEnabled: true, inferEnabled: true, kind: 'fact' },
      new Map(chain.map((e) => [e.id, e])),
    )
    expect(kd.every((h) => h.id !== 'ik')).toBe(true)
    const th = queryIndex(
      buildIndex([chain[0]!]),
      '主数据库',
      { fusionMode: 'rrf', now: T0, decay: false, graph: g, graphEnabled: true, inferEnabled: true, theme: 'theme-y' },
      new Map(chain.map((e) => [e.id, e])),
    )
    expect(th.every((h) => h.id !== 'it')).toBe(true)
  })

  it('why.chains 截断臂：单条目关联 4+ 终结实体 → 至多 3 条证据链', () => {
    const many = [
      freshEntry({
        id: 'hub',
        content: '中枢 使用 组件甲。中枢 使用 组件乙。中枢 使用 组件丙。中枢 使用 组件丁',
        createdAt: T0,
        updatedAt: T0,
      }),
      freshEntry({
        id: 'leaf',
        content: '组件甲 依赖 底座一。组件乙 依赖 底座二。组件丙 依赖 底座三。组件丁 依赖 底座四',
        createdAt: T0,
        updatedAt: T0,
      }),
    ]
    const g = buildGraph(many, 100)
    const hits = queryIndex(
      buildIndex(many),
      '中枢',
      { now: T0, decay: false, graph: g, graphEnabled: true, inferEnabled: true, explain: true },
      new Map(many.map((e) => [e.id, e])),
    )
    const hub = hits.find((h) => h.id === 'hub')
    expect(hub?.why?.chains).toBeDefined()
    expect(hub?.why?.chains!.length).toBeLessThanOrEqual(3)
  })
})

describe('覆盖率回归五：graph 抽取余留臂', () => {
  it('裸「是」含拉丁侧产出；同文重复三元组去重；归一后同实体拒收；非法英文字符拒收；超长主语拒收', () => {
    // 裸「是」但主语含拉丁 → 产出（降噪只针对双侧纯 CJK）
    expect(ruleExtractTriples('MySQL 是 主键库').length).toBeGreaterThan(0)
    // 同一三元组出现两次 → 去重为 1
    const dup = ruleExtractTriples('主数据库 使用 Redis。主数据库 使用 Redis。')
    expect(dup.filter((t) => t.subject === '主数据库' && t.object === 'redis').length).toBe(1)
    // 大小写归一后主宾同实体 → 拒收
    expect(ruleExtractTriples('mysql 使用 MYSQL')).toEqual([])
    // 英文实体含非法字符（#）→ 拒收
    expect(ruleExtractTriples('My#SQL 使用 Redis')).toEqual([])
    // 超长主语（>24 字符）→ 拒收
    const long = '这是一个特别特别特别特别长的主语片段超过二十四字符 使用 Redis'
    expect(ruleExtractTriples(long).some((t) => t.subject.length > 24)).toBe(false)
  })

  it('空图对齐：tokens 非空但图为空 → 无对齐实体', () => {
    const g = buildGraph([], 10)
    expect(g.alignByTokens(['postgresql', 'redis'])).toEqual([])
  })
})

describe('覆盖率回归五：cognitive/distill/工具面余留臂', () => {
  it('runCognitiveMaintenance：off/off 直通零产出', async () => {
    const metrics = createMetrics()
    const r = await runCognitiveMaintenance(
      memoryStore([freshEntry({ id: 'e1', content: '一条记忆' })]),
      {
        distillMode: 'off',
        consolidationMode: 'off',
        distillMinCluster: 3,
        recallThreshold: 0.4,
        maxEntryChars: 500,
      },
      metrics,
    )
    expect(r?.distilled ?? 0).toBe(0)
    expect(r?.consolidated ?? 0).toBe(0)
  })

  it('distillBatch：噪声条目不足成簇零产出', () => {
    const r = distillBatch([freshEntry({ id: 'n1', content: '完全孤立的内容片段' })], { now: T0 })
    expect(r.distilled).toHaveLength(0)
  })

  it('降级存储 asOf + workspace/kind 过滤：createdAt 之后的异类条目不进入', async () => {
    const now = Date.now()
    const rows = [
      freshEntry({ id: 'a', content: '部署用 Node 18', createdAt: now - 5000, updatedAt: now - 5000 }),
      freshEntry({ id: 'later', content: '部署用 Node 22', createdAt: now + 5000, updatedAt: now + 5000 }),
      freshEntry({
        id: 'pref',
        content: '部署偏好记录',
        kind: 'preference',
        createdAt: now - 5000,
        updatedAt: now - 5000,
      }),
    ]
    let current = [...rows]
    const degraded = {
      upsert: (e: MemoryEntry) => {
        current = [...current.filter((r) => r.id !== e.id), e]
        return Promise.resolve(e)
      },
      list: () => Promise.resolve([...current]),
      get: (id: string) => Promise.resolve(current.find((r) => r.id === id)),
      remove: () => Promise.resolve(false),
      close: () => Promise.resolve(),
    } as unknown as MemoryStore
    const tool = createMemoryRecallTool(degraded, 400, 8) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<{ hits: Array<{ id: string }>; total: number }>
    }
    const out = await tool.execute({
      query: 'Node 部署',
      asOf: now,
      kind: 'fact',
      limit: 8,
      maxTokens: 400,
    })
    expect(out.hits.every((h) => h.id !== 'later')).toBe(true)
    expect(out.hits.every((h) => h.id !== 'pref')).toBe(true)
    expect(out.hits.some((h) => h.id === 'a')).toBe(true)
  })
})
