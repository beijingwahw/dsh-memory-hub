import { describe, expect, it } from 'vitest'
import { buildIndex, queryIndex, recall, tokenize } from '../../src/memory/engine'
import type { MemoryEntry, MemoryKind } from '../../src/memory/types'

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `q-${content.length}-${Math.random().toString(36).slice(2, 8)}`,
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

describe('空查询边界（P1-1：tokenize 为空时返回空数组）', () => {
  const memory = [
    entry('热门记忆 AAA 热度很高', { accessCount: 50 }),
    entry('另一条热闹的 BBB 记忆', { accessCount: 30 }),
  ]

  it('纯标点查询不返回全库', () => {
    const hits = recall(memory, '！！！？？？')
    expect(hits).toHaveLength(0)
  })

  it('空字符串查询返回空', () => {
    expect(recall(memory, '')).toHaveLength(0)
  })

  it('空白字符查询返回空', () => {
    expect(recall(memory, '   ')).toHaveLength(0)
  })

  it('tokenize 为空时 queryIndex 直接短路且不产生覆盖', () => {
    const index = buildIndex(memory)
    const byId = new Map(memory.map((e) => [e.id, e]))
    expect(tokenize('。。。')).toHaveLength(0)
    expect(queryIndex(index, '。。。', {}, byId)).toHaveLength(0)
  })
})

describe('大库召回一致性（P3-1：1000 条随机条目）', () => {
  const KINDS: MemoryKind[] = ['fact', 'decision', 'preference', 'instruction', 'generic']
  const WORKSPACES = ['proj-a', 'proj-b', 'proj-c']
  const now = Date.now()

  function makeLibrary(n: number): MemoryEntry[] {
    const lib: MemoryEntry[] = []
    for (let i = 0; i < n; i++) {
      const kind = KINDS[i % KINDS.length]!
      const workspace = i % 3 === 0 ? WORKSPACES[(i / 3) % 3]! : undefined
      const base: Partial<MemoryEntry> = {
        id: `lib-${i}`,
        kind,
        createdAt: now - (i % 90) * 86400000,
        accessCount: i % 7,
      }
      if (workspace !== undefined) base.workspace = workspace
      lib.push(entry(`记录编号${i}：关于搜索关键词 架构演进 与 部署方案 的长期记忆片段 ${'x'.repeat(i % 20)}`, base))
    }
    return lib
  }

  it('token 预算裁剪不越界且首条必含', () => {
    const lib = makeLibrary(1000)
    const hits = recall(lib, '架构演进 部署方案', { maxTokens: 120, limit: 50 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(120) // 每条至少 1 token（estimateTokens 保证 >= 1）
    expect(hits[0]).toBeDefined()
  })

  it('heat（accessCount）更高者在相似相关度下优先（热度语义正确）', () => {
    const lib = makeLibrary(1000)
    const hot = entry('独特标记词 zzzq 热度极高', { accessCount: 100 })
    const cold = entry('独特标记词 zzzq 温度正常', { accessCount: 0 })
    const hits = recall([...lib, hot, cold], 'zzzq', { limit: 2 })
    expect(hits[0]!.id).toBe(hot.id)
  })

  it('workspace/kind 过滤在大库上成立', () => {
    const lib = makeLibrary(1000)
    // 语义：无 workspace 的条目为全局记忆，对所有工作区可见
    const ra = recall(lib, '记忆片段', { workspace: 'proj-a', limit: 100 })
    expect(ra.length).toBeGreaterThan(0)
    expect(ra.every((h) => h.workspace === undefined || h.workspace === 'proj-a')).toBe(true)
    // 指定了 workspace 时，其他工作区的条目必然被排除
    expect(ra.some((h) => h.workspace === 'proj-b' || h.workspace === 'proj-c')).toBe(false)
    const kd = recall(lib, '记忆片段', { kind: 'decision', limit: 100 })
    expect(kd.every((h) => h.kind === 'decision')).toBe(true)
  })

  it('queryIndex 与 recall 在千级库上结果一致（同一评分语义）', () => {
    const lib = makeLibrary(1000)
    const index = buildIndex(lib)
    const byId = new Map(lib.map((e) => [e.id, e]))
    const a = recall(lib, '架构演进 记录', { limit: 10 })
    const b = queryIndex(index, '架构演进 记录', { limit: 10 }, byId)
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id))
  })
})
