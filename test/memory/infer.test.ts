/**
 * 激活扩散推理线（1.2.0，DESIGN-1.2 模块 E）与召回溯源（模块 F）行为锁定。
 *
 * 覆盖面：
 * - inferChains 纯函数：两跳链/跳数折扣/最优路径/种子排除/确定性（重复调用 + 乱序构建）/
 *   asOf 时间线正确性（失效边不可穿越 + reassertedAt 复活）/hub 扇出与链数有界性；
 * - inferLineScores：终结实体关联条目计分；
 * - engine 第五线集成：interpolate 推理兜底召回 / RRF 第五条秩融合 / inferMaxHops 钳制 /
 *   缺省零回归（与 1.1.1 输出逐字节一致）；
 * - 模块 F 溯源：interpolate 加权项 / rrf 倒数秩贡献（Σvalue × lineBase 精确等于最终分）/
 *   explain 缺省不产生 why 字段；
 * - 工具面：memory_recall infer/explain 参数、metrics.inferHits 观测、缺省形状不变；
 * - 配置面：inferEnabled 默认 false / inferMaxHops 运行时钳制 1..3。
 */
import { describe, expect, it } from 'vitest'
import { buildGraph } from '../../src/memory/graph'
import { inferChains, inferLineScores, INFER_MAX_CHAINS } from '../../src/memory/infer'
import { buildIndex, queryIndex, recall } from '../../src/memory/engine'
import { normalizeConfig, defaultConfig } from '../../src/config'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import type { RecallOutput } from '../../src/tools/memory-recall'
import { createMetrics } from '../../src/memory/metrics'
import type { MemoryEntry, MemoryStore } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** 关系链夹具：主数据库—使用→PostgreSQL—依赖→MVCC—属于→事务机制 */
function chainFixture(): MemoryEntry[] {
  return [
    freshEntry({ id: 'e1', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 }),
    freshEntry({ id: 'e2', content: 'PostgreSQL 依赖 MVCC', createdAt: T0, updatedAt: T0 }),
    freshEntry({ id: 'e3', content: 'MVCC 属于 事务机制', createdAt: T0, updatedAt: T0 }),
    freshEntry({ id: 'noise', content: '今天天气不错 出门散步', createdAt: T0, updatedAt: T0 }),
  ]
}

