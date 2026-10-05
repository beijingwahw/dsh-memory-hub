/**
 * 召回性能基准（vitest bench，`npm run bench` 运行）。
 *
 * 设计目标：性能热点可量化、可回归观察。
 * - 不进 CI 门槛（`npm test` 仅跑 test 目录下的 .test.ts 文件，bench 独立运行，避免环境抖动误报）；
 * - 覆盖三个热点：buildIndex（全量索引构建）、queryIndex（冷查询）、IndexCache 热命中；
 * - 附 token 预算裁剪场景，量化裁剪对返回量的影响；
 * - 0.4.0 新增：BM25（当前评分）与 0.3 基线 cosine 的**检索质量对比**（top@1 命中率）。
 */
import { bench, describe } from 'vitest'
import { buildIndex, IndexCache, queryIndex, recall } from '../src/memory/engine'
import type { MemoryEntry } from '../src/memory/types'

function entry(i: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `e-${i}`,
    kind: 'fact',
    content: `记忆条目 ${i}：项目部署架构、前端工程化、后端服务治理与监控告警链路 ${i}`,
    tags: ['memory', 'project'],
    source: 'auto',
    createdAt: now - (i % 90) * 86400000,
    updatedAt: now,
    accessCount: i % 5,
    ...overrides,
  }
}

function makeLibrary(n: number): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => entry(i))
}

describe('召回性能基准（1K / 10K 条目）', () => {
  const small = makeLibrary(1000)
  const large = makeLibrary(10000)
  const query = '部署 架构 后端 监控'
  const smallIndex = buildIndex(small)
  const largeIndex = buildIndex(large)
  const smallById = new Map(small.map((e) => [e.id, e]))
  const largeById = new Map(large.map((e) => [e.id, e]))

  bench('1K 冷查询（recall：buildIndex + queryIndex）', () => {
    recall(small, query)
  })

  bench('1K 索引命中查询（queryIndex）', () => {
    queryIndex(smallIndex, query, {}, smallById)
  })

  bench('10K 索引构建（buildIndex）', () => {
    buildIndex(large)
  })

  bench('10K 索引命中查询（queryIndex）', () => {
    queryIndex(largeIndex, query, {}, largeById)
  })

  bench('10K token 预算裁剪（maxTokens=200）', () => {
    queryIndex(largeIndex, query, { maxTokens: 200, limit: 20 }, largeById)
  })

  bench('IndexCache 热命中（revision 不变，repeated 10 次缓存复用）', () => {
    const cache = new IndexCache()
    for (let i = 0; i < 10; i++) cache.query(small, 1, query)
  })

  bench('IndexCache 热度更新复用（revision 变但指纹不变，10 次）', () => {
    const cache = new IndexCache()
    const hot = small.map((e) => ({ ...e, accessCount: e.accessCount + 1 }))
    for (let i = 0; i < 10; i++) cache.query(hot, i + 2, query)
  })
})

// ---------------------------------------------------------------------------
// 0.4.0 检索质量对比：BM25 vs 0.3 基线 cosine（top@1 命中率）
// ---------------------------------------------------------------------------

/** 0.3.0 的 cosine 评分基线（保留旧公式内联，仅用于对比；评分语义与生产线无关） */
function legacyCosineQuery(entries: MemoryEntry[], query: string, options: { limit?: number } = {}): MemoryEntry[] {
  const index = buildIndex(entries)
  const docCount = Math.max(1, index.docCount)
  const idf = (token: string): number => {
    const df = index.df.get(token) ?? 0
    return Math.log((docCount + 1) / (df + 1)) + 1
  }
  const qTf = new Map<string, number>()
  for (const t of query
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)) {
    if (t.length >= 2) qTf.set(t, (qTf.get(t) ?? 0) + 1)
  }
  if (qTf.size === 0) return []
  const norm = (vec: ReadonlyMap<string, number>): number => {
    let sum = 0
    for (const [t, n] of vec) {
      const w = n * idf(t)
      sum += w * w
    }
    return Math.sqrt(sum)
  }
  const qNorm = norm(qTf)
  const scored = entries
    .map((entry) => {
      const vec = new Map<string, number>()
      for (const t of `${entry.content} ${entry.tags.join(' ')}`.toLocaleLowerCase().split(/\s+/)) {
        if (t.length >= 2) vec.set(t, (vec.get(t) ?? 0) + 1)
      }
      const eNorm = norm(vec)
      if (eNorm === 0) return undefined
      let dot = 0
      for (const [t, qtf] of qTf) {
        const etf = vec.get(t)
        if (etf) dot += qtf * idf(t) * etf
      }
      const cosine = dot / (qNorm * eNorm)
      return cosine > 0 ? { entry, cosine } : undefined
    })
    .filter((x): x is { entry: MemoryEntry; cosine: number } => x !== undefined)
    .sort((a, b) => b.cosine - a.cosine)
  return scored.slice(0, options.limit ?? 8).map((x) => x.entry)
}

/**
 * 检索质量对比（BM25 0.4 vs cosine 0.3，top@1 命中率）。
 * 命中率在 bench 任务内直接落 stdout（`[bench]` 前缀，warmup 多次调用时仅打印一次）；硬门限断言由 eval/ 承担。
 */
const printedRatio: Record<string, boolean> = {}
function printRatio(label: string, hits: number, total: number): void {
  if (printedRatio[label]) return
  printedRatio[label] = true
  process.stdout.write(`[bench] ${label}: ${hits}/${total} = ${((hits / total) * 100).toFixed(2)}%\n`)
}

/** 构造质量评测语料：锚词目标 + 大量含锚词的长干扰项（长度归一化可区分的场景） */
function makeQualityCorpus(n: number): { entries: MemoryEntry[]; queries: string[] } {
  const entries: MemoryEntry[] = []
  const queries: string[] = []
  const now = Date.now()
  for (let i = 0; i < n; i++) {
    const anchor = `q${i}anchor`
    // 目标条目：锚词精炼命中
    entries.push({
      id: `target-${i}`,
      kind: 'fact',
      content: `${anchor} 部署方案`,
      tags: [],
      source: 'auto',
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    })
    // 干扰项：长文档、锚词高频出现（旧 cosine 因无长度归一化倾向高词频，BM25 因长度惩罚更稳）
    for (let j = 0; j < 5; j++) {
      entries.push({
        id: `noise-${i}-${j}`,
        kind: 'fact',
        content: `${anchor} ${anchor} ${anchor} 与项目历史记录中的全部细节展开说明持续延长文档长度增加干扰`,
        tags: [],
        source: 'auto',
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
      })
    }
    queries.push(anchor)
  }
  return { entries, queries }
}

describe('检索质量对比（BM25 0.4 vs cosine 0.3，top@1 命中率）', () => {
  const { entries, queries } = makeQualityCorpus(80)
  bench(
    'cosine 基线（legacy top@1 命中率）',
    () => {
      let hits = 0
      for (const q of queries) {
        if (legacyCosineQuery(entries, q, { limit: 1 })[0]?.id.startsWith('target-')) hits++
      }
      printRatio('cosine 基线 top@1 命中率', hits, queries.length)
    },
    { iterations: 1 },
  )

  bench(
    'BM25 0.4（top@1 命中率）',
    () => {
      let hits = 0
      for (const q of queries) {
        if (recall(entries, q, { limit: 1 })[0]?.id.startsWith('target-')) hits++
      }
      printRatio('BM25 0.4 top@1 命中率', hits, queries.length)
    },
    { iterations: 1 },
  )
})
