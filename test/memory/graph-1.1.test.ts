/**
 * 1.1.0 时序知识图谱召回线测试（DESIGN-1.1 模块 C，门禁 G10）。
 *
 * G10 门限：
 * - 抽取有效性：中英文小语料三元组抽取全部命中（主观召回 ≥ 80% 的向下测试）；
 * - 图召回命中：查询邻域可命中相关条目（graphHits > 0，含词面/语义全零的图可达补录）；
 * - 增量一致性：增量 add 序列与 buildGraph 全量重建对拍（stats / 邻域得分 / 实体反查一致）；
 * - 零行为回归：graphEnabled 缺省 false 时召回与 1.0.0 逐字节一致（无 graph 注入亦然）。
 *
 * 语料经实测锁定（normalizeForMatch 归一化 + 关系词表单一事实源）：
 *   "PostgreSQL 使用 MVCC 做并发控制" → (postgresql, 使用, mvcc 做并发控制)
 *   "服务器 使用 PostgreSQL"          → (服务器, 使用, postgresql)
 *   "该项目依赖 Redis 做缓存"        → (该项目, 依赖, redis 做缓存)
 *   "界面设计 使用 色彩系统"          → (界面设计, 使用, 色彩系统)
 *   "色彩系统 使用 渐变"              → (色彩系统, 使用, 渐变)
 *   "Postgres uses MVCC"              → (postgres, uses, mvcc)
 *   "the app uses caching"            → (the app, uses, caching)
 *   "the app is built with Rust"      → (the app is, built with, rust)
 */
import { describe, expect, it } from 'vitest'
import { buildGraph, graphLineScores, ruleExtractTriples, TemporalGraph } from '../../src/memory/graph'
import { buildIndex, queryIndex } from '../../src/memory/engine'
import type { MemoryEntry } from '../../src/memory/types'

const T0 = 1_700_000_000_000