describe('激活扩散推理（inferChains 纯函数）', () => {
  it('两跳链可达且跳数折扣：1 跳链强度 > 2 跳链强度', () => {
    const g = buildGraph(chainFixture(), 100)
    const chains = inferChains(g, ['PostgreSQL'], { now: T0 })
    const terminals = chains.map((c) => c.terminal)
    expect(terminals).toContain('mvcc') // 1 跳（依赖）
    expect(terminals).toContain('事务机制') // 2 跳（依赖→属于）
    expect(terminals).toContain('主数据库') // 1 跳（反向 ~使用）
    const oneHop = chains.find((c) => c.terminal === 'mvcc')!
    const twoHop = chains.find((c) => c.terminal === '事务机制')!
    expect(oneHop.path).toHaveLength(1)
    expect(twoHop.path).toHaveLength(2)
    // 同新鲜度下：1 跳 = 0.5 × conf；2 跳 = 0.5² × conf² —— 跳数折扣单调
    expect(twoHop.score).toBeLessThan(oneHop.score)
    // 路径语义可解释回放：postgresql —依赖→ mvcc —属于→ 事务机制
    expect(twoHop.path[0]).toMatchObject({ from: 'postgresql', relation: '依赖', to: 'mvcc' })
    expect(twoHop.path[1]).toMatchObject({ from: 'mvcc', relation: '属于', to: '事务机制' })
  })

  it('最优路径语义：同终结实体多条关系时保留最高置信路径；种子不可作为终结实体', () => {
    const entries = [
      ...chainFixture(),
      freshEntry({ id: 'e5', content: 'PostgreSQL 喜欢 MVCC', createdAt: T0, updatedAt: T0 }), // 0.9 < 依赖 1.0
    ]
    const g = buildGraph(entries, 100)
    const chains = inferChains(g, ['postgresql'], { now: T0 })
    expect(chains.find((c) => c.terminal === 'postgresql')).toBeUndefined()
    const mvcc = chains.find((c) => c.terminal === 'mvcc')
    expect(mvcc?.path[0]?.relation).toBe('依赖')
  })

  it('确定性：重复调用一致；乱序构建的图产出一致', () => {
    const entries = chainFixture()
    const g1 = buildGraph(entries, 100)
    const g2 = buildGraph([...entries].reverse(), 100)
    const a = JSON.stringify(inferChains(g1, ['postgresql'], { now: T0 }))
    const b = JSON.stringify(inferChains(g1, ['postgresql'], { now: T0 }))
    const c = JSON.stringify(inferChains(g2, ['postgresql'], { now: T0 }))
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('asOf 时间线正确性：被取代的边不可穿越；reassertedAt 复活后可再次穿越', () => {
    // e2 的边在 T0+DAY 被取代失效（superseded-by 协议）
    const superseded = freshEntry({
      id: 'e2s',
      content: 'PostgreSQL 依赖 MVCC',
      tags: ['superseded-by:e9'],
      createdAt: T0,
      updatedAt: T0 + DAY,
    })
    const base = [chainFixture()[0]!, chainFixture()[2]!, superseded]
    const g = buildGraph(base, 100)
    // 失效前：链完整可达事务机制
    expect(inferChains(g, ['postgresql'], { now: T0 }).map((c) => c.terminal)).toContain('事务机制')
    // 失效期间：postgresql→mvcc 不可穿越，事务机制不可达（只剩 ~使用→主数据库）
    const during = inferChains(g, ['postgresql'], { now: T0 + Math.floor(DAY * 1.5) })
    expect(during.map((c) => c.terminal)).not.toContain('事务机制')
    expect(during.map((c) => c.terminal)).toContain('主数据库')
    // 重断言复活：同一三元组被新的非取代条目重新确立（updatedAt = T0+2DAY）
    g.add(freshEntry({ id: 'e4', content: 'PostgreSQL 依赖 MVCC', createdAt: T0 + 2 * DAY, updatedAt: T0 + 2 * DAY }))
    const revived = inferChains(g, ['postgresql'], { now: T0 + 3 * DAY })
    expect(revived.map((c) => c.terminal)).toContain('事务机制')
    // asOf 回放：复活时刻之前的历史视图仍忠实呈现「失效期间」
    const replay = inferChains(g, ['postgresql'], { now: T0 + Math.floor(DAY * 1.5) })
    expect(replay.map((c) => c.terminal)).not.toContain('事务机制')
  })

  it('有界性：hub 扇出下链数受 maxChains 截断；波束宽度限制第 2 跳探索面', () => {
    const entries: MemoryEntry[] = []
    for (let i = 0; i < 60; i++) {
      entries.push(freshEntry({ id: `hub-${i}`, content: `hub 使用 组件${i}`, createdAt: T0, updatedAt: T0 }))
      entries.push(freshEntry({ id: `dep-${i}`, content: `组件${i} 依赖 集群中枢`, createdAt: T0, updatedAt: T0 }))
    }
    // 仅组件2 指向备用中枢——字典序前 16 为 组件0/1/10-19/2/20，组件2 在 beam=16 内、beam=4（组件0/1/10/11）外
    entries.push(freshEntry({ id: 'alt', content: '组件2 偏好 备用中枢', createdAt: T0, updatedAt: T0 }))
    const g = buildGraph(entries, 500)
    // 链数上限：60 个 1 跳终结实体 > 默认上限 16 → 截断且确定性
    const capped = inferChains(g, ['hub'], { now: T0 })
    expect(capped.length).toBeLessThanOrEqual(INFER_MAX_CHAINS)
    expect(JSON.stringify(capped)).toBe(JSON.stringify(inferChains(g, ['hub'], { now: T0 })))
    // 波束宽度：beam=4 时第 2 跳只探索字典序前 4 个组件（组件0/1/10/11），组件2 未覆盖 → 备用中枢不可达
    const narrow = inferChains(g, ['hub'], { now: T0, beam: 4, maxChains: 64 })
    expect(narrow.map((c) => c.terminal)).not.toContain('备用中枢')
    // beam=16 覆盖组件2 → 备用中枢经 2 跳可达；链数受 maxChains=64 护栏
    const wide = inferChains(g, ['hub'], { now: T0, beam: 16, maxChains: 64 })
    expect(wide.map((c) => c.terminal)).toContain('备用中枢')
    expect(wide.length).toBeLessThanOrEqual(64)
  })

  it('inferLineScores：终结实体关联条目按链强度 × currentness 计分', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const scores = inferLineScores(g, 'PostgreSQL', byId, T0)
    // 三个终结实体（mvcc/事务机制/主数据库）关联的条目全部计分，噪声条目不计
    expect(scores.get('e1')!).toBeGreaterThan(0)
    expect(scores.get('e2')!).toBeGreaterThan(0)
    expect(scores.get('e3')!).toBeGreaterThan(0)
    expect(scores.has('noise')).toBe(false)
  })
})

describe('推理线召回集成（engine 第五线）', () => {
  it('interpolate：词面零命中但推理 2 跳可达的条目经推理线进入召回', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    // 查询种子 =「事务机制」（引号实体）；e1（主数据库 使用 PostgreSQL）与查询零词面重叠，
    // 但 事务机制—~属于→mvcc—~依赖→postgresql 两跳推理可达
    const base = { now: T0, decay: false, graph: g, graphEnabled: false } as const
    const off = recall(entries, '"事务机制" 的上游演进', { ...base })
    expect(off.map((h) => h.id)).not.toContain('e1')
    const on = recall(entries, '"事务机制" 的上游演进', { ...base, inferEnabled: true })
    expect(on.map((h) => h.id)).toContain('e1')
  })

  it('缺省零回归：inferEnabled 缺省时输出与 1.1.1 逐字节一致（interpolate/rrf 双模式）', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const index = buildIndex(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    for (const mode of ['interpolate', 'rrf'] as const) {
      for (const graphOn of [false, true]) {
        const v111 = queryIndex(
          index,
          'PostgreSQL 的并发控制',
          { fusionMode: mode, now: T0, graph: g, graphEnabled: graphOn },
          byId,
        )
        const withInferOff = queryIndex(
          index,
          'PostgreSQL 的并发控制',
          { fusionMode: mode, now: T0, graph: g, graphEnabled: graphOn, inferEnabled: false },
          byId,
        )
        expect(JSON.stringify(withInferOff)).toBe(JSON.stringify(v111))
      }
    }
  })

  it('RRF：推理线作为第五条秩融合参与（推理专属候选补录）', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const hits = recall(entries, '"事务机制" 的上游演进', {
      fusionMode: 'rrf',
      now: T0,
      decay: false,
      graph: g,
      graphEnabled: false,
      inferEnabled: true,
    })
    expect(hits.map((h) => h.id)).toContain('e1')
    expect(hits.find((h) => h.id === 'e1')!.score).toBeGreaterThan(0)
  })

  it('inferMaxHops 钳制：1 跳时 2 跳推理目标不可达', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const base = { now: T0, decay: false, graph: g, graphEnabled: false, inferEnabled: true } as const
    expect(recall(entries, '"事务机制" 的上游演进', { ...base, inferMaxHops: 1 }).map((h) => h.id)).not.toContain('e1')
    expect(recall(entries, '"事务机制" 的上游演进', { ...base, inferMaxHops: 2 }).map((h) => h.id)).toContain('e1')
  })

  it('配置面：inferEnabled 默认 false；inferMaxHops 运行时钳制 1..3', () => {
    expect(defaultConfig.inferEnabled).toBe(false)
    expect(normalizeConfig({}).inferEnabled).toBe(false)
    expect(normalizeConfig({}).inferMaxHops).toBe(2)
    expect(normalizeConfig({ inferMaxHops: 0 }).inferMaxHops).toBe(1)
    expect(normalizeConfig({ inferMaxHops: 9 }).inferMaxHops).toBe(3)
    expect(normalizeConfig({ inferEnabled: 'yes' as unknown as boolean }).inferEnabled).toBe(false)
  })
})

