/**
 * 记忆层次蒸馏层（1.1.0，DESIGN-1.1 模块 A）。
 *
 * 把零散的低层记忆（episodic 事实）按主题簇批量蒸馏为高层抽象：
 * - abstract：共性蒸馏（稳定背景主题 / 行为偏好模式）；
 * - procedural：规则蒸馏（跨多条指令/偏好记忆的一致约束）。
 *
 * 蒸馏产物是**普通的 MemoryEntry**（MemoryEntry 持久化契约零变更），
 * 通过 tags 协议标注（distilled-layer / distilled-from / distilled-theme），
 * 源记忆完整可追踪（G9 源可追踪率 100% 的落点）；召回命中蒸馏条目时可
 * 用 expandDistilled 向下展开证据链。
 *
 * 全部为纯函数、零 IO、零外部依赖；蒸馏批处理可复算——相同输入两次调用
 * 产出逐字节一致的蒸馏条目（id = `dist-<contentHash(摘要)>`，无随机成分）。
 *
 * DESIGN-1.1 模块 A 验收门限（G9）：
 * - 蒸馏可复算：相同输入两遍产出 id 一致（纯函数）；
 * - 源可追踪率 100%：每个蒸馏条目都存在有效源引用（distilled-from）；
 * - 冲突守卫：含 supersede/conflict 对立对的簇 0 蒸馏（跳过并计数）；
 * - 召回展开：expandDistilled 返回的展开源 = distilled-from 有效引用数。
 */
import { normalizeForMatch, PREFERENCE_SIGNAL_TERMS } from './capture'
import { tokenize } from './engine'
import { contentHash } from './store'
import { isSuperseded, SUPERSEDE_TAG_PREFIX, SUPERSEDED_BY_TAG_PREFIX } from './entry-factory'
import type { MemoryEntry, MemoryKind } from './types'

/** 蒸馏分层标记 tag 前缀（单一事实源；蒸馏协议） */
export const DISTILLED_LAYER_TAG_PREFIX = 'distilled-layer:'
/** 源引用 tag 前缀：`distilled-from:<id1>,<id2>,...`（G9 可追踪性载体） */
export const DISTILLED_FROM_TAG_PREFIX = 'distilled-from:'
/** 主题追溯 tag 前缀：`distilled-theme:<簇名>` */
export const DISTILLED_THEME_TAG_PREFIX = 'distilled-theme:'
/** 蒸馏条目 id 前缀（确定性 id = 内容指纹，可复算） */
export const DISTILL_ID_PREFIX = 'dist'

/** 蒸馏层类型：abstract = 共性/偏好抽象；procedural = 规则约束蒸馏 */
export type DistillLayer = 'abstract' | 'procedural'

/** 蒸馏跳过原因（可观测：why-not-distilled） */
export type DistillSkipReason = 'too-small' | 'conflict' | 'no-resonance'

/** 蒸馏批处理配置 */
export interface DistillOptions {
  /** 可蒸馏的最小簇成员数（默认 3，低于则不产出，防单例噪音） */
  minCluster?: number
  /** 簇划分的共享 token 数门槛（默认 2，与 1.0.0 主题聚类一致） */
  minShared?: number
  /** 蒸馏产物 content 最大字符数（默认 1000，沿 maxEntryChars 语义） */
  maxChars?: number
  /** 评分/时间戳基准（ms；注入可复算） */
  now?: number
}

/** 一条被跳过的簇（可观测） */
export interface DistillSkip {
  reason: DistillSkipReason
  /** 簇主题（最高频 token；无共鸣面时为空） */
  theme: string
  memberCount: number
}

/** 蒸馏批处理结果（纯描述：新蒸馏条目 + 跳过原因；不落盘，由调用方决定写入） */
export interface DistillResult {
  /** 生成的抽象/规则条目（id 确定性，可复算；未写入存储） */
  distilled: MemoryEntry[]
  /** 被跳过的簇及原因（too-small / conflict / no-resonance） */
  skipped: DistillSkip[]
}

