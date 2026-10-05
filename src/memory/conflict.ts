/**
 * 信念修正与冲突共存（1.1.0，DESIGN-1.1 模块 D）。
 *
 * 在 1.0.0 的 supersede（强制取代）之上增加**矛盾共存**语义：
 * - 明确替换（改用/升级到/switch to…）→ 仍走 supersede 协议（打标互斥）；
 * - 疑似反转（不再/禁止/opposite/no longer…）→ 相近但不可判取代的对立事实**并存**，
 *   通过 `conflicts-with:<旧id>` / `conflict-of:<新id>` 双向标注（tags 协议，
 *   MemoryEntry 契约零变更），修正时间线由条目 updatedAt 天然承载；
 * - 召回时冲突双方**都保留**（不与 supersede 一样剔除旧条目），按时间锚定新者优先；
 * - status 提供 conflictPairs 可观测（计数 + 最近样本）。
 *
 * 设计纪律：
 * - 全部纯函数/纯常量，零依赖、可复算（now 注入）；
 * - 弱化对立词表（反转倾向）与 supersede 的强对立词表（明确替换）分离，
 *   二者来源互斥，避免「改用 X」被误标矛盾；
 * - 冲突检测用弱门槛（similarity > 0.55，低于 supersede 的 0.85）：
 *   相近但非重复 + 疑似反转 → 共存，而非删除旧信念。
 *
 * DESIGN-1.1 模块 D 验收门限（G12）：
 * - 矛盾检出精度：eval 冲突夹具 precision ≥ 0.8 / recall ≥ 0.7；
 * - 与 supersede 区分：「改用 X」类只走 supersede 不标 conflict（打标互斥测试）；
 * - 并存语义：冲突对双方在召回中同时出现（不剔除），新者序先；
 * - 零行为回归：conflictMode 缺省 off 时行为与 1.0.0 逐字节一致。
 */
import { normalizeForMatch } from './capture'
import { isSuperseded, supersedeTargetId } from './entry-factory'
import { similarity } from './engine'
import type { MemoryEntry, MemoryHit } from './types'

/** 矛盾并存相似度门槛（默认；低于 supersede 0.85 强门槛——相近但非重复） */
export const CONFLICT_SIMILARITY_THRESHOLD = 0.55
/** 强指令排除门槛：kind=instruction 且含下词 → 不判矛盾（止损指令非信念反转） */
const STRONG_INSTRUCTION_HINTS = new RegExp(/(?:必须|务必|一定要|始终|always|must|required)/i)
/** 弱化对立词表（单一事实源；反转倾向，与 supersede 强表互斥语义） */
export const CONFLICT_SIGNAL_TERMS: readonly string[] = [
  '不再',
  '不要',
  '禁止',
  '停止',
  '放弃',
  '反转',
  '相反',
  '不再是',
  'no longer',
  'opposite',
  'revert',
  'reversed',
  'stop using',
  "don't use",
  'do not use',
  'quit',
  'give up',
] as const

/** 弱化对立信号正则（由 CONFLICT_SIGNAL_TERMS 编译派生，单一事实源不可漂移） */
export const CONFLICT_HINTS = new RegExp(`(?:${CONFLICT_SIGNAL_TERMS.join('|')})`, 'i')

/** 文本是否含「疑似反转」弱对立信号（conflictMode='auto' 时触发矛盾判定） */
export function hasConflictSignal(text: string): boolean {
  return CONFLICT_HINTS.test(normalizeForMatch(text))
}

/**
 * 共存协议 tag 常量（DESIGN-1.1 模块 D；tags 兼容协议，MemoryEntry 契约零变更）。
 * - 新记忆 tags 追加 `conflicts-with:<旧id>`（指向被反转的旧信念）；
 * - 被反转的旧记忆 tags 追加 `conflict-of:<新id>`（双向标注，倒查 O(1)）。
 */
export const CONFLICTS_WITH_TAG_PREFIX = 'conflicts-with:'
export const CONFLICT_OF_TAG_PREFIX = 'conflict-of:'

