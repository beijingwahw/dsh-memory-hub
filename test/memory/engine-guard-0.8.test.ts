/**
 * 引擎守卫分支专场（0.8.0 L9）：把 engine.ts 全部防御/守卫分支逐支路闭合。
 * 每个用例针对一处「未覆盖时可能误判」的边界：空签名、空查询、缺失索引字段、
 * 非法 kind、零窗口去重、TTL 关闭。全部为纯函数断言，可复算。
 */
import { describe, expect, it } from 'vitest'
import {
  MINHASH_K,
  SIGNIFICANCE_KIND,
  buildIndex,
  featureCoverage,
  isDuplicate,
  isExpired,
  minhashCoverage,
  minhashJaccard,
  minhashSignature,
  pruneExpired,
  queryIndex,
  significanceWeight,
  similarity,
} from '../../src/memory/engine'
import type { MemoryEntry, RecallOptions } from '../../src/memory/types'

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `g-${Math.random().toString(36).slice(2, 8)}`,
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

describe('minhashJaccard 守卫（L9）', () => {
  it('维度数不符即判 0（长度不等于 MINHASH_K）', () => {
    expect(minhashJaccard([1, 2, 3], [1, 2, 3])).toBe(0) // 双侧都短
    expect(minhashJaccard(new Array(MINHASH_K).fill(1), [1])).toBe(0) // 单侧不符
  })

  it('空特征维度（0xffffffff）不参与比较，不破坏有效维度计数', () => {
    const empty = minhashSignature([]) // 全 0xffffffff
    const real = minhashSignature(['苹果', '香蕉'])
    // 空侧维度被跳过，有效维度来自 real 侧自身 → 无交集
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
})

describe('featureCoverage / minhashCoverage 守卫（L9）', () => {
  it('查询特征集为空时覆盖率恒 0', () => {
    expect(featureCoverage(new Set(), new Set(['x']))).toBe(0)
  })

  it('minhashCoverage：querySig.size=0 即 0', () => {
    expect(minhashCoverage({ sig: minhashSignature(['a']), size: 0 }, { sig: minhashSignature(['a']), size: 1 })).toBe(
      0,
    )
  })

  it('minhashCoverage：签名维度不符即 0', () => {
    expect(minhashCoverage({ sig: [1], size: 1 }, { sig: minhashSignature(['a']), size: 1 })).toBe(0)
  })

  it('minhashCoverage：零交集返回 0；有交集时按覆盖率归一且不超 1', () => {
    const qs = minhashSignature(['苹果'])
    const ds = minhashSignature(['香蕉'])
    expect(minhashCoverage({ sig: qs, size: 1 }, { sig: ds, size: 1 })).toBe(0) // 无交集 → jac=0 → cov=0
    const qs2 = minhashSignature(['苹果', '香蕉'])
    const ds2 = minhashSignature(['苹果', '香蕉', '西瓜'])
    const cov = minhashCoverage({ sig: qs2, size: 2 }, { sig: ds2, size: 3 })
    expect(cov).toBeGreaterThan(0)
    expect(cov).toBeLessThanOrEqual(1)
  })
})

describe('similarity / levenshtein 空串守卫（L9）', () => {
  it('任一为空串即返回 0（不进入 DP）', () => {
    expect(similarity('较长的记忆内容', '')).toBe(0)
    expect(similarity('', '较长的记忆内容')).toBe(0)
  })

  it('超长文本走 token Jaccard 近似（>300 字符）', () => {
    const longA = '苹果 '.repeat(90) // 270 字符
    const longB = `${'苹果 '.repeat(45)}香蕉 `.repeat(3) // 共享词多但不完全相同
    const sim = similarity(longA, longB)
    expect(sim).toBeGreaterThan(0)
    expect(sim).toBeLessThan(1)
  })

  it('长度差悬殊的相似度低（编辑距离路径）', () => {
    expect(similarity('abcde', 'abc')).toBeLessThan(0.92)
  })
})

describe('queryIndex 内部容错（L9）', () => {
  const e1 = entry('苹果香蕉', { id: 'qid-1' })
  const idx = buildIndex([e1])
  const byId = new Map([[e1.id, e1]])

  it('查询词在语料中无文档频率（df=0 ID 平滑不除零）', () => {
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

  it('空查询（无可检索词）返回空数组，不按热度误召回全部', () => {
    expect(queryIndex(idx, '！？。。', {}, byId)).toHaveLength(0)
  })
})

describe('isDuplicate / isExpired / pruneExpired 守卫（L9）', () => {
  it('去重窗口 ≤0 时不做任何去重', () => {
    const e = entry('相同内容')
    expect(isDuplicate([e], '相同内容', 0)).toBe(false)
  })

  it('TTL ≤0 表示永不过期（单条/批量均早退）', () => {
    const old = entry('陈年记忆', { createdAt: 0, updatedAt: 0 })
    expect(isExpired(old, 0)).toBe(false)
    expect(pruneExpired([old], 0)).toHaveLength(0)
  })
})

describe('significanceWeight kind 查表（0.9.0 S）', () => {
  it('全部已知 kind 命中 Record 全键表，无运行时兜底分支', () => {
    // 0.9.0 S：删除 `?? 1` 死兜底——SIGNIFICANCE_KIND 为 Record<MemoryKind, number> 全键声明，
    // kind 收窄为 MemoryKind 联合时索引命中索引签名（类型为 number），非法 kind 由类型层编译期拦截
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
