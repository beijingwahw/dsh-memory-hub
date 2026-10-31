/**
 * 情景回放（1.3.0，DESIGN-1.3 模块 G）行为锁定。
 *
 * 覆盖面：
 * - replayAsOf 纯函数：存在性时间线 / 内容版本回放 / 取代标注时间线 / 热度回写不污染过去 /
 *   tombstone 删除时刻（带 at 与旧格式）/ 删除后复活 / 损坏行跳过 / 确定性（重复回放一致）/
 *   远未来 asOf ≡ 加载语义；
 * - 存储层 listAsOf：分阶段写入与手算一致 / removeMany(ids, now) 的 at 时间戳 /
 *   回放只读（revision 与文件行数不变）；
 * - 工具面：memory_recall asOf 只召回当时存在的记忆、不写热度、metrics.asOfRecalls 计数、
 *   渲染含回放时刻、缺省（无 asOf）输出形状不变；无 listAsOf 实现的降级路径。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonlMemoryStore, replayAsOf } from '../../src/memory/store'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import type { RecallOutput } from '../../src/tools/memory-recall'
import { createMetrics } from '../../src/memory/metrics'
import type { MemoryEntry } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** 把条目序列化为 JSONL 行（与 store 落盘格式一致） */
function lines(...entries: MemoryEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

/** 分阶段语料：T0 建 e1/e2；T1 e1 改写内容（v2）；T2 e2 被取代（补 superseded-by）；T3 新条目 e3 */
function stagedRaw(): string {
  const e1v1 = freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 })
  const e2 = freshEntry({ id: 'e2', content: '缓存 使用 Redis', createdAt: T0, updatedAt: T0 })
  const e1v2 = { ...e1v1, content: '部署用 Node 20', updatedAt: T0 + DAY }
  const e2Sup = { ...e2, tags: [...e2.tags, 'superseded-by:e4'], updatedAt: T0 + 2 * DAY }
  const e4 = freshEntry({ id: 'e4', content: '缓存 使用 Valkey', createdAt: T0 + 2 * DAY, updatedAt: T0 + 2 * DAY })
  const e3 = freshEntry({ id: 'e3', content: '网关 使用 Nginx', createdAt: T0 + 3 * DAY, updatedAt: T0 + 3 * DAY })
  return lines(e1v1, e2, e1v2, e2Sup, e4, e3)
}

