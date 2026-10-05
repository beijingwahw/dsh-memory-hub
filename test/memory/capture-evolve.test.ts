import { describe, expect, it } from 'vitest'
import {
  containsSensitive,
  extractFromAssistant,
  extractFromToolResult,
  extractFromUserMessage,
  normalizeForMatch,
} from '../../src/memory/capture'

describe('normalizeForMatch', () => {
  it('NFKC 折叠全角与异体字符并小写', () => {
    expect(normalizeForMatch('ｐａｓｓｗｏｒｄ')).toBe('password')
    expect(normalizeForMatch('ＡＢＣ１２３')).toBe('abc123')
  })
})

describe('containsSensitive 防 Unicode 变体绕过', () => {
  it('全角/异体字符不再绕过敏感过滤', () => {
    expect(containsSensitive('ｐａｓｓｗｏｒｄ ＝ ｓｕｐｅｒｓｅｃｒｅｔ')).toBe(true)
    expect(containsSensitive('token：ｓｋ－ａｂｃ１２３ｄｅｆ４５６ｇｈｉ７８９ｊｋｌ０ｍｎ')).toBe(true)
  })

  it('识别主流云厂商密钥格式', () => {
    expect(containsSensitive('AKIAIOSFODNN7EXAMPLE')).toBe(true) // AWS access key
    expect(containsSensitive('ghp_1234567890abcdefghijklmnopqrstuvwxyzAB')).toBe(true) // GitHub PAT
    expect(containsSensitive('xoxb-123456789012345678901234567890')).toBe(true) // Slack
    expect(containsSensitive('AIzaSyA1234567890abcdefghijklmnopqrstuv')).toBe(true) // GCP
  })

  it('普通文本不误伤', () => {
    expect(containsSensitive('今天的代码评审意见是统一命名规范')).toBe(false)
    expect(containsSensitive('项目 xox 模块待重构')).toBe(false)
  })
})

describe('提取器与归一化敏感拦截', () => {
  it('用户消息含全角敏感信息不捕获', () => {
    expect(
      extractFromUserMessage('记住 token：ｓｋ－ａｂｃ１２３ｄｅｆ４５６ｇｈｉ７８９ｊｋｌ０ｍｎ', 'aggressive'),
    ).toEqual([])
  })

  it('工具结果含敏感信息不捕获', () => {
    expect(extractFromToolResult('run_code', '成功，密码是 ｐａｓｓｗｏｒｄ ＝ １２３', 'aggressive')).toEqual([])
  })

  it('助手消息含敏感信息不捕获', () => {
    expect(extractFromAssistant('总结：连接串是 mongodb://user:ｐａｓｓ@host', 'aggressive')).toEqual([])
  })
})

describe('extractFromAssistant（0.2.0 修正路径）', () => {
  it('非 aggressive 一律不捕获', () => {
    expect(extractFromAssistant('结论：成本可降 30%', 'balanced')).toEqual([])
    expect(extractFromAssistant('结论：成本可降 30%', 'conservative')).toEqual([])
  })

  it('aggressive 且含结论信号词捕获为 generic/summary', () => {
    const cands = extractFromAssistant('总结：本次调研的核心要点是采用事件驱动拆分', 'aggressive')
    expect(cands.length).toBe(1)
    expect(cands[0]!.kind).toBe('generic')
    expect(cands[0]!.content).toContain('总结')
  })

  it('无结论信号词不捕获', () => {
    expect(extractFromAssistant('我们继续讨论下一个话题吧', 'aggressive')).toEqual([])
  })
})