/**
 * 共鸣面比例：token 在簇内出现频次 ≥ memberCount×该值 才计入「簇内共鸣」，
 * 防止单条记忆的独有词污染抽象摘要。
 */
const DISTILL_RESONANCE = 0.5
/** distilled-from 最大引用源数（防 tag 超长） */
const DISTILL_MAX_REF = 24
/** 摘要中列出的高频词上限 */
const DISTILL_TOKEN_CAP = 3
/** instruction 占比 ≥ 该值 → procedural（命令约束主导）；否则 abstract（偏好/共性模式） */
const PROCEDURAL_RATIO = 0.5

/** 簇内 kind 主导序（价值序，用于蒸馏产物的 kind 选择） */
const DOMINANT_KINDS: readonly MemoryKind[] = ['instruction', 'preference', 'decision', 'fact', 'generic']

/** 一条蒸馏簇（按共享 token 并查集聚类后的分组视图） */
interface DistillCluster {
  members: MemoryEntry[]
  tokenFreq: Map<string, number>
  kinds: Map<MemoryKind, number>
}

/**
 * 簇划分：token→条目倒排 + 共享 token 计数 + 并查集连通分量（算法与
 * clusterThemes 一致，但保留成员条目引用以支持蒸馏归纳与源引用）。
 * 纯函数、零 IO、可复算。
 */
function buildDistillClusters(entries: readonly MemoryEntry[], minShared: number): DistillCluster[] {
  const byToken = new Map<string, number[]>()
  const tokenSets = new Map<string, Set<string>>()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    const tokens = new Set(tokenize(e.content))
    tokenSets.set(e.id, tokens)
    for (const t of tokens) {
      const list = byToken.get(t)
      if (list) list.push(i)
      else byToken.set(t, [i])
    }
  }
  // pair 共享 token 计数
  const pairCount = new Map<string, number>()
  for (const ids of byToken.values()) {
    if (ids.length < 2) continue
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const ia = ids[a]!
        const ib = ids[b]!
        const key = ia < ib ? `${ia}\u0000${ib}` : `${ib}\u0000${ia}`
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      }
    }
  }
  // 并查集（路径压缩）
  const parent = new Array<number>(entries.length)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    let c = x
    while (parent[c] !== c) {
      const next = parent[c]!
      parent[c] = r
      c = next
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (const [key, count] of pairCount) {
    if (count < minShared) continue
    const sep = key.indexOf('\u0000')
    union(Number(key.slice(0, sep)), Number(key.slice(sep + 1)))
  }
  // 簇内聚合：成员 / token 频次 / kind 分布
  const clusters = new Map<number, DistillCluster>()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    const root = find(i)
    let c = clusters.get(root)
    if (!c) {
      c = { members: [], tokenFreq: new Map(), kinds: new Map() }
      clusters.set(root, c)
    }
    c.members.push(e)
    for (const t of tokenSets.get(e.id) ?? []) c.tokenFreq.set(t, (c.tokenFreq.get(t) ?? 0) + 1)
    c.kinds.set(e.kind, (c.kinds.get(e.kind) ?? 0) + 1)
  }
  return [...clusters.values()].filter((c) => c.members.length >= 2)
}

/** 簇主题：最高频 token（与 1.0.0 clusterThemes 的 label 算法一致） */
function topToken(freq: Map<string, number>): string {
  let label = ''
  let best = 0
  for (const [t, n] of freq) {
    if (n > best) {
      best = n
      label = t
    }
  }
  return label
}

/** 簇内共鸣面：频次 ≥ memberCount×DISTILL_RESONANCE 且非主题词的高频 token（按频次降序） */
function resonanceTokens(freq: Map<string, number>, theme: string, count: number): string[] {
  const threshold = Math.max(1, Math.ceil(count * DISTILL_RESONANCE))
  const out: Array<{ t: string; n: number }> = []
  for (const [t, n] of freq) {
    if (t.length > 1 && t !== theme && n >= threshold) out.push({ t, n })
  }
  out.sort((a, b) => b.n - a.n || (a.t < b.t ? -1 : 1))
  return out.slice(0, DISTILL_TOKEN_CAP).map((x) => x.t)
}

