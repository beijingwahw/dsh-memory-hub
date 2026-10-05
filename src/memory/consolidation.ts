/**
 * 认知巩固与遗忘曲线（1.1.0，DESIGN-1.1 模块 B）。
 *
 * 把 1.0.0 的单调热度/衰减升级为**自适应记忆强度（memory strength）+ Ebbinghaus
 * 遗忘曲线**驱动的间隔巩固（间隔重复 SRS 语义）：
 * - 记忆强度 strength：由访问历史（accessCount）重算——首建 1.0，前 3 次成功访问
 *   各 +0.5，之后增益减半渐变饱和（越熟的记忆遗忘越慢）；
 * - 遗忘曲线：预测可召回率 R(t) = strength × e^(−Δt / τ(strength))，
 *   τ(strength) = τ₀ × strength（强度越高遗忘越慢）；
 * - 巩固判定：R(t) < recallThreshold 且高价值（significance ≥ 阈值）→ 到期入巩固队列；
 * - 巩固动作：模拟一次成功召回（accessCount+1、lastAccessAt=now），τ 增大 → 下次
 *   巩固间隔拉长（间隔重复收敛特征）。
 *
 * 设计纪律（对应 DESIGN-1.1 硬约束）：
 * - 巩固**不改变 content/kind/tags/createdAt**，只更新访问历史字段（存储纯净）；
 * - 全部纯函数、零 IO、零外部依赖、可复算（now 注入）；
 * - 本模块不挂接任何入口——由 config.consolidationMode（默认 off）在入口层决定是否调用，
 *   缺省零行为变化；metrics 计数由调用方（工具/入口层）负责。
 *
 * DESIGN-1.1 模块 B 验收门限（G11）：
 * - 收敛性：模拟时间轴 100 步，巩固后 R(t) 不落入 <0.2（对照不巩固则跌落）；
 * - 间隔拉伸：连续巩固 5 次后单次巩固间隔 ≥ 首次巩固间隔 × 1.5；
 * - 零行为回归：consolidationMode 缺省 off 时无任何调用路径 → 输出逐字节不变；
 * - 存储纯净：全程不新增 MemoryEntry 字段、不改变 content。
 */
import { significanceWeight } from './engine'
import type { MemoryEntry } from './types'

/** 基础遗忘时间常数 τ₀（与 1.0.0 DECAY_HALF_LIFE_MS 同数量级：7 天） */
export const DEFAULT_TAU0_MS = 7 * 24 * 60 * 60 * 1000
/** 初始记忆强度 S0 */
export const DEFAULT_BASE_STRENGTH = 1.0
/** 强度上限（对数饱和，防止高频访问无限增值） */
export const DEFAULT_MAX_STRENGTH = 4.0
/** 每次成功访问的强度增益基准 */
export const DEFAULT_GAIN = 0.5
/** 增益半衰步长：每 saturateAfter 次访问，增益减半 */
export const DEFAULT_SATURATE_AFTER = 3
/** 到期巩固的可召回率阈值 */
export const DEFAULT_RECALL_THRESHOLD = 0.4
/** 高价值门槛：significanceWeight(kind, source) ≥ 该值才值得巩固（自动事实 1.0 不被复习，显式事实 1.1 复习） */
export const DEFAULT_SIGNIFICANCE_THRESHOLD = 1.05

/** 强度模型参数（全部有默认值，可注入复算） */
export interface StrengthParams {
  /** 初始强度（默认 1.0） */
  baseStrength?: number
  /** 强度上限（默认 4.0） */
  maxStrength?: number
  /** 单次访问增益基准（默认 0.5） */
  gain?: number
  /** 增益减半步长（默认 3：前 3 次访问每 +0.5，之后每 3 次减半） */
  saturateAfter?: number
  /** 基础遗忘时间常数 τ₀ ms（默认 7 天） */
  tau0Ms?: number
}

/** 巩固调度配置（在 StrengthParams 之上叠加到期/价值门槛） */
export interface ConsolidationOptions extends StrengthParams {
  /** 到期巩固阈值（默认 0.4） */
  recallThreshold?: number
  /** 高价值门槛（默认 1.0，复用 significanceWeight） */
  significanceThreshold?: number
}

/** 单条记忆的巩固评估视图（可观测/测试） */
export interface RetrievabilityView {
  id: string
  kind: MemoryEntry['kind']
  /** 当前记忆强度（派生，不落盘） */
  strength: number
  /** 预测可召回率 R(t) ∈ [0, strength] */
  r: number
  /** 是否到期需巩固（R< 阈值 且 高价值） */
  due: boolean
  /** 价值分（significanceWeight） */
  significance: number
}

/** 巩固批处理结果 */
export interface ConsolidationResult {
  /** 到期应巩固的条目（未修改的原始引用） */
  due: MemoryEntry[]
  /** 执行巩固后的新条目（accessCount+1、lastAccessAt=now；未修改入参对象） */
  reinforced: MemoryEntry[]
  /** 全量评估视图（每次调用重新计算，可复算） */
  views: RetrievabilityView[]
}

/** 第 i 次成功访问的强度增益：增益按阶段减半（1,1,1 → 2,2,2 → 3,3,3 → …） */
function accessGain(i: number, gain: number, saturateAfter: number): number {
  const stage = Math.ceil(i / saturateAfter)
  return gain * Math.pow(0.5, stage - 1)
}