describe('召回溯源（模块 F：why 注记）', () => {
  it('interpolate：每命中 why 非空、lines 含实际参与线、score 与最终分同源', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const hits = recall(entries, 'PostgreSQL', {
      now: T0,
      decay: false,
      graph: g,
      graphEnabled: true,
      inferEnabled: true,
      explain: true,
    })
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      expect(h.why).toBeDefined()
      expect(h.why!.lines.length).toBeGreaterThan(0)
      expect(h.why!.fusion).toBe('interpolate')
      expect(h.why!.score).toBe(h.score)
      expect(h.why!.lineBase).toBeGreaterThan(0)
      // lines 按召回线固定序（bm25 在前）
      const names = h.why!.lines.map((l) => l.line)
      for (const n of names) expect(['bm25', 'fuzzy', 'semantic', 'graph', 'infer']).toContain(n)
    }
    // 词面命中的条目首线为 bm25；推理参与至少一条命中
    const lexical = hits.find((h) => h.id === 'e1')
    expect(lexical?.why?.lines[0]?.line).toBe('bm25')
    expect(hits.some((h) => h.why!.lines.some((l) => l.line === 'infer'))).toBe(true)
    expect(hits.some((h) => h.why!.lines.some((l) => l.line === 'graph'))).toBe(true)
  })

  it('rrf：perLine 倒数秩贡献之和 × lineBase 精确等于最终分（与融合算术同序同值）', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const hits = recall(entries, 'PostgreSQL 并发控制', {
      fusionMode: 'rrf',
      now: T0,
      decay: false,
      graph: g,
      graphEnabled: true,
      inferEnabled: true,
      explain: true,
    })
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      expect(h.why).toBeDefined()
      expect(h.why!.fusion).toBe('rrf')
      // 融合算术：rrf 按 bm25→fuzzy→semantic→graph→infer 固定序累加后 ×lineBase 一次；
      // reduce 同序累加 → 逐位一致（非近似）
      let sum = 0
      for (const l of h.why!.lines) sum += l.value
      expect(sum * h.why!.lineBase).toBe(h.score)
    }
  })

  it('确定性：同查询重复调用 why 逐字节一致；explain 缺省不产生 why 字段', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const opts = {
      now: T0,
      decay: false,
      graph: g,
      graphEnabled: true,
      inferEnabled: true,
      explain: true,
    } as const
    expect(JSON.stringify(recall(entries, 'PostgreSQL', opts))).toBe(
      JSON.stringify(recall(entries, 'PostgreSQL', opts)),
    )
    const plain = recall(entries, 'PostgreSQL', { ...opts, explain: false })
    for (const h of plain) expect('why' in h).toBe(false)
  })
})

