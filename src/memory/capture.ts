/**
 * 事件驱动的记忆捕获。
 *
 * 从 dsh 会话事件（用户消息、工具结果、助手消息）中启发式提炼可记忆内容：
 * - 指令词（记住/以后/始终/不要/优先）→ preference / instruction；
 * - 工具成功执行的明确结论 → fact；
 * - 不做敏感信息入库：匹配 API key / 令牌 / 密码 / 连接串等模式即丢弃。
 *
 * 全部为纯函数，便于单测覆盖。
 */
import type { MemoryKind } from './types'

/** 捕获模式：off / conservative / balanced / aggressive */
export type CaptureMode = 'off' | 'conservative' | 'balanced' | 'aggressive'

/** 单条捕获候选 */
export interface CaptureCandidate {
  kind: MemoryKind
  content: string
  tags: string[]
}

/** 显式记忆动词：用户直接说「记住 xxx」 */
const MEMORIZE_VERBS = ['记住', '记下', '记得', '把我的', '请记住', 'remember']

/**
 * 0.9.0：单一信号源词法（drift-proof lexicon，主题 T1）。
 *
 * 全部捕获强度语义由三级词表派生，任何正则/数组均由词表编译生成，
 * 从构造上杜绝 0.8.0 的跨表漂移（STRONG_HINTS 含「务必/一定」而
 * PREFERENCE_HINTS 不含 → 空命中守卫短路强度检查，高置信指令漏记）。
 * 新增强度词只改词表一处，正则自动跟随。
 */

/** 高置信强度词（单一事实源）：conservative 模式命中单个即放行 */
export const STRONG_TERMS = ['务必', '一定', '永远', '始终', 'never', 'always'] as const

/** 中置信强度词（单一事实源）：balanced 模式命中单个即放行（与 STRONG_TERMS 部分重叠） */
export const BALANCED_STRONG_TERMS = [
  '记住',
  '以后',
  '始终',
  '永远',
  '优先',
  '偏好',
  '习惯',
  'never',
  'always',
] as const

/** 基础信号词（非强度；conservative/balanced 需 ≥2 命中才放行） */
const BASIC_TERMS = [
  '记得',
  '不要',
  '别',
  '避免',
  '喜欢',
  '不喜欢',
  '请务必',
  '请一定',
  '默认',
  '统一',
  '规范',
  '标准',
  'prefer',
  'remember',
  "don't",
  'do not',
  'avoid',
] as const

/**
 * 用户消息偏好/指令信号词全集（单一事实源）：
 * 强词与中置信词全部并入，确保「命中强度词但基础表无词」时
 * 强度检查可达（0.8.0 B 缺陷根因：PREFERENCE_HINTS 无裸「务必/一定」）。
 * Set 去重（三表存在大量重叠词），导出供测试与文档引用。
 */
export const PREFERENCE_HINTS: readonly string[] = [
  ...new Set<string>([...STRONG_TERMS, ...BALANCED_STRONG_TERMS, ...BASIC_TERMS]),
]

/** 高置信强度词（0.8.0 起命名共享，0.9.0 起由 STRONG_TERMS 编译派生）：conservative 命中单个即放行 */
export const STRONG_HINTS = new RegExp(`(?:${STRONG_TERMS.join('|')})`, 'i')

/** 中置信强度词（0.8.0 起命名共享，0.9.0 起由 BALANCED_STRONG_TERMS 编译派生）：balanced 命中单个即放行 */
export const BALANCED_STRONG_HINTS = new RegExp(`(?:${BALANCED_STRONG_TERMS.join('|')})`, 'i')

/**
 * 1.0.0（DESIGN-1.0 疑点 9 修复）：语义信号词表单一事实源。
 * 0.10.0 的 importer 内联了第二份信号词正则（INSTRUCTION_HINTS/PREFERENCE_HINTS），
 * 与 capture.ts 词表不同源 → 跨文件漂移。1.0.0 将「指令」「偏好」两组语义词面
 * 收敛于此（覆盖 importer 原正则全部词面 + capture 既有词面并集），importer 由此
 * 编译派生，彻底消灭双份词表。新增词只增强、不删词，既有推断行为保持超集兼容。
 */
