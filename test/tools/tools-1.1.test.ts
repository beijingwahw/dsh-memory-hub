/**
 * 1.1.0 工具层新可选参数/字段断言（DESIGN-1.1；源码见 src/tools/*.ts）。
 *
 * 覆盖「四工具仅新增可选参数且旧调用逐字节兼容」在工具层的可观察点：
 *  1. recall expand：蒸馏条目命中时 hits[].expanded 向下展开源记忆（仅 expand=true 输出；
 *     缺省不输出 expanded 字段 = 零行为回归点）；
 *  2. recall conflicts：矛盾并存对双方都保留 + 新者优先稳定重排（conflictAwareOrder），
 *     命中条目输出 conflicts 字段（对方 id 列表）；
 *  3. recall graphEnabled：graph 注入且 graphEnabled=true 时图线生效（词面全零但图可达的
 *     条目进入召回，metrics.graphHits 计数）；graph 未注入时参数不生效；
 *  4. recall 只读热度语义：reinforce=false / asOf 只读回放不写热度（accessCount 不增加）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlMemoryStore } from '../../src/memory/store'
import { buildGraph } from '../../src/memory/graph'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import type { HubMetrics } from '../../src/memory/metrics'
import type { MemoryEntry } from '../../src/memory/types'

type Toolish = { execute: (args: never) => Promise<Record<string, unknown>> }

const T0 = 1_700_000_000_000

function entry(content: string, overrides: Partial<MemoryEntry> & { content?: string } = {}): MemoryEntry {
  return {
    id: overrides.id ?? `e-${content.length}-${content.charCodeAt(0) ?? 0}-${content.trim().length}`,
    kind: 'fact',
    tags: [],
    source: 'explicit',
    createdAt: T0,
    updatedAt: T0,
    accessCount: 0,
    content,
    ...overrides,
  }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-tools11-'))
  const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
  return { store }
}

function freshMetrics(): HubMetrics {
  return {
    errors: 0,
    capturedTotal: 0,
    rejectedSensitive: 0,
    rejectedDuplicate: 0,
    explicitStored: 0,
    recallCalls: 0,
    recallHits: 0,
    forgotten: 0,
    pruned: 0,
    dropped: 0,
  }
}

describe('1.1.0 recall expand：蒸馏命中向下展开证据链', () => {
  it('expand=true 时蒸馏条目输出 expanded 源记忆；缺省不输出（零行为回归）', async () => {
    const { store } = await setup()
    // 蒸馏产物协议（与 distillBatch 产物同构：distilled-layer + distilled-from）
    const src1 = entry('用户喜欢用 TypeScript 构建工程', { id: 'src-1', kind: 'preference' })
    const src2 = entry('用户习惯用 TypeScript 编写内部工具', { id: 'src-2', kind: 'preference' })
    const distilled = entry('用户偏好使用 TypeScript 完成工程实践', {
      id: 'dist-1',
      kind: 'preference',
      source: 'auto',
      tags: ['distilled-layer:abstract', 'distilled-from:src-1,src-2', 'distilled-theme:typescript', 'distilled'],
    })
    for (const e of [src1, src2, distilled]) await store.upsert(e)

    const metrics = freshMetrics()
    const tool = createMemoryRecallTool(store, 800, 8, undefined, metrics) as unknown as Toolish

    // 缺省（expand 未传）：hits 命中蒸馏条目但不输出 expanded / conflicts 键
    const off = (await tool.execute({ query: 'TypeScript 工程实践' } as never)) as {
      hits: Array<{ id: string; expanded?: unknown; conflicts?: unknown }>
    }
    const distHitOff = off.hits.find((h) => h.id === 'dist-1')
    expect(distHitOff).toBeDefined()
    expect(distHitOff!.expanded).toBeUndefined() // 缺省不展开 = 1.0.0 无此字段

    // expand=true：蒸馏条目向下展开源记忆（2 个有效源）
    const on = (await tool.execute({ query: 'TypeScript 工程实践', expand: true } as never)) as {
      hits: Array<{
        id: string
        expanded?: Array<{ id: string; content: string }>
        conflicts?: Array<string>
      }>
    }
    const distHit = on.hits.find((h) => h.id === 'dist-1')
    expect(distHit).toBeDefined()
    const expanded = distHit!.expanded ?? []
    expect(expanded.map((e) => e.id).sort()).toEqual(['src-1', 'src-2'])
    expect(expanded.some((e) => e.content.includes('TypeScript'))).toBe(true)
    // 非蒸馏命中不输出 expanded
    const srcHit = on.hits.find((h) => h.id === 'src-1')
    expect(srcHit).toBeDefined()
    expect(srcHit!.expanded).toBeUndefined()
  })

  it('expand=true 且蒸馏源已失效时无效源自动跳过（expandDistilled 收缩语义）', async () => {
    const { store } = await setup()
    const live = entry('用户经常使用 React 编写前端界面', { id: 'src-live', kind: 'preference' })
    const distilled = entry('用户偏好在前端工程中使用 React', {
      id: 'dist-ghost',
      kind: 'preference',
      source: 'auto',
      tags: ['distilled-layer:abstract', 'distilled-from:src-live,src-gone', 'distilled-theme:react', 'distilled'],
    })
    for (const e of [live, distilled]) await store.upsert(e)

    const tool = createMemoryRecallTool(store, 800, 8) as unknown as Toolish
    const out = (await tool.execute({ query: 'React 前端工程', expand: true } as never)) as {
      hits: Array<{ id: string; expanded?: Array<{ id: string }> }>
    }
    const distHit = out.hits.find((h) => h.id === 'dist-ghost')
    expect(distHit).toBeDefined()
    const ids = (distHit!.expanded ?? []).map((e) => e.id)
    expect(ids).toContain('src-live')
    expect(ids).not.toContain('src-gone') // 无效源跳过
  })
})

describe('1.1.0 recall conflicts：矛盾并存显式标注 + 新者优先', () => {
  it('冲突对双方都保留、输出 conflicts 字段，且新者优先稳定重排', async () => {
    const { store } = await setup()
    // 疑似反转对（双向标注，与 conflictMode=auto 写入产物同构）
    const older = entry('用户日常使用 Rust 构建命令行工具', {
      id: 'c-old',
      kind: 'preference',
      tags: ['conflict-of:c-new'],
      updatedAt: T0 - 86400000,
    })
    const newer = entry('用户不再使用 Rust 构建命令行工具', {
      id: 'c-new',
      kind: 'preference',
      tags: ['conflicts-with:c-old'],
      updatedAt: T0,
    })
    for (const e of [older, newer]) await store.upsert(e)

    const tool = createMemoryRecallTool(store, 800, 8) as unknown as Toolish
    const out = (await tool.execute({ query: 'Rust 命令行工具' } as never)) as {
      hits: Array<{
        id: string
        content: string
        conflicts?: Array<string>
        score: number
      }>
    }
    // 双方都保留（矛盾并存，不剔除旧条目）
    const ids = out.hits.map((h) => h.id)
    expect(ids).toContain('c-old')
    expect(ids).toContain('c-new')
    // conflicts 字段：对方 id 列表
    const oldHit = out.hits.find((h) => h.id === 'c-old')!
    const newHit = out.hits.find((h) => h.id === 'c-new')!
    expect(oldHit.conflicts).toEqual(['c-new'])
    expect(newHit.conflicts).toEqual(['c-old'])
    // conflictAwareOrder：新者（更新时间较晚）在旧者之前
    expect(ids.indexOf('c-new')).toBeLessThan(ids.indexOf('c-old'))
  })

  it('无冲突标注时顺序稳定（缺省零行为变化）', async () => {
    const { store } = await setup()
    const a = entry('团队采用微服务架构拆分业务', { id: 'z-a' })
    const b = entry('团队使用容器化部署微服务', { id: 'z-b' })
    for (const e of [a, b]) await store.upsert(e)

    const tool = createMemoryRecallTool(store, 800, 8) as unknown as Toolish
    const out = (await tool.execute({ query: '微服务 架构' } as never)) as {
      hits: Array<{ id: string; conflicts?: Array<string> }>
    }
    expect(out.hits.length).toBeGreaterThanOrEqual(1)
    for (const h of out.hits) expect(h.conflicts).toBeUndefined() // 无冲突标注不输出 conflicts
  })
})

describe('1.1.0 recall graphEnabled：图线第四召回线', () => {
  it('graph 注入 + graphEnabled=true 时词面全零但图可达条目进入召回（graphHits 计数）', async () => {
    const { store } = await setup()
    // 与 eval/graph 2-hop 夹具同构：查询「渐变」词面只命中第二条；第一条经色彩系统两跳可达
    const design = entry('界面设计 使用 色彩系统', { id: 'g-design' })
    const gradient = entry('色彩系统 使用 渐变', { id: 'g-gradient' })
    const noise = entry('瑞士 使用 阿尔卑斯', { id: 'g-noise' })
    for (const e of [design, gradient, noise]) await store.upsert(e)
    const graph = buildGraph([design, gradient, noise])

    // graph 注入但 graphEnabled 缺省 false：图线不启用（词面全零条目不可达）
    const metricsOff = freshMetrics()
    const toolOff = createMemoryRecallTool(
      store,
      800,
      8,
      undefined,
      metricsOff,
      undefined,
      undefined,
      graph,
    ) as unknown as Toolish
    const off = (await toolOff.execute({ query: '渐变' } as never)) as { hits: Array<{ id: string }> }
    expect(off.hits.some((h) => h.id === 'g-design')).toBe(false) // 图线缺省关：不可达
    expect(metricsOff.graphHits ?? 0).toBe(0)

    // graph 注入 + graphEnabled=true：2-hop 可达条目补录进入召回
    const metricsOn = freshMetrics()
    const toolOn = createMemoryRecallTool(
      store,
      800,
      8,
      undefined,
      metricsOn,
      undefined,
      undefined,
      graph,
    ) as unknown as Toolish
    const on = (await toolOn.execute({ query: '渐变', graphEnabled: true } as never)) as {
      hits: Array<{ id: string }>
    }
    expect(on.hits.some((h) => h.id === 'g-design')).toBe(true) // 图线命中词面全零条目
    expect(on.hits.some((h) => h.id === 'g-gradient')).toBe(true) // 词面命中者仍在
    expect(metricsOn.graphHits ?? 0).toBeGreaterThan(0) // 图线启用才计数
  })

  it('graph 未注入时 graphEnabled=true 不生效（缺省行为保持）', async () => {
    const { store } = await setup()
    const gradient = entry('色彩系统 使用 渐变', { id: 'ng-gradient' })
    for (const e of [gradient]) await store.upsert(e)

    const tool = createMemoryRecallTool(store, 800, 8) as unknown as Toolish
    const out = (await tool.execute({ query: '渐变', graphEnabled: true } as never)) as {
      hits: Array<{ id: string }>
    }
    // 无 graph 注入：图线参数不生效，但词面命中仍正常召回（行为与 1.0.0 一致）
    expect(out.hits.some((h) => h.id === 'ng-gradient')).toBe(true)
  })
})

describe('1.1.0 recall 只读热度语义（reinforce=false / asOf）', () => {
  it('reinforce=false 与 asOf 只读回放不写热度；缺省保持 1.0.0 热度更新', async () => {
    const { store } = await setup()
    const base = entry('用户偏好使用 pnpm 管理依赖', { id: 'heat-1' })
    await store.upsert(base)

    const tool = createMemoryRecallTool(store, 800, 8) as unknown as Toolish
    // 缺省：命中后热度递增（1.0.0 行为）
    await tool.execute({ query: 'pnpm 依赖' } as never)
    await new Promise((r) => setTimeout(r, 50)) // 等热度 flush
    expect((await store.list()).find((e) => e.id === 'heat-1')!.accessCount).toBeGreaterThanOrEqual(1)

    // reinforce=false：只读查看，不更新热度
    const before = (await store.list()).find((e) => e.id === 'heat-1')!.accessCount
    await tool.execute({ query: 'pnpm 依赖', reinforce: false } as never)
    await new Promise((r) => setTimeout(r, 50))
    expect((await store.list()).find((e) => e.id === 'heat-1')!.accessCount).toBe(before)

    // asOf：时间线回放只读，不更新热度
    await tool.execute({ query: 'pnpm 依赖', asOf: Date.now() } as never)
    await new Promise((r) => setTimeout(r, 50))
    expect((await store.list()).find((e) => e.id === 'heat-1')!.accessCount).toBe(before)
  })
})