/** 内存版 MemoryStore（工具面测试用；1.3.0 起提升到模块作用域供两个 describe 共用） */
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

describe('工具面：memory_recall infer/explain 参数', () => {
  it('explain=true：输出含 why 溯源、渲染含「溯源」、metrics 计 inferHits', async () => {
    const store = memoryStore(chainFixture())
    const metrics = createMetrics()
    const g = buildGraph(chainFixture(), 100)
    const tool = createMemoryRecallTool(
      store,
      400,
      8,
      undefined,
      metrics,
      undefined,
      { inferEnabled: true, inferMaxHops: 2 },
      g,
    ) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<RecallOutput>
      output: { render: (args: unknown, value: RecallOutput) => Array<{ type: string; text: string }> }
    }
    const output = await tool.execute({
      query: '"事务机制" 的上游演进',
      explain: true,
      reinforce: false,
      limit: 8,
      maxTokens: 400,
    })
    expect(output.total).toBeGreaterThan(0)
    expect(output.hits.some((h) => h.why !== undefined)).toBe(true)
    expect(output.hits.some((h) => h.why?.lines.some((l) => l.line === 'infer'))).toBe(true)
    expect(metrics.inferHits).toBe(output.total)
    const text = tool.output
      .render({}, output)
      .map((r) => r.text)
      .join('\n')
    expect(text).toContain('溯源')
  })

  it('缺省调用：不传 infer/explain → 输出无 why 字段（形状与 1.1.1 一致）、不启用推理线', async () => {
    const store = memoryStore(chainFixture())
    const metrics = createMetrics()
    const tool = createMemoryRecallTool(store, 200, 8, undefined, metrics) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<RecallOutput>
    }
    const output = await tool.execute({ query: 'PostgreSQL', limit: 8, maxTokens: 200 })
    expect(output.total).toBeGreaterThan(0)
    for (const h of output.hits) {
      expect(h).not.toHaveProperty('why')
      expect(h).not.toHaveProperty('conflicts')
      expect(h).not.toHaveProperty('expanded')
    }
    expect(metrics.inferHits).toBeUndefined()
  })

  it('infer 参数显式开启：无需插件配置即可启用推理线', async () => {
    const store = memoryStore(chainFixture())
    const g = buildGraph(chainFixture(), 100)
    const tool = createMemoryRecallTool(store, 400, 8, undefined, undefined, undefined, undefined, g) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<RecallOutput>
    }
    const output = await tool.execute({
      query: '"事务机制" 的上游演进',
      infer: true,
      reinforce: false,
      limit: 8,
      maxTokens: 400,
    })
    expect(output.hits.map((h) => h.id)).toContain('e1')
  })
})

