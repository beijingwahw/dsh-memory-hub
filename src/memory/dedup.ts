/**
 * 内容级库内去重（1.1.1 自 engine.ts 拆出）。
 * 依赖方向：dedup → fuzzy（相似度）+ hash（指纹），与检索索引解耦——
 * 去重属入库管线而非检索引擎，此前挂在 engine.ts 上是职责错位。
 */
import { contentHash } from './hash'
import type { MemoryEntry } from './types'
import { similarity } from './fuzzy'

/**
 * 指纹缓存（1.1.1）：以 entries 数组**引用**为键（store.list() 的 copy-on-write 快照在
 * 每次结构性写入后必然产生新数组引用），同一快照上的多次去重判定只计算一轮 sha256。
 * 此前 detectDuplicate 每次调用对全库重算哈希：导入 1 万块 × 库内 5 千条 = 5000 万次
 * sha256——正是 planImport / ingestCaptured 的隐性 O(blocks × N) 热点。
 */
const duplicateHashCache = new WeakMap<object, ReadonlyArray<readonly [string, MemoryEntry]>>()

function hashedEntries(existing: readonly MemoryEntry[]): ReadonlyArray<readonly [string, MemoryEntry]> {
  const cached = duplicateHashCache.get(existing)
  if (cached !== undefined) return cached
  const out = existing.map((e) => [contentHash(e.content), e] as const)
  duplicateHashCache.set(existing, out)
  return out
}

/**
 * 1.0.0 UF-1.0（DESIGN-1.0 模块 C1）+ 1.1.1 升级：内容级库内去重检测，命中返回条目。
 * 语义：以 `contentHash(content)` 为**跨 id 前缀的统一指纹**（捕获 `contentHash-uuid`、
 * 显式 `contentHash-uuid`、导入 `imp-contentHash` 三种 id 规范互认），两层级判定：
 * 1. 指纹精确命中（同内容）→ 返回该条目；
 * 2. 窗口内编辑距离近似（similarity > 0.92，长度预筛避免 O(L²)）→ 返回该条目。
 * 返回 undefined 表示无重复；调用方按需拒绝写入或幂等返回已存在条目
 * （1.1.1 起 memory_store 近重复命中也幂等返回，修复「>0.92 命中但精确匹配找不到而落穿写入」）。
 */
export function findDuplicate(
  existing: readonly MemoryEntry[],
  content: string,
  windowMs: number,
  now = Date.now(),
): MemoryEntry | undefined {
  if (windowMs <= 0) return undefined
  const len = content.length
  const hash = contentHash(content)
  let approx: MemoryEntry[] | undefined
  for (const [h, e] of hashedEntries(existing)) {
    if (now - e.createdAt > windowMs) continue
    if (h === hash) return e // 精确指纹命中：立即返回（与近似路径隔离，避免无谓 similarity）
    if (e.content !== content) {
      // 长度窗口预筛后的近似比对候选（第 2 层；候选已受限）
      const eLen = e.content.length
      const maxLen = Math.max(len, eLen)
      if (Math.abs(eLen - len) <= 0.08 * maxLen + 1) {
        ;(approx ??= []).push(e)
      }
    }
  }
  if (approx !== undefined) {
    for (const e of approx) {
      if (similarity(e.content, content) > 0.92) return e
    }
  }
  return undefined
}

/** 布尔形式去重判定（语义同 findDuplicate；保留以兼容既有调用方与测试） */
export function detectDuplicate(
  existing: readonly MemoryEntry[],
  content: string,
  windowMs: number,
  now = Date.now(),
): boolean {
  return findDuplicate(existing, content, windowMs, now) !== undefined
}

/**
 * 内容近似度去重（0.2.0 起语义保持；1.0.0 起委托 UF-1.0 detectDuplicate，语义升级为
 * 「同指纹或窗口内近重复」双层级，向后兼容：对既有测试的全部输入行为一致或更宽松地拒绝同内容）。
 */
export function isDuplicate(existing: MemoryEntry[], content: string, windowMs: number, now = Date.now()): boolean {
  return detectDuplicate(existing, content, windowMs, now)
}
