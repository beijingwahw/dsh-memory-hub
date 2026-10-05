/**
 * 剩余薄弱分支专场（0.8.0 L11/L12）：
 * - capture：conservative/balanced 强弱信号词分支（单信号词 + 强度词放行边界）；
 * - importer：JSON 原始值行（非对象）宽容回落 unhandled；
 * - types：toMemoryEntry 可选字段（sessionId/workspace/lastAccessAt）拷贝分支。
 */
import { describe, expect, it } from 'vitest'
import { extractFromUserMessage } from '../../src/memory/capture'
import { extractSessionText } from '../../src/memory/importer'
import { toMemoryEntry } from '../../src/memory/types'

describe('capture 强弱信号词分支（L11）', () => {
  it('conservative：单一高置信强度词（务必）放行', () => {
    const cands = extractFromUserMessage('请务必使用 pnpm 统一包管理', 'conservative')
    expect(cands).toHaveLength(1)
    expect(cands[0]!.kind).toBe('preference')
  })

  it('conservative：单一普通信号词（以后）无强度词 → 拒绝', () => {
    expect(extractFromUserMessage('以后再说吧朋友', 'conservative')).toHaveLength(0)
  })

  it('conservative：两个及以上信号词 → 放行（无需强度词）', () => {
    const cands = extractFromUserMessage('以后优先使用 pnpm 吧', 'conservative')
    expect(cands).toHaveLength(1) // 命中「以后」「优先」两个信号词
  })

  it('balanced：单一中置信强度词（以后）放行', () => {
    const cands = extractFromUserMessage('以后再说吧朋友', 'balanced')
    expect(cands).toHaveLength(1)
  })

  it('balanced：单一弱信号词（不要）无强度词 → 拒绝', () => {
    expect(extractFromUserMessage('不要这样做也可以的', 'balanced')).toHaveLength(0)
  })

  it('aggressive：任何单一信号词即放行', () => {
    const cands = extractFromUserMessage('以后再说吧朋友', 'aggressive')
    expect(cands).toHaveLength(1)
  })

  it('off / 空文本 / 短文一律不捕获', () => {
    expect(extractFromUserMessage('记住', 'balanced')).toHaveLength(0) // <6 字符
    expect(extractFromUserMessage('', 'balanced')).toHaveLength(0)
    expect(extractFromUserMessage('以后再说吧朋友', 'off')).toHaveLength(0)
  })
})

describe('importer 非对象 JSON 行回落（L12）', () => {
  it('JSON 原始值行（数字/字符串/null）按 unhandled 容错，不误判 corrupt', () => {
    expect(extractSessionText('42')).toEqual({ ok: false, reason: 'unhandled' })
    expect(extractSessionText('"plain text"')).toEqual({ ok: false, reason: 'unhandled' })
    expect(extractSessionText('null')).toEqual({ ok: false, reason: 'unhandled' })
  })

  it('JSON 解析失败仍判 corrupt（守卫不回归）', () => {
    expect(extractSessionText('not-json{')).toEqual({ ok: false, reason: 'corrupt' })
  })

  it('正常 user/message 仍可提取（行为锚点）', () => {
    const line = JSON.stringify({
      type: 'user/message',
      data: { content: [{ type: 'text', text: '记住要用 pnpm 统一管理依赖' }] },
    })
    expect(extractSessionText(line).ok).toBe(true)
  })
})

describe('toMemoryEntry 可选字段拷贝（L12）', () => {
  it('sessionId / workspace / lastAccessAt 全备时逐字段拷贝', () => {
    const raw = {
      id: 'full-1',
      kind: 'preference',
      content: '完整字段记忆',
      tags: ['a', 'b'],
      source: 'explicit',
      sessionId: 'ses-9',
      workspace: 'w-x',
      createdAt: 111,
      updatedAt: 222,
      accessCount: 3,
      lastAccessAt: 333,
    }
    const out = toMemoryEntry(raw)
    expect(out).toBeDefined()
    expect(out!.sessionId).toBe('ses-9')
    expect(out!.workspace).toBe('w-x')
    expect(out!.lastAccessAt).toBe(333)
  })

  it('可选字段缺省时不携带 undefined 键（契约稳定）', () => {
    const raw = {
      id: 'min-1',
      kind: 'fact',
      content: '最小字段记忆',
      tags: [],
      source: 'auto',
      createdAt: 1,
      updatedAt: 2,
      accessCount: 0,
    }
    const out = toMemoryEntry(raw)
    expect(out).toBeDefined()
    expect('sessionId' in out!).toBe(false)
    expect('workspace' in out!).toBe(false)
    expect('lastAccessAt' in out!).toBe(false)
  })
})
