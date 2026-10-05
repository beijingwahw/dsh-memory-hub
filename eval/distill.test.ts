/**
 * 蒸馏层离线质量门禁（DESIGN-1.1 F2，门禁 G9）：`npm run eval` 一键运行。
 *
 * G9 门限（与 DESIGN-1.1 模块 A 对齐）：
 *  1. 蒸馏可复算：相同输入两遍产出 id 一致（纯函数，无随机成分）；
 *  2. 源可追踪率 100%：每个蒸馏条目的 distilled-from 都解析出有效源引用，
 *     且全部指向源簇成员（证据链完整）；
 *  3. 分层准确：行为/偏好簇 → abstract（偏好模式），指令簇 → procedural（规则约束）；
 *  4. 冲突守卫：含 supersede 对立对的簇 0 蒸馏（矛盾事实不揉成伪原则），
 *     且跳过原因被可观测记录（reason=conflict）；
 *  5. 召回展开：expandDistilled 返回展开源 = distilled-from 有效引用数（含失效收缩）。
 *
 * 夹具设计（4 组，覆盖 G9-F2 全部蒸馏场景）：
 *  - 行为簇：含偏好信号的重复行为描述（用户习惯…/喜欢…）→ 蒸馏为偏好模式 abstract；
 *  - 偏好簇：preference 类记忆共享主题 → abstract；
 *  - 指令簇：instruction 类记忆共享约束词 → procedural；
 *  - 冲突簇：簇内成员处于 supersede 对立对 → 守卫跳过（0 蒸馏）。
 */
import { describe, expect, it } from 'vitest'
import {
  DISTILLED_FROM_TAG_PREFIX,
  distilledLayer,
  distilledSourceIds,
  distillBatch,
  expandDistilled,
  isDistilled,
} from '../src/memory/distill'
import type { MemoryEntry } from '../src/memory/types'

function entry(content: string, overrides: Partial<MemoryEntry> & { content?: string } = {}): MemoryEntry {
  const now = 1_700_000_000_000
  return {
    id: `e-${content.length}-${content.charCodeAt(0) ?? 0}`,
    kind: 'fact',
    tags: [],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    content,
    ...overrides,
  }
}

/** 蒸馏纯度：源可追踪率 100% 且产物内容可展开为证据链 */
function assertTraceable(distilled: MemoryEntry[], sources: MemoryEntry[]): void {
  const byId = new Map(sources.map((s) => [s.id, s]))
  for (const d of distilled) {
    // 协议完备：分层标记 + 源引用 + 主题追溯 + distilled 标记
    expect(isDistilled(d)).toBe(true)
    expect(typeof distilledLayer(d)).toBe('string')
    const refIds = distilledSourceIds(d)
    expect(refIds.length).toBeGreaterThan(0)
    for (const rid of refIds) {
      const src = byId.get(rid)
      expect(src).toBeDefined() // 有效源引用（指向真实成员）
      expect(sources.some((s) => s.id === rid)).toBe(true) // 且是源簇成员
    }
    // 展开证据链完整：expandDistilled 数量 = 有效引用数
    expect(expandDistilled(d, byId)).toHaveLength(refIds.length)
  }
}

describe('G9 行为簇：偏好信号驱动抽象蒸馏', () => {
  const cluster = [
    entry('用户习惯用 TypeScript 构建后端服务', { kind: 'preference' }),
    entry('用户喜欢用 TypeScript 写自动化脚本', { kind: 'preference' }),
    entry('用户偏好 TypeScript 作为开发主语言', { kind: 'preference' }),
  ]

  it('产出 1 条偏好模式蒸馏（abstract 层）', () => {
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    expect(distilled).toHaveLength(1)
    expect(distilledLayer(distilled[0]!)).toBe('abstract')
    expect(distilled[0]!.content).toContain('偏好模式')
    expect(distilled[0]!.kind).toBe('preference')
  })

  it('可复算 + 源可追踪率 100%', () => {
    const a = distillBatch(cluster, { now: 1_700_000_000_000 })
    const b = distillBatch(cluster, { now: 1_700_000_000_000 })
    expect(a.distilled.map((d) => d.id)).toEqual(b.distilled.map((d) => d.id))
    assertTraceable(a.distilled, cluster)
  })
})

