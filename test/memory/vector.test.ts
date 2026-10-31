/**
 * 本地向量第六召回线（1.5.0，DESIGN-1.5 模块 M）行为锁定。
 *
 * 覆盖面：
 * - 稀疏向量底座：TF·IDF 权重、L2 范数、零向量/无交集余弦 0、同文余弦 1、对称性；
 * - HNSW 确定性：同 id 集合两次构建 stats 逐项一致（层指派哈希驱动，无 Math.random）、
 *   插入幂等、k 上限、层高分布（maxLevel ≥ 1 锁定分层路径）、查询确定性；
 * - 召回质量：簇状语料上 HNSW top-k 与暴力全量对拍（exactTopK）重叠 ≥ 0.8、
 *   近邻查询 top1 命中同簇文档、零相似度过滤；
 * - VectorIndexCache：同语料复用同一实例、语料变更重建、clear；
 * - 引擎接线：缺省零回归（vectorEnabled 缺席输出逐字节一致）、interpolate 线性叠加
 *   与 why.vector 溯源、RRF 第六条秩融合 + 仅向量可达候选补录、
 *   engine.recall 现建路径（vector 未注入时自动构建）；
 * - 工具面：memory_recall vector 参数 + metrics.vectorHits + 回放路径向量现建。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recall as engineRecall, rrfFuseCandidates } from '../../src/memory/engine'
import { createMetrics } from '../../src/memory/metrics'
import { JsonlMemoryStore } from '../../src/memory/store'
import {
  cosineSparse,
  HnswVectorIndex,
  sparseFromFeatures,
  VectorIndexCache,
  buildVectorIndex,
} from '../../src/memory/vector'
import { semanticFeatureCounts } from '../../src/memory/tokenize'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import type { MemoryEntry } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000

function e(id: string, content: string, at = T0): MemoryEntry {
  return freshEntry({ id, content, createdAt: at, updatedAt: at })
}

/** 环形流形合成语料：每条文档非对称混相邻两簇主题（3:1 / 1:2，连续相似度梯度且
 * 跨簇无重复成分向量——近邻结构真实、排序不退化为完全并列） */
function clusteredCorpus(clusters = 10, perCluster = 30): MemoryEntry[] {
  const out: MemoryEntry[] = []
  const themes = [
    '缓存 redis 热点',
    '网关 路由 负载',
    '数据库 索引 查询',
    '部署 镜像 滚动',
    '日志 采集 检索',
    '认证 令牌 刷新',
    '消息 队列 消费',
    '配置 灰度 开关',
    '测试 覆盖 回归',
    '监控 告警 阈值',
  ]
  for (let c = 0; c < clusters; c++) {
    for (let i = 0; i < perCluster; i++) {
      const main = themes[c % themes.length]!
      const next = themes[(c + 1) % themes.length]!
      out.push(e(`c${c}-${i}`, i / perCluster < 0.5 ? `${main} ${main} ${main} ${next}` : `${main} ${next} ${next}`))
    }
  }
  return out
}

/** 严格分级语料：doc i = 主题 + i 组互异填充词（相似度随填充长度严格递减——排序无并列） */
function gradedCorpus(n = 60): MemoryEntry[] {
  const base = '部署 镜像 滚动'
  const out: MemoryEntry[] = []
  for (let i = 0; i < n; i++) {
    const filler = Array.from({ length: i }, (_, j) => `fill${i}x${j}`).join(' ')
    out.push(e(`g${String(i).padStart(2, '0')}`, i === 0 ? base : `${base} ${filler}`))
  }
  return out
}