/** 簇内 kind 主导（按 DOMINANT_KINDS 价值序取计数最高者） */
function dominantKind(cluster: DistillCluster): MemoryKind {
  let best: MemoryKind = 'generic'
  let bestCount = -1
  for (const k of DOMINANT_KINDS) {
    const n = cluster.kinds.get(k) ?? 0
    if (n > bestCount) {
      bestCount = n
      best = k
    }
  }
  return best
}

/** 文本是否含偏好信号词面（复用 capture 单一事实源 PREFERENCE_SIGNAL_TERMS） */
export function hasPreferenceSignal(text: string): boolean {
  const lower = normalizeForMatch(text)
  return PREFERENCE_SIGNAL_TERMS.some((t) => lower.includes(t.toLocaleLowerCase()))
}

/** 共性蒸馏摘要（abstract 层：稳定背景/偏好模式） */
function composeAbstract(theme: string, resonance: string, count: number, hasPref: boolean): string {
  const lead = hasPref ? '偏好模式' : '共性主题'
  return `蒸馏抽象[${theme}]：${count} 条记忆构成一致的${lead}，高频共同点：${resonance}。`
}

/** 规则蒸馏摘要（procedural 层：跨记忆一致约束） */
function composeProcedural(theme: string, resonance: string, count: number): string {
  return `蒸馏规则[${theme}]：${count} 条指令/偏好记忆一致要求「${theme}」相关约定（高频约束：${resonance}）。`
}

/**
 * 蒸馏批处理（纯函数，可复算）。
 *
 * 流程（DESIGN-1.1 模块 A1）：
 * 1. 过滤已蒸馏条目（蒸馏产物不再参与二次蒸馏）；
 * 2. 共享 token 并查集聚簇（minShared 门槛）；
 * 3. 每簇逐项检查：簇太小 → too-small；含 supersede 对立对（成员被取代/成员声明取代）
 *    → conflict（冲突守卫，矛盾事实不揉成伪原则）；无共鸣面 → no-resonance；
 * 4. 归纳：按 kind 分布选层（instruction+preference 主导 → procedural，否则 abstract）、
 *    选主导 kind、生成确定性 id 的蒸馏条目（tags 含分层/源引用/主题追溯）。
 *
 * 不写存储（纯描述输出），调用方决定 upsert 策略与时机（distillMode 控制，默认关闭）。
 */
