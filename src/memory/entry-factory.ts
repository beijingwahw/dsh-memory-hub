/**
 * 记忆条目统一工厂（1.0.0, DESIGN-1.0 S5）。
 *
 * 0.10.0 之前，捕获/显式/导入三条写入路径各自用不同代码组装 MemoryEntry：
 * - ingest.ts：contentHash + randomUUID 后缀，tags 原样；
 * - tools/memory-store.ts：同款 id 规范但 tags 清洗逻辑内联；
 * - importer.ts：`imp-` 前缀内容哈希 id。
 * 这导致 id 规范、tags 清洗、敏感拒绝前置在三条路径间漂移（行级报告疑点 7 的根因之一）。
 *
 * 1.0.0 统一为单一工厂：id 组装 / tags 清洗 / 截断 / workspace 注入 / 时间戳一套语义，
 * 三条路径全部接入；配合 UF-1.0 内容级去重（engine.detectDuplicate）实现跨路径近重复根治。
 *
 * 纯函数、零 IO，可独立单测。
 */
import { randomUUID } from 'node:crypto'
import { contentHash } from './store'
import type { MemoryEntry, MemoryKind, MemorySource } from './types'

/** 记忆条目组装输入（路径无关的语义视图） */
export interface EntryInput {
  /** 记忆正文（工厂内部负责 trim 与截断） */
  content: string
  kind: MemoryKind
  /** 请求方提供的 tags（工厂内部清洗：仅字符串、去重、去空白） */
  tags?: readonly string[]
  source: MemorySource
  workspace?: string
  sessionId?: string
  /** 单条最大字符数（截断） */
  maxChars: number
  /** 时间戳（ms，默认 Date.now()；注入以便可复算测试） */
  now?: number
  /** id 前缀（default ''）：捕获/显式用 ''（id=`<contentHash>-<uuid8>` 兼容 0.10.0），导入用 'imp' */
  idPrefix?: string
  /** 是否追加 8 位随机后缀（default true）：唯一性用；false 时 id=`<prefix>-<contentHash>` 纯内容幂等（importer 幂等 id） */
  idSuffix?: boolean
}

/**
 * 统一组装 MemoryEntry。
 * - id = `${idPrefix}-${contentHash}-${randomUUID8}`（idSuffix=true，default）：
 *   contentHash 保证同内容指纹一致（跨路径去重键），随机后缀保证同内容多次写入唯一；
 * - id = `${idPrefix}-${contentHash}`（idSuffix=false）：纯内容幂等 id（importer 用，跨来源/跨时间合并）；
 * - content 先 trim 后截断（maxChars）；
 * - tags 清洗：仅保留字符串、trim、去空、去重；
 * - workspace/sessionId 仅非空时写入（可选字段不落地 undefined）。
 */
export function makeEntry(input: EntryInput): MemoryEntry {
  const trimmed = input.content.trim()
  // 指纹针对「trim 后完整正文」而非截断版：兼容 0.10.0 语义——超长内容也按原全文
  // 哈希（跨路径 dedup 键与既有 id 断言一致），存储正文才按 maxChars 截断。
  const body = trimmed.slice(0, input.maxChars)
  // 清洗 tags：仅字符串 → trim → 去空白 → 去重（保持首现顺序）
  const cleanTags: string[] = []
  const seen = new Set<string>()
  for (const raw of input.tags ?? []) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    cleanTags.push(t)
  }
  const now = input.now ?? Date.now()
  const prefix = input.idPrefix ?? ''
  const suffix = input.idSuffix === false ? '' : `-${randomUUID().slice(0, 8)}`
  const entry: MemoryEntry = {
    id: `${prefix}${prefix ? '-' : ''}${contentHash(trimmed)}${suffix}`,
    kind: input.kind,
    content: body,
    tags: cleanTags,
    source: input.source,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
  }
  if (input.workspace) entry.workspace = input.workspace
  if (input.sessionId) entry.sessionId = input.sessionId
  return entry
}

/**
 * 取代协议 tag 常量（DESIGN-1.0 模块 A；tags 兼容协议，MemoryEntry 契约零变更）。
 * - 新记忆 tags 含 `supersede:<旧id>`（1 条）；
 * - 被取代的旧记忆 tags 追加 `superseded-by:<新id>`（queryIndex 对含该 tag 的条目降权）。
 */
export const SUPERSEDE_TAG_PREFIX = 'supersede:'
export const SUPERSEDED_BY_TAG_PREFIX = 'superseded-by:'

/** 判断条目 tags 是否含「被取代」标记（召回降权判定） */
export function isSuperseded(entry: MemoryEntry): boolean {
  return entry.tags.some((t) => t.startsWith(SUPERSEDED_BY_TAG_PREFIX))
}

/** 取出取代标记指向的旧条目 id（supersede:<id> → id；无则 undefined） */
export function supersedeTargetId(entry: MemoryEntry): string | undefined {
  for (const t of entry.tags) {
    if (t.startsWith(SUPERSEDE_TAG_PREFIX)) return t.slice(SUPERSEDE_TAG_PREFIX.length)
  }
  return undefined
}

/** 取出被取代标记指向的新条目 id（superseded-by:<id> → id；无则 undefined） */
export function supersededByTargetId(entry: MemoryEntry): string | undefined {
  for (const t of entry.tags) {
    if (t.startsWith(SUPERSEDED_BY_TAG_PREFIX)) return t.slice(SUPERSEDED_BY_TAG_PREFIX.length)
  }
  return undefined
}