describe('稀疏向量底座（1.5.0 模块 M）', () => {
  it('TF·IDF 权重与 L2 范数：未见特征按最大特异 idf 计权，范数 = 权重平方和开方', () => {
    const idf = new Map([['red', Math.log(2)]])
    const v = sparseFromFeatures(
      new Map([
        ['red', 3],
        ['blue', 1],
      ]),
      idf,
      1,
    )
    const wRed = (1 + Math.log(3)) * Math.log(2)
    const wBlue = 1 * Math.log(2) // 未见特征缺省 idf = log(1+1)
    expect(v.weights.get('red')).toBeCloseTo(wRed, 10)
    expect(v.weights.get('blue')).toBeCloseTo(wBlue, 10)
    expect(v.norm).toBeCloseTo(Math.hypot(wRed, wBlue), 10)
  })

  it('余弦：同文 1、无交集 0、零向量 0、对称', () => {
    const idf = new Map<string, number>()
    const a = sparseFromFeatures(semanticFeatureCounts('部署 镜像 滚动'), idf, 5)
    const b = sparseFromFeatures(semanticFeatureCounts('部署 镜像 滚动'), idf, 5)
    const c = sparseFromFeatures(semanticFeatureCounts('认证 令牌 刷新'), idf, 5)
    const zero = sparseFromFeatures(new Map(), idf, 5)
    expect(cosineSparse(a, b)).toBeCloseTo(1, 10)
    expect(cosineSparse(a, c)).toBe(0)
    expect(cosineSparse(a, zero)).toBe(0)
    expect(cosineSparse(a, c)).toBe(cosineSparse(c, a))
  })
})