describe('情景回放纯函数（replayAsOf）', () => {
  it('存在性时间线：晚于 asOf 创建的条目不存在，之后的时刻存在', () => {
    const raw = stagedRaw()
    const at0 = replayAsOf(raw, T0 + 1000)
    expect(at0.entries.map((e) => e.id).sort()).toEqual(['e1', 'e2'])
    const at3 = replayAsOf(raw, T0 + 3 * DAY + 1000)
    expect(at3.entries.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3', 'e4'])
  })

  it('内容版本回放：改写发生在 T1 → asOf ∈ [T0,T1) 看到旧内容，≥ T1 看到新内容', () => {
    const raw = stagedRaw()
    expect(replayAsOf(raw, T0 + 1000).entries.find((e) => e.id === 'e1')?.content).toBe('部署用 Node 18')
    expect(replayAsOf(raw, T0 + DAY + 1000).entries.find((e) => e.id === 'e1')?.content).toBe('部署用 Node 20')
  })

  it('取代标注时间线：supersede 回写在 T2 → 之前旧条目无标记，之后携带标记', () => {
    const raw = stagedRaw()
    const before = replayAsOf(raw, T0 + DAY + 1000).entries.find((e) => e.id === 'e2')
    const after = replayAsOf(raw, T0 + 2 * DAY + 1000).entries.find((e) => e.id === 'e2')
    expect(before?.tags).toEqual([])
    expect(after?.tags).toContain('superseded-by:e4')
  })

  it('热度回写不污染过去：bump 发生在 Tb → asOf < Tb 回放 bump 前的 accessCount', () => {
    const e1 = freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 })
    // 1.2.0 bumped() 协议：updatedAt 原样保留、lastAccessAt = bump 时刻、accessCount+1
    const bumped = { ...e1, accessCount: 5, lastAccessAt: T0 + DAY }
    const raw = lines(e1, bumped)
    expect(replayAsOf(raw, T0 + 1000).entries[0]?.accessCount).toBe(0)
    expect(replayAsOf(raw, T0 + DAY + 1000).entries[0]?.accessCount).toBe(5)
  })

  it('tombstone 删除时刻：at ≤ asOf 已删除，at > asOf 仍存在；之后重加可复活', () => {
    const e1 = freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 })
    const tomb = `{"__tombstone__":"e1","at":${T0 + DAY}}`
    const revived = freshEntry({
      id: 'e1',
      content: '部署用 Node 18',
      createdAt: T0 + 2 * DAY,
      updatedAt: T0 + 2 * DAY,
    })
    const raw = lines(e1) + tomb + '\n' + lines(revived)
    expect(replayAsOf(raw, T0 + 1000).entries.map((e) => e.id)).toEqual(['e1'])
    expect(replayAsOf(raw, T0 + DAY + 1000).entries).toHaveLength(0)
    expect(replayAsOf(raw, T0 + 2 * DAY + 1000).entries.map((e) => e.id)).toEqual(['e1'])
  })

  it('旧格式 tombstone（无 at）：删除时刻未知 → 任意时刻保守视为已删除', () => {
    const e1 = freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 })
    const raw = lines(e1) + '{"__tombstone__":"e1"}\n'
    expect(replayAsOf(raw, T0 + 1000).entries).toHaveLength(0)
    expect(replayAsOf(raw, T0 + 100 * DAY).entries).toHaveLength(0)
  })

  it('损坏行跳过并计数（与加载语义一致）', () => {
    const e1 = freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 })
    const raw = lines(e1) + '{not json\n' + '{"kind":"fact"}\n'
    const r = replayAsOf(raw, T0 + 1000)
    expect(r.entries.map((e) => e.id)).toEqual(['e1'])
    expect(r.skippedCorrupt).toBe(2)
  })

  it('确定性：同一文件重复回放逐字节一致', () => {
    const raw = stagedRaw()
    const a = replayAsOf(raw, T0 + 2 * DAY)
    const b = replayAsOf(raw, T0 + 2 * DAY)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('远未来 asOf 与加载语义一致（等价于当前存活集）', async () => {
    const raw = stagedRaw() + `{"__tombstone__":"e3","at":${T0 + 4 * DAY}}\n`
    const replayed = replayAsOf(raw, Number.MAX_SAFE_INTEGER).entries
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const file = join(dir, 'mem.jsonl')
    writeFileSync(file, raw, 'utf8')
    const store = await JsonlMemoryStore.open(file)
    const live = await store.list()
    expect(replayed.map((e) => e.id).sort()).toEqual(live.map((e) => e.id).sort())
    for (const e of replayed) {
      expect(JSON.stringify(e)).toBe(JSON.stringify(live.find((l) => l.id === e.id)))
    }
    await store.close()
  })
})

describe('存储层 listAsOf（JsonlMemoryStore）', () => {
  it('分阶段写入：listAsOf 与写入时间线手算一致；远未来 ≡ list()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const e1 = freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 })
    const e2 = freshEntry({ id: 'e2', content: '网关 使用 Nginx', createdAt: T0 + 2 * DAY, updatedAt: T0 + 2 * DAY })
    await store.upsert(e1)
    await store.upsert(e2)
    const e1Sup = { ...e1, tags: [...e1.tags, 'superseded-by:e2'], updatedAt: T0 + 3 * DAY }
    await store.upsert(e1Sup)

    const atMid = await store.listAsOf(T0 + DAY)
    expect(atMid.map((e) => e.id)).toEqual(['e1'])
    expect(atMid[0]?.tags).toEqual([])

    const atEnd = await store.listAsOf(T0 + 3 * DAY + 1000)
    expect(atEnd.map((e) => e.id).sort()).toEqual(['e1', 'e2'])
    expect(atEnd.find((e) => e.id === 'e1')?.tags).toContain('superseded-by:e2')

    const live = await store.list()
    const future = await store.listAsOf(Number.MAX_SAFE_INTEGER)
    expect(future.map((e) => e.id)).toEqual(live.map((e) => e.id))
    await store.close()
  })

  it('removeMany(ids, now) 写入删除时刻：now 之前仍存在、之后已删除', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    const e1 = freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 })
    await store.upsert(e1)
    const delAt = T0 + DAY
    await store.removeMany(['e1'], delAt)
    expect((await store.listAsOf(delAt - 1)).map((e) => e.id)).toEqual(['e1'])
    expect(await store.listAsOf(delAt + 1)).toHaveLength(0)
    // tombstone 行携带 at（落盘格式锁定）
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain(`"__tombstone__":"e1","at":${delAt}`)
    await store.close()
  })

  it('回放只读：revision 与文件行数不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const file = join(dir, 'mem.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 }))
    const revBefore = store.revision
    const sizeBefore = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length
    await store.listAsOf(T0 + 1000)
    await store.listAsOf(T0 - 1000)
    expect(store.revision).toBe(revBefore)
    expect(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim()).length,
    ).toBe(sizeBefore)
    await store.close()
  })
})

