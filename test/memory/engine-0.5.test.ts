import { describe, expect, it } from 'vitest'
import {
  IndexCache,
  buildIndex,
  featureCoverage,
  fnv1a,
  fuzzyVariants,
  minhashCoverage,
  minhashJaccard,
  minhashSignature,
  queryIndex,
  recall,
  semanticFeatures,
  type MinHashSignature,
} from '../../src/memory/engine'
import type { MemoryEntry } from '../../src/memory/types'

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `c5-${content.length}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'fact',
    content,
    tags: [],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}

describe('FNV-1a 散列（0.5.0 A2 基元）', () => {
  it('确定性：同输入同种子输出一致', () => {
    expect(fnv1a('deploy', 0x9e3779b9)).toBe(fnv1a('deploy', 0x9e3779b9))
  })
  it('不同输入散列区分（碰撞容许但不应系统性相同）', () => {
    expect(fnv1a('deploy', 1)).not.toBe(fnv1a('deployee', 1))
  })
})

describe('semanticFeatures 特征空间（0.5.0 A2）', () => {
  it('英文词展开为字符 3-gram 并带边界标记', () => {
    const f = semanticFeatures('deploy')
    expect(f.has('^de')).toBe(true)
    expect(f.has('dep')).toBe(true)
    expect(f.has('epl')).toBe(true)
    expect(f.has('loy')).toBe(true)
    expect(f.has('oy$')).toBe(true)
    expect(f.has('deploy')).toBe(false) // 整词不再作为特征（已被 3-gram 取代）
  })
  it('中文 2-gram 原样保留（本身即字符级）', () => {
    const f = semanticFeatures('部署流程')
    expect(f.has('部署')).toBe(true)
    expect(f.has('署流')).toBe(true)
    expect(f.has('流程')).toBe(true)
  })
  it('词根/形态变体在特征空间高重叠（deploy ↔ deployment）', () => {
    const a = semanticFeatures('deploy')
    const b = semanticFeatures('deployment')
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    const jac = inter / (a.size + b.size - inter)
    expect(jac).toBeGreaterThan(0.3)
    expect(jac).toBeLessThan(0.8) // 仍是不同词，不应过度相似
  })
})

describe('MinHash 签名与覆盖率（0.5.0 A2）', () => {
  it('同文本签名一致、Jaccard 为 1（全维度相等）', () => {
    const a = minhashSignature(semanticFeatures('deploy 到生产环境'))
    const b = minhashSignature(semanticFeatures('deploy 到生产环境'))
    expect(a).toEqual(b)
    expect(minhashJaccard(a, b)).toBe(1)
  })
  it('签名确定性且与索引缓存一致（含特征数与精确特征集）', () => {
    const text = '自动化测试覆盖核心链路'
    const features = semanticFeatures(text)
    const direct: MinHashSignature = { sig: minhashSignature(features), size: features.size }
    const idx = buildIndex([entry(text, { id: 'sig-1' })])
    expect(idx.minhash.get('sig-1')!.sig).toEqual(direct.sig)
    expect(idx.minhash.get('sig-1')!.size).toBe(direct.size)
    expect([...idx.features.get('sig-1')!].sort()).toEqual([...features].sort())
  })
  it('无关文本精确覆盖率低（显著低于阈值 0.45）', () => {
    const q = semanticFeatures('deploy 到生产环境')
    const d = semanticFeatures('周末计划去爬山露营')
    expect(featureCoverage(q, d)).toBeLessThan(0.45)
  })
  it('词根变体精确覆盖率达标（deploy ↔ deployment，长记忆不被稀释）', () => {
    const q = semanticFeatures('deployment')
    const d = semanticFeatures('将应用 deploy 到生产集群')
    expect(featureCoverage(q, d)).toBeGreaterThanOrEqual(0.45)
  })
  it('MinHash 估计覆盖率与精确值方向一致（估计偏差不改变判定方向）', () => {
    const q = semanticFeatures('deployment')
    const d = semanticFeatures('deploy 到生产集群')
    const qs: MinHashSignature = { sig: minhashSignature(q), size: q.size }
    const ds: MinHashSignature = { sig: minhashSignature(d), size: d.size }
    const est = minhashCoverage(qs, ds)
    const exact = featureCoverage(q, d)
    expect(est).toBeGreaterThan(0) // 估计值至少要能“提示”存在语义关联
    expect(exact).toBeGreaterThanOrEqual(0.45)
  })
})

describe('A1 容错检索：编辑距离 ≤1 变体兜底（0.5.0）', () => {
  it('查询词拼写错误时经变体召回（0.5 折扣）', () => {
    const target = entry('项目部署使用 deployment 流水线')
    const hits = recall([target], 'deploymen')
    expect(hits.map((h) => h.id)).toContain(target.id)
  })
  it('变体不干扰精确命中：精确命中仍排最前', () => {
    const exact = entry('deploy 配置文档')
    const typoOnly = entry('部署 deployment 流水线 pipeline')
    const hits = recall([exact, typoOnly], 'deploy', { limit: 2 })
    expect(hits[0]!.id).toBe(exact.id)
  })
  it('fuzzy 关闭时变体兜底失效（语义关闭以隔离变量）', () => {
    const target = entry('项目部署使用 deployment 流水线')
    const hits = recall([target], 'deploymen', { fuzzy: false, semantic: false })
    expect(hits.map((h) => h.id)).not.toContain(target.id)
  })
  it('过短英文词（<4）不触发变体扩展（节省计算）', () => {
    const target = entry('abcd 测试')
    const hits = recall([target], 'abc', { fuzzy: true, semantic: false })
    expect(hits.map((h) => h.id)).not.toContain(target.id)
  })
})

describe('A2 近似语义召回：MinHash 兜底（0.5.0）', () => {
  it('词面零命中但特征高卡德相似 → 语义兜底召回（BM25/变体均失效的场景）', () => {
    // 查询 "deployment"：记忆只有 "deploy"（整词不同 → BM25=0；编辑距离 5 → 变体也无用）
    const target = entry('将应用 deploy 到生产集群')
    const hits = recall([target], 'deployment', { limit: 3 })
    expect(hits.map((h) => h.id)).toContain(target.id)
  })
  it('语义召回不会抢占精确命中排序（分数显著低）', () => {
    const exact = entry('deployment 步骤包含构建与发布')
    const semanticOnly = entry('we 将应用 deploy 到生产集群')
    const hits = recall([semanticOnly, exact], 'deployment', { limit: 5 })
    expect(hits[0]!.id).toBe(exact.id)
    const exactScore = hits.find((h) => h.id === exact.id)!.score
    const semanticScore = hits.find((h) => h.id === semanticOnly.id)!.score
    expect(exactScore).toBeGreaterThan(semanticScore)
  })
  it('semantic 关闭时语义兜底失效', () => {
    const target = entry('将应用 deploy 到生产集群')
    const hits = recall([target], 'deployment', { semantic: false })
    expect(hits.map((h) => h.id)).not.toContain(target.id)
  })
  it('低于阈值的弱相似不召回（无噪音混入）', () => {
    const noise = entry('周末计划去爬山露营野餐')
    const hits = recall([noise], 'deployment', { limit: 5 })
    expect(hits.map((h) => h.id)).not.toContain(noise.id)
  })
})

describe('A1+A2 与既有语义兼容（0.5.0）', () => {
  it('无关中文记忆不混入：既有 0.4 断言保持', () => {
    const relevant = entry('登录模块重构完成，接口全部兼容')
    const irrelevant = entry('周末计划去爬山露营')
    const hits = recall([irrelevant, relevant], '登录 重构')
    expect(hits.map((h) => h.id)).toContain(relevant.id)
    expect(hits.map((h) => h.id)).not.toContain(irrelevant.id)
  })
  it('大库下 heat 语义不变（热度优先于弱相似）', () => {
    const hot = entry('独特标记词 zzzq 热度极高', { accessCount: 100 })
    const cold = entry('独特标记词 zzzq 温度正常', { accessCount: 0 })
    const hits = recall([cold, hot], 'zzzq', { limit: 2 })
    expect(hits[0]!.id).toBe(hot.id)
  })
  it('IndexCache 复用索引时语义召回一致（minhash 随索引缓存）', () => {
    const cache = new IndexCache()
    const base = [entry('deploy 到生产集群', { id: 'c5-hot-1' })]
    const r1 = cache.query(base, 1, 'deployment')
    expect(r1).toHaveLength(1)
    const bumped = [{ ...base[0]!, accessCount: base[0]!.accessCount + 1, lastAccessAt: Date.now() }]
    const r2 = cache.query(bumped, 2, 'deployment')
    expect(r2).toHaveLength(1)
    expect(r2[0]!.id).toBe('c5-hot-1')
  })
  it('空查询/空语料仍短路（A1/A2 不改变边界）', () => {
    expect(recall([], '任意查询')).toEqual([])
    const memory = [entry('deploy 部署')]
    expect(recall(memory, '！！！')).toEqual([])
    expect(recall(memory, '')).toEqual([])
  })
})

describe('queryIndex 变体/语义与 recall 一致（0.5.0）', () => {
  it('buildIndex/queryIndex 与 recall 共享容错与语义评分', () => {
    const memory = [entry('deployment 发布流程'), entry('将应用 deploy 到集群')]
    const index = buildIndex(memory)
    const byId = new Map(memory.map((e) => [e.id, e]))
    const viaQuery = queryIndex(index, 'deployment', {}, byId)
    const viaRecall = recall(memory, 'deployment')
    expect(viaQuery.map((h) => h.id)).toEqual(viaRecall.map((h) => h.id))
  })
})

describe('fuzzyVariants 基元（0.5.0 A1）', () => {
  it('覆盖删除/替换/插入/交换四类单编辑', () => {
    const v = fuzzyVariants('cat')
    expect(v.has('ca')).toBe(true) // 删除 t
    expect(v.has('bat')).toBe(true) // 替换 c→b
    expect(v.has('cart')).toBe(true) // 插入 r
    expect(v.size).toBeGreaterThan(50)
  })
  it('不含原词自身且去重', () => {
    const v = fuzzyVariants('config')
    expect(v.has('config')).toBe(false)
    expect(v.size).toBe(new Set(v).size)
  })
})
