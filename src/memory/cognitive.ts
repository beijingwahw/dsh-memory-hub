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
import { consolidate, reinforce } from './consolidation'
import { distillBatch, distilledLayer, distilledTheme, isDistilled } from './distill'
import { SUPERSEDED_BY_TAG_PREFIX } from './entry-factory'
import type { TemporalGraph } from './graph'
import type { HubMetrics } from './metrics'
import type { MemoryEntry, MemoryStore } from './types'

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
      // 1.1.1 代际治理索引：既有蒸馏条目按 distilled-theme 归组。蒸馏 content 内嵌
      // 簇成员数，簇成员增长 → content/hash/id 变化 → 产生新一代条目；上一代若不
      // 治理将永久残留，且其内容是高频 bigram，在 BM25 上极易命中、持续挤占
      // limit=8 的召回名额（代际膨胀：开启蒸馏反而负收益的根因）。
      const existingByTheme = new Map<string, MemoryEntry[]>()
      for (const e of entries) {
        if (!isDistilled(e)) continue
        const theme = distilledTheme(e)
        if (theme === undefined) continue
        const list = existingByTheme.get(theme)
        if (list) list.push(e)
        else existingByTheme.set(theme, [e])
      }
      const fresh = distilled.filter((d) => !existingIds.has(d.id))
      for (const d of fresh) {
        await store.upsert(d)
        if (graph) graph.add(d) // 模块 C：蒸馏产物同步进图谱
        // 代际治理：同主题上一代补 superseded-by 标记（召回降权 0.5 + 与新一代
        // 同现时被取代对去重剔除），新一代成为唯一有效抽象层
        const theme = distilledTheme(d)
        for (const prev of (theme !== undefined ? existingByTheme.get(theme) : undefined) ?? []) {
          const marker = `${SUPERSEDED_BY_TAG_PREFIX}${d.id}`
          if (prev.tags.includes(marker)) continue
          const updated: MemoryEntry = { ...prev, tags: [...prev.tags, marker], updatedAt: now }
          await store.upsert(updated)
        }
      }
      metrics.distilled = (metrics.distilled ?? 0) + fresh.length
      metrics.distilledAbstract =
        (metrics.distilledAbstract ?? 0) + fresh.filter((d) => distilledLayer(d) === 'abstract').length
      metrics.distilledProcedural =
        (metrics.distilledProcedural ?? 0) + fresh.filter((d) => distilledLayer(d) === 'procedural').length
      result.distilled = fresh.length
    }
  }

  // 模块 B：认知巩固（默认 off，零行为变化）。
  // 1.1.1 语义做实（召回锚定巩固）：只对「发生过**真实召回**的记忆」（accessCount > 0，
  // 即 memory_recall 命中 / 用户显式访问过）执行到期巩固——真正的间隔重复（SRS）
  // 要求复习事件来自实际回忆；此前对从未被召回过的条目也无差别 +1，是「假复习」，
  // 效果为周期性热度泵（与遗忘曲线的语义相反）。从未被使用的记忆容许自然衰减
  // （use it or lose it），status 的 due 观测不变，仍如实报告 fading 条目。
  if (cfg.consolidationMode === 'auto') {
    const { due } = consolidate(entries, now, { recallThreshold: cfg.recallThreshold })
    metrics.consolidationDue = due.length
    // 过滤必须在 reinforce **之前**作用于 due 原件（reinforce 副本的 accessCount 已 +1，
    // 恒 >0，过滤形同虚设——T11 回归测试锁定此语义）
    const dueUsed = due.filter((e) => e.accessCount > 0)
    const actuallyReinforced = dueUsed.map((e) => reinforce(e, now))
    if (actuallyReinforced.length > 0) {
      // 合并回写：与 heat flush 同一 coalesced 通道（upsertMany 单次落盘多行）
      if (typeof store.upsertMany === 'function') {
        await store.upsertMany(actuallyReinforced)
      } else {
        for (const r of actuallyReinforced) await store.upsert(r)
      }
      metrics.consolidated = (metrics.consolidated ?? 0) + actuallyReinforced.length
      result.consolidated = actuallyReinforced.length
      // 巩固只改访问历史（content/updatedAt 未变），图谱边无需同步
    }
  }

  return result
}
