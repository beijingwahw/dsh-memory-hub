/**
 * 记忆入库管线（0.7.0 自 index.ts 拆出，独立可测）。
 *
 * 职责：把捕获候选（CaptureCandidate[]）逐条规整为 MemoryEntry 并写入存储：
 * - 敏感过滤（NFKC 归一化 + 云厂商 key/口令模式，与显式 memory_store 同一防线）；
 * - 窗口内去重（UF-1.0 内容指纹精确 + 编辑距离近似双保险，跨 id 前缀互认）；
 * - 超长截断、统一组装（entry-factory.makeEntry，三条写入路径单一实现）；
 * - 1.0.0 冲突感知：supersedeMode='auto' 且候选含对立信号时，对窗口内高相似旧条目
 *   建立取代关系（新条目 supersede:<旧id>、旧条目 superseded-by:<新id>）；
 * - 指标计数（rejectedSensitive / rejectedDuplicate / capturedTotal）。
 *
 * 纯逻辑 + 只依赖 MemoryStore 接口，不依赖插件运行时，可独立单测。
 */
import { containsSensitive, hasOpposingSignal, type CaptureCandidate } from './capture'
import { detectContradiction } from './conflict'
import { detectDuplicate } from './engine'
import { makeEntry, supersededByTargetId } from './entry-factory'
import { similarity } from './engine'
import type { HubMetrics } from './metrics'
import type { GraphWriteSink, MemoryEntry, MemoryStore } from './types'

/** 入库所需的最小配置视图（取自 MemoryHubConfig 的映射子集） */
export interface IngestOptions {
  /** 单条记忆最大字符数 */
  maxEntryChars: number
  /** 去重时间窗口（ms） */
  dedupWindowMs: number
  /** 1.0.0：取代关系识别（默认 off = 0.10.0 行为；auto 时对含对立信号的候选建立 supersede 协议） */
  supersedeMode?: 'off' | 'auto'
  /** 1.0.0：取代判定相似度阈值（仅 supersedeMode='auto' 生效；默认 0.85） */
  supersedeSimilarity?: number
  /** 1.0.0：取代判定只对同 kind 生效（默认 true） */
  supersedeSameKind?: boolean
  /** 1.1.0：矛盾共存识别（默认 off；auto 时对未取代的疑似反转候选建立 conflicts-with 协议） */
  conflictMode?: 'off' | 'auto'
  /** 1.1.0：矛盾判定相似度阈值（仅 conflictMode='auto' 生效；默认 0.55，低于 supersede 强门槛） */
  conflictSimilarity?: number
  /** 1.1.0：矛盾判定只对同 kind 生效（默认 true） */
  conflictSameKind?: boolean
}

/**
 * 1.0.0（DESIGN-1.0 模块 A1）：查找候选的对立取代目标。
 * 条件：候选含对立信号（改用/换成/不再用/升级到……）且与窗口内既有条目内容
 * 高度相似（similarity > 阈值，可选同 kind）。命中返回旧条目；否则 undefined。
 * 纯函数可单测。窗口 = dedupWindowMs（与去重同窗，避免陈旧条目被误判为取代对）。
 */
export function findSupersedeTarget(
  existing: readonly MemoryEntry[],
  cand: Pick<CaptureCandidate, 'content' | 'kind'>,
  opts: Pick<IngestOptions, 'dedupWindowMs' | 'supersedeSimilarity' | 'supersedeSameKind'>,
  now = Date.now(),
): MemoryEntry | undefined {
  if (!hasOpposingSignal(cand.content)) return undefined
  const threshold = opts.supersedeSimilarity ?? 0.85
  let best: MemoryEntry | undefined
  let bestSim = threshold
  for (const e of existing) {
    if (now - e.createdAt > opts.dedupWindowMs) continue
    if (opts.supersedeSameKind !== false && e.kind !== cand.kind) continue
    const sim = similarity(e.content, cand.content)
    if (sim > bestSim) {
      bestSim = sim
      best = e
    }
  }
  return best
}

