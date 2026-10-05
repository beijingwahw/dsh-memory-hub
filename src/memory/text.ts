/**
 * 内容块文本提取（0.7.0 去重：index.ts 与 importer.ts 的唯一实现）。
 *
 * 从模型可见内容块（ContentBlock 结构）宽容提取纯文本：
 * - `{ type: 'text', text }` → 直接取 text；
 * - `{ type: 'tool-result', content }` → 递归提取（工具结果内嵌 content 块）；
 * - 嵌套数组递归拼接；未知类型/形状静默忽略（不抛错、不产生噪音）。
 *
 * 语义约定：顶层数组最终 trim（与历史 blocksToText/extractTextBlocks 行为一致）。
 * 0.9.0 词边界感知拼接（F 薄弱项）：相邻块若都以 ASCII 词字符（[A-Za-z0-9_]）
 * 收尾/开头，则补一个空格分隔——修复 `Use pnpm` + `for installs` → `Use pnpmfor installs`
 * 的英文粘连（切词错误、召回精度下降）；中文/标点边界不插分隔，逐字节兼容 0.7.0 断言
 * （`甲乙`、`结果：共 12 条`、`甲 乙` 等）。
 * 纯函数、零外部依赖。
 */

/** ASCII 词字符判定（0.9.0 词边界感知拼接专用） */
function isWordChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'
}

/** 递归提取：数组逐项拼接、text 取文本、tool-result 递归、其余忽略 */
export function extractTextBlocks(blocks: unknown): string {
  if (blocks === null || blocks === undefined) return ''
  if (Array.isArray(blocks)) {
    let out = ''
    for (const b of blocks) {
      const part = extractTextBlocks(b)
      if (!part) continue // 空块不参与边界判定、不产生分隔
      const tail = out.length > 0 ? out[out.length - 1]! : ''
      const head = part[0]!
      // 词边界：前块末尾与后块开头都是词字符 → 插一个空格（仅英文/数字粘连场景）
      if (out.length > 0 && isWordChar(tail) && isWordChar(head)) out += ' '
      out += part
    }
    return out.trim()
  }
  if (typeof blocks === 'object') {
    const b = blocks as Record<string, unknown>
    if (b['type'] === 'text' && typeof b['text'] === 'string') return b['text']
    if (b['type'] === 'tool-result') return extractTextBlocks(b['content'])
  }
  return ''
}
