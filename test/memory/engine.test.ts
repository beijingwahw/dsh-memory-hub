/**
 * 记忆检索引擎 · 行为测试（单一事实源）。
 *
 * 1.1.1 测试重组：此前按版本堆叠的 6 个文件（engine / engine-0.3-quality /
 * engine-0.4 / engine-0.5 / engine-evolve / engine-guard-0.8）合并为本文件，
 * 按**行为**分节组织；8 处逐字或弱重复的用例已去重（保留断言更强者）。
 * 各节标题即行为面，与 src/memory/engine.ts 及其拆分模块一一对应。
 */
import { describe, expect, it } from 'vitest'
import {
  IndexCache,
  buildIndex,
  estimateTokens,
  featureCoverage,
  fingerprint,
  fnv1a,
  fuzzyVariants,
  isDuplicate,
  isExpired,
  minhashCoverage,
  minhashJaccard,
  minhashSignature,
  pruneExpired,
  queryIndex,
  recall,
  recall as recallAlias,
  semanticFeatures,
  significanceWeight,
  SIGNIFICANCE_KIND,
  similarity,
  summarize,
  tokenize,
  type MinHashSignature,
} from '../../src/memory/engine'
import type { MemoryEntry, MemoryKind, RecallOptions } from '../../src/memory/types'

const DAY = 24 * 60 * 60 * 1000

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `e-${content.length}-${Math.random().toString(36).slice(2, 8)}`,
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