describe('工具面：memory_recall asOf 情景回放', () => {
  /** 分阶段真存储：T0 写 Node 条目；T2 写同话题新条目（词面更强命中） */
  async function stagedStore(): Promise<{ store: JsonlMemoryStore; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    await store.upsert(freshEntry({ id: 'old', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 }))
    await store.upsert(
      freshEntry({
        id: 'new',
        content: '部署用 Node 22 LTS',
        createdAt: T0 + 2 * DAY,
        updatedAt: T0 + 2 * DAY,
      }),
    )
    return { store, dir }
  }

  function as<T>(tool: unknown): T {
    return tool as T
  }

  it('asOf 只召回当时存在的记忆；不写热度；metrics.asOfRecalls 计数；渲染含回放时刻', async () => {
    const { store } = await stagedStore()
    const metrics = createMetrics()
    const tool = as<{
      execute: (args: Record<string, unknown>) => Promise<RecallOutput>
      output: { render: (args: unknown, value: RecallOutput) => Array<{ type: string; text: string }> }
    }>(createMemoryRecallTool(store, 400, 8, undefined, metrics))
    const before = await store.list()
    const rev0 = store.revision
    const out = await tool.execute({ query: 'Node 部署', asOf: T0 + DAY, limit: 8, maxTokens: 400 })
    expect(out.total).toBeGreaterThan(0)
    expect(out.hits.every((h) => h.id === 'old')).toBe(true)
    // 只读回放：热度/版本号不变（无 heat 回写、无缓存污染）
    const after = await store.list()
    expect(after.find((e) => e.id === 'old')?.accessCount).toBe(before.find((e) => e.id === 'old')?.accessCount)
    expect(store.revision).toBe(rev0)
    expect(metrics.asOfRecalls).toBe(1)
    // 渲染：回放时刻前缀（ISO 8601）
    const text = tool.output.render({ query: 'Node 部署', asOf: T0 + DAY }, out)[0]?.text ?? ''
    expect(text).toContain(`@${new Date(T0 + DAY).toISOString()}`)
    expect(text).toContain('[memory recall @')

    // 对照：无 asOf（当前时刻）能看到后写条目
    const now2 = await tool.execute({ query: 'Node 部署', limit: 8, maxTokens: 400, reinforce: false })
    expect(now2.hits.some((h) => h.id === 'new')).toBe(true)
    // 缺省渲染无回放前缀（形状不变）
    const text2 = tool.output.render({ query: 'Node 部署' }, now2)[0]?.text ?? ''
    expect(text2).toContain('[memory recall] ')
    await store.close()
  })

  it('asOf 时刻早于一切写入 → 空结果（当时还没有记忆）', async () => {
    const { store } = await stagedStore()
    const tool = as<{ execute: (args: Record<string, unknown>) => Promise<RecallOutput> }>(
      createMemoryRecallTool(store, 400, 8),
    )
    const out = await tool.execute({ query: 'Node 部署', asOf: T0 - DAY, limit: 8, maxTokens: 400 })
    expect(out.total).toBe(0)
    expect(out.hits).toHaveLength(0)
    await store.close()
  })

  it('asOf + 图谱/推理/溯源：回放语料重建 T 时刻图——未来条目（词面+图边）都不参与 T 时刻召回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    // T0：主链 主数据库—使用→PostgreSQL—依赖→MVCC—属于→事务机制
    await store.upsert(freshEntry({ id: 'e1', content: '主数据库 使用 PostgreSQL', createdAt: T0, updatedAt: T0 }))
    await store.upsert(freshEntry({ id: 'e2', content: 'PostgreSQL 依赖 MVCC', createdAt: T0, updatedAt: T0 }))
    await store.upsert(freshEntry({ id: 'e3', content: 'MVCC 属于 事务机制', createdAt: T0, updatedAt: T0 }))
    // T0+2d：未来条目（既有词面命中也有新图边「~依赖」反向边）
    await store.upsert(
      freshEntry({
        id: 'future',
        content: '并发吞吐 依赖 MVCC',
        createdAt: T0 + 2 * DAY,
        updatedAt: T0 + 2 * DAY,
      }),
    )
    // 运行时图（当前视图，含未来边）——工具在 asOf 时应改用回放语料重建的 T 时刻图
    const { buildGraph } = await import('../../src/memory/graph')
    const runtimeGraph = buildGraph(await store.list(), 100)
    const metrics = createMetrics()
    const tool = as<{
      execute: (args: Record<string, unknown>) => Promise<RecallOutput>
    }>(createMemoryRecallTool(store, 400, 8, undefined, metrics, undefined, { inferEnabled: true }, runtimeGraph, 100))
    // T 时刻：词面上「并发吞吐」只存在于未来条目 → 不应召回（条目层回放已排除）
    const atT = await tool.execute({
      query: '并发吞吐 的实现机制',
      asOf: T0 + DAY,
      explain: true,
      reinforce: false,
      limit: 8,
      maxTokens: 400,
    })
    for (const h of atT.hits) {
      expect(h.id).not.toBe('future')
      // 推理证据链的边都发生在 T 时刻或之前（T 时刻图视图不含未来边）
      for (const c of h.why?.chains ?? []) {
        for (const e of c.path) expect(e.occurredAt).toBeLessThanOrEqual(T0 + DAY)
      }
    }
    expect(metrics.asOfRecalls).toBe(1)
    // 对照（当前时刻）：未来条目词面可召回
    const now2 = await tool.execute({
      query: '并发吞吐 的实现机制',
      reinforce: false,
      limit: 8,
      maxTokens: 400,
    })
    expect(now2.hits.some((h) => h.id === 'future')).toBe(true)
    await store.close()
  })

  it('降级路径：存储无 listAsOf 实现时按 createdAt 过滤（文档化降级）', async () => {
    const e1 = freshEntry({ id: 'e1', content: '部署用 Node 18', createdAt: T0, updatedAt: T0 })
    const e1v2 = { ...e1, content: '部署用 Node 22', updatedAt: T0 + 2 * DAY }
    let rows = [e1v2]
    const degraded = {
      upsert: (e: MemoryEntry) => {
        rows = [...rows.filter((r) => r.id !== e.id), e]
        return Promise.resolve(e)
      },
      list: () => Promise.resolve([...rows]),
      get: (id: string) => Promise.resolve(rows.find((r) => r.id === id)),
      remove: () => Promise.resolve(false),
      close: () => Promise.resolve(),
    } as unknown as JsonlMemoryStore
    const tool = as<{ execute: (args: Record<string, unknown>) => Promise<RecallOutput> }>(
      createMemoryRecallTool(degraded, 400, 8),
    )
    // createdAt = T0 ≤ asOf → 条目可见（内容为当前版本——降级语义，无内容版本回溯）
    const out = await tool.execute({ query: 'Node 部署', asOf: T0 + DAY, limit: 8, maxTokens: 400 })
    expect(out.hits.some((h) => h.id === 'e1')).toBe(true)
    // createdAt > asOf → 不可见
    const rows2 = [
      freshEntry({ id: 'later', content: '部署用 Node 22', createdAt: T0 + 2 * DAY, updatedAt: T0 + 2 * DAY }),
    ]
    ;(degraded as unknown as { list: () => Promise<MemoryEntry[]> }).list = () => Promise.resolve([...rows2])
    const out2 = await tool.execute({ query: 'Node 部署', asOf: T0 + DAY, limit: 8, maxTokens: 400 })
    expect(out2.total).toBe(0)
  })
})