export function distillBatch(entries: readonly MemoryEntry[], opts: DistillOptions = {}): DistillResult {
  const now = opts.now ?? Date.now()
  const maxChars = opts.maxChars ?? 1000
  const minShared = opts.minShared ?? 2
  const minCluster = opts.minCluster ?? 3
  const sources = entries.filter((e) => !isDistilled(e))
  // 少于 2 条不可能成簇（minCluster 在簇级判定：见下方 too-small skip）
  if (sources.length < 2) return { distilled: [], skipped: [] }

  const clusters = buildDistillClusters(sources, minShared)
  const distilled: MemoryEntry[] = []
  const skipped: DistillSkip[] = []

  for (const c of clusters) {
    const theme = topToken(c.tokenFreq)
    const count = c.members.length
    // 冲突守卫：簇内任一成员处于 supersede 对立对中（被取代，或声明取代他人）→ 跳过，
    // 防止把矛盾事实蒸馏成一条伪原则（G9 冲突守卫门限）。
    if (
      c.members.some(
        (m) =>
          isSuperseded(m) ||
          m.tags.some((t) => t.startsWith(SUPERSEDE_TAG_PREFIX) || t.startsWith(SUPERSEDED_BY_TAG_PREFIX)),
      )
    ) {
      skipped.push({ reason: 'conflict', theme, memberCount: count })
      continue
    }
    if (count < minCluster) {
      skipped.push({ reason: 'too-small', theme, memberCount: count })
      continue
    }
    const resonance = resonanceTokens(c.tokenFreq, theme, count)
    if (resonance.length === 0) {
      skipped.push({ reason: 'no-resonance', theme, memberCount: count })
      continue
    }

    // 分层：instruction 占比 ≥ PROCEDURAL_RATIO → 规则层（命令约束主导）；
    // 纯偏好/事实/混合 → abstract（偏好模式与共性主题正是抽象层语义）。
    const totalKinds = [...c.kinds.values()].reduce((a, b) => a + b, 0)
    const instCount = c.kinds.get('instruction') ?? 0
    const layer: DistillLayer = totalKinds > 0 && instCount / totalKinds >= PROCEDURAL_RATIO ? 'procedural' : 'abstract'
    const joined = resonance.join('、')
    const hasPref = c.members.some((m) => hasPreferenceSignal(m.content))
    const content =
      layer === 'procedural' ? composeProcedural(theme, joined, count) : composeAbstract(theme, joined, count, hasPref)

    // 源引用：成员按 createdAt 升序稳定，截断防 tag 超长（201 个 id ≈ 25 字符/个）
    const refIds = [...c.members]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .slice(0, DISTILL_MAX_REF)
      .map((m) => m.id)

    const entry: MemoryEntry = {
      // 确定性 id：dist-<contentHash(摘要)>——相同输入两次调用 id 一致（G9 可复算）
      id: `${DISTILL_ID_PREFIX}-${contentHash(content)}`,
      kind: dominantKind(c),
      content: content.slice(0, maxChars),
      tags: [
        `${DISTILLED_LAYER_TAG_PREFIX}${layer}`,
        `${DISTILLED_FROM_TAG_PREFIX}${refIds.join(',')}`,
        `${DISTILLED_THEME_TAG_PREFIX}${theme}`,
        'distilled',
      ],
      source: 'auto',
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    }
    distilled.push(entry)
  }
  return { distilled, skipped }
}

/** 判断条目是否为蒸馏产物（tags 含 distilled-layer: 协议） */
export function isDistilled(entry: MemoryEntry): boolean {
  return entry.tags.some((t) => t.startsWith(DISTILLED_LAYER_TAG_PREFIX))
}

/** 取蒸馏分层（abstract / procedural；非蒸馏条目返回 undefined） */
export function distilledLayer(entry: MemoryEntry): DistillLayer | undefined {
  for (const t of entry.tags) {
    if (!t.startsWith(DISTILLED_LAYER_TAG_PREFIX)) continue
    const v = t.slice(DISTILLED_LAYER_TAG_PREFIX.length)
    if (v === 'abstract' || v === 'procedural') return v
  }
  return undefined
}

/** 取蒸馏条目的源引用 id 列表（distilled-from:<id1>,<id2>,... → string[]；无则空数组） */
export function distilledSourceIds(entry: MemoryEntry): string[] {
  for (const t of entry.tags) {
    if (t.startsWith(DISTILLED_FROM_TAG_PREFIX)) {
      return t.slice(DISTILLED_FROM_TAG_PREFIX.length).split(',').filter(Boolean)
    }
  }
  return []
}

/**
 * 召回向下展开（DESIGN-1.1 模块 A3）：把蒸馏条目展开为其源记忆证据链。
 * 无效引用（源已被遗忘）自动跳过——源条目被清理后蒸馏条目仍可召回，只是展开收缩；
 * 返回顺序与 distilled-from 声明一致（createdAt 升序），零 IO 纯函数。
 */
export function expandDistilled(hit: MemoryEntry, entriesById: ReadonlyMap<string, MemoryEntry>): MemoryEntry[] {
  const out: MemoryEntry[] = []
  for (const id of distilledSourceIds(hit)) {
    const src = entriesById.get(id)
    if (src) out.push(src)
  }
  return out
}
