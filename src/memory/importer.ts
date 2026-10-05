/**
 * 真实数据接入层（0.6.0, REALDATA-0.6）
 *
 * 把用户已经沉淀的真实数据资产批量接入记忆库，让插件"开箱即有记忆"：
 * - Markdown / 纯文本记忆文件（AGENTS.md、MEMORY.md、USER.md 等）→ 显式记忆；
 * - Harness 会话事件 JSONL 日志（SessionEvent 序列化）→ 自动记忆；
 * - 内容级幂等：同一内容多次导入（含不同文件、不同时间）合并为同一条目。
 *
 * 全部为纯函数，零外部依赖，便于单测覆盖与跨设备可复算。
 */
import { containsSensitive, INSTRUCTION_SIGNAL_TERMS, PREFERENCE_SIGNAL_TERMS } from './capture'
import { extractTextBlocks } from './text'
import { detectDuplicate } from './engine'
import { makeEntry } from './entry-factory'
import type { MemoryEntry, MemoryKind, MemorySource } from './types'

// 0.7.0：文本提取归一至 ./text（唯一实现），此处仅 re-export 保持既有导入路径兼容
export { extractTextBlocks }

/** 一个可导入的文档源（label 常为文件路径，仅用于打标） */
export interface DocumentSource {
  label: string
  text: string
}

/** 一个可导入的会话日志源（JSONL 原始行） */
export interface SessionSource {
  label: string
  lines: string[]
}

/** 导入选项 */
export interface ImportOptions {
  /** 信号词推断模式（预留，与插件捕获模式语义一致；当前不影响推断规则） */
  mode?: 'conservative' | 'balanced' | 'aggressive'
  /** 单条记忆最大字符数（默认 1000，对齐 maxEntryChars） */
  maxChars?: number
  /** 时间戳注入（ms，默认 Date.now()）；同基准下可复算 */
  now?: number
}

/**
 * 导入统计（total = imported + droppedShort + droppedSensitive + droppedDuplicate 恒成立，
 * corruptLines 为会话行级计数，不入块级恒等式）
 */
export interface ImportStats {
  /** 去重前的全部候选条目数（文档块 + 会话事件文本；含批内重复、库内重复、短块、敏感块） */
  total: number
  /** 进入 entries 的条数 */
  imported: number
  /** 长度 < 8 的噪声块 */
  droppedShort: number
  /** 命中敏感模式的块（不入库） */
  droppedSensitive: number
  /** 1.0.0（UF-1.0）：与库内既有条目内容级重复（任意 id 前缀同指纹/近重复）被拒绝的块 */
  droppedDuplicate: number
  /** 会话日志 JSON 解析失败的损坏行 */
  corruptLines: number
}

/** 导入计划：规范化后的 MemoryEntry 列表 + 统计 */
export interface ImportPlan {
  entries: MemoryEntry[]
  stats: ImportStats
}

/** 会话事件行提取结果 */
export type SessionTextResult =
  { ok: true; text: string; isUser: boolean } | { ok: false; reason: 'corrupt' | 'unhandled' }

/**
 * 把 Markdown / 纯文本切分为记忆语义块。
 *
 * 规则（稳定、无状态）：
 * - 标题行（# 开头，去掉井号保留正文）、列表行（无序/有序）各自成块；
 * - 连续普通文本行聚合成一段（直至遇到标题/列表/空行）；
 * - 纯链接索引行（`- [name](url)` 整行）跳过（MEMORY.md 索引是元数据）；
 * - 空行与分隔线（---）作为段的边界。
 */
export function splitDocument(text: string): string[] {
  const blocks: string[] = []
  let plain: string[] = []

  const flush = (): void => {
    if (plain.length) {
      blocks.push(plain.join(' ').trim())
      plain = []
    }
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || /^-{3,}\s*$/.test(line)) {
      flush()
      continue
    }
    if (/^#+\s/.test(line)) {
      flush()
      blocks.push(line.replace(/^#+\s*/, '').trim())
      continue
    }
    if (/^\s*[-*+]\s/.test(line)) {
      const entry = line.replace(/^[-*+]\s+/, '')
      // 纯链接索引行（无描述）跳过
      if (/^\[[^\]]+\]\([^)]+\)\s*$/.test(entry)) {
        flush()
        continue
      }
      flush()
      blocks.push(entry)
      continue
    }
    if (/^\d+\.\s/.test(line)) {
      flush()
      blocks.push(line.replace(/^\d+\.\s+/, ''))
      continue
    }
    plain.push(line)
  }
  flush()
  return blocks
}

