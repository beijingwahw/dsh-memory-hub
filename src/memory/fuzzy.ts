/**
 * 字符串近似匹配（1.1.1 自 engine.ts 拆出）。
 * - fuzzyVariants：编辑距离 ≤1 变体生成（A1 容错检索的查询侧扩展）；
 * - levenshtein：滚动两行 DP；
 * - similarity：归一化相似度（长文本降级 token Jaccard）。
 */
import { tokenSet } from './tokenize'

/** 模糊变体权重：仅当精确 BM25 为零时以 0.5 折扣计入（不干扰精确命中排序） */
export const FUZZY_VARIANT_WEIGHT = 0.5
/** 触发模糊变体扩展的最小英文词长（过短词的变体噪音大、信息量低） */
export const FUZZY_MIN_WORD_LEN = 4

/**
 * 生成英文词的编辑距离 ≤ 1 变体（删除 / 相邻交换 / 替换 / 插入）。
 * 仅处理小写纯字母词（由调用方保证），返回去重变体集（不含原词自身）。
 */
export function fuzzyVariants(word: string): Set<string> {
  const variants = new Set<string>()
  const n = word.length
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  // 删除（单字符）
  for (let i = 0; i < n; i++) variants.add(word.slice(0, i) + word.slice(i + 1))
  // 相邻交换：charAt 越界返回 ''，但循环条件 i+1 < n 保证不越界，等价于 word[i+1]!
  for (let i = 0; i + 1 < n; i++) {
    variants.add(word.slice(0, i) + word.charAt(i + 1) + word.charAt(i) + word.slice(i + 2))
  }
  // 替换与插入
  for (let i = 0; i < n; i++) {
    for (const ch of letters) {
      if (ch !== word.charAt(i)) variants.add(word.slice(0, i) + ch + word.slice(i + 1))
      variants.add(word.slice(0, i) + ch + word.slice(i))
    }
  }
  // 末尾插入
  for (const ch of letters) variants.add(word + ch)
  return variants
}

/**
 * 编辑距离（滚动两行 DP）。
 *
 * 算法不变式：进入第 i 行前 prev[0..b.length] 已完整填充；每行自左向右写 cur，
 * 只读 cur[j-1]（本轮左邻）与 prev[j]/prev[j-1]（上一行），所有读取点在访问时
 * 均已赋值。此处 `!` 是对该不变式的收敛断言，可由上述不变式直接证明。
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  // 0.8.0：空串分支（return b.length / a.length）经不变式证明不可达——本函数仅供 similarity 调用，
  // 而 similarity 入口先以 `if (!a || !b) return 0` 拦截空串；滚动数组实现对空串语义等价，予以移除
  let prev = new Array<number>(b.length + 1)
  let cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    // 整行交换引用而非拷贝，时间复杂度由 O(b.length) 降至 O(1)
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]!
}

/** 归一化相似度：1 表示完全相同 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  const maxLen = Math.max(a.length, b.length)
  // 0.8.0：maxLen === 0 已由上守卫（!a || !b）先行返回，此分支经不变式证明不可达，予以移除
  if (maxLen > 300) {
    // 长文本用 token 集合 Jaccard 近似
    const sa = tokenSet(a)
    const sb = tokenSet(b)
    if (sa.size === 0 || sb.size === 0) return 0
    let inter = 0
    for (const t of sa) if (sb.has(t)) inter++
    return inter / (sa.size + sb.size - inter)
  }
  return 1 - levenshtein(a, b) / maxLen
}
