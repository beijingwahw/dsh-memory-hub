/**
 * 激活扩散推理线（1.2.0，DESIGN-1.2 模块 E）——第五召回线。
 *
 * 认知科学经典模型（Collins & Loftus 1975, spreading activation）的工程化落地：
 * 查询实体作为激活源，沿时序图谱的**活跃**出边扩散激活，逐跳衰减、逐边乘证据置信度，
 * 终结实体按「最优路径链强度」参与召回计分。与第四线（图谱邻域扩展，纯拓扑求和）的
 * 本质差异：推理线保留**路径**（A—使用→B—依赖→C 的证据链可解释回放），并对链上
 * 任一关系失效（asOf 时间线）敏感——时间正确性是推理的硬约束，不是评分点缀。
 *
 * 设计纪律（延续 DESIGN-1.1 硬约束）：
 * - 零第三方依赖、纯函数（now 注入可复算）、不写存储；
 * - 确定性：frontier/边/并列链全部按（分值降序，键字典序）排序，插入顺序无关；
 * - 有界性：每跳波束宽度 + 链数上限双护栏，hub 实体扇出不可引爆复杂度；
 * - 缺省关闭：引擎侧 inferEnabled !== true 时本模块零调用，行为与 1.1.1 逐字节一致。
 */
import { GRAPH_TAU_MS, normalizeEntityKey, queryEntities } from './graph'
import { tokenize } from './tokenize'
import type { GraphRecallSource, MemoryEntry } from './types'

/** 推理线默认最大跳数（1 = 直接关系；2 = 一跳中介推理；钳制上限 3） */
export const INFER_DEFAULT_MAX_HOPS = 2
/** 跳数硬上限（配置/参数超限一律收到 3——长链证据衰减到无意义，且成本按扇物增长） */
export const INFER_MAX_HOPS_LIMIT = 3
/** 每跳波束宽度（frontier 保留的最高激活数；对齐层种子上限 8 + 问句实体数，16 覆盖典型全量） */
export const INFER_BEAM = 16
/** 单次推理产出链数上限 */
export const INFER_MAX_CHAINS = 16
/** 每跳激活衰减（2 跳链 = 0.5² 证据折扣：推理越远，置信越低） */
export const INFER_HOP_DECAY = 0.5
/** 推理线融合权重（interpolate 模式；低于图谱线 0.35——推理证据天然弱于邻域直达） */
export const INFER_LINE_WEIGHT = 0.25

/** 推理链上的一条边（时序锚定，可回放） */
export interface InferEdge {
  from: string
  relation: string
  to: string
  confidence: number
  occurredAt: number
}

/** 一条推理链：种子经若干关系到达终结实体 */
export interface InferChain {
  /** 证据路径（hops 条边；path[0].from 为种子实体） */
  path: InferEdge[]
  /** 终结实体（= path[path.length - 1].to） */
  terminal: string
  /** 链强度 = ∏edge.confidence × INFER_HOP_DECAY^hops × exp(−最旧边年龄/τ)（保守新鲜度） */
  score: number
}

/** inferChains 选项（全部可选，均有确定性缺省） */
export interface InferChainOptions {
  now?: number
  maxHops?: number
  beam?: number
  maxChains?: number
  /** 边时效半衰期（默认与图谱线一致 90 天） */
  tauMs?: number
}

/** 整数钳制（波束/跳数/链数护栏的公共实现） */
function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.max(min, Math.min(max, n))
}

/** 链的确定性序键（并列分时按字典序保留更小者，消除遍历顺序依赖） */
function chainKey(path: readonly InferEdge[]): string {
  return path.map((e) => `${e.from}\u0000${e.relation}\u0000${e.to}`).join('\u0001')
}

/**
 * 激活扩散推理（纯函数、确定性、有界）。
 *
 * 语义：从种子实体沿活跃出边逐跳扩散；每个终结实体只保留**最高链强度**的路径
 * （最优路径语义，多路径不叠加——与图谱线的拓扑求和形成互补而非重复计分）；
 * 种子自身不可作为终结实体（「推理回出发点」无信息量）。
 * 链强度逐边乘 confidence、逐跳乘 INFER_HOP_DECAY，再乘以链上**最旧边**决定的
 * 保守时效因子（链的成立性受最旧证据约束，任一环节陈旧则整链降权）。
 */
