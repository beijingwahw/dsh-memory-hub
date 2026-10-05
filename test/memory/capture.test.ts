import { describe, expect, it } from 'vitest'
import {
  containsSensitive,
  extractFromAssistant,
  extractFromToolResult,
  extractFromUserMessage,
} from '../../src/memory/capture'

describe('containsSensitive', () => {
  it('识别 API key / 密码 / JWT / 私钥 / 连接串', () => {
    expect(containsSensitive('key is sk-abc123def456ghi789jkl0mn')).toBe(true)
    expect(containsSensitive('password=supersecret')).toBe(true)
    expect(
      containsSensitive('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.aBcDeFgHiJkLmNoPqRsTuVwXyZ'),
    ).toBe(true)
    expect(containsSensitive('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(containsSensitive('mongodb+srv://user:pass@cluster.example.com/db')).toBe(true)
    expect(containsSensitive('https://user:pass@host.example.com/path')).toBe(true)
  })
  it('普通文本不误伤', () => {
    expect(containsSensitive('今天天气不错，适合写代码')).toBe(false)
    expect(containsSensitive('the password field is validated on server side')).toBe(false)
  })
})

describe('extractFromUserMessage', () => {
  it('off 模式不捕获', () => {
    expect(extractFromUserMessage('请记住我喜欢喝美式咖啡', 'off')).toEqual([])
  })

  it('显式记忆动词整句入库', () => {
    const cands = extractFromUserMessage('记住我以后都用 pnpm 装包', 'balanced')
    expect(cands.length).toBe(1)
    expect(cands[0]!.kind).toBe('preference')
    expect(cands[0]!.content).toContain('记住')
  })

  it('balanced 模式需要足够信号', () => {
    expect(extractFromUserMessage('我今天吃了午饭', 'balanced')).toEqual([])
    const cands = extractFromUserMessage('以后写前端默认用 Vue，样式统一用 Tailwind', 'balanced')
    expect(cands.length).toBeGreaterThan(0)
  })

  it('aggressive 模式单一信号词即可', () => {
    const cands = extractFromUserMessage('我习惯中午集中回消息', 'aggressive')
    expect(cands.length).toBe(1)
    expect(cands[0]!.kind).toBe('preference')
  })

  it('保守模式需要强信号', () => {
    expect(extractFromUserMessage('我以后可能会试试 Go', 'conservative')).toEqual([])
    expect(extractFromUserMessage('以后永远不要在生产环境执行 rm -rf', 'conservative')).toHaveLength(1)
  })

  it('敏感内容不捕获', () => {
    expect(extractFromUserMessage('记住 token 是 sk-abc123def456ghi789jkl0mn', 'aggressive')).toEqual([])
  })
})

describe('extractFromToolResult', () => {
  it('结果性表述入库为 fact', () => {
    const cands = extractFromToolResult('run_code', '成功写入 128 行测试，全部通过', 'balanced')
    expect(cands.length).toBe(1)
    expect(cands[0]!.kind).toBe('fact')
    expect(cands[0]!.content).toContain('run_code')
  })

  it('非结果性输出不入库', () => {
    expect(extractFromToolResult('web_search', '这是一段普通的中文描述文字', 'balanced')).toEqual([])
  })

  it('超长输出仅激进模式取摘要头', () => {
    const long = 'x'.repeat(2500)
    expect(extractFromToolResult('run_code', `成功 ${long}`, 'conservative')).toEqual([])
    const cands = extractFromToolResult('run_code', `成功 ${long}`, 'aggressive')
    expect(cands.length).toBe(1)
    expect(cands[0]!.content.length).toBeLessThan(300)
  })
})

describe('extractFromAssistant', () => {
  it('仅 aggressive 且含结论词时捕获', () => {
    expect(extractFromAssistant('结论：建议采用事件驱动架构拆分模块', 'balanced')).toEqual([])
    const cands = extractFromAssistant('总结：这个方案的主要结论是成本可降 30%', 'aggressive')
    expect(cands.length).toBe(1)
    expect(cands[0]!.kind).toBe('generic')
  })
})
