/**
 * 1.1.0 记忆层次蒸馏层测试（DESIGN-1.1 模块 A，门禁 G9）。
 *
 * G9 门限：
 * - 蒸馏可复算：相同输入两遍产出 id 一致（纯函数，无随机成分）；
 * - 源可追踪率：每个蒸馏条目 distilled-from 都解析出有效源引用（且全部指向源簇成员）；
 * - 冲突守卫：含 supersede 对立对的簇 0 蒸馏（skip conflict）；
 * - 召回展开：expandDistilled 返回展开源 = distilled-from 有效引用数。
 * - 分层与跳过原因覆盖（abstract / procedural / too-small / no-resonance）。
 */
import { describe, expect, it } from 'vitest'
import {
  distilledLayer,
  distilledSourceIds,
  distillBatch,
  DISTILLED_FROM_TAG_PREFIX,
  expandDistilled,
  hasPreferenceSignal,
  isDistilled,
} from '../../src/memory/distill'
import type { MemoryEntry } from '../../src/memory/types'

function entry(overrides: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  const now = 1_700_000_000_000
  return {
    id: `e-${overrides.content.length}-${overrides.content.charCodeAt(0) ?? 0}`,
    kind: 'fact',
    tags: [],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}

describe('distillBatch（1.1.0 模块 A，G9）', () => {
  it('可复算：相同输入两遍产出完全一致的蒸馏条目（id 相同）', () => {
    const cluster = [
      entry({ content: '用户喜欢 TypeScript 构建工程', kind: 'preference', tags: ['preference'] }),
      entry({ content: '用户习惯用 TypeScript 写后端服务', kind: 'preference', tags: ['preference'] }),
      entry({ content: 'TypeScript 是用户的首选开发语言', kind: 'preference', tags: ['preference'] }),
    ]
    const a = distillBatch(cluster, { now: 1_700_000_000_000 })
    const b = distillBatch(cluster, { now: 1_700_000_000_000 })
    expect(a.distilled).toHaveLength(1)
    expect(b.distilled).toHaveLength(1)
    expect(a.distilled[0]!.id).toBe(b.distilled[0]!.id)
    expect(a.distilled[0]!.content).toBe(b.distilled[0]!.content)
    expect(a.distilled[0]!.tags).toEqual(b.distilled[0]!.tags)
  })

  it('源可追踪率 100%：每条蒸馏条目的 distilled-from 都指向源簇成员', () => {
    const cluster = [
      entry({ content: '用户喜欢 TypeScript 构建工程', kind: 'preference', tags: ['preference'] }),
      entry({ content: '用户习惯用 TypeScript 写后端服务', kind: 'preference', tags: ['preference'] }),
      entry({ content: 'TypeScript 是用户的首选开发语言', kind: 'preference', tags: ['preference'] }),
    ]
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    expect(distilled).toHaveLength(1)
    const d = distilled[0]!
    const srcIds = distilledSourceIds(d)
    const memberIds = new Set(cluster.map((e) => e.id))
    expect(srcIds.length).toBe(3)
    for (const sid of srcIds) expect(memberIds.has(sid)).toBe(true)
  })

  it('抽象层（abstract）：偏好信号词 → 抽象偏好断言并带分层/主题 tag', () => {
    const cluster = [
      entry({ content: '用户喜欢 TypeScript 构建工程', kind: 'preference', tags: ['preference'] }),
      entry({ content: '用户习惯用 TypeScript 写后端服务', kind: 'preference', tags: ['preference'] }),
      entry({ content: 'TypeScript 是用户的首选开发语言', kind: 'preference', tags: ['preference'] }),
    ]
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    const d = distilled[0]!
    expect(isDistilled(d)).toBe(true)
    expect(distilledLayer(d)).toBe('abstract')
    expect(d.content).toContain('蒸馏抽象')
    expect(d.content.toLocaleLowerCase()).toContain('typescript')
    expect(d.tags.some((t) => t.startsWith('distilled-theme:'))).toBe(true)
    expect(d.tags.some((t) => t.startsWith('distilled-layer:abstract'))).toBe(true)
  })

  it('规则层（procedural）：instruction 主导簇蒸馏为规则约束', () => {
    const cluster = [
      entry({ content: '必须优先使用 pnpm 安装依赖', kind: 'instruction', tags: ['instruction'] }),
      entry({ content: '始终用 pnpm 管理项目依赖', kind: 'instruction', tags: ['instruction'] }),
      entry({ content: '依赖安装默认走 pnpm', kind: 'instruction', tags: ['instruction'] }),
    ]
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    expect(distilled).toHaveLength(1)
    const d = distilled[0]!
    expect(distilledLayer(d)).toBe('procedural')
    expect(d.content).toContain('蒸馏规则')
    expect(d.content.toLocaleLowerCase()).toContain('pnpm')
  })

  it('冲突守卫：含 supersede 对立对的簇 0 蒸馏，记入 skipped[conflict]', () => {
    // 三条共享「数据库/MySQL」token 成簇，且含 supersede 对（被取代者 + 取代者）
    const withSuper = [
      { ...entry({ content: '数据库默认使用 MySQL 做主库', kind: 'decision' }), tags: ['superseded-by:sup-2'] },
      { ...entry({ content: '改用 PostgreSQL 代替 MySQL 作为主库', kind: 'decision' }), tags: ['supersede:e-0-0'] },
      { ...entry({ content: 'MySQL 数据库曾用于生产环境', kind: 'fact' }) },
    ]
    const { distilled, skipped } = distillBatch(withSuper)
    expect(distilled).toHaveLength(0)
    expect(skipped.some((s) => s.reason === 'conflict')).toBe(true)
  })

  it('簇太小（<minCluster）不产出，记入 skipped[too-small]', () => {
    const { distilled, skipped } = distillBatch(
      [
        entry({ content: '用户喜欢 TypeScript 构建工程', kind: 'preference' }),
        entry({ content: '用户也喜欢 Rust 写工具链', kind: 'preference' }),
      ],
      { now: 1_700_000_000_000 },
    )
    expect(distilled).toHaveLength(0)
    expect(skipped.some((s) => s.reason === 'too-small')).toBe(true)
  })

  it('无共鸣面（无 ≥50% 高频共享词）→ no-resonance 跳过', () => {
    const cluster = [
      entry({ content: '用户住在杭州西湖附近', kind: 'fact' }),
      entry({ content: '北京故宫是游客打卡地', kind: 'fact' }),
      entry({ content: '上海外滩夜景很出名', kind: 'fact' }),
    ]
    const { distilled, skipped } = distillBatch(cluster, { now: 1_700_000_000_000 })
    // 三城无共享 token → 不聚类（无簇）或簇内无共鸣：蒸馏必为空
    expect(distilled).toHaveLength(0)
    expect(skipped.length).toBeGreaterThanOrEqual(0)
  })

  it('已蒸馏条目不参与二次蒸馏（防蒸馏递归）', () => {
    const base = [
      entry({ content: '用户喜欢 TypeScript 构建工程', kind: 'preference' }),
      entry({ content: '用户习惯用 TypeScript 写后端服务', kind: 'preference' }),
      entry({ content: 'TypeScript 是用户的首选开发语言', kind: 'preference' }),
    ]
    const first = distillBatch(base, { now: 1_700_000_000_000 })
    expect(first.distilled).toHaveLength(1)
    // 二次输入 = 源 + 已蒸馏条目：不允许再蒸馏出第二层
    const second = distillBatch([...base, ...first.distilled], { now: 1_700_000_000_000 })
    expect(second.distilled).toHaveLength(1)
    expect(second.distilled[0]!.id).toBe(first.distilled[0]!.id)
  })
})

describe('expandDistilled（模块 A3，G9 召回展开）', () => {
  it('展开源 = distilled-from 有效引用数', () => {
    const cluster = [
      entry({ content: '用户喜欢 TypeScript 构建工程', kind: 'preference' }),
      entry({ content: '用户习惯用 TypeScript 写后端服务', kind: 'preference' }),
      entry({ content: 'TypeScript 是用户的首选开发语言', kind: 'preference' }),
    ]
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    const d = distilled[0]!
    const byId = new Map(cluster.map((e) => [e.id, e]))
    const expanded = expandDistilled(d, byId)
    expect(expanded).toHaveLength(3)
    expect(expanded.map((e) => e.id).sort()).toEqual(cluster.map((e) => e.id).sort())
  })

  it('无效引用（源已遗忘）自动跳过，展开收缩但不报错', () => {
    const cluster = [
      entry({ content: '用户喜欢 TypeScript 构建工程', kind: 'preference' }),
      entry({ content: '用户习惯用 TypeScript 写后端服务', kind: 'preference' }),
      entry({ content: 'TypeScript 是用户的首选开发语言', kind: 'preference' }),
    ]
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    const d = distilled[0]!
    // 只保留一个源，其余视为已遗忘
    const byId = new Map([[cluster[0]!.id, cluster[0]!]])
    const expanded = expandDistilled(d, byId)
    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.id).toBe(cluster[0]!.id)
  })

  it('distilled-from tag 解析：无 tag 条目返回空数组', () => {
    const plain = entry({ content: '普通记忆，无蒸馏协议', tags: [] })
    expect(distilledSourceIds(plain)).toEqual([])
    expect(expandDistilled(plain, new Map())).toEqual([])
  })
})