/**
 * 宽容递归：从 ContentBlock 结构提取纯文本（0.7.0 起实现归一至 ./text.ts，
 * 此处 re-export 保持兼容；行为见 text.ts）。
 */

/**
 * 解析一行会话 JSONL。
 * - `user/message` → 取 data.content；
 * - `assistant/message` → 取 data.message.content（缺省回退 data.content）；
 * - JSON 解析失败 → { ok:false, reason:'corrupt' }；
 * - 非目标事件 / 无文本 → { ok:false, reason:'unhandled' }。
 */
export function extractSessionText(line: string): SessionTextResult {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'unhandled' }
  const e = value as Record<string, unknown>
  const type = e['type']
  if (type === 'user/message') {
    const data = e['data'] as Record<string, unknown> | undefined
    return textResult(extractTextBlocks(data?.['content']), true)
  }
  if (type === 'assistant/message') {
    const data = e['data'] as Record<string, unknown> | undefined
    const message = data?.['message'] as Record<string, unknown> | undefined
    const content = message?.['content'] ?? data?.['content']
    return textResult(extractTextBlocks(content), false)
  }
  return { ok: false, reason: 'unhandled' }
}

/** 非空文本包装为 ok 结果，空文本视为 unhandled */
function textResult(text: string, isUser: boolean): SessionTextResult {
  const trimmed = text.trim()
  return trimmed ? { ok: true, text: trimmed, isUser } : { ok: false, reason: 'unhandled' }
}

/**
 * 指令性/偏好性信号正则（1.0.0 起由 capture.ts 语义词表**编译派生**，单一事实源）。
 * 0.10.0 在此内联第二份词表（INSTRUCTION_HINTS/PREFERENCE_HINTS），与 capture.ts
 * 不同源 → 跨文件漂移（CODE-WALKTHROUGH.html 疑点 9）。1.0.0 彻底消灭双份词表：
 * 新增强度词只改 capture.ts 一处，此处与捕获侧自动同步，不可漂移。
 */
const INSTRUCTION_HINTS = new RegExp(`(?:${INSTRUCTION_SIGNAL_TERMS.join('|')})`, 'i')
const PREFERENCE_HINTS = new RegExp(`(?:${PREFERENCE_SIGNAL_TERMS.join('|')})`, 'i')

/**
 * 离线文本的 kind 推断（信号词子集，与 capture.ts 语义对表）：
 * - 指令性信号 → instruction（"永远不要在提交里泄露密钥"）；
 * - 偏好性信号 → preference（"记住要用 pnpm"）；
 * - 其余 → generic。
 * 不产 fact/decision：离线文档无工具执行上下文，无法可靠判定，宁缺毋滥。
 */
export function inferKind(text: string): MemoryKind {
  if (INSTRUCTION_HINTS.test(text)) return 'instruction'
  if (PREFERENCE_HINTS.test(text)) return 'preference'
  return 'generic'
}

/**
 * 0.9.0 G：说话者感知的 kind 分类（isUser 字段正式消费）。
 * 用户句（isUser=true）保持 inferKind 高置信推断；
 * 助手句（isUser=false）的偏好信号**降为 generic**——助手复述叮嘱 ≠ 用户偏好
 * （0.8.0 实锤：planImport 从未使用 extractSessionText 的 isUser，死字段），
 * 指令信号保持 instruction（规则复述仍有长期价值）。
 */
export function inferSpeakerKind(text: string, isUser: boolean): MemoryKind {
  if (isUser) return inferKind(text)
  const kind = inferKind(text)
  return kind === 'preference' ? 'generic' : kind
}

/**
 * 0.9.0 M：模式化 kind 推断（ImportOptions.mode 正式落地，此前为死配置）。
 * - conservative：仅高置信指令词/偏好词判定 kind，语义弱信号一律 generic；
 * - balanced（默认）：inferKind 现状语义（既有导入行为逐字节不变）；
 * - aggressive：inferKind 现状语义（与 balanced 一致：关键词与保守面相同的
 *   离线文本判定，区别主要在捕获侧，此处保持单一推断规则，文档注明）。
 */
export function inferKindWithMode(text: string, mode: ImportOptions['mode']): MemoryKind {
  if (mode === 'conservative') {
    if (INSTRUCTION_HINTS.test(text)) return 'instruction'
    if (PREFERENCE_HINTS.test(text)) return 'preference'
    return 'generic'
  }
  return inferKind(text)
}