export const INSTRUCTION_SIGNAL_TERMS: readonly string[] = [
  '不要',
  '别',
  '避免',
  '禁止',
  '必须',
  '务必',
  '请务必',
  '请一定',
  '始终',
  '永远',
  '请勿',
  'never',
  'always',
  "don't",
  'do not',
] as const

/** 1.0.0：偏好语义信号词面（单一事实源；importer 由此编译派生 PREFERENCE_HINTS） */
export const PREFERENCE_SIGNAL_TERMS: readonly string[] = [
  '记住',
  '记得',
  '以后',
  '优先',
  '偏好',
  '喜欢',
  '习惯',
  '默认',
  '倾向于',
  'remember',
  'prefer',
] as const

/**
 * 1.0.0（DESIGN-1.0 模块 A1）：对立/取代信号词面（单一事实源）。
 * 命中表示「新内容宣布旧约定作废」（改用/换成/不再是/升级到/移到/取消/不用……），
 * supersedeMode='auto' 时据此建立 supersede 取代关系；召回时被取代记忆降权。
 */
export const OPPOSING_SIGNAL_TERMS: readonly string[] = [
  '改用',
  '换成',
  '不要再用',
  '不再用',
  '不用了',
  '取消',
  '升级到',
  '迁移到',
  '移到',
  '不再是',
  'switch to',
  'migrate to',
  'replace',
  'instead of',
  'now use',
] as const

/** 1.0.0：对立/取代信号正则（由 OPPOSING_SIGNAL_TERMS 编译派生，单一事实源不可漂移） */
export const OPPOSING_HINTS = new RegExp(`(?:${OPPOSING_SIGNAL_TERMS.join('|')})`, 'i')

/** 1.0.0：文本是否含「取代旧约定」的对立信号（supersedeMode='auto' 时触发取代判定） */
export function hasOpposingSignal(text: string): boolean {
  return OPPOSING_HINTS.test(normalizeForMatch(text))
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9]{16,}\b/i, // OpenAI 风格 key
  /\b[0-9a-f]{40}\b/i, // sha1 长度 token
  /\beyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\./i, // JWT（输入已 NFKC + 小写归一化）
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(?:\s*[:=]\s*)\S+/i,
  /-----BEGIN (?:rsa |ec |openssh )?private key-----/i,
  /mongodb(?:\+srv)?:\/\/\S+/i,
  /(?:https?:\/\/)?[^\s@]+:[^\s@]+@[^\s@]+/i, // user:pass@host
  /\bakia[0-9a-z]{16}\b/i, // AWS Access Key
  /\bgh[pousr]_[a-z0-9]{36,}\b/i, // GitHub token（pat/oauth/sso)
  /\bxox[baprs]-[a-z0-9-]{10,}\b/i, // Slack token
  /\baiza[0-9a-z_-]{35}\b/i, // GCP API key
]

/**
 * 归一化文本用于模式匹配：NFKC 折叠全角/异体字符（ｐａｓｓｗｏｒｄ → password），
 * 并统一小写。仅用于敏感检测与信号词匹配，原文保持原样入库。
 */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase()
}

/** 判断文本是否含敏感信息（命中即不入库；先归一化防 Unicode 变体绕过） */
export function containsSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(normalizeForMatch(text)))
}

