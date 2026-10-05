/**
 * 零行为回归 / 默认配置逐字节等价门禁（DESIGN-1.1 F1 + G2 语义落地）：`npm run eval` 一键运行。
 *
 * 门限（1.1.0 硬约束「默认关闭、缺省行为与 1.0.0 逐字节一致」的可执行锁定）：
 *  1. 配置面：normalizeConfig({}) 的四个 1.1.0 新键全部为关闭态
 *     （distillMode=off ∧ consolidationMode=off ∧ graphEnabled=false ∧ conflictMode=off），
 *     且其它既有键与 defaultConfig 完全一致（逐字节对拍，无意外搬移）；
 *  2. 召回面：queryIndex 在「未注入 graph」=「注入 graph 但默认不开图线」=
 *     「显式 graphEnabled:false」三路输出逐字节一致（1.1.0 图线不改变 1.0.0 召回）；
 *  3. 入库面：conflictMode 缺省 off 时，疑似反转候选入库不产生任何新标注
 *     （tags 等于 1.0.0 行为），supersedeMode 缺省 off 同理；
 *  4. 模块面：distill / consolidate 纯函数调用不修改入参对象（存储纯净、零副作用）；
 *  5. 工具面：memory_recall 未传入 1.1.0 可选参数时，输出不含 1.1.0 新增字段
 *     （hits[].conflicts / hits[].expanded 不出现，schema 兼容旧客户端）。
 *
 * 这些断言与 test/memory 下的零行为回归单测互为补充：此处从「默认配置 → 全链路输出」
 * 的端到端视角锁定，单测从各模块内部视角锁定。
 */
import { describe, expect, it } from 'vitest'
import { defaultConfig, normalizeConfig } from '../src/config'
import { buildIndex, queryIndex } from '../src/memory/engine'
import { buildGraph } from '../src/memory/graph'
import { ingestCaptured } from '../src/memory/ingest'
import { distillBatch } from '../src/memory/distill'
import { consolidate } from '../src/memory/consolidation'
import { createMemoryRecallTool } from '../src/tools/memory-recall'
import type { RecallOutput } from '../src/tools/memory-recall'
import type { HubMetrics } from '../src/memory/metrics'
import type { MemoryEntry, MemoryStore } from '../src/memory/types'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function fixtureEntry(content: string, overrides: Partial<MemoryEntry> & { content?: string } = {}): MemoryEntry {
  return {
    id: `e-${content.trim().charCodeAt(0) ?? 0}-${content.length}`,
    kind: 'fact',
    tags: [],
    source: 'explicit',
    createdAt: T0,
    updatedAt: T0,
    accessCount: 0,
    content,
    ...overrides,
  }
}

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

const noopMetrics: HubMetrics = {
  capturedTotal: 0,
  explicitStored: 0,
  recallCalls: 0,
  recallHits: 0,
  forgotten: 0,
  rejectedSensitive: 0,
  rejectedDuplicate: 0,
  pruned: 0,
  dropped: 0,
  errors: 0,
}

describe('bit-exact 配置面：默认配置逐字节等价', () => {
  it('1.1.0 新键默认全部关闭（零行为变化）', () => {
    const cfg = normalizeConfig({})
    expect(cfg.distillMode).toBe('off')
    expect(cfg.consolidationMode).toBe('off')
    expect(cfg.graphEnabled).toBe(false)
    expect(cfg.conflictMode).toBe('off')
  })

  it('normalizeConfig({}) 与 defaultConfig 逐字节一致（无意外搬移）', () => {
    expect(JSON.stringify(normalizeConfig({}))).toBe(JSON.stringify(defaultConfig))
    // 关键既有键抽查：supersede/语义/融合等 1.0.0 语义未被 1.1.0 改动
    expect(defaultConfig.supersedeMode).toBe('off')
    expect(defaultConfig.fusionMode).toBe('interpolate')
    expect(defaultConfig.maxEntries).toBe(0)
  })
})