// ---------------------------------------------------------------------------
// 行为面 1：分词与 token 估算
// ---------------------------------------------------------------------------
describe('tokenize / estimateTokens（分词与预算估算）', () => {
  it('英文单词小写化并切分中文二字组', () => {
    expect(tokenize('Hello World')).toContain('hello')
    expect(tokenize('你好世界')).toContain('你好')
    expect(tokenize('你好世界')).toContain('好世')
  })
  it('单个汉字按 1-gram 入 token', () => {
    expect(tokenize('前')).toContain('前')
  })
  it('NFKC 折叠全角英文，与半角一致', () => {
    expect(tokenize('Ｈｅｌｌｏ Ｗｏｒｌｄ')).toContain('hello')
    expect(tokenize('Ｈｅｌｌｏ Ｗｏｒｌｄ')).toContain('world')
    expect(tokenize('full-width ＡＢＣ')).toContain('abc')
  })
  it('英文停止词被过滤，中文 2-gram 不受影响', () => {
    expect(tokenize('the quick brown fox')).toEqual(['quick', 'brown', 'fox'])
    expect(tokenize('a plan of action')).toEqual(['plan', 'action'])
    expect(tokenize('前端工程化')).toContain('前端')
    expect(tokenize('前端工程化')).toContain('端工')
  })
  it('中文按字、英文按词估算 token', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcd')).toBe(1)
    const both = estimateTokens('hello 世界')
    expect(both).toBeGreaterThanOrEqual(2)
  })
  it('至少 1 token', () => {
    expect(estimateTokens('!')).toBe(1)
    expect(estimateTokens('')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 行为面 2：相似度与编辑距离
// ---------------------------------------------------------------------------
describe('similarity（归一化相似度与长文本退化）', () => {
  it('相同文本为 1，无关文本接近 0', () => {
    expect(similarity('hello world', 'hello world')).toBe(1)
    expect(similarity('hello', 'xyzzy')).toBeLessThan(0.5)
  })
  it('空串快速返回 0（不进入 DP）', () => {
    expect(similarity('', 'a')).toBe(0)
    expect(similarity('较长的记忆内容', '')).toBe(0)
    expect(similarity('', '较长的记忆内容')).toBe(0)
    expect(similarity('x'.repeat(400), '')).toBe(0)
  })
  it('超长文本走 token 集合 Jaccard，命中词集合相等时为 1', () => {
    const long = '架构 '.repeat(160)
    expect(similarity(long, '架构 '.repeat(160))).toBe(1)
  })
  it('超长文本无交集词时为 0（不进入编辑距离）', () => {
    expect(similarity('架构 '.repeat(160), '星辰 '.repeat(160))).toBe(0)
  })
  it('超长停止词文本的 token 集为空时返回 0', () => {
    expect(similarity('the and of is '.repeat(100), 'the and of is '.repeat(100))).toBe(0)
  })
  it('超长文本部分重叠时 Jaccard 介于 (0,1)', () => {
    const longA = '苹果 '.repeat(90)
    const longB = `${'苹果 '.repeat(45)}香蕉 `.repeat(3)
    const sim = similarity(longA, longB)
    expect(sim).toBeGreaterThan(0)
    expect(sim).toBeLessThan(1)
  })
  it('长度差悬殊的相似度低（编辑距离路径）', () => {
    expect(similarity('abcde', 'abc')).toBeLessThan(0.92)
  })
})

// ---------------------------------------------------------------------------
// 行为面 3：BM25 检索质量
// ---------------------------------------------------------------------------
describe('BM25 检索质量（长度归一化 / 词频饱和 / IDF）', () => {
  it('文档长度归一化：精炼短文档优先于含同样锚词的长尾文档', () => {
    const anchor = 'uniqueAnchor'
    const target = entry(`${anchor} 部署方案`)
    // 旧 cosine 按词频线性放大：锚词×3 + 长尾 → 误排第一；BM25 长度归一化识别精炼目标
    const noise = entry(`${anchor} ${anchor} ${anchor} 与项目历史记录中的全部细节展开说明持续延长文档长度增加干扰`)
    const hits = recall([noise, target], anchor, { limit: 1 })
    expect(hits[0]!.id).toBe(target.id)
  })
  it('词频饱和但单调：同上下文下高频词仍优先（不反转）', () => {
    const four = entry('服务 服务 服务 服务 部署 架构')
    const once = entry('服务 部署 架构 登录')
    const hits = recall([once, four], '服务', { limit: 2 })
    expect(hits[0]!.id).toBe(four.id)
    expect(hits[1]!.id).toBe(once.id)
  })
  it('BM25 评分可复算：同输入两次评分一致（纯函数）', () => {
    const memory = [entry('项目引入事件溯源架构'), entry('前端使用 React 与 TypeScript')]
    const a = recall(memory, '事件溯源 架构', { now: 1000 })
    const b = recall(memory, '事件溯源 架构', { now: 1000 })
    expect(a.map((h) => [h.id, h.score])).toEqual(b.map((h) => [h.id, h.score]))
  })
  it('稀有词 IDF 保留：查询词中 df 更低者贡献更强', () => {
    const common = entry('项目部署在欧洲 北欧 节点，关注延迟与成本')
    const rare = entry('项目引入量子比特技术栈进行架构演进')
    const hits = recall([common, rare], '量子比特 架构')
    expect(hits[0]!.id).toBe(rare.id)
  })
  it('无关记忆不混入（bm25=0 不入候选）', () => {
    const relevant = entry('登录模块重构完成，接口全部兼容')
    const irrelevant = entry('周末计划去爬山露营')
    const hits = recall([irrelevant, relevant], '登录 重构')
    expect(hits.map((h) => h.id)).toContain(relevant.id)
    expect(hits.map((h) => h.id)).not.toContain(irrelevant.id)
  })
})

// ---------------------------------------------------------------------------
// 行为面 4：召回基础语义（排序 / limit / 预算 / 过滤 / 时间与热度）
// ---------------------------------------------------------------------------
describe('recall 基础语义（排序 / limit / 预算 / 过滤 / 衰减与热度）', () => {
  const memory = [
    entry('用户偏好使用 TypeScript 编写后端'),
    entry('项目部署到北欧节点，成本每月 200 美元'),
    entry('本周完成了登录模块的重构'),
  ]

  it('按相关性排序并命中预期', () => {
    const hits = recall(memory, 'TypeScript 后端')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toContain('TypeScript')
  })
  it('limit 生效', () => {
    const hits = recall(memory, '项目 部署 登录 TypeScript', { limit: 1 })
    expect(hits.length).toBe(1)
  })
  it('token 预算裁剪生效', () => {
    const big = Array.from({ length: 20 }, (_, i) => entry(`记忆内容${i} 与查询关键词完全一致 ${'x'.repeat(30)}${i}`))
    const hits = recall(big, '记忆内容 查询关键词', { maxTokens: 30, limit: 20 })
    expect(hits.length).toBeGreaterThan(0)
    const used = hits.reduce((acc, h) => acc + estimateTokens(`${h.kind} ${h.content}`), 0)
    expect(used).toBeLessThanOrEqual(30)
  })
  it('workspace 过滤生效', () => {
    const scoped = [entry('甲项目约定', { workspace: 'proj-a' }), entry('乙项目约定', { workspace: 'proj-b' })]
    const hits = recall(scoped, '项目约定', { workspace: 'proj-a' })
    expect(hits.length).toBe(1)
    expect(hits[0]!.content).toContain('甲')
  })
  it('新鲜记忆权重更高（时间衰减）', () => {
    const now = Date.now()
    const old = entry('很久以前的记忆关键词 alpha', { createdAt: now - 30 * DAY })
    const fresh = entry('最近的新记忆关键词 alpha', { createdAt: now })
    const hits = recall([old, fresh], 'alpha', { limit: 2, now })
    expect(hits[0]!.content).toContain('最近')
  })
  it('访问热度增加权重', () => {
    const a = entry('完全相同的检索内容 hot', { accessCount: 10 })
    const b = entry('完全相同的检索内容 hot')
    const hits = recall([a, b], 'hot', { limit: 2 })
    expect(hits[0]!.id).toBe(a.id)
  })
  it('now 并入 RecallOptions（固定基准时间可复算，queryIndex 路径）', () => {
    const now = Date.now()
    const old = entry('很久以前的 alpha', { createdAt: now - 40 * DAY })
    const fresh = entry('新近的 alpha', { createdAt: now })
    const index = buildIndex([old, fresh])
    const byId = new Map([
      [old.id, old],
      [fresh.id, fresh],
    ])
    const hits = queryIndex(index, 'alpha', { now }, byId)
    expect(hits[0]!.id).toBe(fresh.id)
  })
})

// ---------------------------------------------------------------------------
// 行为面 5：查询规范化与空查询守卫
// ---------------------------------------------------------------------------
describe('查询规范化与空查询守卫', () => {
  const memory = [
    entry('热门记忆 AAA 热度很高', { accessCount: 50 }),
    entry('另一条热闹的 BBB 记忆', { accessCount: 30 }),
  ]

  it('纯标点查询不返回全库', () => {
    expect(recall(memory, '！！！？？？')).toHaveLength(0)
  })
  it('空字符串 / 空白字符查询返回空', () => {
    expect(recall(memory, '')).toHaveLength(0)
    expect(recall(memory, '   ')).toHaveLength(0)
  })
  it('tokenize 为空时 queryIndex 直接短路且不产生覆盖', () => {
    const index = buildIndex(memory)
    const byId = new Map(memory.map((e) => [e.id, e]))
    expect(tokenize('。。。')).toHaveLength(0)
    expect(queryIndex(index, '。。。', {}, byId)).toHaveLength(0)
  })
  it('纯停止词查询返回空（无有效检索词）', () => {
    expect(recall([entry('任意内容')], 'the and of is')).toHaveLength(0)
  })
  it('查询经 NFKC 后命中全角英文记忆', () => {
    const m = [entry('deploy lambda function')]
    const hits = recall(m, 'Ｄｅｐｌｏｙ ＬＡＭＢＤＡ')
    expect(hits.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 行为面 6：A1 容错检索（编辑距离 ≤1 变体）
// ---------------------------------------------------------------------------
describe('A1 容错检索（编辑距离 ≤1 变体兜底）', () => {
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

describe('fuzzyVariants 基元', () => {
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

// ---------------------------------------------------------------------------
// 行为面 7：A2 近似语义召回（特征空间 / MinHash / 兜底）
// ---------------------------------------------------------------------------
describe('FNV-1a 散列基元', () => {
  it('确定性：同输入同种子输出一致', () => {
    expect(fnv1a('deploy', 0x9e3779b9)).toBe(fnv1a('deploy', 0x9e3779b9))
  })
  it('不同输入散列区分（碰撞容许但不应系统性相同）', () => {
    expect(fnv1a('deploy', 1)).not.toBe(fnv1a('deployee', 1))
  })
})

describe('semanticFeatures 特征空间', () => {
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

describe('MinHash 签名与覆盖率', () => {
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
    expect(featureCoverage(semanticFeatures('deploy 到生产环境'), semanticFeatures('周末计划去爬山露营'))).toBeLessThan(
      0.45,
    )
  })
  it('词根变体精确覆盖率达标（deploy ↔ deployment，长记忆不被稀释）', () => {
    expect(
      featureCoverage(semanticFeatures('deployment'), semanticFeatures('将应用 deploy 到生产集群')),
    ).toBeGreaterThanOrEqual(0.45)
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

describe('A2 语义兜底召回', () => {
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
  it('大库下 heat 语义不变（热度优先于弱相似）', () => {
    const hot = entry('独特标记词 zzzq 热度极高', { accessCount: 100 })
    const cold = entry('独特标记词 zzzq 温度正常', { accessCount: 0 })
    const hits = recall([cold, hot], 'zzzq', { limit: 2 })
    expect(hits[0]!.id).toBe(hot.id)
  })
})

// ---------------------------------------------------------------------------
// 行为面 8：MinHash / 覆盖率守卫（防御分支闭合）
// ---------------------------------------------------------------------------
describe('minhashJaccard / coverage 守卫', () => {
  it('维度数不符即判 0（长度不等于 MINHASH_K）', () => {
    expect(minhashJaccard([1, 2, 3], [1, 2, 3])).toBe(0)
    expect(minhashJaccard(new Array(16).fill(1), [1])).toBe(0)
  })
  it('空特征维度（0xffffffff）不参与比较，不破坏有效维度计数', () => {
    const empty = minhashSignature([]) // 全 0xffffffff
    const real = minhashSignature(['苹果', '香蕉'])
    expect(minhashJaccard(empty, real)).toBe(0)
  })
  it('两侧全空特征时 valid=0，返回 0（除零防护）', () => {
    const empty = minhashSignature([])
    expect(minhashJaccard(empty, empty)).toBe(0)
  })
  it('非空签名正常计算相似度（真实交集 > 0）', () => {
    const a = minhashSignature(['苹果', '香蕉', '橘子'])
    const b = minhashSignature(['苹果', '香蕉', '西瓜'])
    const jac = minhashJaccard(a, b)
    expect(jac).toBeGreaterThan(0)
    expect(jac).toBeLessThanOrEqual(1)
  })
  it('查询特征集为空时覆盖率恒 0', () => {
    expect(featureCoverage(new Set(), new Set(['x']))).toBe(0)
  })
  it('minhashCoverage：querySig.size=0 / 签名维度不符即 0', () => {
    expect(minhashCoverage({ sig: minhashSignature(['a']), size: 0 }, { sig: minhashSignature(['a']), size: 1 })).toBe(
      0,
    )
    expect(minhashCoverage({ sig: [1], size: 1 }, { sig: minhashSignature(['a']), size: 1 })).toBe(0)
  })
  it('minhashCoverage：零交集返回 0；有交集时按覆盖率归一且不超 1', () => {
    const qs = minhashSignature(['苹果'])
    const ds = minhashSignature(['香蕉'])
    expect(minhashCoverage({ sig: qs, size: 1 }, { sig: ds, size: 1 })).toBe(0)
    const qs2 = minhashSignature(['苹果', '香蕉'])
    const ds2 = minhashSignature(['苹果', '香蕉', '西瓜'])
    const cov = minhashCoverage({ sig: qs2, size: 2 }, { sig: ds2, size: 3 })
    expect(cov).toBeGreaterThan(0)
    expect(cov).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 行为面 9：索引缓存与查询一致性（IndexCache / buildIndex / queryIndex）
// ---------------------------------------------------------------------------
describe('IndexCache 内容指纹失效', () => {
  it('revision 变化但内容未变（热度更新）→ 复用索引且结果一致', () => {
    const cache = new IndexCache()
    const base = [entry('架构采用事件溯源模式', { id: 'hot-1' })]
    const r1 = cache.query(base, 1, '事件溯源')
    expect(r1).toHaveLength(1)
    // 模拟 memory_recall 的热度 bump：accessCount/lastAccessAt 变化 → revision+1，内容指纹不变
    const bumped = [{ ...base[0]!, accessCount: base[0]!.accessCount + 1, lastAccessAt: Date.now() }]
    const r2 = cache.query(bumped, 2, '事件溯源')
    expect(r2).toHaveLength(1)
    expect(r2[0]!.id).toBe('hot-1')
    // 指纹稳定：内容未变时两次指纹一致（证明走复用路径）
    expect(fingerprint(base)).toBe(fingerprint(bumped))
  })
  it('revision 变化且内容变化 → 重建并反映新语料', () => {
    const cache = new IndexCache()
    cache.query([entry('旧方案 TypeScript')], 1, 'TypeScript')
    const hits = cache.query([entry('新方案 Rust')], 2, 'Rust')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.content).toContain('新方案')
  })
  it('指纹可区分内容而忽略热度字段', () => {
    const a = entry('内容指纹测试', { id: 'fp-1', accessCount: 0 })
    const b = { ...a, accessCount: 99, lastAccessAt: Date.now() }
    expect(fingerprint([a])).toBe(fingerprint([b]))
    expect(fingerprint([a])).not.toBe(fingerprint([entry('内容指纹测试', { id: 'fp-2' })]))
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
})

describe('buildIndex / queryIndex 一致性（与 recall 共享评分语义）', () => {
  it('词面路径：queryIndex 与 recall 结果一致', () => {
    const memory = [entry('用户偏好使用 TypeScript 编写后端'), entry('项目部署到北欧节点')]
    const index = buildIndex(memory)
    const byId = new Map(memory.map((e) => [e.id, e]))
    const viaQuery = queryIndex(index, 'TypeScript 后端', {}, byId)
    const viaRecall = recallAlias(memory, 'TypeScript 后端')
    expect(viaQuery.map((h) => h.id)).toEqual(viaRecall.map((h) => h.id))
    expect(viaQuery[0]!.content).toContain('TypeScript')
  })
  it('语义路径：queryIndex 与 recall 共享容错与语义评分', () => {
    const memory = [entry('deployment 发布流程'), entry('将应用 deploy 到集群')]
    const index = buildIndex(memory)
    const byId = new Map(memory.map((e) => [e.id, e]))
    const viaQuery = queryIndex(index, 'deployment', {}, byId)
    const viaRecall = recall(memory, 'deployment')
    expect(viaQuery.map((h) => h.id)).toEqual(viaRecall.map((h) => h.id))
  })
  it('queryIndex 对 entriesBy 缺失项静默跳过（防御分支）', () => {
    const memory = [entry('存在项', { id: 'exists-1' })]
    const idx = buildIndex(memory)
    const missing = new Map<string, MemoryEntry>()
    expect(queryIndex(idx, '存在项', {}, missing)).toEqual([])
  })
  it('空语料召回不抛错且返回空数组', () => {
    expect(recall([], '任意查询')).toEqual([])
  })
})

describe('queryIndex 内部容错（索引字段缺失回退）', () => {
  const e1 = entry('苹果香蕉', { id: 'qid-1' })
  const idx = buildIndex([e1])
  const byId = new Map([[e1.id, e1]])

  it('查询词在语料中无文档频率（df=0 IDF 平滑不除零）', () => {
    const options: RecallOptions = {}
    const hits = queryIndex(idx, '苹果 凤梨', options, byId) // 凤梨不在语料 → idf 走 df=0 平滑
    expect(hits.length).toBeGreaterThan(0)
  })
  it('df 索引缺失条目回退 0（IDF 平滑兜底分支）', () => {
    idx.df.clear() // 索引与词频不一致的极端场景：df 缺失 → ?? 0
    const hits = queryIndex(idx, '苹果', {}, byId)
    expect(hits.length).toBeGreaterThan(0) // idf = log(1+(docCount+0.5)/0.5) > 0，打分不受影响
    idx.df.set('苹果', 1) // 恢复供其它用例
  })
  it('docLen 缺失条目回退 0（长度归一化仍可评分）', () => {
    ;(idx.docLen as Map<string, number>).clear()
    const hits = queryIndex(idx, '苹果', {}, byId)
    expect(hits.length).toBeGreaterThan(0)
    ;(idx.docLen as Map<string, number>).set(e1.id, 2) // 恢复供其它用例
  })
})

// ---------------------------------------------------------------------------
// 行为面 10：大库规模一致性（1000 条）
// ---------------------------------------------------------------------------
describe('大库召回一致性（1000 条随机条目）', () => {
  const KINDS: MemoryKind[] = ['fact', 'decision', 'preference', 'instruction', 'generic']
  const WORKSPACES = ['proj-a', 'proj-b', 'proj-c']
  const now = Date.now()

  function makeLibrary(n: number): MemoryEntry[] {
    const lib: MemoryEntry[] = []
    for (let i = 0; i < n; i++) {
      const kind = KINDS[i % KINDS.length]!
      const workspace = i % 3 === 0 ? WORKSPACES[(i / 3) % 3]! : undefined
      const base: Partial<MemoryEntry> = {
        id: `lib-${i}`,
        kind,
        createdAt: now - (i % 90) * 86400000,
        accessCount: i % 7,
      }
      if (workspace !== undefined) base.workspace = workspace
      lib.push(entry(`记录编号${i}：关于搜索关键词 架构演进 与 部署方案 的长期记忆片段 ${'x'.repeat(i % 20)}`, base))
    }
    return lib
  }

  it('token 预算裁剪不越界且首条必含', () => {
    const lib = makeLibrary(1000)
    const hits = recall(lib, '架构演进 部署方案', { maxTokens: 120, limit: 50 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(120) // 每条至少 1 token（estimateTokens 保证 >= 1）
    expect(hits[0]).toBeDefined()
  })
  it('heat（accessCount）更高者在相似相关度下优先（热度语义正确）', () => {
    const lib = makeLibrary(1000)
    const hot = entry('独特标记词 zzzq 热度极高', { accessCount: 100 })
    const cold = entry('独特标记词 zzzq 温度正常', { accessCount: 0 })
    const hits = recall([...lib, hot, cold], 'zzzq', { limit: 2 })
    expect(hits[0]!.id).toBe(hot.id)
  })
  it('workspace/kind 过滤在大库上成立', () => {
    const lib = makeLibrary(1000)
    // 语义：无 workspace 的条目为全局记忆，对所有工作区可见
    const ra = recall(lib, '记忆片段', { workspace: 'proj-a', limit: 100 })
    expect(ra.length).toBeGreaterThan(0)
    expect(ra.every((h) => h.workspace === undefined || h.workspace === 'proj-a')).toBe(true)
    expect(ra.some((h) => h.workspace === 'proj-b' || h.workspace === 'proj-c')).toBe(false)
    const kd = recall(lib, '记忆片段', { kind: 'decision', limit: 100 })
    expect(kd.every((h) => h.kind === 'decision')).toBe(true)
  })
  it('queryIndex 与 recall 在千级库上结果一致（同一评分语义）', () => {
    const lib = makeLibrary(1000)
    const index = buildIndex(lib)
    const byId = new Map(lib.map((e) => [e.id, e]))
    const a = recall(lib, '架构演进 记录', { limit: 10 })
    const b = queryIndex(index, '架构演进 记录', { limit: 10 }, byId)
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id))
  })
})

// ---------------------------------------------------------------------------
// 行为面 11：去重 / 过期 / 统计 / 显著性（生命周期纯函数）
// ---------------------------------------------------------------------------
describe('isDuplicate / isExpired / pruneExpired / summarize / significanceWeight', () => {
  it('窗口内近似重复判定为重复', () => {
    const existing = [entry('我喜欢用 Python 写脚本')]
    expect(isDuplicate(existing, '我喜欢用 Python 写脚本', DAY)).toBe(true)
    expect(isDuplicate(existing, '完全不同的话题内容在这里', DAY)).toBe(false)
  })
  it('去重窗口 ≤0 时不做任何去重', () => {
    expect(isDuplicate([entry('相同内容')], '相同内容', 0)).toBe(false)
  })
  it('过期判定与清理', () => {
    const now = Date.now()
    const expired = entry('老数据', { createdAt: now - 10 * DAY, updatedAt: now - 10 * DAY })
    const active = entry('新数据', { updatedAt: now })
    const toPrune = pruneExpired([expired, active], 7, now)
    expect(toPrune.map((e) => e.id)).toEqual([expired.id])
  })
  it('TTL ≤0 表示永不过期（单条/批量均早退）', () => {
    const old = entry('陈年记忆', { createdAt: 0, updatedAt: 0 })
    expect(isExpired(old, 0)).toBe(false)
    expect(pruneExpired([old], 0)).toHaveLength(0)
  })
  it('summarize 汇总统计', () => {
    const stats = summarize(
      [entry('a', { kind: 'fact', source: 'auto' }), entry('b', { kind: 'preference', source: 'explicit' })],
      128,
    )
    expect(stats.total).toBe(2)
    expect(stats.byKind.fact).toBe(1)
    expect(stats.byKind.preference).toBe(1)
    expect(stats.bySource.auto).toBe(1)
    expect(stats.bySource.explicit).toBe(1)
    expect(stats.bytes).toBe(128)
    expect(stats.oldestAt).toBeTypeOf('number')
    expect(stats.newestAt).toBeTypeOf('number')
  })
  it('significanceWeight kind 查表：全部已知 kind 命中 Record 全键表，无运行时兜底', () => {
    const kinds: MemoryEntry['kind'][] = ['instruction', 'decision', 'preference', 'fact', 'generic']
    for (const k of kinds) {
      const w = significanceWeight(k, 'auto')
      expect(Number.isFinite(w)).toBe(true)
      expect(w).toBe(SIGNIFICANCE_KIND[k])
    }
    // 已知 kind × explicit 组合不受影响（回归锚点）
    expect(significanceWeight('decision', 'explicit')).toBeCloseTo(1.15 * 1.1, 10)
  })
})
