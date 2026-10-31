/**
 * 主题自动聚类（1.1.1 自 engine.ts 拆出；运行时视图，不持久化）。
 * 与检索引擎无共享状态，此前挂在 engine.ts 上是职责错位；
 * distill.ts 的簇划分算法与本模块同构（其保留成员引用以支持蒸馏归纳）。
 */
import { tokenize } from './tokenize'
import type { MemoryEntry, MemoryKind } from './types'

/**
 * hub token 护栏（1.1.1）：出现在超过该条数的 token 不参与 pair 计数与聚类。
 * 中文高频双字词（"使用/我们/可以"）几乎出现在所有条目中：N 条共享 → O(N²) 个
 * 字符串键 Map 插入（1 万条库 ≈ 5000 万对，内存与耗时双爆炸），且是蒸馏巨簇噪声
 * 的共同来源。df ≤ 64 的语义 token 才有聚类价值。
 */
export const MAX_CLUSTER_DF = 64

/** 主题簇：共享 token 数 ≥2 的条目聚为一类；label = 簇内最高频 token */
export interface ThemeCluster {
  /** 唯一 id（= label 的 hash 去冲突后截断） */
  id: string
  /** 主题标签（簇内 content 最高频 token） */
  label: string
  memberCount: number
  /** 簇内 top 3 kind（按出现次数降序） */
  topKinds: MemoryKind[]
}

/**
 * 1.0.0（DESIGN-1.0 模块 A2）：主题自动聚类——并查集连通分量。
 * 算法：token→条目倒排；两两共享 token 计数（Map<pair, count>）；
 * 共享 token ≥ minShared（默认 2）的条目对 union 进同一主题簇。
 * 主题 id = 簇内最高频 token（hash 截断去冲突），成员按 createdAt 升序稳定。
 * 纯函数、零 IO、可复算；1.1.1 加 df 护栏（> MAX_CLUSTER_DF 的 hub token 跳过，
 * O(N²) 上限解除 + 巨簇噪声根治）。
 */
export function clusterThemes(entries: readonly MemoryEntry[], minShared = 2): ThemeCluster[] {
  if (entries.length < 2) return []
  // token → 条目索引（倒排）
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
  // pair 共享 token 计数（1.1.1：df > MAX_CLUSTER_DF 的 hub token 跳过）
  const pairCount = new Map<string, number>()
  for (const ids of byToken.values()) {
    if (ids.length < 2 || ids.length > MAX_CLUSTER_DF) continue
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const ia = ids[a]!
        const ib = ids[b]!
        const key = ia < ib ? `${ia}\u0000${ib}` : `${ib}\u0000${ia}`
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      }
    }
  }
  // 并查集：共享 ≥ minShared 个 token 的条目对 union（路径压缩）
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
  // 簇内 token 频率聚合 → label / topKinds
  const clusters = new Map<
    number,
    { members: number[]; tokenFreq: Map<string, number>; kinds: Map<MemoryKind, number> }
  >()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    const root = find(i)
    let c = clusters.get(root)
    if (!c) {
      c = { members: [], tokenFreq: new Map(), kinds: new Map() }
      clusters.set(root, c)
    }
    c.members.push(i)
    for (const t of tokenSets.get(e.id) ?? []) c.tokenFreq.set(t, (c.tokenFreq.get(t) ?? 0) + 1)
    c.kinds.set(e.kind, (c.kinds.get(e.kind) ?? 0) + 1)
  }
  const out: ThemeCluster[] = []
  for (const c of clusters.values()) {
    if (c.members.length < 2) continue
    let label = ''
    let best = 0
    for (const [t, n] of c.tokenFreq) {
      if (n > best) {
        best = n
        label = t
      }
    }
    const topKinds = [...c.kinds.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 3)
      .map(([k]) => k)
    out.push({
      id: tokenThemeId(label),
      label,
      memberCount: c.members.length,
      topKinds,
    })
  }
  return out.sort((a, b) => b.memberCount - a.memberCount || (a.label < b.label ? -1 : 1))
}

/** 主题 id：label 的短哈希（去冲突不可见字符）+ 前缀，稳定可复现 */
export function tokenThemeId(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0
  }
  return `theme-${h.toString(36)}`
}