/** 从 label 提取打标用的文件 basename（含扩展名；路径分隔符 / 或 \） */
function labelTag(label: string): string {
  const idx = Math.max(label.lastIndexOf('/'), label.lastIndexOf('\\'))
  return idx >= 0 ? label.slice(idx + 1) : label
}

/**
 * 真实数据 → 规范化导入计划。
 * 文档块 source='explicit'、会话文本 source='auto'；
 * 统一走 entry-factory.makeEntry：id = `imp-${contentHash}`（无随机后缀，内容级幂等，
 * 跨来源/跨时间合并；与捕获/显式路径的 `contentHash-uuid8` 前缀不同但指纹一致）；
 * 敏感过滤、长短校验、超长截断后进入 entries。
 * 1.0.0（UF-1.0）：新增可选 existing（当前库内容）——导入前先做**库内内容级去重**
 * （engine.detectDuplicate：任意 id 前缀同指纹或窗口内近重复），命中计 droppedDuplicate
 * 且不入库；与捕获路径对同一文本互认重复，根治"导入/捕获双 id 并存"（疑点 7）。
 */
export function planImport(input: {
  documents?: DocumentSource[]
  sessions?: SessionSource[]
  options?: ImportOptions
  /** 1.0.0：当前库内条目（可选；未传则不做库内去重，行为与 0.10.0 逐字节一致） */
  existing?: readonly MemoryEntry[]
}): ImportPlan {
  const opts: Required<ImportOptions> = {
    mode: 'balanced',
    maxChars: 1000,
    now: Date.now(),
    ...(input.options ?? {}),
  }
  const stats: ImportStats = {
    total: 0,
    imported: 0,
    droppedShort: 0,
    droppedSensitive: 0,
    droppedDuplicate: 0,
    corruptLines: 0,
  }
  const entries: MemoryEntry[] = []
  const seen = new Set<string>()

  const push = (content: string, kind: MemoryKind, source: MemorySource, tags: string[]): void => {
    const key = content.trim()
    if (seen.has(key)) return // 内容级幂等：重复候选不重复入库、不重复计数
    const body = key.length > opts.maxChars ? key.slice(0, opts.maxChars) : key
    if (body.length < 8) {
      stats.droppedShort++
      return
    }
    if (containsSensitive(body)) {
      stats.droppedSensitive++
      return
    }
    // 1.0.0（UF-1.0）：与库内既有内容重复 → 拒绝并计数（existing 未提供时恒 0，行为与旧版一致）
    const existing = input.existing
    if (existing !== undefined && existing.length > 0 && detectDuplicateFrom(existing, body, opts.now)) {
      stats.droppedDuplicate++
      return
    }
    seen.add(key)
    const entry = makeEntry({
      content: body,
      kind,
      tags,
      source,
      maxChars: opts.maxChars,
      now: opts.now,
      idPrefix: 'imp',
      idSuffix: false,
    })
    entries.push(entry)
  }

  for (const doc of input.documents ?? []) {
    const tag = labelTag(doc.label)
    for (const block of splitDocument(doc.text)) {
      // 0.9.0 M：文档块按 ImportOptions.mode 推断（默认 balanced = 0.8.0 语义）
      push(block, inferKindWithMode(block, opts.mode), 'explicit', ['imported', tag])
    }
  }

  for (const session of input.sessions ?? []) {
    for (const line of session.lines) {
      const hit = extractSessionText(line)
      if (!hit.ok) {
        if (hit.reason === 'corrupt') stats.corruptLines++
        continue
      }
      // 0.9.0 G：会话文本按说话者感知分类（isUser 正式生效）
      push(hit.text, inferSpeakerKind(hit.text, hit.isUser), 'auto', ['imported', 'session'])
    }
  }

  stats.total = entries.length + stats.droppedShort + stats.droppedSensitive + stats.droppedDuplicate
  stats.imported = entries.length
  return { entries, stats }
}

/**
 * 1.0.0（UF-1.0）：库内内容级去重判定（importer 专用包装）。
 * 窗口语义对齐捕获路径：detectDuplicate 对 existing 按 createdAt 窗口（24h×30d 宽窗，
 * 保持导入场景的保守性）判定同指纹/近重复。导出便于专项测试。
 * @internal 主要供 planImport 使用；external 调用请直接用 engine.detectDuplicate。
 */
export function detectDuplicateFrom(
  existing: readonly MemoryEntry[],
  content: string,
  now: number,
  windowMs = 30 * 24 * 60 * 60 * 1000,
): boolean {
  return detectDuplicate(existing, content, windowMs, now)
}
