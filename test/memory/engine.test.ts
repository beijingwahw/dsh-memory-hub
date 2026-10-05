import { describe, expect, it } from 'vitest'
import {
  estimateTokens,
  isDuplicate,
  pruneExpired,
  recall,
  similarity,
  summarize,
  tokenize,
} from '../../src/memory/engine'
import type { MemoryEntry } from '../../src/memory/types'

const DAY = 24 * 60 * 60 * 1000

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `e-${content.length}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'fact',
    content,
    tags: [],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}

describe('estimateTokens', () => {
  it('中文按字、英文按词估算', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcd')).toBe(1)
    const both = estimateTokens('hello 世界')
    expect(both).toBeGreaterThanOrEqual(2)
  })
  it('至少 1 token', () => {
    expect(estimateTokens('!')).toBe(1)
    expect(estimateTokens('')).toBe(1)
  })
})

describe('tokenize', () => {
  it('英文单词小写化并切分中文二字组', () => {
    expect(tokenize('Hello World')).toContain('hello')
    expect(tokenize('你好世界')).toContain('你好')
    expect(tokenize('你好世界')).toContain('好世')
  })
})

describe('similarity', () => {
  it('相同文本为 1，无关文本接近 0', () => {
    expect(similarity('hello world', 'hello world')).toBe(1)
    expect(similarity('hello', 'xyzzy')).toBeLessThan(0.5)
  })
  it('空串判 0', () => {
    expect(similarity('', 'a')).toBe(0)
  })
})

describe('recall', () => {
  const memory = [
    entry('用户偏好使用 TypeScript 编写后端'),
    entry('项目部署到北欧节点，成本每月 200 美元'),
    entry('本周完成了登录模块的重构'),
  ]

  it('按相关性排序并命中预期', () => {
    const hits = recall(memory, 'TypeScript 后端')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toContain('TypeScript')
  })

  it('limit 生效', () => {
    const hits = recall(memory, '项目 部署 登录 TypeScript', { limit: 1 })
    expect(hits.length).toBe(1)
  })

  it('token 预算裁剪生效', () => {
    const big = Array.from({ length: 20 }, (_, i) => entry(`记忆内容${i} 与查询关键词完全一致 ${'x'.repeat(30)}${i}`))
    const hits = recall(big, '记忆内容 查询关键词', { maxTokens: 30, limit: 20 })
    expect(hits.length).toBeGreaterThan(0)
    const used = hits.reduce((acc, h) => acc + estimateTokens(`${h.kind} ${h.content}`), 0)
    expect(used).toBeLessThanOrEqual(30)
  })

  it('workspace 过滤生效', () => {
    const scoped = [entry('甲项目约定', { workspace: 'proj-a' }), entry('乙项目约定', { workspace: 'proj-b' })]
    const hits = recall(scoped, '项目约定', { workspace: 'proj-a' })
    expect(hits.length).toBe(1)
    expect(hits[0]!.content).toContain('甲')
  })

  it('新鲜记忆权重更高（时间衰减）', () => {
    const now = Date.now()
    const old = entry('很久以前的记忆关键词 alpha', { createdAt: now - 30 * DAY })
    const fresh = entry('最近的新记忆关键词 alpha', { createdAt: now })
    const hits = recall([old, fresh], 'alpha', { limit: 2, now })
    expect(hits[0]!.content).toContain('最近')
  })

  it('访问热度增加权重', () => {
    const a = entry('完全相同的检索内容 hot', { accessCount: 10 })
    const b = entry('完全相同的检索内容 hot')
    const hits = recall([a, b], 'hot', { limit: 2 })
    expect(hits[0]!.id).toBe(a.id)
  })
})

describe('isDuplicate / pruneExpired / summarize', () => {
  it('窗口内近似重复判定为重复', () => {
    const existing = [entry('我喜欢用 Python 写脚本')]
    expect(isDuplicate(existing, '我喜欢用 Python 写脚本', DAY)).toBe(true)
    expect(isDuplicate(existing, '完全不同的话题内容在这里', DAY)).toBe(false)
  })

  it('过期判定与清理', () => {
    const now = Date.now()
    const expired = entry('老数据', { createdAt: now - 10 * DAY, updatedAt: now - 10 * DAY })
    const active = entry('新数据', { updatedAt: now })
    const toPrune = pruneExpired([expired, active], 7, now)
    expect(toPrune.map((e) => e.id)).toEqual([expired.id])
  })

  it('summarize 汇总统计', () => {
    const stats = summarize(
      [entry('a', { kind: 'fact', source: 'auto' }), entry('b', { kind: 'preference', source: 'explicit' })],
      128,
    )
    expect(stats.total).toBe(2)
    expect(stats.byKind.fact).toBe(1)
    expect(stats.byKind.preference).toBe(1)
    expect(stats.bySource.auto).toBe(1)
    expect(stats.bySource.explicit).toBe(1)
    expect(stats.bytes).toBe(128)
    expect(stats.oldestAt).toBeTypeOf('number')
    expect(stats.newestAt).toBeTypeOf('number')
  })
})
