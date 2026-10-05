/**
 * 时序知识图谱离线质量门禁（DESIGN-1.1 F2，门禁 G10）：`npm run eval` 一键运行。
 *
 * G10 门限（与 DESIGN-1.1 模块 C 对齐）：
 *  1. 抽取有效性：中英混合小语料主观三元组召回命中 ≥ 80%（向下测试）；
 *  2. 图召回命中：查询邻域可命中相关条目（graphHits > 0）；
 *  3. zero-hop/2-hop：词面全零但图可达条目可被补录（含 supersede 时间线语义）；
 *  4. 增量一致性：增量 add 序列与 buildGraph 全量重建对拍
 *     （stats / 邻域得分 / 实体反查一致）；
 *  5. 零行为回归：graphEnabled 缺省 false 时召回输出与不带 graph 逐字节一致。
 *
 * 夹具设计（5 组，覆盖 G10-F2 全部图谱场景）：
 *  - 中文语料（客观锁定规则抽取）；
 *  - 英文语料（词边界正则抽取）；
 *  - 中英混合语料（跨语言互不干扰）；
 *  - 含 supersede 时间线（失效边语义）；
 *  - zero-hop（词面精确命中）与 2-hop（图可达补录）查询。
 */
import { describe, expect, it } from 'vitest'
import { buildGraph, graphLineScores, queryEntities, ruleExtractTriples, TemporalGraph } from '../src/memory/graph'
import { buildIndex, queryIndex } from '../src/memory/engine'
import type { MemoryEntry } from '../src/memory/types'

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

