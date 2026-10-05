import { describe, expect, it } from 'vitest'
import { IndexCache, buildIndex, fingerprint, queryIndex, recall, similarity, tokenize } from '../../src/memory/engine'
import type { MemoryEntry } from '../../src/memory/types'

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `c4-${content.length}-${Math.random().toString(36).slice(2, 8)}`,
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

describe('BM25 检索质量（0.4.0 世纪升级）', () => {
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

  it('稀有词 IDF 保留：查询词中 df 更低者贡献更强（阈值可调）', () => {
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

describe('查询规范化与停止词（0.4.0）', () => {
  it('tokenize 折叠全角英文（NFKC），与半角一致', () => {
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

  it('纯停止词查询返回空（无有效检索词）', () => {
    expect(recall([entry('任意内容')], 'the and of is')).toHaveLength(0)
  })

  it('查询经 NFKC 后命中全角英文记忆', () => {
    const m = [entry('deploy lambda function')]
    const hits = recall(m, 'Ｄｅｐｌｏｙ ＬＡＭＢＤＡ')
    expect(hits.length).toBeGreaterThan(0)
  })
})

describe('IndexCache 内容指纹失效（0.4.0）', () => {
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

  it('buildIndex/queryIndex 与 recall 共享同一 BM25 评分语义', () => {
    const memory = [entry('语义检索闭环测试内容'), entry('另一条无关记忆')]
    const index = buildIndex(memory)
    const byId = new Map(memory.map((e) => [e.id, e]))
    const viaQuery = queryIndex(index, '语义检索', {}, byId)
    const viaRecall = recall(memory, '语义检索')
    expect(viaQuery.map((h) => h.id)).toEqual(viaRecall.map((h) => h.id))
    expect(viaQuery[0]!.content).toContain('语义检索')
  })
})

describe('长文本相似度（0.4.0 覆盖 Jaccard 退化路径）', () => {
  it('超长文本走 token 集合 Jaccard，命中词集合相等时为 1', () => {
    const long = '架构 '.repeat(160)
    expect(similarity(long, '架构 '.repeat(160))).toBe(1)
  })

  it('超长文本无交集词时为 0（不进入编辑距离）', () => {
    const a = '架构 '.repeat(160)
    const b = '星辰 '.repeat(160)
    expect(similarity(a, b)).toBe(0)
  })

  it('空串快速返回 0（保留 0.3 语义）', () => {
    expect(similarity('', 'x'.repeat(400))).toBe(0)
    expect(similarity('x'.repeat(400), '')).toBe(0)
  })

  it('超长停止词文本的 token 集为空时返回 0', () => {
    expect(similarity('the and of is '.repeat(100), 'the and of is '.repeat(100))).toBe(0)
  })
})

describe('engine 分支边界（0.4.0 补齐）', () => {
  it('单个汉字按 1-gram 入token', () => {
    expect(tokenize('前')).toContain('前')
  })

  it('空语料召回不抛错且返回空数组', () => {
    expect(recall([], '任意查询')).toEqual([])
  })

  it('queryIndex 对 entriesBy 缺失项静默跳过（防御分支）', () => {
    const memory = [entry('存在项', { id: 'exists-1' })]
    const idx = buildIndex(memory)
    const missing = new Map<string, MemoryEntry>()
    expect(queryIndex(idx, '存在项', {}, missing)).toEqual([])
  })
})