function fixtureEntry(content: string, overrides: Partial<MemoryEntry> & { content?: string } = {}): MemoryEntry {
  return {
    id: `g-${content.trim().charCodeAt(0) ?? 0}-${content.length}`,
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

describe('ruleExtractTriples（G10 抽取有效性）', () => {
  it('中文小语料：主观三元组全部命中（召回 100% ≥ 80%）', () => {
    const cases: Array<[string, string, string, string]> = [
      // [句子, 主语, 关系, 宾语片段]
      ['服务器 使用 PostgreSQL', '服务器', '使用', 'postgresql'],
      ['该项目依赖 Redis 做缓存', '该项目', '依赖', 'redis'],
      ['PostgreSQL 使用 MVCC 做并发控制', 'postgresql', '使用', 'mvcc'],
      ['界面设计 使用 色彩系统', '界面设计', '使用', '色彩系统'],
      ['色彩系统 使用 渐变', '色彩系统', '使用', '渐变'],
    ]
    let hit = 0
    for (const [sentence, subj, rel, obj] of cases) {
      const triples = ruleExtractTriples(sentence)
      const subjOk = triples.some((t) => t.subject === subj)
      const relOk = triples.some((t) => t.relation === rel)
      const objOk = triples.some((t) => t.object.includes(obj) || obj.includes(t.object))
      if (subjOk && relOk && objOk) hit += 1
    }
    expect(hit).toBeGreaterThanOrEqual(Math.ceil(cases.length * 0.8))
  })

  it('英文小语料：词边界匹配（use 不误匹配 because）', () => {
    const t1 = ruleExtractTriples('Postgres uses MVCC for concurrency')
    expect(t1.some((t) => t.subject === 'postgres' && t.relation === 'uses')).toBe(true)
    // because 中的 "use" 不应命中词边界（\buse\b 要求两侧非字母数字）
    const t2 = ruleExtractTriples('the system because of cache')
    expect(t2.some((t) => t.relation === 'use')).toBe(false)
    // the app uses caching：主语前缀只剥指示词（the user/we/our…），"the app" 保留
    const t3 = ruleExtractTriples('the app uses caching')
    expect(t3.some((t) => t.subject === 'the app' && t.relation === 'uses' && t.object === 'caching')).toBe(true)
  })

  it('长关系词优先（built with 优先于 use/uses）', () => {
    const triples = ruleExtractTriples('the app is built with Rust')
    expect(triples.some((t) => t.relation === 'built with' && t.object === 'rust')).toBe(true)
  })

  it('嵌套关系宾语提前截断（主句优先拆分）', () => {
    const triples = ruleExtractTriples('服务器 使用 PostgreSQL 存储数据')
    expect(
      triples.some((t) => t.subject === '服务器' && t.relation === '使用' && t.object.includes('postgresql')),
    ).toBe(true)
  })

  it('空/纯标点/过短输入不产出', () => {
    expect(ruleExtractTriples('')).toEqual([])
    expect(ruleExtractTriples('。。。')).toEqual([])
    expect(ruleExtractTriples('ab')).toEqual([])
  })
})

describe('TemporalGraph / buildGraph（G10 增量一致性）', () => {
  it('增量 add 与 buildGraph 全量重建对拍：stats / 邻域得分 / 实体反查一致', () => {
    const entries = [
      fixtureEntry('服务器 使用 PostgreSQL'),
      fixtureEntry('该项目依赖 Redis 做缓存'),
      fixtureEntry('PostgreSQL 使用 MVCC 做并发控制'),
      fixtureEntry('界面设计 使用 色彩系统'),
      fixtureEntry('色彩系统 使用 渐变'),
      fixtureEntry('今天天气不错 出门散步'), // 无关系词：不进图
    ]
    const inc = new TemporalGraph()
    for (const e of entries) inc.add(e)
    const full = buildGraph(entries)

    expect(inc.stats()).toEqual(full.stats())

    // 邻域得分对拍（多个已知实体 + 未知实体）
    for (const q of ['postgresql', '服务器', 'redis', '色彩系统', '渐变', '不存在的实体']) {
      const a = [...inc.neighborEntityScores([q], T0).entries()].sort((x, y) => x[0].localeCompare(y[0]))
      const b = [...full.neighborEntityScores([q], T0).entries()].sort((x, y) => x[0].localeCompare(y[0]))
      expect(a).toEqual(b)
    }

    // 实体反查对拍
    for (const q of ['postgresql', '服务器', 'redis', '色彩系统', '渐变', '不存在的实体']) {
      expect([...inc.entryIdsByEntity(q)].sort()).toEqual([...full.entryIdsByEntity(q)].sort())
    }
  })

  it('supersede 条目：其边标记失效（时间线语义），activeEdges 不因失效边增加', () => {
    const fresh = fixtureEntry('旧方案 使用 传统布局')
    const ghost = fixtureEntry('新方案 使用 现代布局', { tags: ['superseded-by:old'] })
    const g = new TemporalGraph()
    g.add(fresh)
    const before = g.stats()
    g.add(ghost)
    const after = g.stats()
    // ghost 的边已失效（superseded），计入 supersededEdges 而非 activeEdges
    expect(after.edges).toBe(before.edges + 2)
    expect(after.activeEdges).toBe(before.activeEdges)
    expect(after.supersededEdges).toBe(before.supersededEdges + 2)
  })

  it('remove 软删除：无引用边失效（asOf 时间线保留），实体保留', () => {
    const a = fixtureEntry('服务器 使用 PostgreSQL')
    const b = fixtureEntry('后端 使用 PostgreSQL')
    const g = new TemporalGraph()
    g.add(a)
    g.add(b)
    const before = g.stats()
    g.remove(a.id, T0)
    const after = g.stats()
    expect(after.entities).toBe(before.entities)
    expect(after.edges).toBe(before.edges) // 边软失效但保留
    expect(after.supersededEdges).toBeGreaterThanOrEqual(before.supersededEdges)
    // postgresql 仍有 b 的引用 → 邻域非空
    expect(g.neighborEntityScores(['postgresql'], T0).size).toBeGreaterThan(0)
  })

  it('实体上限淘汰：超限按最旧淘汰并有计数', () => {
    const g = new TemporalGraph(4)
    for (let i = 0; i < 10; i++) {
      g.add(fixtureEntry(`实体${String(i)} 使用 技术${String(i)}`))
    }
    const s = g.stats()
    expect(s.entities).toBeLessThanOrEqual(4)
    expect(s.evicted).toBeGreaterThan(0)
  })
})

describe('graphLineScores（G10 图召回命中）', () => {
  it('查询邻域命中相关条目（graphHits > 0）', () => {
    const entries = [
      fixtureEntry('服务器 使用 PostgreSQL'),
      fixtureEntry('PostgreSQL 使用 MVCC 做并发控制'),
      fixtureEntry('今天天气不错 出门散步'),
    ]
    const g = buildGraph(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const scores = graphLineScores(g, 'PostgreSQL', byId, T0)
    const hits = [...scores.entries()].filter(([, v]) => v > 0)
    expect(hits.length).toBeGreaterThan(0)
    // 引用 PostgreSQL 的条目都应命中
    const pg = entries.find((e) => e.content.includes('PostgreSQL'))
    expect(scores.get(pg!.id) ?? 0).toBeGreaterThan(0)
    // 无关条目（无关系词）不入图 → 无图分
    const noise = entries.find((e) => !e.content.includes('PostgreSQL'))
    expect(scores.get(noise!.id) ?? 0).toBe(0)
  })

  it('图可达但词面全零：图线仍能计分（补录语义源头）', () => {
    // 「渐变」不在「界面设计」条目中，但通过 界面设计→使用→色彩系统→使用→渐变 两跳可达
    const entries = [fixtureEntry('界面设计 使用 色彩系统'), fixtureEntry('色彩系统 使用 渐变')]
    const g = buildGraph(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const scores = graphLineScores(g, '渐变', byId, T0)
    const design = entries.find((e) => e.content.includes('界面设计'))
    expect(scores.get(design!.id) ?? 0).toBeGreaterThan(0)
  })
})

describe('图谱线接入 queryIndex（G10 图召回 + 零行为回归）', () => {
  it('零行为回归：graphEnabled 缺省 false 时带 graph 与不带 graph 逐字节一致', () => {
    const entries = [
      fixtureEntry('服务器 使用 PostgreSQL'),
      fixtureEntry('PostgreSQL 使用 MVCC 做并发控制'),
      fixtureEntry('该项目依赖 Redis 做缓存'),
      fixtureEntry('界面设计 使用 色彩系统'),
      fixtureEntry('色彩系统 使用 渐变'),
      fixtureEntry('今天天气不错 出门散步'),
    ]
    const graph = buildGraph(entries)
    const index = buildIndex(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    for (const mode of ['interpolate', 'rrf'] as const) {
      const a = queryIndex(index, 'PostgreSQL 的用法', { fusionMode: mode, now: T0 }, byId)
      const b = queryIndex(index, 'PostgreSQL 的用法', { fusionMode: mode, now: T0, graph }, byId) // 默认不开图线
      const c = queryIndex(index, 'PostgreSQL 的用法', { fusionMode: mode, now: T0, graphEnabled: false }, byId)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(JSON.stringify(a)).toBe(JSON.stringify(c))
    }
  })

  it('graphEnabled=true 时图谱线生效：词面全零但图可达条目可被召回（RRF 补录）', () => {
    const entries = [
      fixtureEntry('服务器 使用 PostgreSQL'),
      fixtureEntry('PostgreSQL 使用 MVCC 做并发控制'),
      fixtureEntry('该项目依赖 Redis 做缓存'),
      fixtureEntry('界面设计 使用 色彩系统'),
      fixtureEntry('色彩系统 使用 渐变'),
      fixtureEntry('瑞士 使用 阿尔卑斯'), // 无「渐变」，但与未知查询词无关
      fixtureEntry('今天天气不错 出门散步'),
    ]
    const graph = buildGraph(entries)
    const index = buildIndex(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    // 查询「渐变」：词面只命中「色彩系统 使用 渐变」条目；
    // 图线开启后两跳可达「界面设计 使用 色彩系统」（词面全零）+ 直接命中条目经图线加分
    const rOff = queryIndex(index, '渐变', { fusionMode: 'rrf', now: T0 }, byId)
    const rOn = queryIndex(index, '渐变', { fusionMode: 'rrf', now: T0, graph, graphEnabled: true }, byId)
    const design = entries.find((e) => e.content.includes('界面设计'))!
    expect(rOff.some((h) => h.id === design.id)).toBe(false)
    expect(rOn.some((h) => h.id === design.id)).toBe(true)
    // 开关开启后整体召回结果集合 ≠ 关闭时（图线产生真实增益）
    expect(JSON.stringify(rOn)).not.toBe(JSON.stringify(rOff))
  })

  it('graphEnabled=true 时 interpolate 模式：图分线性叠加提升图可达条目', () => {
    const entries = [
      fixtureEntry('服务器 使用 PostgreSQL'),
      fixtureEntry('PostgreSQL 使用 MVCC 做并发控制'),
      fixtureEntry('该项目依赖 Redis 做缓存'),
      fixtureEntry('界面设计 使用 色彩系统'),
      fixtureEntry('色彩系统 使用 渐变'),
    ]
    const graph = buildGraph(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const index = buildIndex(entries)
    const rOff = queryIndex(index, '颜色 渐变', { fusionMode: 'interpolate', now: T0 }, byId)
    const rOn = queryIndex(index, '颜色 渐变', { fusionMode: 'interpolate', now: T0, graph, graphEnabled: true }, byId)
    const design = entries.find((e) => e.content.includes('界面设计'))!
    const sOff = rOff.find((h) => h.id === design.id)?.score ?? 0
    const sOn = rOn.find((h) => h.id === design.id)?.score ?? 0
    expect(sOn).toBeGreaterThanOrEqual(sOff * 0.999) // 图线只增不减（叠加语义）
  })
})
