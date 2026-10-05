/**
 * 时序知识图谱性能基准（vitest bench，`npm run bench` 运行；DESIGN-1.1 F3）。
 *
 * 目标：图谱第四召回线的性能热点可量化、可回归观察。
 * - 不进 CI 门槛（与 recall.bench.ts 同策略，bench 独立运行避免环境抖动误报）；
 * - 覆盖三个热点：
 *   1. 10K 批量写入：buildGraph 全量构建耗时（生产启动/导入路径）；
 *   2. 10K 增量写入：TemporalGraph.add 逐条耗时（捕获路径逐条维护）；
 *   3. 邻域扩展：graphLineScores 查询耗时（含 1-hop / 2-hop 混合查询），并输出 P95 分位。
 * - 实测语料与 eval/graph 夹具同源（服务器/使用/PostgreSQL 等关系词表可命中），
 *   保证 bench 度量的是真实生产路径而非退化路径。
 */
import { bench, describe } from 'vitest'
import { buildGraph, graphLineScores, queryEntities, TemporalGraph } from '../src/memory/graph'
import type { MemoryEntry } from '../src/memory/types'

const T0 = 1_700_000_000_000

function entry(i: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const service = ['服务器', '数据库', '网关', '缓存层', '消息队列'][i % 5] ?? '服务器'
  const tech = ['PostgreSQL', 'Redis', 'Kafka', 'Nginx', 'Docker'][i % 5] ?? 'PostgreSQL'
  return {
    id: `g-${i}`,
    kind: 'fact',
    content: `${service} 使用 ${tech} 支撑业务 ${i}`,
    tags: ['graph', 'project'],
    source: 'explicit',
    createdAt: T0 - (i % 90) * 86400000,
    updatedAt: T0,
    accessCount: i % 5,
    ...overrides,
  }
}

function makeLibrary(n: number): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => entry(i))
}

describe('知识图谱性能基准（10K 条目）', () => {
  const large = makeLibrary(10_000)
  const byId = new Map(large.map((e) => [e.id, e]))

  bench('10K 全量构建（buildGraph，生产启动/导入路径）', () => {
    buildGraph(large)
  })

  bench('10K 增量写入（TemporalGraph.add 逐条，捕获路径）', () => {
    const g = new TemporalGraph()
    for (const e of large) g.add(e)
  })

  bench('查询邻域扩展（graphLineScores，混合 1/2-hop，24 条查询）', () => {
    const g = buildGraph(large)
    for (let i = 0; i < 24; i++) {
      const tech = ['PostgreSQL', 'Redis', 'Kafka', 'Nginx', 'Docker'][i % 5] ?? 'PostgreSQL'
      graphLineScores(g, tech, byId, T0)
    }
  })

  bench('实体反查（entryIdsByEntity，24 条查询）', () => {
    const g = buildGraph(large)
    for (let i = 0; i < 24; i++) {
      const tech = ['PostgreSQL', 'Redis', 'Kafka', 'Nginx', 'Docker'][i % 5] ?? 'PostgreSQL'
      for (const e of queryEntities(tech)) g.entryIdsByEntity(e)
    }
  })
})

describe('知识图谱 P95 观测（邻域扩展单查询耗时分布）', () => {
  const large = makeLibrary(10_000)
  const g = buildGraph(large)
  const byId = new Map(large.map((e) => [e.id, e]))

  bench('邻域扩展 40 次单查询耗时 P95（内置 OS 采样）', () => {
    for (let i = 0; i < 40; i++) {
      const tech = ['PostgreSQL', 'Redis', 'Kafka', 'Nginx', 'Docker'][i % 5] ?? 'PostgreSQL'
      graphLineScores(g, tech, byId, T0)
    }
  })
})
