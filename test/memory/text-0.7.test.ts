import { describe, expect, it } from 'vitest'
import { extractTextBlocks } from '../../src/memory/text'
import { extractTextBlocks as importerExtractTextBlocks } from '../../src/memory/importer'

describe('extractTextBlocks 文本提取（0.7.0, U2 唯一实现）', () => {
  it('text 块直接取文本，顶层数组 trim 首尾空白', () => {
    expect(
      extractTextBlocks([
        { type: 'text', text: '  你好 ' },
        { type: 'text', text: '世界' },
      ]),
    ).toBe('你好 世界')
  })

  it('多块拼接并 trim 顶层首尾（块内空白保留）', () => {
    expect(
      extractTextBlocks([
        { type: 'text', text: ' 甲 ' },
        { type: 'text', text: ' 乙 ' },
      ]),
    ).toBe('甲  乙')
    expect(
      extractTextBlocks([
        { type: 'text', text: ' 甲 ' },
        { type: 'text', text: '乙' },
      ]),
    ).toBe('甲 乙')
  })

  it('tool-result 递归提取内嵌 content 块', () => {
    const blocks = [
      { type: 'text', text: '结果：' },
      { type: 'tool-result', content: [{ type: 'text', text: '共 12 条' }] },
    ]
    expect(extractTextBlocks(blocks)).toBe('结果：共 12 条')
  })

  it('tool-result 多层嵌套仍可递归', () => {
    const blocks = [
      { type: 'tool-result', content: [{ type: 'tool-result', content: [{ type: 'text', text: '深层文本' }] }] },
    ]
    expect(extractTextBlocks(blocks)).toBe('深层文本')
  })

  it('嵌套数组递归拼接', () => {
    const blocks: unknown = [[{ type: 'text', text: '甲' }], [{ type: 'text', text: '乙' }]]
    expect(extractTextBlocks(blocks)).toBe('甲乙')
  })

  it('text 字段非字符串时忽略', () => {
    expect(extractTextBlocks([{ type: 'text', text: 42 }])).toBe('')
  })

  it('未知类型 / 非块对象静默忽略（不抛错）', () => {
    expect(extractTextBlocks([{ type: 'image', src: 'x.png' }, { hello: 1 }])).toBe('')
  })

  it('null / undefined / 标量返回空串', () => {
    expect(extractTextBlocks(null)).toBe('')
    expect(extractTextBlocks(undefined)).toBe('')
    expect(extractTextBlocks('plain')).toBe('')
    expect(extractTextBlocks(42)).toBe('')
  })

  it('object 但无 type 字段忽略', () => {
    expect(extractTextBlocks({ foo: 'bar' })).toBe('')
  })

  it('tool-result 内嵌字符串标量（宽松形状）', () => {
    expect(extractTextBlocks([{ type: 'tool-result', content: '直接文本' }])).toBe('')
  })
})

describe('importer re-export 等价性（0.7.0, U2 去重）', () => {
  const SAMPLES: unknown[] = [
    [{ type: 'text', text: '会话内容' }],
    [
      { type: 'text', text: '甲' },
      { type: 'tool-result', content: [{ type: 'text', text: '乙' }] },
    ],
    null,
    undefined,
    'plain',
    [{ type: 'unknown' }],
  ]

  it('importer 导出的 extractTextBlocks 与 text.ts 行为完全一致', () => {
    for (const s of SAMPLES) {
      expect(importerExtractTextBlocks(s)).toBe(extractTextBlocks(s))
    }
  })
})
