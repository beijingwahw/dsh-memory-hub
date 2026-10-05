/**
 * 检索质量指标（0.5.0 A5）：纯函数、可复算。
 * - recall@k：前 k 条命中中包含相关记忆的比例（单目标场景 = 是否命中）；
 * - MRR：首个相关记忆排位的倒数均值；
 * - NDCG@k：相关度按位置对数折扣的 DCG 与理想 DCG 之比（相关记忆权重 1，无关 0）。
 */
import type { MemoryHit } from '../src/memory/types'

/** 前 k 条中是否命中任一相关记忆（单目标场景即 recall@1/3/5） */
export function recallAt(hits: MemoryHit[], relevantIds: ReadonlySet<string>, k: number): number {
  if (relevantIds.size === 0) return 1 // 无相关标注视为空真，指标无意义，返回 1 避免除零噪音
  const topK = hits.slice(0, k)
  return topK.some((h) => relevantIds.has(h.id)) ? 1 : 0
}

/** Reciprocal Rank：首个相关记忆排位倒数（无相关记忆返回 0） */
export function reciprocalRank(hits: MemoryHit[], relevantIds: ReadonlySet<string>): number {
  for (let i = 0; i < hits.length; i++) {
    if (relevantIds.has(hits[i]!.id)) return 1 / (i + 1)
  }
  return 0
}

/** DCG@k：相关度（0/1）× 对数位置折扣 */
export function dcgAt(hits: MemoryHit[], relevantIds: ReadonlySet<string>, k: number): number {
  let sum = 0
  for (let i = 0; i < Math.min(k, hits.length); i++) {
    if (relevantIds.has(hits[i]!.id)) sum += 1 / Math.log2(i + 2)
  }
  return sum
}

/** NDCG@k：DCG ÷ 理想 DCG（理想排序 = 所有相关记忆在前） */
export function ndcgAt(hits: MemoryHit[], relevantIds: ReadonlySet<string>, k: number): number {
  const relCount = relevantIds.size
  if (relCount === 0) return 1
  let ideal = 0
  for (let i = 0; i < Math.min(k, relCount); i++) ideal += 1 / Math.log2(i + 2)
  if (ideal === 0) return 1
  return dcgAt(hits, relevantIds, k) / ideal
}

/** 单查询完整指标集 */
export interface QueryMetrics {
  recall1: number
  recall3: number
  recall5: number
  mrr: number
  ndcg3: number
  ndcg5: number
}

/** 计算单查询在给定召回结果上的指标 */
export function queryMetrics(hits: MemoryHit[], relevantIds: ReadonlySet<string>): QueryMetrics {
  return {
    recall1: recallAt(hits, relevantIds, 1),
    recall3: recallAt(hits, relevantIds, 3),
    recall5: recallAt(hits, relevantIds, 5),
    mrr: reciprocalRank(hits, relevantIds),
    ndcg3: ndcgAt(hits, relevantIds, 3),
    ndcg5: ndcgAt(hits, relevantIds, 5),
  }
}

/** 多查询聚合（逐查询指标求均值） */
export interface AggregatedMetrics {
  recall1: number
  recall3: number
  recall5: number
  mrr: number
  ndcg3: number
  ndcg5: number
  /** 参与聚合的查询数 */
  n: number
}

export function aggregate(queryMetricsList: QueryMetrics[]): AggregatedMetrics {
  const n = queryMetricsList.length
  if (n === 0) return { recall1: 0, recall3: 0, recall5: 0, mrr: 0, ndcg3: 0, ndcg5: 0, n: 0 }
  const sum = (f: (m: QueryMetrics) => number): number => queryMetricsList.reduce((acc, m) => acc + f(m), 0) / n
  return {
    recall1: sum((m) => m.recall1),
    recall3: sum((m) => m.recall3),
    recall5: sum((m) => m.recall5),
    mrr: sum((m) => m.mrr),
    ndcg3: sum((m) => m.ndcg3),
    ndcg5: sum((m) => m.ndcg5),
    n,
  }
}