describe('推理证据链（1.3.0 模块 H：why.chains）', () => {
  it('interpolate：infer 线参与的命中携带 chains——路径可回放、≤3 条、按链强度降序、边 occurredAt ≤ now', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const hits = recall(entries, '"事务机制" 的上游演进', {
      now: T0,
      decay: false,
      graph: g,
      graphEnabled: true,
      inferEnabled: true,
      explain: true,
    })
    expect(hits.length).toBeGreaterThan(0)
    const withInfer = hits.filter((h) => h.why?.lines.some((l) => l.line === 'infer'))
    expect(withInfer.length).toBeGreaterThan(0)
    for (const h of withInfer) {
      const chains = h.why!.chains
      expect(chains).toBeDefined()
      expect(chains!.length).toBeGreaterThan(0)
      expect(chains!.length).toBeLessThanOrEqual(3)
      for (let i = 1; i < chains!.length; i++) {
        expect(chains![i]!.score).toBeLessThanOrEqual(chains![i - 1]!.score)
      }
      for (const c of chains!) {
        expect(c.path.length).toBeGreaterThanOrEqual(1)
        // 路径连续：每条边的 from = 上一条边的 to（首边 from = 种子实体）
        for (let i = 1; i < c.path.length; i++) expect(c.path[i]!.from).toBe(c.path[i - 1]!.to)
        expect(c.terminal).toBe(c.path[c.path.length - 1]!.to)
        for (const e of c.path) {
          expect(e.confidence).toBeGreaterThan(0)
          expect(e.confidence).toBeLessThanOrEqual(1)
          // asOf 时间线：推理不能穿越该时刻尚未发生的关系
          expect(e.occurredAt).toBeLessThanOrEqual(T0)
        }
      }
      // 该命中的链终结实体确实关联到本条目（图反查）
      const ids = new Set(g.entryIdsByEntity(chains![0]!.terminal))
      expect(ids.has(h.id)).toBe(true)
    }
    // 无 infer 线的命中不携带 chains 字段（精确可选，缺省不产生）
    for (const h of hits.filter((x) => !x.why?.lines.some((l) => l.line === 'infer'))) {
      expect(h.why?.chains).toBeUndefined()
    }
  })

  it('rrf：infer 线参与的命中同样携带 chains；重复调用逐字节一致', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const opts = {
      fusionMode: 'rrf',
      now: T0,
      decay: false,
      graph: g,
      graphEnabled: true,
      inferEnabled: true,
      explain: true,
    } as const
    const hits = recall(entries, 'PostgreSQL 并发控制', opts)
    expect(hits.some((h) => h.why?.chains !== undefined && h.why.chains.length > 0)).toBe(true)
    expect(JSON.stringify(recall(entries, 'PostgreSQL 并发控制', opts))).toBe(
      JSON.stringify(recall(entries, 'PostgreSQL 并发控制', opts)),
    )
  })

  it('infer 关闭时即使 explain=true 也无 chains；explain 关闭时无 why', () => {
    const entries = chainFixture()
    const g = buildGraph(entries, 100)
    const noInfer = recall(entries, 'PostgreSQL', {
      now: T0,
      decay: false,
      graph: g,
      graphEnabled: true,
      explain: true,
    })
    for (const h of noInfer) expect(h.why?.chains).toBeUndefined()
    const noExplain = recall(entries, 'PostgreSQL', {
      now: T0,
      decay: false,
      graph: g,
      graphEnabled: true,
      inferEnabled: true,
    })
    for (const h of noExplain) expect('why' in h).toBe(false)
  })

  it('asOf 图视图重建：buildGraph(T 时刻语料) 的推理链不含未来边（模块 G 与模块 H 组合语义）', () => {
    // T0 建主链；T0+2d 追加「并发吞吐 依赖 MVCC」——未来条目在 T 时刻语料中不存在，
    // 由其建边的「~依赖」反向边在 T 时刻图视图中不存在（工具层 asOf 用回放语料重建图，见 replay-asof.test.ts）
    const future = freshEntry({
      id: 'future',
      content: '并发吞吐 依赖 MVCC',
      createdAt: T0 + 2 * DAY,
      updatedAt: T0 + 2 * DAY,
    })
    const pre = chainFixture()
    const gT = buildGraph(pre, 100) // T 时刻图视图 = 仅 T0 语料
    const chains = inferChains(gT, ['mvcc'], { now: T0 })
    for (const c of chains) {
      expect(c.terminal).not.toBe('并发吞吐')
      for (const e of c.path) expect(e.occurredAt).toBeLessThanOrEqual(T0)
    }
    // 对照：当前视图（含未来条目）可经「~依赖」到达——证明上例排除的是未来边而非路径本身
    const gNow = buildGraph([...pre, future], 100)
    expect(inferChains(gNow, ['mvcc'], { now: T0 + 3 * DAY }).map((c) => c.terminal)).toContain('并发吞吐')
  })

  it('工具面：explain=true 输出 why.chains，渲染含「推理:」链回放', async () => {
    const store = memoryStore(chainFixture())
    const g = buildGraph(chainFixture(), 100)
    const tool = createMemoryRecallTool(
      store,
      400,
      8,
      undefined,
      undefined,
      undefined,
      { inferEnabled: true },
      g,
    ) as unknown as {
      execute: (args: Record<string, unknown>) => Promise<RecallOutput>
      output: { render: (args: unknown, value: RecallOutput) => Array<{ type: string; text: string }> }
    }
    const output = await tool.execute({
      query: '"事务机制" 的上游演进',
      explain: true,
      reinforce: false,
      limit: 8,
      maxTokens: 400,
    })
    const withChains = output.hits.filter((h) => h.why?.chains !== undefined)
    expect(withChains.length).toBeGreaterThan(0)
    for (const h of withChains) {
      const c = h.why!.chains!
      expect(c.length).toBeLessThanOrEqual(3)
      expect(c[0]!.path.length).toBeGreaterThanOrEqual(1)
      expect(c[0]!.terminal).toBe(c[0]!.path[c[0]!.path.length - 1]!.to)
    }
    const text = tool.output
      .render({ query: '"事务机制" 的上游演进', explain: true }, output)
      .map((r) => r.text)
      .join('\n')
    expect(text).toContain('推理:')
    expect(text).toContain('—')
    // 缺省（无 explain）不产生 chains
    const plain = await tool.execute({ query: 'PostgreSQL', reinforce: false, limit: 8, maxTokens: 400 })
    for (const h of plain.hits) expect(h).not.toHaveProperty('why')
  })
})