/** 从用户消息提炼偏好/指令候选 */
export function extractFromUserMessage(
  text: string,
  mode: CaptureMode = 'balanced',
  autoTags = true,
): CaptureCandidate[] {
  if (mode === 'off' || !text || text.length < 6 || containsSensitive(text)) return []

  const trimmed = text.trim()
  const lower = trimmed.toLocaleLowerCase()

  // 显式记忆动词：整句作为 preference/instruction
  if (MEMORIZE_VERBS.some((v) => lower.includes(v.toLocaleLowerCase()))) {
    // 0.9.0 L：autoTags=false 时清空自动标签（autoTags 配置正式消费，不再是无效果开关）
    return autoTags
      ? [{ kind: 'preference', content: trimmed, tags: ['explicit', 'preference'] }]
      : [{ kind: 'preference', content: trimmed, tags: [] }]
  }

  const hits = PREFERENCE_HINTS.filter((h) => lower.includes(h.toLocaleLowerCase()))
  if (hits.length === 0) return []

  // conservative：至少两个信号词或包含明确强度词（单一高置信词可放行）
  if (mode === 'conservative' && hits.length < 2 && !STRONG_HINTS.test(lower)) {
    return []
  }
  // balanced：至少两个信号词或包含高频偏好强度词（单一中置信词可放行）
  if (mode === 'balanced' && hits.length < 2 && !BALANCED_STRONG_HINTS.test(lower)) {
    return []
  }

  // 截取信号词所在句子片段（hits 非空已由上方守卫保证，此处收敛断言）
  const first = hits[0]
  if (first === undefined) return []
  const candidate = extractSnippet(trimmed, first)
  // 0.9.0 L：autoTags=false 清空自动标签
  return autoTags
    ? [{ kind: 'preference', content: candidate, tags: ['auto', 'preference'] }]
    : [{ kind: 'preference', content: candidate, tags: [] }]
}

/** 从工具结果提炼事实候选（输出较长或含敏感信息则跳过） */
export function extractFromToolResult(
  toolName: string,
  outputText: string,
  mode: CaptureMode = 'balanced',
  autoTags = true,
): CaptureCandidate[] {
  if (mode === 'off' || !outputText || outputText.length < 6 || containsSensitive(outputText)) return []
  if (outputText.length > 2000) {
    // 长输出不做整段入库，取摘要头
    if (mode === 'aggressive') {
      return autoTags
        ? [{ kind: 'fact', content: `${toolName}: ${outputText.slice(0, 120)}…`, tags: ['auto', 'fact', toolName] }]
        : [{ kind: 'fact', content: `${toolName}: ${outputText.slice(0, 120)}…`, tags: [] }]
    }
    return []
  }

  const trimmed = outputText.trim()
  // 只看像「结论」的内容：以结果性表述开头，或包含明确结果词
  const looksConclusive =
    /^(成功|完成|已|结果|结论|生成|写入|创建|删除|修复|通过|失败|报错|错误|summar|result|done|ok|success|error|fail)/i.test(
      trimmed,
    ) || /(总计|共|完成|成功|失败|错误|通过|耗时|用时)/.test(trimmed.slice(0, 60))

  if (!looksConclusive) return []

  const content = `${toolName} 执行结果: ${trimmed.slice(0, 300)}`
  return autoTags
    ? [{ kind: 'fact', content, tags: ['auto', 'fact', toolName] }]
    : [{ kind: 'fact', content, tags: [] }]
}

/** 从助手消息提炼通用记忆（保守：仅 aggressive 且含明确结论） */
export function extractFromAssistant(
  text: string,
  mode: CaptureMode = 'balanced',
  autoTags = true,
): CaptureCandidate[] {
  if (mode !== 'aggressive' || !text || text.length < 10 || containsSensitive(text)) return []
  const trimmed = text.trim()
  if (/(结论|总结|要点|建议|推荐|decision|summary|conclusion)/i.test(trimmed.slice(0, 80))) {
    return autoTags
      ? [{ kind: 'generic', content: trimmed.slice(0, 300), tags: ['auto', 'summary'] }]
      : [{ kind: 'generic', content: trimmed.slice(0, 300), tags: [] }]
  }
  return []
}

/** 截取包含信号词的小句子（≤160 字符） */
function extractSnippet(text: string, hint: string): string {
  const idx = text.toLocaleLowerCase().indexOf(hint.toLocaleLowerCase())
  if (idx < 0) return text.slice(0, 160)
  const start = Math.max(0, idx - 20)
  const end = Math.min(text.length, idx + hint.length + 120)
  return text.slice(start, end).trim()
}