/** 取出矛盾协议指向的对方 id（conflicts-with:<id> / conflict-of:<id> 双向合并去重） */
export function conflictPeerIds(entry: MemoryEntry): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of entry.tags) {
    if (t.startsWith(CONFLICTS_WITH_TAG_PREFIX)) {
      const id = t.slice(CONFLICTS_WITH_TAG_PREFIX.length)
      if (!seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    } else if (t.startsWith(CONFLICT_OF_TAG_PREFIX)) {
      const id = t.slice(CONFLICT_OF_TAG_PREFIX.length)
      if (!seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
  }
  return out
}

/** 条目是否带矛盾共存标注（召回冲突感知排序的入口判定） */
export function isConflicted(entry: MemoryEntry): boolean {
  return entry.tags.some((t) => t.startsWith(CONFLICTS_WITH_TAG_PREFIX) || t.startsWith(CONFLICT_OF_TAG_PREFIX))
}

/**
 * D1 矛盾对检测（纯函数，可复算）。
 * 条件（全部满足才命中）：
 * - 候选含弱化对立信号（hasConflictSignal）；
 * - 与窗口内既有条目 similarity > 阈值（默认 0.55，可注入）；可选同 kind；
 * - 排除已处于 supersede 协议的条目：既有条目带 superseded-by / supersede tag → 跳过
 *   （取代对走 1.0.0 协议，不打矛盾标）；
 * - 排除强指令：候选 kind=instruction 且含 必须/务必/always/must… → 止损指令非信念反转。
 * 命中返回窗口内相似度最高的旧条目；否则 undefined。
 */
export function detectContradiction(
  existing: readonly MemoryEntry[],
  cand: Pick<MemoryEntry, 'content' | 'kind'>,
  opts: {
    dedupWindowMs: number
    conflictSimilarity?: number
    conflictSameKind?: boolean
  },
  now = Date.now(),
): MemoryEntry | undefined {
  if (!hasConflictSignal(cand.content)) return undefined
  const threshold = opts.conflictSimilarity ?? CONFLICT_SIMILARITY_THRESHOLD
  // 强指令排除：kind=instruction 且含务必类词 → 止损/纪律指令不判为信念反转
  if (cand.kind === 'instruction' && STRONG_INSTRUCTION_HINTS.test(cand.content)) return undefined
  let best: MemoryEntry | undefined
  let bestSim = threshold
  for (const e of existing) {
    if (now - e.createdAt > opts.dedupWindowMs) continue
    if (opts.conflictSameKind !== false && e.kind !== cand.kind) continue
    // 互斥：已走 supersede 协议的条目不参与矛盾共存（取代对内部不再打矛盾标）
    if (isSuperseded(e) || supersedeTargetId(e) !== undefined) continue
    const sim = similarity(e.content, cand.content)
    if (sim > bestSim) {
      bestSim = sim
      best = e
    }
  }
  return best
}

/**
 * D3 冲突感知排序（纯函数）：命中集合内冲突对双方按时间锚定**新者优先**重排，
 * 但双方都保留（不与 supersede 一样剔除旧条目）。
 * - 规则：对每个命中且带矛盾标注的条目 e，取其 peer；
 *   若 peer 也在命中集合中，则对 (e, peer) 按 updatedAt 新者在前（等时保持原序）；
 * - 无冲突命中的条目保持原相对顺序（稳定）。
 * 输入输出均为 MemoryHit[]，不动 score（排序是「呈现顺序」而非「评分修正」）。
 */
export function conflictAwareOrder(hits: readonly MemoryHit[], byId: ReadonlyMap<string, MemoryEntry>): MemoryHit[] {
  if (hits.length < 2) return [...hits]
  const index = new Map(hits.map((h, i) => [h.id, i]))
  // 冲突对被记录为 [新者id, 旧者id, 新者索引, 旧者索引]
  const pairs: Array<{ newerId: string; olderId: string; iMin: number; iMax: number }> = []
  const seenPairs = new Set<string>()
  const inHits = (id: string): boolean => index.has(id)
  for (const h of hits) {
    for (const peerId of conflictPeerIds(h)) {
      if (!inHits(peerId)) continue
      const b = byId.get(peerId)
      if (!b) continue
      const key = h.id < peerId ? `${h.id}\u0000${peerId}` : `${peerId}\u0000${h.id}`
      if (seenPairs.has(key)) continue
      seenPairs.add(key)
      if (h.updatedAt === b.updatedAt) continue // 等时保持原序
      const newer = h.updatedAt > b.updatedAt ? h : b
      const older = h.updatedAt > b.updatedAt ? b : h
      const iNew = index.get(newer.id)!
      const iOld = index.get(older.id)!
      if (iNew < iOld) continue // 新者已在前
      pairs.push({ newerId: newer.id, olderId: older.id, iMin: Math.min(iNew, iOld), iMax: Math.max(iNew, iOld) })
    }
  }
  if (pairs.length === 0) return [...hits]
  // 按 (区间起点升序, 区间长度降序) 处理：区间内重排为新者开头、旧者末尾，
  // 其余元素保持原相对顺序；已参与调整的元素不再重复移动（稳定）。
  const arr = [...hits]
  const adjusted = new Set<string>()
  pairs.sort((a, b) => a.iMin - b.iMin || b.iMax - a.iMax)
  for (const p of pairs) {
    if (adjusted.has(p.newerId) || adjusted.has(p.olderId)) continue
    const curNew = arr.findIndex((h) => h.id === p.newerId)
    const curOld = arr.findIndex((h) => h.id === p.olderId)
    if (curNew < 0 || curOld < 0 || curNew < curOld) continue
    const lo = curOld
    const hi = curNew
    const newerHit = arr[curNew]!
    const olderHit = arr[curOld]!
    const rest = arr.slice(lo + 1, hi)
    const segment = [newerHit, ...rest, olderHit]
    arr.splice(lo, hi - lo + 1, ...segment)
    adjusted.add(p.newerId)
    adjusted.add(p.olderId)
  }
  return arr
}

/** 冲突对样本（status 可观测用） */
export interface ConflictPairSample {
  /** 新者 id（updatedAt 较大方） */
  newerId: string
  /** 旧者 id（updatedAt 较小方） */
  olderId: string
  /** 新者时间戳（修正时间线锚点） */
  updatedAt: number
}

/**
 * 扫描语料统计矛盾共存对（仅统计双向标注完备的对；计数 = 唯一对，样本 = 最近 N 对）。
 * 纯函数：遍历 entries，对每条 conflicts-with 标注补全 peer；同一对只计一次。
 */
export function summarizeConflictPairs(
  entries: readonly MemoryEntry[],
  limit = 3,
): { count: number; samples: ConflictPairSample[] } {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const pairs = new Map<string, ConflictPairSample>()
  for (const e of entries) {
    for (const peerId of conflictPeerIds(e)) {
      const peer = byId.get(peerId)
      if (!peer) continue
      const key = e.id < peerId ? `${e.id}\u0000${peerId}` : `${peerId}\u0000${e.id}`
      if (pairs.has(key)) continue
      const newer = e.updatedAt >= peer.updatedAt ? e : peer
      const older = e.updatedAt >= peer.updatedAt ? peer : e
      pairs.set(key, { newerId: newer.id, olderId: older.id, updatedAt: newer.updatedAt })
    }
  }
  const samples = [...pairs.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.newerId < b.newerId ? -1 : 1))
    .slice(0, limit)
  return { count: pairs.size, samples }
}
