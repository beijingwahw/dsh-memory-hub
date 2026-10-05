/**
 * 认知维护批处理入口（1.1.0，DESIGN-1.1 模块 E「A-D 的入口聚合与空闲调度」）。
 *
 * 职责（DESIGN A4/B2 语义）：
 * - 模块 A 蒸馏（distillMode='auto'）：对零散事实/偏好做主题簇蒸馏，产出 abstract /
 *   procedural 条目（id 确定性可复算；已存在则跳过——append-only 存储防行膨胀）；
 * - 模块 B 巩固（consolidationMode='auto'）：按遗忘曲线对到期高价值条目执行巩固复习，
 *   只更新访问历史字段（accessCount+1 / lastAccessAt=now），存储纯净可收敛；
 * - 模块 C 图谱同步：蒸馏新增条目进运行时图（graph?.add）。
 *
 * 全部能力默认关闭（config 缺省 off/false）；auto 模式由插件入口在「启动后空闲窗口」
 * 与「卸载栅栏」两处调用，不挂接 recall/status 热路径（G11 零行为回归）。
 * 纯管道：无 IO 之外的副作用，可独立单测。
 */
import { consolidate } from './consolidation'
import { distillBatch, distilledLayer } from './distill'
import type { TemporalGraph } from './graph'
import type { HubMetrics } from './metrics'
import type { MemoryStore } from './types'

/** 认知维护所需的最小配置视图（取自 MemoryHubConfig 的映射子集） */
export interface CognitiveMaintenanceConfig {
  /** 蒸馏开关（默认 off = 零行为变化） */
  distillMode: 'off' | 'auto'
  /** 蒸馏最小簇成员数（默认 3，低于该值的簇不产出） */
  distillMinCluster: number
  /** 巩固开关（默认 off = 零行为变化） */
  consolidationMode: 'off' | 'auto'
  /** 巩固可召回率阈值（默认 0.4；R(t) 低于该值且高价值 → 到期入巩固队列） */
  recallThreshold: number
  /** 蒸馏产物最大字符数（沿 maxEntryChars 语义） */
  maxEntryChars: number
}

/** 一次认知维护批处理的结果摘要（供调用方日志/可观测） */
export interface CognitiveMaintenanceResult {
  /** 新增蒸馏条目数（已存在的确定性 id 幂等跳过，不计入） */
  distilled: number
  /** 执行巩固复习的条目数（accessCount+1 / lastAccessAt=now） */
  consolidated: number
}

/**
 * 空闲认知维护批处理（A 蒸馏 + B 巩固 + C 图谱同步）。
 *
 * 幂等可重入：蒸馏产物 id 确定性（dist-<contentHash>），重复执行不重复写盘；
 * 巩固只更新访问历史字段，不改变 content/kind/tags/createdAt（DESIGN G11 存储纯净）。
 * 失败向上抛出（调用方按插件级容错处理：计入 metrics.errors + 告警，不阻断主链路）。
 */
export async function runCognitiveMaintenance(
  store: MemoryStore,
  cfg: CognitiveMaintenanceConfig,
  metrics: HubMetrics,
  graph?: TemporalGraph,
): Promise<CognitiveMaintenanceResult> {
  const result: CognitiveMaintenanceResult = { distilled: 0, consolidated: 0 }
  const entries = await store.list()
  const now = Date.now()

  // 模块 A：记忆层次蒸馏（默认 off，零行为变化）
  if (cfg.distillMode === 'auto') {
    const { distilled, skipped } = distillBatch(entries, {
      minCluster: cfg.distillMinCluster,
      maxChars: cfg.maxEntryChars,
      now,
    })
    metrics.distillSkips = (metrics.distillSkips ?? 0) + skipped.length
    if (distilled.length > 0) {
      // 幂等：确定性 id 已存在（上次维护已写入）则跳过，防 append-only 行膨胀
      const existingIds = new Set(entries.map((e) => e.id))
      const fresh = distilled.filter((d) => !existingIds.has(d.id))
      for (const d of fresh) {
        await store.upsert(d)
        if (graph) graph.add(d) // 模块 C：蒸馏产物同步进图谱
      }
      metrics.distilled = (metrics.distilled ?? 0) + fresh.length
      metrics.distilledAbstract =
        (metrics.distilledAbstract ?? 0) + fresh.filter((d) => distilledLayer(d) === 'abstract').length
      metrics.distilledProcedural =
        (metrics.distilledProcedural ?? 0) + fresh.filter((d) => distilledLayer(d) === 'procedural').length
      result.distilled = fresh.length
    }
  }

  // 模块 B：认知巩固（默认 off，零行为变化）
  if (cfg.consolidationMode === 'auto') {
    const { due, reinforced } = consolidate(entries, now, { recallThreshold: cfg.recallThreshold })
    metrics.consolidationDue = due.length
    if (reinforced.length > 0) {
      // 合并回写：与 heat flush 同一 coalesced 通道（upsertMany 单次落盘多行）
      if (typeof store.upsertMany === 'function') {
        await store.upsertMany(reinforced)
      } else {
        for (const r of reinforced) await store.upsert(r)
      }
      metrics.consolidated = (metrics.consolidated ?? 0) + reinforced.length
      result.consolidated = reinforced.length
      // 巩固只改访问历史（content/updatedAt 未变），图谱边无需同步
    }
  }

  return result
}