describe('G9 偏好簇：共性主题抽象', () => {
  const cluster = [
    entry('团队统一使用 monorepo 管理前端工程', { kind: 'preference' }),
    entry('团队偏好 monorepo 组织多包项目', { kind: 'preference' }),
    entry('新项目默认接入 monorepo 工作流', { kind: 'preference' }),
  ]

  it('产出 abstract 蒸馏且源可追踪', () => {
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    expect(distilled.length).toBeGreaterThanOrEqual(1)
    for (const d of distilled) expect(distilledLayer(d)).toBe('abstract')
    assertTraceable(distilled, cluster)
  })
})

describe('G9 指令簇：规则蒸馏（procedural）', () => {
  const cluster = [
    entry('代码提交前必须运行全部测试', { kind: 'instruction' }),
    entry('提交代码前务必先跑 lint 检查', { kind: 'instruction' }),
    entry('合并分支前必须通过持续集成', { kind: 'instruction' }),
  ]

  it('产出 procedural 规则蒸馏且源可追踪', () => {
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    expect(distilled.length).toBeGreaterThanOrEqual(1)
    for (const d of distilled) {
      expect(distilledLayer(d)).toBe('procedural')
      expect(d.content).toContain('蒸馏规则')
      expect(d.kind).toBe('instruction')
    }
    assertTraceable(distilled, cluster)
  })
})

describe('G9 冲突簇：supersede 对立对守卫（0 蒸馏）', () => {
  const cluster = [
    entry('部署环境使用 docker compose', { id: 'old-ci' }),
    entry('CI 流水线使用 docker compose 构建', { id: 'ci-2', tags: ['superseded-by:new-ci'] }),
    entry('新 CI 改用自建 runner 构建', { id: 'new-ci' }),
  ]

  it('含对立对的簇被守卫跳过，不产出伪原则', () => {
    const { distilled, skipped } = distillBatch(cluster, { now: 1_700_000_000_000 })
    expect(distilled).toHaveLength(0)
    // 跳过原因可观测（冲突守卫）
    const conflictSkips = skipped.filter((s) => s.reason === 'conflict')
    expect(conflictSkips.length).toBeGreaterThanOrEqual(1)
    expect(conflictSkips.some((s) => s.memberCount >= 3)).toBe(true)
  })

  it('跳过只影响冲突簇，无冲突的普通簇仍可蒸馏（守卫不误伤）', () => {
    const normal = [
      entry('用户习惯用 Rust 写命令行工具', { kind: 'preference' }),
      entry('用户喜欢用 Rust 做系统编程', { kind: 'preference' }),
      entry('用户偏好 Rust 编写底层模块', { kind: 'preference' }),
    ]
    const { distilled } = distillBatch([...cluster, ...normal], { now: 1_700_000_000_000 })
    expect(distilled.length).toBeGreaterThanOrEqual(1) // Rust 簇正常蒸馏
    for (const d of distilled) {
      const refs = distilledSourceIds(d)
      expect(refs.every((r) => normal.some((n) => n.id === r))).toBe(true) // 全部指向无冲突簇
    }
  })
})

describe('G9 召回展开：expandDistilled 语义', () => {
  const cluster = [
    entry('用户习惯用 Postgres 存核心数据', { kind: 'preference', id: 'pg-1' }),
    entry('用户喜欢 Postgres 处理复杂查询', { kind: 'preference', id: 'pg-2' }),
    entry('用户偏好 Postgres 作为默认数据库', { kind: 'preference', id: 'pg-3' }),
  ]
  const byId = new Map(cluster.map((e) => [e.id, e]))

  it('展开源 = distilled-from 有效引用数（全部有效）', () => {
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    const d = distilled[0]!
    const refs = distilledSourceIds(d)
    expect(refs).toHaveLength(cluster.length)
    expect(expandDistilled(d, byId)).toHaveLength(refs.length)
    // distilled-from tag 声明与展开一致（协议无漂移）
    expect(d.tags.some((t) => t.startsWith(DISTILLED_FROM_TAG_PREFIX))).toBe(true)
  })

  it('源已遗忘（失效引用）：展开自动收缩但不报错', () => {
    const { distilled } = distillBatch(cluster, { now: 1_700_000_000_000 })
    const d = distilled[0]!
    const partial = new Map([...byId].filter(([id]) => id !== cluster[0]!.id))
    const expanded = expandDistilled(d, partial)
    expect(expanded).toHaveLength(cluster.length - 1)
    expect(expanded.map((e) => e.id).sort()).toEqual([cluster[1]!.id, cluster[2]!.id].sort())
  })
})