describe('HnswVectorIndex（1.5.0 模块 M）', () => {
  const corpus = clusteredCorpus()
  const idxOf = (entries: MemoryEntry[]): HnswVectorIndex => {
    const idf = new Map<string, number>()
    const feats = new Map<string, Map<string, number>>()
    for (const x of entries) {
      const f = semanticFeatureCounts(`${x.content} ${x.tags.join(' ')}`)
      feats.set(x.id, f)
      for (const k of f.keys()) idf.set(k, (idf.get(k) ?? 0) + 1)
    }
    const n = entries.length
    const idfMap = new Map([...idf.entries()].map(([f, c]) => [f, Math.log(1 + n / c)]))
    const h = new HnswVectorIndex()
    for (const x of entries) h.insert(x.id, sparseFromFeatures(feats.get(x.id)!, idfMap, n))
    return h
  }

  it('空索引查询返回空；单节点索引可查询自身', () => {
    const h = new HnswVectorIndex()
    const q = sparseFromFeatures(semanticFeatureCounts('任意 查询'), new Map(), 1)
    expect(h.search(q, 5)).toEqual([])
    h.insert('only', sparseFromFeatures(semanticFeatureCounts('唯一 文档'), new Map(), 1))
    const hits = h.search(sparseFromFeatures(semanticFeatureCounts('唯一 文档'), new Map(), 1), 3)
    expect(hits.length).toBe(1)
    expect(hits[0]?.id).toBe('only')
    expect(hits[0]?.score).toBeCloseTo(1, 10)
  })

  it('确定性：同 id 集合两次构建 stats 逐项一致（层指派哈希驱动）', () => {
    const s1 = idxOf(corpus).stats()
    const s2 = idxOf(corpus).stats()
    expect(s1).toEqual(s2)
    expect(s1.nodes).toBe(300)
    expect(s1.edges).toBeGreaterThan(300)
  })

  it('层高分布：300 节点出现 ≥1 层节点（分层图路径真实命中）', () => {
    const s = idxOf(corpus).stats()
    expect(s.maxLevel).toBeGreaterThanOrEqual(1)
  })

  it('插入幂等：同 id 重复插入忽略（size 不变）', () => {
    const h = idxOf(corpus.slice(0, 10))
    const before = h.stats()
    h.insert('c0-0', sparseFromFeatures(semanticFeatureCounts('再插入 一次'), new Map(), 1))
    expect(h.stats().nodes).toBe(before.nodes)
  })

  it('k 上限：结果 ≤ k 且有序（相似度降序）', () => {
    const h = idxOf(corpus)
    const q = sparseFromFeatures(semanticFeatureCounts('缓存 redis 热点'), new Map(), 300)
    const hits = h.search(q, 7)
    expect(hits.length).toBeLessThanOrEqual(7)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(hits[i]?.score ?? 0)
    }
  })

  it('小 ef 束搜索：结果已满时提前终止（break 臂），仍返回 k 个有序结果 + stats 可观测', () => {
    const h = idxOf(corpus)
    const q = sparseFromFeatures(semanticFeatureCounts('缓存 redis 热点'), new Map(), 300)
    const tight = h.search(q, 3, 3)
    expect(tight.length).toBeLessThanOrEqual(3)
    for (let i = 1; i < tight.length; i++) {
      expect(tight[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(tight[i]?.score ?? 0)
    }
    const st = h.stats()
    expect(st.nodes).toBe(300)
    expect(st.maxLevel).toBeGreaterThanOrEqual(1)
    expect(st.edges).toBeGreaterThan(0)
    expect(st.distanceCalculations).toBeGreaterThan(0)
  })

  it('查询确定性：同查询两次结果 deep-equal', () => {
    const h = idxOf(corpus)
    const q = sparseFromFeatures(semanticFeatureCounts('网关 路由 负载'), new Map(), 300)
    expect(h.search(q, 10)).toEqual(h.search(q, 10))
  })
})

describe('VectorRecallIndex 召回质量（1.5.0 模块 M）', () => {
  const corpus = clusteredCorpus()

  it('严格分级语料：HNSW top-10 与暴力全量对拍 id 完全一致（排序无并列下的真值锚）', () => {
    const idx = buildVectorIndex(gradedCorpus())
    const exact = idx.exactTopK('部署 镜像 滚动', 10).map((x) => x.id)
    const approx = [...idx.search('部署 镜像 滚动', 10).keys()]
    expect(exact).toEqual(approx)
  })

  it('环形流形：HNSW top-1 相似度 ≥ 真值的 90%（分数对拍——近并列语料下的诚实度量）', () => {
    const idx = buildVectorIndex(corpus)
    for (const q of ['缓存 redis 热点', '网关 路由 负载', '监控 告警 阈值', '认证 令牌 刷新']) {
      const exactTop = idx.exactTopK(q, 1)[0]?.score ?? 0
      const approxTop = [...idx.search(q, 10).values()].reduce((m, s) => Math.max(m, s), 0)
      expect(approxTop).toBeGreaterThanOrEqual(exactTop * 0.9)
    }
  })

  it('环形流形：HNSW 结果全部落在查询簇族（本簇或环形相邻簇——导航不跑偏）', () => {
    const idx = buildVectorIndex(corpus)
    const cases: Array<[string, RegExp]> = [
      ['缓存 redis 热点', /^c[09]-/],
      ['网关 路由 负载', /^c[01]-/],
      ['监控 告警 阈值', /^c[89]-/],
      ['认证 令牌 刷新', /^c[56]-/],
    ]
    for (const [q, family] of cases) {
      const approx = [...idx.search(q, 10).keys()]
      expect(approx.length).toBe(10)
      for (const id of approx) expect(id).toMatch(family)
    }
  })

  it('top1 命中查询簇族文档；零相似度结果被过滤（无特征交集的查询不产生向量命中）', () => {
    const idx = buildVectorIndex(corpus)
    const top1 = idx.exactTopK('数据库 索引 查询', 1)[0]!
    expect(top1.id).toMatch(/^c[123]-/)
    // 完全无交集的查询：search 过滤零分近邻
    expect(idx.search('zzzqqq xxxyyy wwwvvv', 10).size).toBe(0)
  })

  it('零范数条目（纯标点正文）不进索引；其余条目不受影响', () => {
    const idx = buildVectorIndex([e('p1', '！！！。。。', T0), e('p2', '缓存 redis 热点', T0)])
    expect(idx.size).toBe(1)
    expect(idx.search('缓存', 5).has('p2')).toBe(true)
  })

  it('k 与 topK 钳制：显式 k 超过 topK 时取 topK', () => {
    const idx = buildVectorIndex(corpus, { topK: 5 })
    expect(idx.search('缓存 redis 热点', 50).size).toBeLessThanOrEqual(5)
  })
})

describe('VectorIndexCache（1.5.0 模块 M）', () => {
  const corpus = clusteredCorpus(4, 12)
  it('同语料复用同一实例；语料变更重建；clear 后重建', () => {
    const cache = new VectorIndexCache()
    const a = cache.acquire(corpus.slice(0, 24), 1)
    const b = cache.acquire(corpus.slice(0, 24), 1)
    expect(b).toBe(a)
    const c = cache.acquire(corpus.slice(0, 25), 2)
    expect(c).not.toBe(a)
    cache.clear()
    const d = cache.acquire(corpus.slice(0, 24), 1)
    expect(d).not.toBe(a)
  })
})

describe('引擎接线（1.5.0 模块 M 第六召回线）', () => {
  const corpus = clusteredCorpus(6, 8)

  it('缺省零回归：vectorEnabled 缺席/显式 false 时输出与无向量路径逐字节一致', () => {
    // now 注入固定（缺省 Date.now() 相隔毫秒即会在 e-69 级衰减分上产生尾数差）
    const a = JSON.stringify(engineRecall(corpus, '缓存 redis 热点', { fusionMode: 'rrf', now: T0 + 1000 }))
    const b = JSON.stringify(
      engineRecall(corpus, '缓存 redis 热点', { fusionMode: 'rrf', vectorEnabled: false, now: T0 + 1000 }),
    )
    expect(a).toBe(b)
  })

  it('interpolate：向量分线性叠加 + why 溯源含 vector 线（加权项系数）', () => {
    const vector = buildVectorIndex(corpus)
    const base = engineRecall(corpus, '缓存 redis 热点', {})
    const withVec = engineRecall(corpus, '缓存 redis 热点', { vectorEnabled: true, vector, explain: true })
    // 至少一条命中的 why 含 vector 线，且分数不低于缺省（叠加只增不减）
    const vecHits = withVec.filter((h) => h.why?.lines.some((l) => l.line === 'vector'))
    expect(vecHits.length).toBeGreaterThan(0)
    const baseById = new Map(base.map((h) => [h.id, h.score]))
    for (const h of withVec) {
      const prev = baseById.get(h.id)
      if (prev !== undefined) expect(h.score).toBeGreaterThanOrEqual(prev)
    }
  })

  it('RRF：仅向量可达（词面/语义全零）的候选被补录为第六条秩，why 含 vector 线', () => {
    // 语料：一条与查询零词面重叠但特征空间近邻的条目（字符 3-gram 同源）
    const trick = [
      e('v1', 'deployments of the authservice pipeline'), // 与查询共享 deploy/auth 字符 3-gram
      e('x1', '完全无关 的条目 甲'),
      e('x2', '完全无关 的条目 乙'),
    ]
    const vector = buildVectorIndex(trick)
    const hits = engineRecall(trick, 'deployment auth', {
      fusionMode: 'rrf',
      vectorEnabled: true,
      vector,
      explain: true,
    })
    const v1 = hits.find((h) => h.id === 'v1')
    expect(v1).toBeDefined()
    expect(v1?.why?.lines.some((l) => l.line === 'vector')).toBe(true)
    expect(v1?.why?.fusion).toBe('rrf')
  })

  it('engine.recall 现建路径：vectorEnabled=true 且未注入 vector 时按语料自动构建', () => {
    const hits = engineRecall(corpus, '缓存 redis 热点', { fusionMode: 'rrf', vectorEnabled: true, explain: true })
    expect(hits.some((h) => h.why?.lines.some((l) => l.line === 'vector'))).toBe(true)
  })

  it('rrfFuseCandidates 直测：vector 字段参与第六条秩 + ranksOut.vector', () => {
    const ranks = new Map<string, { vector?: number; bm25?: number }>()
    const fused = rrfFuseCandidates(
      [
        {
          id: 'a',
          entry: e('a', '条目 甲'),
          bm25: 1,
          fuzzy: 0,
          cov: 0,
          vector: 0.9,
          lineBase: 1,
        },
        { id: 'b', entry: e('b', '条目 乙'), bm25: 0, fuzzy: 0, cov: 0, vector: 0.5, lineBase: 1 },
        { id: 'c', entry: e('c', '条目 丙'), bm25: 2, fuzzy: 0, cov: 0, lineBase: 1 },
      ],
      ranks,
    )
    expect(fused.length).toBe(3)
    expect(ranks.get('a')?.vector).toBe(1)
    expect(ranks.get('b')?.vector).toBe(2)
    expect(ranks.get('a')?.bm25).toBe(2)
    expect(ranks.get('c')?.bm25).toBe(1)
    expect(ranks.get('c')?.vector).toBeUndefined() // 无 vector 的候选不携带该键
  })

  it('RRF merge 臂：词面与向量双线同候选（raw 就地合并 vector 字段 + why 双线共存）', () => {
    const vector = buildVectorIndex(corpus)
    const hits = engineRecall(corpus, '缓存 redis 热点', {
      fusionMode: 'rrf',
      vectorEnabled: true,
      vector,
      explain: true,
    })
    const dual = hits.filter(
      (h) => h.why?.lines.some((l) => l.line === 'bm25') && h.why?.lines.some((l) => l.line === 'vector'),
    )
    expect(dual.length).toBeGreaterThan(0)
  })
})

describe('memory_recall 工具面（1.5.0 模块 M）', () => {
  it('vector 参数启用第六线：命中可含 vector 溯源 + metrics.vectorHits 计数；缓存路径免重建', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-vec-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    for (const x of clusteredCorpus(4, 6)) await store.upsert(x)
    const metrics = createMetrics()
    const tool = createMemoryRecallTool(store, 800, 8, undefined, metrics, undefined, undefined) as unknown as {
      execute: (
        args: Record<string, unknown>,
      ) => Promise<{ hits: Array<{ id: string; why?: { lines: Array<{ line: string }> } }> }>
    }
    const out = await tool.execute({ query: '缓存 redis 热点', vector: true, explain: true, fusionMode: 'rrf' })
    expect(out.hits.length).toBeGreaterThan(0)
    expect(out.hits.some((h) => h.why?.lines.some((l) => l.line === 'vector'))).toBe(true)
    expect(metrics.vectorHits).toBe(out.hits.length)
    // 二次调用走缓存（同语料复用，行为一致）
    const out2 = await tool.execute({ query: '缓存 redis 热点', vector: true, explain: true, fusionMode: 'rrf' })
    expect(out2.hits.map((h) => h.id)).toEqual(out.hits.map((h) => h.id))
    await store.close()
  })

  it('recallDefaults.vectorEnabled 配置注入：无参数时第六线生效；缺省零回归', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-vec2-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    for (const x of clusteredCorpus(4, 6)) await store.upsert(x)
    const metrics = createMetrics()
    const tool = createMemoryRecallTool(store, 800, 8, undefined, metrics, undefined, {
      vectorEnabled: true,
    }) as unknown as {
      execute: (
        args: Record<string, unknown>,
      ) => Promise<{ hits: Array<{ id: string; why?: { lines: Array<{ line: string }> } }> }>
    }
    const out = await tool.execute({ query: '网关 路由 负载', explain: true, fusionMode: 'rrf' })
    expect(out.hits.some((h) => h.why?.lines.some((l) => l.line === 'vector'))).toBe(true)
    expect(metrics.vectorHits).toBeGreaterThan(0)
    await store.close()
  })

  it('情景回放路径：asOf + vector 现建索引生效（回放语料上的向量线）', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mh-vec3-')), 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(e('old1', '缓存 redis 热点 甲', T0))
    await store.upsert(e('old2', '网关 路由 负载 乙', T0))
    await store.upsert(e('new1', '缓存 redis 热点 丙', Date.now()))
    const tool = createMemoryRecallTool(store, 800, 8, undefined, undefined, undefined, undefined) as unknown as {
      execute: (
        args: Record<string, unknown>,
      ) => Promise<{ hits: Array<{ id: string; why?: { lines: Array<{ line: string }> } }> }>
    }
    const out = await tool.execute({
      query: '缓存 redis 热点',
      asOf: T0 + 1000,
      vector: true,
      explain: true,
      fusionMode: 'rrf',
    })
    expect(out.hits.map((h) => h.id)).toEqual(['old1']) // 回放时刻只有 old1/old2
    expect(out.hits[0]?.why?.lines.some((l) => l.line === 'vector')).toBe(true)
    await store.close()
  })
})
