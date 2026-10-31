/**
 * 分词与 token 估算（1.1.1 自 engine.ts 拆出；含中文分词根治）。
 *
 * 拆分动机：engine.ts 已膨胀为 8+ 职责的 god-module；分词是检索/去重/聚类/蒸馏
 * 四个消费方共享的基础设施，独立成模块。
 *
 * 1.1.1 中文分词修复（三项根治，此前的问题）：
 * - **伪 bigram**：旧实现先 `replace(/[^\u4e00-\u9fff]/g,'')` 剔除全部非 CJK 字符
 *   再整体切 bigram——"服务用k8s部署" 变成 "服务用部署"，产生跨英文边界的伪 bigram
 *   （"务用/用部"），污染 similarity、蒸馏共鸣词、semanticFeatures 三处；
 * - **扩展区不可检索**：只覆盖基本区 U+4E00-9FFF，扩展 A（U+3400-4DBF）、
 *   兼容区（U+F900-FAFF）、扩展 B+（代理对）汉字全部丢失；
 * - 现按**连续 CJK 段**切分：段内 2-gram、单字段独成 token，段间边界天然隔断。
 */

/** 英文高频虚词（无检索价值的停用词）；中文 2-gram 不设停止词（双字对天然含语义） */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'of',
  'to',
  'and',
  'or',
  'for',
  'with',
  'in',
  'on',
  'at',
  'by',
  'from',
  'as',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'he',
  'she',
  'they',
  'we',
  'you',
  'your',
  'his',
  'her',
  'their',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'not',
  'no',
  'but',
  'so',
  'if',
  'then',
  'than',
  'too',
  'very',
  'can',
  'will',
  'just',
  'should',
  'would',
  'could',
])

/**
 * 码点是否为 CJK 表意文字（覆盖基本区 / 扩展 A / 兼容区 / 扩展 B-F）。
 * 注意：不含 CJK 标点（U+3000-303F）与全角符号——它们没有检索语义。
 */
export function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字（基本区）
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
    (cp >= 0x20000 && cp <= 0x2ffff) // 扩展 B-F（代理对，经 codePointAt 正确取码点）
  )
}

/** 英文停止词判定（供 fuzzy 变体过滤等检索侧消费；单一事实源在本模块） */
export function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word)
}

/**
 * 提取检索词：英文单词小写（NFKC 折叠全角）+ 连续 CJK 段按 2-gram 切分。
 * 英文单字（<2）与停止词被过滤；数字/下划线词保留（如版本号、代码标识）。
 * 中文段内单字段独成 token；段与段之间不产生跨边界 bigram（伪 bigram 根治）。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.normalize('NFKC').toLocaleLowerCase()
  // 英文/数字词
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) {
    const w = m[0]
    if (w.length < 2) continue
    if (/^[a-z]+$/.test(w) && STOP_WORDS.has(w)) continue
    tokens.push(w)
  }
  // 中文：连续 CJK 段收集码点（代理对安全），段内切 2-gram、单字段独立成词
  const runChars: string[] = []
  const flushRun = (): void => {
    if (runChars.length === 1) {
      tokens.push(runChars[0]!)
    } else {
      for (let i = 0; i + 1 < runChars.length; i++) {
        tokens.push(runChars[i]! + runChars[i + 1]!)
      }
    }
    runChars.length = 0
  }
  for (let i = 0; i < lower.length;) {
    const cp = lower.codePointAt(i)!
    const width = cp > 0xffff ? 2 : 1
    if (isCjk(cp)) runChars.push(lower.slice(i, i + width))
    else flushRun()
    i += width
  }
  flushRun()
  return tokens
}

/** 文本的 token 集合（去重） */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

/**
 * FNV-1a 32 位散列（纯函数、无密码学依赖）。
 * 1.5.0 自 engine.ts 下沉：MinHash 签名（engine）、抽样复核（engine）与 HNSW 层指派
 * （vector.ts）三方共享——单一下沉避免第二份漂移实现（engine re-export 保持既有
 * `from './engine'` 导入路径零变更）。
 */
export function fnv1a(input: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * MinHash/A2 特征空间的计数版特征（1.5.0 随 semanticFeatures 下沉引入）。
 *
 * 关键设计（0.5.0 起）：特征必须与 BM25 词面命中**不同源**，否则「精确零命中」时
 * Jaccard 恒为 0，语义兜底退化为死代码。因此英文/数字词展开为**字符 3-gram**
 * （附首尾边界标记）：词根/形态变体（deploy ↔ deployment）即使整词不重叠也在字符
 * 层面共享大量 3-gram；中文 2-gram 本身即字符级，原样保留。
 * 1.5.0（模块 M）：向量第六线与本特征空间同源（TF·IDF 加权 + 余弦），
 * `semanticFeatures`（集合版）由本函数派生——单一事实源。
 */
export function semanticFeatureCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (f: string): void => {
    counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  for (const t of tokenize(text)) {
    if (/^[a-z0-9_]{3,}$/.test(t)) {
      add('^' + t.slice(0, 2))
      for (let i = 0; i + 3 <= t.length; i++) add(t.slice(i, i + 3))
      add(t.slice(-2) + '$')
    } else {
      add(t)
    }
  }
  return counts
}

/** 特征集合版（A2 语义线既有形状；由 semanticFeatureCounts 派生） */
export function semanticFeatures(text: string): Set<string> {
  return new Set(semanticFeatureCounts(text).keys())
}

/** token 计数（供查询向量） */
export function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1)
  return counts
}

/**
 * 简单 token 估算（1.1.1 修正中文标点计价）：
 * - CJK 表意文字 1 token/字（主流 tokenizer 实测 0.6-0.75，保守取 1，方向安全）；
 * - CJK 标点/全角符号 0.5（此前按全价 1 计，中文条目预算被高估 15-25%，
 *   实际召回条数被提前压缩）；
 * - 字母数字 4 字符/token；其余半角符号 0.5。
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp > 0x2e7f) {
      tokens += isCjk(cp) ? 1 : 0.5
    } else if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f) {
      tokens += 0.25
    } else {
      tokens += 0.5
    }
  }
  return Math.max(1, Math.ceil(tokens))
}
