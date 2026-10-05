import { describe, expect, it } from 'vitest'
import { buildIndex, queryIndex, recall, tokenize } from '../../src/memory/engine'
import type { MemoryEntry } from '../../src/memory/types'

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `e-${now}-${Math.random().toString(36).slice(2, 8)}`,
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

describe('buildIndex / queryIndex', () => {
  it('index 与 recall 结果一致（同一评分语义）', () => {
    const memory = [entry('用户偏好使用 TypeScript 编写后端'), entry('项目部署到北欧节点')]
    const index = buildIndex(memory)
    const byId = new Map(memory.map((e) => [e.id, e]))
    const viaQuery = queryIndex(index, 'TypeScript 后端', {}, byId)
    const viaRecall = recall(memory, 'TypeScript 后端')
    expect(viaQuery.map((h) => h.id)).toEqual(viaRecall.map((h) => h.id))
    expect(viaQuery[0]!.content).toContain('TypeScript')
  })

  it('now 并入 RecallOptions（固定基准时间可复算）', () => {
    const now = Date.now()
    const old = entry('很久以前的 alpha', { createdAt: now - 40 * 24 * 60 * 60 * 1000 })
    const fresh = entry('新近的 alpha', { createdAt: now })
    const index = buildIndex([old, fresh])
    const byId = new Map([
      [old.id, old],
      [fresh.id, fresh],
    ])
    const hits = queryIndex(index, 'alpha', { now }, byId)
    expect(hits[0]!.id).toBe(fresh.id)
  })

  it('tokenize 支持英文与中文二字组', () => {
    expect(tokenize('TypeScript 后端')).toContain('typescript')
    expect(tokenize('前端工程')).toContain('前端')
    expect(tokenize('前端工程')).toContain('端工')
  })
})

describe('TF·IDF 召回质量', () => {
  it('稀有词获得更高权重（IDF）', () => {
    const common = entry('项目部署在欧洲 北欧 节点，关注延迟与成本')
    const rare = entry('项目引入量子比特技术栈进行架构演进')
    const hits = recall([common, rare], '量子比特 架构')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe(rare.id)
  })

  it('词频更高的条目优先', () => {
    const repeated = entry('服务 服务 服务 部署 架构 服务') // '服务' 高词频
    const once = entry('服务 部署 架构')
    const hits = recall([once, repeated], '服务')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe(repeated.id)
  })

  it('按相关度排序，无关记忆不混入', () => {
    const relevant = entry('登录模块重构完成，接口全部兼容')
    const irrelevant = entry('周末计划去爬山露营')
    const hits = recall([irrelevant, relevant], '登录 重构')
    expect(hits.map((h) => h.id)).toContain(relevant.id)
  })
})
