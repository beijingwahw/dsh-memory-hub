/**
 * 图维时间对账（1.5.0，DESIGN-1.5 模块 L）行为锁定。
 *
 * 覆盖面：
 * - diffGraphs 纯函数：新关系确立 → added 边、tombstone/取代 → removed 边、
 *   实体计数、确定性排序、双侧空集；
 * - activeEdgeList：失效边缺席（supersede 标注）、字典序确定性；
 * - 工具面 graphDiff 参数：输出形状（计数完整 + 边样本 ≤10）、渲染图行、
 *   缺省不输出 graph 键（零回归）、与 workspace 过滤正交（按过滤后语料建图）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildGraph, diffGraphs } from '../../src/memory/graph'
import { createMetrics } from '../../src/memory/metrics'
import { JsonlMemoryStore } from '../../src/memory/store'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import type { MemoryEntry } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function e(id: string, content: string, at: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return freshEntry({ id, content, createdAt: at, updatedAt: at, ...overrides })
}

type StatusTool = {
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
}

describe('diffGraphs 纯函数（1.5.0 模块 L）', () => {
  it('新关系确立 → added 边；唯一携带条目删除 → removed 边；实体计数双侧正确', () => {
    const before = [e('a', '网关 使用 Nginx', T0)]
    const after = [
      e('a', '网关 使用 Nginx', T0),
      e('b', '缓存 使用 Valkey', T0 + DAY), // 新条目 → 新边
    ]
    const d = diffGraphs(before, after, T0 + DAY + 1000)
    expect(d.addedEdgeCount).toBe(2) // 缓存 —使用→ valkey + 反向边
    expect(d.removedEdgeCount).toBe(0)
    expect(d.addedEdges.map((x) => `${x.from}|${x.relation}|${x.to}`).sort()).toEqual([
      'valkey|~使用|缓存',
      '缓存|使用|valkey',
    ])
    expect(d.beforeEntities).toBe(2) // 网关 + nginx
    expect(d.afterEntities).toBe(4) // + 缓存 + valkey
  })

  it('tombstone 删除唯一携带条目 → removed 边（图视图消失）', () => {
    const before = [e('a', '网关 使用 Nginx', T0), e('b', '队列 使用 Kafka', T0)]
    const after = [e('a', '网关 使用 Nginx', T0)] // b 被 tombstone（回放语料缺席）
    const d = diffGraphs(before, after, T0 + DAY)
    expect(d.removedEdgeCount).toBe(2) // 队列 —使用→ kafka + 反向边
    expect(d.addedEdgeCount).toBe(0)
    expect(d.removedEdges.map((x) => x.from).sort()).toEqual(['kafka', '队列'])
  })

  it('取代标注使边失效 → removed 边（T2 语料中被 superseded 的条目）', () => {
    const before = [e('a', '缓存 使用 Redis', T0)]
    const after = [
      // a 被取代：tags 标注 superseded-by（回放语料仍存在但边失效）
      e('a', '缓存 使用 Redis', T0, { tags: ['superseded-by:new1'], updatedAt: T0 + DAY }),
      e('new1', '缓存 使用 Valkey', T0 + DAY),
    ]
    const d = diffGraphs(before, after, T0 + DAY + 1000)
    // redis 旧边失效 → removed；valkey 新边 → added
    expect(d.removedEdges.some((x) => x.from === 'redis' || x.to === 'redis')).toBe(true)
    expect(d.addedEdges.some((x) => x.from === 'valkey' || x.to === 'valkey')).toBe(true)
  })

  it('确定性：同输入两次计算 deep-equal；双侧空集零差异', () => {
    const d1 = diffGraphs([], [], T0)
    const d2 = diffGraphs([], [], T0)
    expect(d1).toEqual({
      until: T0,
      beforeEntities: 0,
      afterEntities: 0,
      addedEdges: [],
      removedEdges: [],
      addedEdgeCount: 0,
      removedEdgeCount: 0,
    })
    expect(d1).toEqual(d2)
    const a = [e('x', '服务 使用 GRPC', T0)]
    const b = [e('y', '存储 使用 Rocksdb', T0 + DAY)]
    expect(diffGraphs(a, b, T0 + 2 * DAY)).toEqual(diffGraphs(a, b, T0 + 2 * DAY))
  })

  it('activeEdgeList：失效边缺席、(from, relation, target) 字典序排序', () => {
    const g = buildGraph([e('a', '网关 使用 Nginx', T0), e('b', '队列 使用 Kafka', T0), e('c', '配置 副本数 3', T0)])
    const list = g.activeEdgeList(T0 + 1000)
    expect(list.length).toBeGreaterThan(0)
    const keys = list.map((x) => `${x.from}\u0000${x.relation}\u0000${x.target}`)
    expect([...keys].sort()).toEqual(keys)
    expect(list.every((x) => x.confidence > 0 && x.confidence <= 1)).toBe(true)
  })
})

describe('memory_status graphDiff 参数（1.5.0 模块 L）', () => {
  /** 分阶段语料：T0 建网关边；T1 新增缓存边；T2 删除队列边 */
  async function stagedStore() {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-gdiff-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(e('g', '网关 使用 Nginx', T0))
    await store.upsert(e('q', '队列 使用 Kafka', T0))
    await store.upsert(e('c', '缓存 使用 Valkey', T0 + DAY))
    await store.removeMany(['q'], T0 + 2 * DAY)
    const metrics = createMetrics()
    const tool = createMemoryStatusTool(store, () => 0, undefined, metrics) as unknown as StatusTool
    return { store, tool, metrics }
  }

  it('graphDiff=true：diff 输出附图维对账（计数完整 + 边样本），渲染含 graph 行', async () => {
    const { tool } = await stagedStore()
    const out = await tool.execute({ diffSince: T0 + 1000, asOf: T0 + 2 * DAY + 1000, graphDiff: true })
    const d = out['diff'] as {
      graph?: {
        beforeEntities: number
        afterEntities: number
        addedEdgeCount: number
        removedEdgeCount: number
        addedEdges: Array<{ from: string; relation: string; to: string }>
        removedEdges: Array<{ from: string; relation: string; to: string }>
      }
    }
    expect(d.graph).toBeDefined()
    expect(d.graph!.addedEdgeCount).toBe(2) // 缓存 —使用→ valkey + 反向
    expect(d.graph!.removedEdgeCount).toBe(2) // 队列 —使用→ kafka + 反向
    expect(d.graph!.addedEdges.length).toBe(2)
    expect(d.graph!.removedEdges.length).toBe(2)
    expect(d.graph!.beforeEntities).toBe(4) // 网关/nginx/队列/kafka
    expect(d.graph!.afterEntities).toBe(4) // 网关/nginx/缓存/valkey
    const rendered = tool.output.render({ diffSince: T0 + 1000, asOf: T0 + 2 * DAY + 1000, graphDiff: true }, out)
    expect(rendered[0]?.text).toContain('graph: entities 4→4, +2 −2 edge(s)')
    expect(rendered[0]?.text).toContain('− 队列 —使用→ kafka')
  })

  it('缺省零回归：graphDiff 缺席时 diff 输出无 graph 键、渲染无 graph 行', async () => {
    const { tool } = await stagedStore()
    const out = await tool.execute({ diffSince: T0 + 1000, asOf: T0 + 2 * DAY + 1000 })
    const d = out['diff'] as { graph?: unknown }
    expect(d.graph).toBeUndefined()
    const rendered = tool.output.render({ diffSince: T0 + 1000, asOf: T0 + 2 * DAY + 1000 }, out)
    expect(rendered[0]?.text).not.toContain('graph:')
  })

  it('workspace 过滤叠加：图按过滤后语料重建（指定工作区视角对账）', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-gdiff-ws-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(e('g', '网关 使用 Nginx', T0))
    await store.upsert(e('w', '面板 使用 Grafana', T0, { workspace: 'proj-a' }))
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    const out = await tool.execute({
      diffSince: T0 - 1,
      asOf: T0 + DAY,
      graphDiff: true,
      workspace: 'proj-a',
    })
    const d = out['diff'] as { graph?: { addedEdgeCount: number } }
    // proj-a 视角：全局共享（网关）+ proj-a（面板）都计入
    expect(d.graph!.addedEdgeCount).toBe(4)
    await store.close()
  })
})