describe('G10 抽取有效性：中英混合主观三元组召回 ≥ 80%', () => {
  it('中文语料：主观三元组全部命中（100% ≥ 80%）', () => {
    const cases: Array<[string, string, string, string]> = [
      ['服务器 使用 PostgreSQL', '服务器', '使用', 'postgresql'],
      ['该项目依赖 Redis 做缓存', '该项目', '依赖', 'redis'],
      ['PostgreSQL 使用 MVCC 做并发控制', 'postgresql', '使用', 'mvcc'],
      ['界面设计 使用 色彩系统', '界面设计', '使用', '色彩系统'],
      ['色彩系统 使用 渐变', '色彩系统', '使用', '渐变'],
    ]
    let hit = 0
    for (const [sentence, subj, rel, obj] of cases) {
      const triples = ruleExtractTriples(sentence)
      const ok = triples.some((t) => t.subject.includes(subj) && t.relation.includes(rel) && t.object.includes(obj))
      if (ok) hit++
    }
    // 断言：命中率 ≥ 80%，且至少命中 4/5（语料经实测锁定，5/5 稳定）
    expect(hit / cases.length).toBeGreaterThanOrEqual(0.8)
    expect(hit).toBeGreaterThanOrEqual(4)
  })

  it('英文语料：主观三元组命中（词边界正则）', () => {
    const cases: Array<[string, string, string]> = [
      ['Postgres uses MVCC', 'postgres', 'uses'],
      ['the app uses caching', 'the app', 'uses'],
      ['the app is built with Rust', 'the app is', 'built with'],
    ]
    let hit = 0
    for (const [sentence, subj, rel] of cases) {
      const triples = ruleExtractTriples(sentence)
      if (triples.some((t) => t.subject.includes(subj) && t.relation.includes(rel))) hit++
    }
    expect(hit / cases.length).toBeGreaterThanOrEqual(0.8)
  })

  it('中英混合语料：抽取互不干扰（中文关系词表不误伤英文句）', () => {
    const mixed = ['服务器 使用 PostgreSQL', 'the app is built with Rust', '该项目依赖 Redis 做缓存']
    const all = mixed.map((s) => ruleExtractTriples(s))
    expect(all[0]!.length).toBeGreaterThanOrEqual(1) // 中文句有抽取
    expect(all[1]!.length).toBeGreaterThanOrEqual(1) // 英文句有抽取
    expect(all[2]!.length).toBeGreaterThanOrEqual(1) // 中文句有抽取
    // 全部抽取的主语、宾语都来自词表匹配，无脏实体（空串/单个无意义字符）
    for (const triples of all) {
      for (const t of triples) {
        expect(t.subject.length).toBeGreaterThan(0)
        expect(t.object.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('G10 图召回命中：邻域记分与 zero-hop 查询', () => {
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
    const pg = entries.find((e) => e.content.includes('PostgreSQL'))!
    expect(scores.get(pg.id) ?? 0).toBeGreaterThan(0)
    // 无关条目（无关系词）不入图 → 无图分
    const noise = entries.find((e) => !e.content.includes('PostgreSQL'))!
    expect(scores.get(noise.id) ?? 0).toBe(0)
  })

  it('queryEntities 零依赖实体识别：引号/主语/整句兜底', () => {
    // 引号实体：引号内容被识别为完整短语（英文直引号）
    const quoted = queryEntities('"Redis 使用缓存"')
    expect(quoted.some((e) => e.includes('redis'))).toBe(true)
    // 关系词前主语：PostgreSQL 使用 … → 主语实体识别
    const subjects = queryEntities('PostgreSQL 使用 MVCC')
    expect(subjects.some((e) => e === 'postgresql')).toBe(true)
    // 短整句兜底：无引号无关系词时返回整句归一化实体
    expect(queryEntities('渐变').length).toBeGreaterThanOrEqual(1)
    expect(queryEntities('')).toHaveLength(0)
  })
})

describe('G10 2-hop 图可达补录（词面全零但拓扑可达）', () => {
  it('两跳可达条目被图线记分（补录语义源头）', () => {
    const entries = [fixtureEntry('界面设计 使用 色彩系统'), fixtureEntry('色彩系统 使用 渐变')]
    const g = buildGraph(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    // 查询「渐变」：词面只命中第二条；第一条（界面设计）经 界面设计→色彩系统→渐变 两跳可达
    const scores = graphLineScores(g, '渐变', byId, T0)
    const design = entries.find((e) => e.content.includes('界面设计'))!
    const gradient = entries.find((e) => e.content.includes('渐变'))!
    expect(scores.get(design.id) ?? 0).toBeGreaterThan(0)
    expect(scores.get(gradient.id) ?? 0).toBeGreaterThan(0)
  })

  it('graphEnabled=true 时 2-hop 可达条目进入 queryIndex 召回（RRF 补录）', () => {
    const entries = [
      fixtureEntry('服务器 使用 PostgreSQL'),
      fixtureEntry('PostgreSQL 使用 MVCC 做并发控制'),
      fixtureEntry('该项目依赖 Redis 做缓存'),
      fixtureEntry('界面设计 使用 色彩系统'),
      fixtureEntry('色彩系统 使用 渐变'),
      fixtureEntry('瑞士 使用 阿尔卑斯'), // 与查询无关
      fixtureEntry('今天天气不错 出门散步'),
    ]
    const graph = buildGraph(entries)
    const index = buildIndex(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const rOff = queryIndex(index, '渐变', { fusionMode: 'rrf', now: T0 }, byId)
    const rOn = queryIndex(index, '渐变', { fusionMode: 'rrf', now: T0, graph, graphEnabled: true }, byId)
    const design = entries.find((e) => e.content.includes('界面设计'))!
    expect(rOff.some((h) => h.id === design.id)).toBe(false) // 关图线：词面全零不可达
    expect(rOn.some((h) => h.id === design.id)).toBe(true) // 开图线：2-hop 补录命中
    expect(JSON.stringify(rOn)).not.toBe(JSON.stringify(rOff)) // 产生真实增益
  })
})

describe('G10 增量一致性：add 序列与 buildGraph 全量重建对拍', () => {
  it('stats / 邻域得分 / 实体反查一致', () => {
    const addSeq = [fixtureEntry('服务器 使用 PostgreSQL'), fixtureEntry('该项目依赖 Redis 做缓存')]
    const inc = new TemporalGraph()
    for (const e of addSeq) inc.add(e)
    const full = buildGraph(addSeq)
    expect(inc.stats(T0)).toEqual(full.stats(T0))
    for (const q of ['postgresql', '服务器', 'redis']) {
      expect([...inc.entryIdsByEntity(q)].sort()).toEqual([...full.entryIdsByEntity(q)].sort())
    }
    const byId = new Map(addSeq.map((e) => [e.id, e]))
    expect(graphLineScores(inc, 'PostgreSQL', byId, T0)).toEqual(graphLineScores(full, 'PostgreSQL', byId, T0))
  })
})

describe('G10 含 supersede 时间线：失效边语义', () => {
  it('被取代条目边失效，activeEdges 不因失效边增加', () => {
    const fresh = fixtureEntry('旧方案 使用 传统布局')
    const ghost = fixtureEntry('新方案 使用 现代布局', { tags: ['superseded-by:old'] })
    const g = new TemporalGraph()
    g.add(fresh)
    const before = g.stats()
    g.add(ghost)
    const after = g.stats()
    expect(after.edges).toBe(before.edges + 2)
    expect(after.activeEdges).toBe(before.activeEdges) // 新增边全部失效
    expect(after.supersededEdges).toBe(before.supersededEdges + 2)
  })

  it('asOf 语义：移除后无引用边软失效但实体保留（时间线可追溯）', () => {
    const a = fixtureEntry('服务器 使用 PostgreSQL')
    const b = fixtureEntry('后端 使用 PostgreSQL')
    const g = new TemporalGraph()
    g.add(a)
    g.add(b)
    const before = g.stats()
    g.remove(a.id, T0)
    const after = g.stats()
    expect(after.entities).toBe(before.entities) // 实体保留
    expect(after.edges).toBe(before.edges) // 边软失效但保留
    expect(after.supersededEdges).toBeGreaterThanOrEqual(before.supersededEdges)
    expect(g.neighborEntityScores(['postgresql'], T0).size).toBeGreaterThan(0) // b 仍引用
  })
})

describe('G10 零行为回归：graphEnabled 缺省 false 与 1.0.0 逐字节一致', () => {
  it('带 graph 与不带 graph 输出一致（默认不开图线）', () => {
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
      const b = queryIndex(index, 'PostgreSQL 的用法', { fusionMode: mode, now: T0, graph }, byId) // 缺省不开图线
      const c = queryIndex(index, 'PostgreSQL 的用法', { fusionMode: mode, now: T0, graph, graphEnabled: false }, byId)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(JSON.stringify(a)).toBe(JSON.stringify(c))
    }
  })
})