export function inferChains(
  source: GraphRecallSource,
  seeds: readonly string[],
  opts: InferChainOptions = {},
): InferChain[] {
  if (typeof source.activeOutEdges !== 'function') return []
  const now = opts.now ?? Date.now()
  const maxHops = clampInt(opts.maxHops, 1, INFER_MAX_HOPS_LIMIT, INFER_DEFAULT_MAX_HOPS)
  const beam = clampInt(opts.beam, 1, 64, INFER_BEAM)
  const maxChains = clampInt(opts.maxChains, 1, 64, INFER_MAX_CHAINS)
  const tauMs = opts.tauMs ?? GRAPH_TAU_MS

  const seedSet = new Set(seeds.map(normalizeEntityKey).filter((s) => s.length > 0))
  if (seedSet.size === 0) return []

  interface Frontier {
    entity: string
    activation: number
    path: InferEdge[]
    /** 链上最旧边时间（保守新鲜度基准） */
    oldestAt: number
  }
  let frontier: Frontier[] = [...seedSet]
    .sort()
    .map((entity) => ({ entity, activation: 1, path: [], oldestAt: Infinity }))

  const best = new Map<string, InferChain>()
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    // 确定性：激活降序、实体字典序、路径序键兜底；波束截断只发生在排序之后
    frontier.sort(
      (a, b) =>
        b.activation - a.activation ||
        (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : chainKey(a.path) < chainKey(b.path) ? -1 : 1),
    )
    const active = frontier.slice(0, beam)
    const next: Frontier[] = []
    for (const node of active) {
      // activeOutEdges 已按 (target, relation) 字典序返回，且只含 now 时刻活跃的边
      for (const edge of source.activeOutEdges(node.entity, now)) {
        if (seedSet.has(edge.target)) continue
        const confidence = Math.min(1, Math.max(0, edge.confidence))
        const activation = node.activation * confidence * INFER_HOP_DECAY
        if (activation <= 0) continue
        const path: InferEdge[] = [
          ...node.path,
          { from: node.entity, relation: edge.relation, to: edge.target, confidence, occurredAt: edge.occurredAt },
        ]
        const oldestAt = Math.min(node.oldestAt, edge.occurredAt)
        const score = activation * Math.exp(-Math.max(0, now - oldestAt) / tauMs)
        const prev = best.get(edge.target)
        // 并列分按路径序键字典序保留较小者——最优路径选择与遍历顺序无关
        if (
          prev === undefined ||
          score > prev.score ||
          (score === prev.score && chainKey(path) < chainKey(prev.path))
        ) {
          best.set(edge.target, { path, terminal: edge.target, score })
        }
        next.push({ entity: edge.target, activation, path, oldestAt })
      }
    }
    frontier = next
  }
  return [...best.values()].sort((a, b) => b.score - a.score || (a.terminal < b.terminal ? -1 : 1)).slice(0, maxChains)
}

/**
 * 推理线召回评分（纯函数）：查询 → 种子（问句实体 + token 对齐层）→ 激活扩散链 →
 * 终结实体关联条目计分（链强度 × 条目 currentness）。种子识别与图谱线同源
 * （queryEntities + alignByTokens），保证两线对同一查询的实体理解一致。
 * 1.3.0（DESIGN-1.3 模块 H）：opts.chainsOut 提供时，本次产出的推理链（去重排序后、
 * 截断 maxChains 的最终集）原样收集进去——召回溯源 why.chains 的证据源（与
 * rrfFuseCandidates 的 ranksOut 同一收集模式，纯出参不改变评分路径）。
 */
export function inferLineScores(
  graph: GraphRecallSource,
  query: string,
  entriesById: ReadonlyMap<string, MemoryEntry>,
  now: number,
  opts: { maxHops?: number; tauMs?: number; beam?: number; maxChains?: number; chainsOut?: InferChain[] } = {},
): Map<string, number> {
  const entities = queryEntities(query)
  const aligned =
    typeof graph.alignByTokens === 'function' ? graph.alignByTokens(tokenize(query)) : ([] as readonly string[])
  const seeds = [...entities, ...aligned]
  const scores = new Map<string, number>()
  if (seeds.length === 0) {
    if (opts.chainsOut !== undefined) opts.chainsOut.length = 0
    return scores
  }
  const tauMs = opts.tauMs ?? GRAPH_TAU_MS
  const chains = inferChains(graph, seeds, { now, ...opts })
  if (opts.chainsOut !== undefined) {
    opts.chainsOut.length = 0
    for (const c of chains) opts.chainsOut.push(c)
  }
  for (const chain of chains) {
    for (const id of graph.entryIdsByEntity(chain.terminal)) {
      const entry = entriesById.get(id)
      if (!entry) continue
      const currentness = Math.exp(-Math.max(0, now - entry.updatedAt) / tauMs)
      scores.set(id, (scores.get(id) ?? 0) + chain.score * currentness)
    }
  }
  return scores
}