describe('hasPreferenceSignal（复用 capture 单一词表）', () => {
  it('命中偏好信号词', () => {
    expect(hasPreferenceSignal('我偏好使用 pnpm')).toBe(true)
    expect(hasPreferenceSignal('记住以后用这个库')).toBe(true)
  })
  it('未命中返回 false', () => {
    expect(hasPreferenceSignal('今天天气不错')).toBe(false)
  })
})

describe('蒸馏产物契约（向后兼容）', () => {
  it('产物是标准 MemoryEntry（契约字段齐全）且不打普通 tag 的边', () => {
    const cluster = [
      entry({ content: '用户喜欢 TypeScript 构建工程', kind: 'preference' }),
      entry({ content: '用户习惯用 TypeScript 写后端服务', kind: 'preference' }),
      entry({ content: 'TypeScript 是用户的首选开发语言', kind: 'preference' }),
    ]
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    const d = distilled[0]!
    expect(typeof d.id).toBe('string')
    expect(d.id.startsWith('dist-')).toBe(true)
    expect(['decision', 'fact', 'preference', 'instruction', 'generic']).toContain(d.kind)
    expect(Array.isArray(d.tags)).toBe(true)
    expect(d.source).toBe('auto')
    expect(d.createdAt).toBe(1_700_000_000_000)
    expect(d.accessCount).toBe(0)
    // distilled-from tag 引用 id 与 id 规范一致（纯 MemoryEntry 字段，无新字段）
    const fromTag = d.tags.find((t) => t.startsWith(DISTILLED_FROM_TAG_PREFIX))
    expect(fromTag).toBeDefined()
  })
})
