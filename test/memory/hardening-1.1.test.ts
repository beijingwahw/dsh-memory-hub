/**
 * 1.1.1 加固回归专场：锁定本轮全部行为修复，防止回退。
 *
 * 覆盖（与 src 内 1.1.1 注释一一对应）：
 * - T1  中文分词根治：混合文本不产生跨边界伪 bigram；扩展 B 区汉字可检索；
 * - T2  estimateTokens 中文标点半价；
 * - T3  safeSlice 代理对安全截断；
 * - T4  IndexCache 纯热度更新后 byId 刷新（热度评分不再冻结）；
 * - T5  ingest 批内双取代：同一旧条目保留全部 superseded-by 标记；
 * - T6  memory_store 近重复（>0.92）幂等返回已存在条目；
 * - T7  矛盾检测独立窗口 conflictWindowMs：跨周信念反转可检测；
 * - T8  词表互斥：含强对立信号（改用/不再用）的候选不进矛盾判定；
 * - T9  图边复活：同一三元组被重新断言后回到活跃时间线；
 * - T10 蒸馏代际治理：新一代写入时上一代被 superseded-by 标记；
 * - T11 巩固召回锚定：从未被真实召回的记忆不被「假复习」；
 * - T12 compact 回放式合并：并发进程追加的外部行在重建后保留；
 * - T13 单实例锁：存活持有者使后来者禁用 compact 并告警；close 释放锁；
 * - T14 memory_recall 数值参数钳制（limit/supersededPenalty）；
 * - T15-T18 图谱实体归一层（规范键对齐 / token 对齐 / validEntity 专名 / 裸「是」降噪）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectContradiction } from '../../src/memory/conflict'
import { runCognitiveMaintenance } from '../../src/memory/cognitive'
import { SUPERSEDED_BY_TAG_PREFIX } from '../../src/memory/entry-factory'
import { safeSlice } from '../../src/memory/entry-factory'
import { ingestCaptured } from '../../src/memory/ingest'
import { IndexCache, recall } from '../../src/memory/engine'
import { graphLineScores, TemporalGraph } from '../../src/memory/graph'
import { createMetrics } from '../../src/memory/metrics'
import { JsonlMemoryStore } from '../../src/memory/store'
import { estimateTokens, tokenize } from '../../src/memory/tokenize'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import { createMemoryStoreTool } from '../../src/tools/memory-store'
import type { MemoryEntry } from '../../src/memory/types'

interface Toolish {
  execute(args: unknown): Promise<Record<string, unknown>>
}

let dirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh1.1-'))
  dirs.push(dir)
  return dir
}
function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `h-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'fact',
    content: '加固测试条目',
    tags: [],
    source: 'auto',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  }
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('1.1.1 加固回归：分词与文本处理', () => {
  it('T1: 混合文本无跨边界伪 bigram；扩展 B 区（代理对）汉字可检索', () => {
    const tokens = tokenize('服务用k8s部署')
    // 旧实现先剔除非 CJK 再整体切 bigram，产生 '用部'（用|k8s|部署 的跨界拼接）
    expect(tokens).not.toContain('用部')
    expect(tokens).not.toContain('部k')
    // 英文词与段内合法 bigram 均在
    expect(tokens).toContain('k8s')
    expect(tokens).toContain('服务')
    // 扩展 B 区汉字（U+20000 𠀀，代理对）成段可切分，不再被整段丢弃
    const ext = tokenize('𠀀𠀁𠀂')
    expect(ext).toContain('𠀀𠀁')
    expect(ext).toContain('𠀁𠀂')
  })

  it('T2: estimateTokens 中文标点按半价计（预算不再被高估）', () => {
    // 4 个 CJK 句号：旧 = 4 token（全价）；新 = 2 token（0.5/个）
    expect(estimateTokens('。。。。')).toBe(2)
    // CJK 表意字仍按 1 token/字
    expect(estimateTokens('记忆')).toBe(2)
  })

  it('T3: safeSlice 不劈开代理对', () => {
    // 3 个 emoji = 6 个 UTF-16 单元；截到第 3 单元落在第二个 emoji 的高位代理上 →
    // 回退 1 单元 = 完整保留第一个 emoji（不会产生孤立代理落盘）
    expect(safeSlice('😀😀😀', 3)).toBe('😀')
    expect(safeSlice('😀😀😀', 4)).toBe('😀😀')
    expect(safeSlice('abcdef', 3)).toBe('abc')
    expect(safeSlice('', 5)).toBe('')
  })
})

describe('1.1.1 加固回归：检索与入库正确性', () => {
  it('T4: IndexCache 纯热度更新后 byId 刷新（热度评分不冻结）', () => {
    const now = 1_752_000_000_000
    const base = entry({ id: 'heat-e', content: 'alpha 发布流程约定', createdAt: now - 1000, updatedAt: now - 1000 })
    const cache = new IndexCache()
    const s1 = cache.query([base], 1, 'alpha', { now })
    expect(s1.length).toBe(1)
    // 模拟召回热度回写：accessCount 0 → 10（内容/标签不变 → revision 变但指纹不变）
    const bumpedEntry = { ...base, accessCount: 10, lastAccessAt: now }
    const s2 = cache.query([bumpedEntry], 2, 'alpha', { now })
    const direct = recall([bumpedEntry], 'alpha', { now })
    expect(s2.length).toBe(1)
    expect(direct.length).toBe(1)
    // 缓存路径与直算路径分数一致：byId 已读到最新 accessCount（修复前缓存路径分数停留在旧值）
    expect(s2[0]!.score).toBe(direct[0]!.score)
    // 热度 10 次访问（lastAccessAt=now 不衰减）> 0 次 → 分数严格升高
    expect(s2[0]!.score).toBeGreaterThan(s1[0]!.score)
  })

  it('T5: 批内双取代保留全部 superseded-by 标记', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    // 相似度带设计：两个候选各与旧条目相似度落在 (0.85, 0.92]（supersede 命中且不被
    // 去重拒绝），彼此相似度 < 0.92（互不为重复）——才可能在同批内先后取代同一条目
    const old = entry({
      id: 'old-1',
      content: '网关使用 openresty 处理全部入站流量',
      createdAt: Date.now() - 1000,
    })
    await store.upsert(old)
    await ingestCaptured(
      store,
      [
        { kind: 'fact', content: '边界网关改用 openresty 处理全部入站流量', tags: [] },
        { kind: 'fact', content: '网关取消使用 openresty 处理全部入站流量', tags: [] },
      ],
      { maxEntryChars: 1000, dedupWindowMs: 24 * 60 * 60 * 1000, supersedeMode: 'auto' },
      createMetrics(),
      undefined,
    )
    const updated = await store.get('old-1')
    const markers = updated?.tags.filter((t) => t.startsWith(SUPERSEDED_BY_TAG_PREFIX)) ?? []
    // 修复前：第二个候选基于过期快照写入，覆盖掉第一个标记（只剩 1 个或语义断裂）
    expect(markers.length).toBe(2)
    await store.close()
  })

  it('T6: memory_store 近重复（>0.92）幂等返回已存在条目', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const metrics = createMetrics()
    const tool = createMemoryStoreTool(store, 1000, undefined, metrics, {
      dedupWindowMs: 24 * 60 * 60 * 1000,
    }) as unknown as Toolish
    const first = (await tool.execute({ content: '我喜欢用 vim 编辑器写代码' })) as {
      id: string
    }
    // 近重复（单字符差异，similarity ≈ 0.93 > 0.92）：修复前落穿继续写入新条目
    const second = (await tool.execute({ content: '我喜欢用 vim 编辑器写代码!' })) as { id: string }
    expect(second.id).toBe(first.id)
    expect((await store.list()).length).toBe(1)
    expect(metrics.rejectedDuplicate).toBe(1)
    await store.close()
  })
})

describe('1.1.1 加固回归：矛盾检测', () => {
  it('T7: conflictWindowMs 独立窗口使跨周信念反转可检测', () => {
    const DAY = 24 * 60 * 60 * 1000
    const now = Date.now()
    const oldBelief = entry({
      content: '团队使用 MongoDB 保存会话数据',
      createdAt: now - 20 * DAY,
    })
    const cand = { content: '以后不要使用 MongoDB 保存会话了', kind: 'fact' as const }
    // 旧语义（dedupWindowMs=24h）：旧条目已出窗 → 永远检测不到
    expect(detectContradiction([oldBelief], cand, { dedupWindowMs: DAY }, now)).toBeUndefined()
    // 新独立窗口（30 天）：跨周反转可检测
    const hit = detectContradiction([oldBelief], cand, { dedupWindowMs: DAY, conflictWindowMs: 30 * DAY }, now)
    expect(hit?.id).toBe(oldBelief.id)
  })

  it('T8: 含强对立信号（改用/不再用）的候选不进矛盾判定（词表互斥）', () => {
    const now = Date.now()
    const old = entry({ content: '网关使用 nginx 处理路由', createdAt: now - 1000 })
    // '改用' 为 supersede 强对立词：即使同时含 '不再'（弱对立），也应整体交给 supersede 协议
    const cand = { content: '网关不再用 nginx 了，改用 envoy 处理路由', kind: 'fact' as const }
    expect(detectContradiction([old], cand, { dedupWindowMs: 24 * 60 * 60 * 1000 }, now)).toBeUndefined()
  })
})

describe('1.1.1 加固回归：图谱与认知层', () => {
  it('T9: 被取代边经重新断言复活（invalidAt 不再是终身死刑）', () => {
    const g = new TemporalGraph(100)
    const t0 = 1000
    const t1 = 2000
    const t2 = 3000
    const original = entry({ content: '缓存服务使用 Redis 存会话', updatedAt: t0, createdAt: t0 })
    g.add(original)
    const superseded = entry({
      content: '缓存服务使用 Redis 存会话',
      updatedAt: t1,
      createdAt: t1,
      tags: ['superseded-by:new-1'],
    })
    g.add(superseded) // 同一三元组，条目被取代 → 边失效
    expect(g.stats(t1).activeEdges).toBe(0)
    // 数月后用户重新确立同一事实（无取代标记）→ 边复活
    const reasserted = entry({ content: '缓存服务使用 Redis 存会话', updatedAt: t2, createdAt: t2 })
    g.add(reasserted)
    const stats = g.stats(t2)
    expect(stats.activeEdges).toBeGreaterThan(0)
    // 失效期回放（t1 < asOf < t2）仍如实呈现失效
    expect(g.stats(t1 + 1).activeEdges).toBe(0)
  })

  it('T10: 蒸馏代际治理——新一代写入时上一代被 superseded-by 标记', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const DAY = 24 * 60 * 60 * 1000
    const base = Date.now() - 10 * DAY
    for (let i = 0; i < 3; i++) {
      await store.upsert(entry({ content: `前端项目统一使用 vitest 编写测试用例 ${i}`, createdAt: base + i * 1000 }))
    }
    const r1 = await runCognitiveMaintenance(
      store,
      {
        distillMode: 'auto',
        distillMinCluster: 3,
        consolidationMode: 'off',
        recallThreshold: 0.4,
        maxEntryChars: 1000,
      },
      createMetrics(),
    )
    expect(r1.distilled).toBe(1)
    const gen1 = (await store.list()).find((e) => e.id.startsWith('dist-'))
    expect(gen1).toBeDefined()
    // 簇成员增长 → 摘要含新成员数 → 新 id（新一代）
    await store.upsert(entry({ content: '前端项目统一使用 vitest 编写测试用例 3', createdAt: Date.now() }))
    const r2 = await runCognitiveMaintenance(
      store,
      {
        distillMode: 'auto',
        distillMinCluster: 3,
        consolidationMode: 'off',
        recallThreshold: 0.4,
        maxEntryChars: 1000,
      },
      createMetrics(),
    )
    expect(r2.distilled).toBe(1)
    const after = await store.get(gen1!.id)
    // 上一代被标记 superseded-by:<新一代>（修复前：旧代永久残留且霸占召回名额）
    expect(after?.tags.some((t) => t.startsWith(SUPERSEDED_BY_TAG_PREFIX))).toBe(true)
    await store.close()
  })

  it('T11: 巩固召回锚定——从未被真实召回的记忆不被假复习', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const DAY = 24 * 60 * 60 * 1000
    const old = Date.now() - 40 * DAY
    // 两条到期高价值记忆：一条从未被召回（accessCount=0），一条被真实召回过一次
    //（updatedAt 一并回拨——retrievability 取 max(lastAccessAt, updatedAt, createdAt)）
    await store.upsert(
      entry({
        id: 'never-used',
        kind: 'decision',
        source: 'explicit',
        content: '从未被使用的旧决策',
        createdAt: old,
        updatedAt: old,
      }),
    )
    await store.upsert(
      entry({
        id: 'used-once',
        kind: 'decision',
        source: 'explicit',
        content: '被召回过一次的旧决策',
        createdAt: old,
        updatedAt: old,
        accessCount: 1,
        lastAccessAt: old,
      }),
    )
    const r = await runCognitiveMaintenance(
      store,
      {
        distillMode: 'off',
        distillMinCluster: 3,
        consolidationMode: 'auto',
        recallThreshold: 0.4,
        maxEntryChars: 1000,
      },
      createMetrics(),
    )
    expect(r.consolidated).toBe(1)
    const never = await store.get('never-used')
    const used = await store.get('used-once')
    expect(never?.accessCount).toBe(0) // 未使用 → 容许自然衰减
    expect(used?.accessCount).toBe(2) // 使用过 → 到期巩固（真 SRS：间隔重复已用记忆）
    await store.close()
  })
})

describe('1.1.1 加固回归：存储可靠性', () => {
  it('T12: compact 回放式合并保留并发进程追加的外部行', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    for (let i = 0; i < 40; i++) {
      await store.upsert(entry({ content: `本地条目 ${i}` }))
      await store.remove((await store.list()).at(-1)!.id) // 拉高冗余行数
    }
    await store.upsert(entry({ id: 'local-keep', content: '本地保留条目' }))
    // 模拟另一进程在文件尾追加的外部行（本进程内存中不存在）
    const foreign = JSON.stringify(entry({ id: 'foreign-1', content: '外部进程写入的条目' }))
    const { appendFileSync } = await import('node:fs')
    appendFileSync(file, foreign + '\n', 'utf8')
    // 触发 compact：一次大批量写入把行数推过阈值
    for (let i = 0; i < 80; i++) {
      await store.upsert(entry({ content: `再写 ${i}` }))
      await store.remove((await store.list()).at(-1)!.id)
    }
    await store.close()
    // 重开：外部行必须在（修复前：本进程快照 rename 覆盖 → 外部行被静默吞噬）
    const reopened = await JsonlMemoryStore.open(file)
    const ids = (await reopened.list()).map((e) => e.id)
    expect(ids).toContain('local-keep')
    expect(ids).toContain('foreign-1')
    await reopened.close()
  })

  it('T13: 单实例锁——存活持有者使后来者禁用 compact 并告警；close 释放锁', async () => {
    const dir = freshDir()
    const file = join(dir, 'mem.jsonl')
    // 起一个真实存活的外部进程持有锁
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 300))
    try {
      writeFileSync(`${file}.lock`, `${child.pid}\n`, 'utf8')
      const logs: string[] = []
      const store = await JsonlMemoryStore.open(file, (m) => logs.push(m))
      expect(logs.some((l) => l.includes('another memory-hub instance'))).toBe(true)
      // 后开实例不持锁：close 后锁文件仍在（属外部持有者）
      await store.close()
      expect(existsSync(`${file}.lock`)).toBe(true)
    } finally {
      child.kill()
    }
    // 持有者退出后：新实例正常抢锁，close 释放
    await new Promise((r) => setTimeout(r, 200))
    const store2 = await JsonlMemoryStore.open(file)
    await store2.close()
    expect(existsSync(`${file}.lock`)).toBe(false)
  })
})

describe('1.1.1 加固回归：工具参数钳制', () => {
  it('T14: limit=0 / 负 supersededPenalty 被钳制而非静默退化', async () => {
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.upsert(entry({ id: 'k-1', content: '部署流程 alpha 约定一' }))
    await store.upsert(entry({ id: 'k-2', content: '部署流程 alpha 约定二' }))
    const tool = createMemoryRecallTool(store, 800, 8) as unknown as Toolish
    // limit:0 修复前 → 恒空结果；现在钳到下限 1
    const out = (await tool.execute({ query: 'alpha 部署', limit: 0 })) as { hits: unknown[] }
    expect(out.hits.length).toBe(1)
    // supersededPenalty: -5 修复前 → 被取代条目 score 为负被静默剔除；现在钳到 0
    const out2 = (await tool.execute({ query: 'alpha 部署', supersededPenalty: -5 })) as { hits: unknown[] }
    expect(out2.hits.length).toBeGreaterThan(0)
    await store.close()
  })
})

describe('1.1.1 加固回归：图谱实体归一层', () => {
  it('T15: 实体规范键对齐——大小写/尾标点变体不再 miss', () => {
    const g = new TemporalGraph(100)
    const t0 = 1000
    // 记忆侧主语经 normalizeForMatch 已小写；查询侧带大小写与尾标点的变体此前直接 miss
    g.add(entry({ content: '缓存服务使用 MySQL', updatedAt: t0, createdAt: t0 }))
    const nbr = g.neighborEntityScores(['MySQL。', 'MYSQL'], t0)
    expect(nbr.size).toBeGreaterThan(0)
    // 反查同样经规范键对齐
    expect(g.entryIdsByEntity('MySQL。').length).toBeGreaterThan(0)
  })

  it('T16: 对齐层——自然语言问句经共享特异 token 命中图实体', () => {
    const g = new TemporalGraph(100)
    const t0 = 1000
    const e = entry({ content: '前端项目构建工具使用 vite 加速开发', updatedAt: t0, createdAt: t0 })
    g.add(e)
    // 「用户平时喜欢用什么构建工具」与图键零精确匹配；共享 '构建'+'工具' 两个特异 token → 对齐
    const aligned = g.alignByTokens(['构建', '工具', '喜欢'])
    expect(aligned.length).toBeGreaterThan(0)
    // 完整链路：graphLineScores 对自然语言问句产出命中
    const byId = new Map<string, MemoryEntry>([[e.id, e]])
    const scores = graphLineScores(g, '用户平时喜欢用什么构建工具', byId, t0)
    expect(scores.size).toBeGreaterThan(0)
  })

  it('T17: validEntity 接受 node.js / c++ 类技术栈专名', () => {
    const g = new TemporalGraph(100)
    const t0 = 1000
    g.add(entry({ content: '运行时依赖 node.js 提供 http 服务', updatedAt: t0, createdAt: t0 }))
    g.add(entry({ content: '编译器组件使用 c++ 编写', updatedAt: t0, createdAt: t0 }))
    const stats = g.stats(t0)
    // 此前 '.'/'+' 不在白名单 → 这类实体全部被拒；现在应产出边
    expect(stats.edges).toBeGreaterThanOrEqual(2)
  })

  it('T18: 裸「是」降噪——双侧纯 CJK 的日常句不再产出垃圾三元组', () => {
    const g = new TemporalGraph(100)
    const t0 = 1000
    g.add(entry({ content: '今天是周三，这是对的', updatedAt: t0, createdAt: t0 }))
    expect(g.stats(t0).edges).toBe(0)
    // 任一侧含拉丁/数字（专名形态）仍产出
    const g2 = new TemporalGraph(100)
    g2.add(entry({ content: 'redis 是内存数据库', updatedAt: t0, createdAt: t0 }))
    expect(g2.stats(t0).edges).toBeGreaterThan(0)
  })
})