/**
 * 记忆强度（纯函数，可复算）：由访问计数派生。
 * strength = min(base + Σ gain(i), max)；前 saturateAfter 次访问增益最大，之后渐减饱和。
 * 不依赖任何运行时字段之外的数据；与 heatScore（热度）独立——热度管「最近活跃度」，
 * 强度管「长期熟练度」，二者语义正交（DESIGN-1.1 模块 B1）。
 */
export function memoryStrength(entry: MemoryEntry, params: StrengthParams = {}): number {
  const base = params.baseStrength ?? DEFAULT_BASE_STRENGTH
  const max = params.maxStrength ?? DEFAULT_MAX_STRENGTH
  const gain = params.gain ?? DEFAULT_GAIN
  const saturateAfter = params.saturateAfter ?? DEFAULT_SATURATE_AFTER
  let s = base
  for (let i = 1; i <= entry.accessCount; i++) s += accessGain(i, gain, saturateAfter)
  return Math.min(s, max)
}

/** 遗忘时间常数：τ(strength) = τ₀ × strength（强度越高遗忘越慢） */
function tauOf(strength: number, tau0Ms: number): number {
  return tau0Ms * strength
}

/**
 * 预测可召回率（纯函数，可复算）：R(t) = strength × e^(−Δt / τ(strength))。
 * Δt = now − 最近一次「可回忆时间点」（lastAccessAt 优先，缺失回退 updatedAt/createdAt）。
 * 语义：刚强化后 R=strength（>1 视为 100% 可召回），随时间指数遗忘；
 * strength 越高 τ 越大 → 衰减越慢（间隔重复的「越熟越不易忘」）。
 */
export function retrievability(entry: MemoryEntry, now: number, params: StrengthParams = {}): number {
  const strength = memoryStrength(entry, params)
  const tau0Ms = params.tau0Ms ?? DEFAULT_TAU0_MS
  const lastSeen = Math.max(entry.lastAccessAt ?? 0, entry.updatedAt, entry.createdAt)
  const delta = Math.max(0, now - lastSeen)
  return strength * Math.exp(-delta / tauOf(strength, tau0Ms))
}

/** 是否到期巩固：R(t) < 阈值 且 高价值（非高价值记忆不复习，容许自然遗忘） */
export function isConsolidationDue(entry: MemoryEntry, now: number, opts: ConsolidationOptions = {}): boolean {
  const threshold = opts.recallThreshold ?? DEFAULT_RECALL_THRESHOLD
  const sigThreshold = opts.significanceThreshold ?? DEFAULT_SIGNIFICANCE_THRESHOLD
  if (significanceWeight(entry.kind, entry.source) < sigThreshold) return false
  return retrievability(entry, now, opts) < threshold
}

/** 执行一次巩固（纯函数，返回新条目）：模拟成功召回——accessCount+1、lastAccessAt=now；其余字段原样复制不打散 */
export function reinforce(entry: MemoryEntry, now: number): MemoryEntry {
  return {
    ...entry,
    accessCount: entry.accessCount + 1,
    lastAccessAt: now,
  }
}

/**
 * 巩固批处理（空闲批处理入口；consolidationMode='auto' 时调用方执行）：
 * 扫描全量条目 → 评估 R(t)/强度/到期 → 对到期高价值条目生成巩固副本。
 * 不修改入参（纯函数）；调用方按自身合并回写策略落盘（如 heat flush 通道）。
 */
export function consolidate(
  entries: readonly MemoryEntry[],
  now: number,
  opts: ConsolidationOptions = {},
): ConsolidationResult {
  const views: RetrievabilityView[] = []
  const due: MemoryEntry[] = []
  for (const e of entries) {
    const significance = significanceWeight(e.kind, e.source)
    const strength = memoryStrength(e, opts)
    const r = retrievability(e, now, opts)
    const isDue = isConsolidationDue(e, now, opts)
    views.push({ id: e.id, kind: e.kind, strength, r, due: isDue, significance })
    if (isDue) due.push(e)
  }
  return { due, reinforced: due.map((e) => reinforce(e, now)), views }
}

/** 巩固状态摘要（status 可观测用；absent 字段不输出） */
export interface ConsolidationSummary {
  /** 到期应巩固条目数 */
  dueCount: number
  /** 全量条目数 */
  total: number
  /** 记忆强度均值（近 3 位小数） */
  strengthAvg: number
  /** 记忆强度中位数 */
  strengthMedian: number
  /** 当前全部条目的最低预测可召回率 */
  minR: number
}

/** 汇总巩固视图：均值/中位数/最低 R（纯函数，可复算） */
export function summarizeConsolidation(
  entries: readonly MemoryEntry[],
  now: number,
  opts: ConsolidationOptions = {},
): ConsolidationSummary {
  const strengths: number[] = []
  let minR = Number.POSITIVE_INFINITY
  let dueCount = 0
  for (const e of entries) {
    const s = memoryStrength(e, opts)
    strengths.push(s)
    const r = retrievability(e, now, opts)
    if (r < minR) minR = r
    if (isConsolidationDue(e, now, opts)) dueCount++
  }
  strengths.sort((a, b) => a - b)
  const total = strengths.length
  const avg = total > 0 ? strengths.reduce((a, b) => a + b, 0) / total : 0
  const median = total > 0 ? strengths[Math.floor((total - 1) / 2)]! : 0
  return {
    dueCount,
    total,
    strengthAvg: Number(avg.toFixed(3)),
    strengthMedian: Number(median.toFixed(3)),
    minR: Number((total > 0 ? minR : 0).toFixed(3)),
  }
}