/** 捕获类入库（source: 'auto'；事件捕获专用） */
export async function ingestCaptured(
  store: MemoryStore,
  cands: readonly CaptureCandidate[],
  opts: IngestOptions,
  metrics: HubMetrics,
  workspace: string | undefined,
  graph?: GraphWriteSink,
): Promise<void> {
  if (!cands.length) return
  const existing = await store.list()
  // 0.9.0 两级去重（C 薄弱项）：批内瞬时去重（内容精确键）+ 库内窗口去重（UF-1.0 指纹）。
  // 同批候选互相重复时只入库 1 条（0.8.0 双候选同文会生成两条不同 id 双写入库）。
  const batchSeen = new Set<string>()
  for (const cand of cands) {
    if (containsSensitive(cand.content)) {
      metrics.rejectedSensitive++
      continue
    }
    const batchKey = cand.content.trim()
    if (batchSeen.has(batchKey)) {
      metrics.rejectedDuplicate++
      continue
    }
    batchSeen.add(batchKey)
    if (detectDuplicate(existing, cand.content, opts.dedupWindowMs)) {
      metrics.rejectedDuplicate++
      continue
    }
    // 1.0.0（模块 A1）：取代判定须在写入前确定（新条目要打 supersede:<旧id>）
    const target =
      opts.supersedeMode === 'auto'
        ? findSupersedeTarget(existing, cand, {
            dedupWindowMs: opts.dedupWindowMs,
            ...(opts.supersedeSimilarity !== undefined ? { supersedeSimilarity: opts.supersedeSimilarity } : {}),
            ...(opts.supersedeSameKind !== undefined ? { supersedeSameKind: opts.supersedeSameKind } : {}),
          })
        : undefined
    // 1.1.0（模块 D1）：矛盾共存判定——supersede 命中时打标互斥，不再重复判冲突；
    // 仅 set captured kind（对冲 kind 可能为 instruction，检测内部有强指令排除）。
    const conflictTarget =
      target === undefined && opts.conflictMode === 'auto'
        ? detectContradiction(existing, cand, {
            dedupWindowMs: opts.dedupWindowMs,
            ...(opts.conflictSimilarity !== undefined ? { conflictSimilarity: opts.conflictSimilarity } : {}),
            ...(opts.conflictSameKind !== undefined ? { conflictSameKind: opts.conflictSameKind } : {}),
          })
        : undefined
    const now = Date.now()
    const tags = [
      ...cand.tags,
      ...(target !== undefined ? [`supersede:${target.id}`] : []),
      ...(conflictTarget !== undefined ? [`conflicts-with:${conflictTarget.id}`] : []),
    ]
    const entry = makeEntry({
      content: cand.content,
      kind: cand.kind,
      tags,
      source: 'auto',
      maxChars: opts.maxEntryChars,
      now,
      ...(workspace !== undefined ? { workspace } : {}),
    })
    await store.upsert(entry)
    // 1.1.0（模块 C）：图谱写入钩子——新条目进图；旧条目被取代/冲突更新也进图
    // （superseded 更新让旧条目的边标记失效时间线，冲突更新刷新修正时间线）
    if (graph) graph.add(entry)
    if (target !== undefined) {
      // 旧条目追加被取代标记（只在既有 tags 含 superseded-by 时跳过，避免重复打标）
      if (!supersededByTargetId(target)) {
        const updated: MemoryEntry = { ...target, tags: [...target.tags, `superseded-by:${entry.id}`], updatedAt: now }
        await store.upsert(updated)
        if (graph) graph.add(updated)
      }
    }
    if (conflictTarget !== undefined) {
      // 旧条目追加反向标注（conflict-of:<新id>，双向协议倒查 O(1)）
      const updated: MemoryEntry = {
        ...conflictTarget,
        tags: [...conflictTarget.tags, `conflict-of:${entry.id}`],
        updatedAt: now,
      }
      await store.upsert(updated)
      if (graph) graph.add(updated)
    }
    metrics.capturedTotal++
  }
}
