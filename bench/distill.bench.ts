/**
 * 蒸馏层性能基准（vitest bench，`npm run bench` 运行；DESIGN-1.1 F3）。
 *
 * 目标：蒸馏批处理性能热点可量化、可回归观察。
 * - 不进 CI 门槛（与 recall.bench.ts 同策略，bench 独立运行避免环境抖动误报）；
 * - 覆盖三个场景：
 *   1. 1K 同主题条目蒸馏批处理耗时（生产空闲维护路径）；
 *   2. 1K 混合主题条目蒸馏耗时（聚类 + 蒸馏全链路）；
 *   3. 蒸馏产物展开（expandDistilled）耗时（召回命中向下展开证据链）。
 * - 记忆体量观测：10K 条目蒸馏时产物/跳过计数输出（内存占用信号量）。
 */
import { bench, describe } from 'vitest'
import { distillBatch, expandDistilled } from '../src/memory/distill'
import type { MemoryEntry } from '../src/memory/types'

const T0 = 1_700_000_000_000

function entry(content: string, overrides: Partial<MemoryEntry> & { content?: string } = {}): MemoryEntry {
  return {
    id: `e-${content.length}-${content.charCodeAt(0) ?? 0}-${content.trim().length}`,
    kind: 'preference',
    tags: [],
    source: 'auto',
    createdAt: T0,
    updatedAt: T0,
    accessCount: 0,
    content,
    ...overrides,
  }
}

function makeSameTheme(n: number): MemoryEntry[] {
  const emotions = ['喜欢', '习惯', '偏好', '倾向于', '优先']
  const subjects = ['TypeScript', 'Python', 'Rust', 'Go', 'Java']
  return Array.from({ length: n }, (_, i) =>
    entry(
      `用户${emotions[i % emotions.length] ?? '喜欢'}用${subjects[i % subjects.length] ?? 'TypeScript'}构建工程 ${i}`,
      {
        id: `same-${i}`,
      },
    ),
  )
}

function makeMixedTheme(n: number): MemoryEntry[] {
  const themes = ['部署环境使用 Docker', '数据库选用 PostgreSQL', '前端框架偏好 Vue', '测试优先用 Vitest']
  return Array.from({ length: n }, (_, i) =>
    entry(`${themes[i % themes.length] ?? themes[0]}（编号 ${i}）`, { id: `mix-${i}` }),
  )
}

describe('蒸馏批处理性能基准', () => {
  const sameTheme1K = makeSameTheme(1000)
  const mixed1K = makeMixedTheme(1000)

  bench('1K 同主题条目蒸馏批处理（batchTail 完整链路）', () => {
    distillBatch(sameTheme1K, { now: T0 })
  })

  bench('1K 混合主题条目蒸馏（聚类 + 归纳全链路）', () => {
    distillBatch(mixed1K, { now: T0 })
  })

  bench('蒸馏产物批量展开（expandDistilled，32 条产物）', () => {
    const { distilled } = distillBatch(sameTheme1K.slice(0, 96), { now: T0 })
    const byId = new Map(sameTheme1K.map((e) => [e.id, e]))
    for (const d of distilled.slice(0, 32)) {
      expandDistilled(d, byId)
    }
  })
})

describe('蒸馏产物体量观测（10K 条目输入）', () => {
  const big = makeSameTheme(10_000)

  bench('10K 同主题蒸馏：产物计数观测', () => {
    const { distilled } = distillBatch(big, { now: T0 })
    if (distilled.length === 0) throw new Error('distill produced nothing on 10K same-theme input')
  })
})