describe('bit-exact 召回面：图线不改变 1.0.0 召回输出', () => {
  const entries = [
    fixtureEntry('服务器 使用 PostgreSQL'),
    fixtureEntry('PostgreSQL 使用 MVCC 做并发控制'),
    fixtureEntry('该项目依赖 Redis 做缓存'),
    fixtureEntry('今天天气不错 出门散步'),
  ]

  it('未注入 graph = 注入但默认关闭 = 显式 false，三路输出逐字节一致', () => {
    const graph = buildGraph(entries)
    const index = buildIndex(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    for (const mode of ['interpolate', 'rrf'] as const) {
      const v100 = queryIndex(index, 'PostgreSQL 的用法', { fusionMode: mode, now: T0 }, byId)
      const withGraphDefault = queryIndex(index, 'PostgreSQL 的用法', { fusionMode: mode, now: T0, graph }, byId)
      const withGraphExplicitOff = queryIndex(
        index,
        'PostgreSQL 的用法',
        { fusionMode: mode, now: T0, graph, graphEnabled: false },
        byId,
      )
      expect(JSON.stringify(withGraphDefault)).toBe(JSON.stringify(v100))
      expect(JSON.stringify(withGraphExplicitOff)).toBe(JSON.stringify(v100))
    }
  })
})

describe('bit-exact 入库面：1.1.0 标注默认不产生', () => {
  it('conflictMode / supersedeMode 缺省 off：疑似反转候选入库 tags 与 1.0.0 一致（无新标注）', async () => {
    const store = memoryStore([fixtureEntry('部署环境使用 MySQL', { id: 'mysql', source: 'auto' })])
    const metrics: HubMetrics = { ...noopMetrics }
    await ingestCaptured(
      store,
      [{ content: '部署环境不再使用 MySQL', kind: 'fact', tags: [] }],
      { maxEntryChars: 600, dedupWindowMs: 30 * DAY }, // 未声明任何 1.1.0 冲突/取代模式
      metrics,
      undefined,
    )
    const rows = await store.list()
    const nu = rows.find((r) => r.content.includes('不再使用'))!
    expect(nu.tags).toEqual([]) // 无 conflicts-with、无 supersede、无蒸馏标记
    const old = rows.find((r) => r.id === 'mysql')!
    expect(old.tags).toEqual([])
  })
})

describe('bit-exact 模块面：蒸馏/巩固纯函数零副作用', () => {
  it('distillBatch 不修改入参对象', () => {
    const cluster = [
      fixtureEntry('用户习惯用 TypeScript 构建后端服务', { kind: 'preference', source: 'auto' }),
      fixtureEntry('用户喜欢用 TypeScript 写自动化脚本', { kind: 'preference', source: 'auto' }),
      fixtureEntry('用户偏好 TypeScript 作为开发主语言', { kind: 'preference', source: 'auto' }),
    ]
    const snapshot = cluster.map((c) => JSON.stringify(c))
    distillBatch(cluster, { now: T0 })
    cluster.forEach((c, i) => expect(JSON.stringify(c)).toBe(snapshot[i]!))
  })

  it('consolidate 不修改入参对象（存储纯净）', () => {
    const e = fixtureEntry('测试记忆', { createdAt: T0, updatedAt: T0, source: 'explicit' })
    const snapshot = JSON.stringify(e)
    consolidate([e], T0 + 30 * DAY)
    expect(JSON.stringify(e)).toBe(snapshot)
  })
})

describe('bit-exact 工具面：memory_recall 1.1.0 新字段默认不出现', () => {
  it('缺省调用输出与 1.0.0 形状一致（无 conflicts/expanded 字段）', async () => {
    const entries = [fixtureEntry('用户喜欢 TypeScript', { kind: 'preference' })]
    const store = memoryStore(entries)
    const metrics: HubMetrics = { ...noopMetrics }
    // 工厂缺省注入：不传 graph，不传 1.1.0 参数（旧客户端调用形状）
    const recallTool = createMemoryRecallTool(store, 200, 8, undefined, metrics) as unknown as {
      execute: (args: never) => Promise<RecallOutput>
    }
    const output = await recallTool.execute({ query: 'TypeScript', limit: 8, maxTokens: 200 } as never)
    expect(Array.isArray(output.hits)).toBe(true)
    for (const h of output.hits) {
      expect(h).not.toHaveProperty('conflicts')
      expect(h).not.toHaveProperty('expanded')
    }
  })
})
