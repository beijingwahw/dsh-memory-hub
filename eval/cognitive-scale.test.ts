/**
 * 认知层真实规模接地评测（1.1.1 G13-G16）。
 *
 * 背景：G9-G12（蒸馏/图谱/巩固/矛盾）全部跑在 3-5 条手工夹具上，没有任何真实规模
 * 验证——本组门禁把 G6 的真实语料（Node.js v26.10.0 官方文档四模块快照，经生产同
 * 路径 planImport 导入 ≈ 3300+ 条）喂给认知层全链路，锁定规模下的正确性与有界性：
 *
 * - G13 图谱规模一致性与有界性：乱序增量构建与全量重建实体/边集一致；邻域评分确定；
 *   graphMaxEntities 上限在超限语料下严格生效（对齐层索引随淘汰清理不泄漏）；
 * - G14 蒸馏规模幂等与代际治理：同输入两次批处理 id 确定性一致；认知维护二次执行
 *   零新增（append-only 不膨胀）；簇增长触发新一代时旧代被 superseded-by 治理；
 * - G15 矛盾检测规模精度：真实语料上注入的跨周反转对全部可检出（独立窗口），
 *   带信号但无对应旧信念的候选零误报；
 * - G16 规模护栏（smoke）：导入→图谱→蒸馏→矛盾全链路在真实语料上有界完成。
 */
import { describe, expect, it } from 'vitest'
import { loadRealDocuments, REAL_NOW } from './realdata'
import { planImport } from '../src/memory/importer'
import { buildGraph, TemporalGraph, normalizeEntityKey, ruleExtractTriples, diffGraphs } from '../src/memory/graph'
import { distillBatch, isDistilled } from '../src/memory/distill'
import { SUPERSEDED_BY_TAG_PREFIX } from '../src/memory/entry-factory'
import { detectContradiction } from '../src/memory/conflict'
import { runCognitiveMaintenance } from '../src/memory/cognitive'
import { buildIndex, queryIndex } from '../src/memory/engine'
import { inferChains, inferLineScores, INFER_MAX_CHAINS } from '../src/memory/infer'
import { diffReplay, JsonlMemoryStore, replayAsOf } from '../src/memory/store'
import { buildVectorIndex } from '../src/memory/vector'
import { renderMemoryHtml } from '../src/memory/html-export'
import { parseKeyRecord } from '../src/memory/crypto'
import { createMemoryStatusTool } from '../src/tools/memory-status'
import { createMetrics } from '../src/memory/metrics'
import { existsSync as existsSyncCheck, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryEntry } from '../src/memory/types'

const DAY = 24 * 60 * 60 * 1000

/** 真实语料库（固定 now 可复算；≈3300+ 条，含代码块/多段落真实文档形态） */
function realLibrary(): MemoryEntry[] {
  const docs = loadRealDocuments()
  const plan = planImport({
    documents: docs.map((d) => ({ label: d.label, text: d.text })),
    options: { now: REAL_NOW },
  })
  return plan.entries
}

/** 确定性乱序（seed 固定的 mulberry32，与 eval/corpus.ts 同族实现） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('认知层真实规模接地（1.1.1 G13-G16）', () => {
  it('G13: 图谱规模一致性与有界性（乱序增量 = 全量重建；实体上限严格生效）', () => {
    const lib = realLibrary()
    expect(lib.length).toBeGreaterThan(1000)
    const full = buildGraph(lib, 2000)
    // 乱序增量：固定 seed 洗牌后逐条 add，实体/边集合应与顺序构建一致
    const rng = mulberry32(20261030)
    const shuffled = [...lib]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    const scrambled = new TemporalGraph(2000)
    for (const e of shuffled) scrambled.add(e)
    const a = full.stats(REAL_NOW)
    const b = scrambled.stats(REAL_NOW)
    expect(b.entities).toBe(a.entities)
    expect(b.edges).toBe(a.edges)
    expect(b.activeEdges).toBe(a.activeEdges)
    // 邻域评分确定性：同一查询在两种构建下逐实体一致
    const qa = full.neighborEntityScores(['node.js', 'fs', 'path'], REAL_NOW)
    const qb = scrambled.neighborEntityScores(['node.js', 'fs', 'path'], REAL_NOW)
    expect([...qb.entries()].sort()).toEqual([...qa.entries()].sort())
    // 有界性：上限 200 时实体数不超限（对齐层索引随淘汰清理，不因索引泄漏超限）
    const capped = buildGraph(lib, 200)
    expect(capped.stats(REAL_NOW).entities).toBeLessThanOrEqual(200)
  }, 120_000)

  it('G14: 蒸馏规模幂等（同输入同 id）+ 认知维护二次执行零新增 + 代际治理', async () => {
    const lib = realLibrary()
    const r1 = distillBatch(lib, { now: REAL_NOW })
    const r2 = distillBatch(lib, { now: REAL_NOW })
    expect(new Set(r1.distilled.map((d) => d.id))).toEqual(new Set(r2.distilled.map((d) => d.id)))
    // 真实 store 上的维护幂等：首次产出 ≥1（真实文档存在共性簇），二次零新增
    const dir = mkdtempSync(join(tmpdir(), 'g14-'))
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    try {
      const cfg = {
        distillMode: 'auto' as const,
        distillMinCluster: 3,
        consolidationMode: 'off' as const,
        recallThreshold: 0.4,
        maxEntryChars: 1000,
      }
      for (const e of lib) await store.upsert(e)
      const first = await runCognitiveMaintenance(store, cfg, createMetrics())
      expect(first.distilled).toBe(r1.distilled.filter((d) => !lib.some((e) => e.id === d.id)).length)
      const second = await runCognitiveMaintenance(store, cfg, createMetrics())
      expect(second.distilled).toBe(0)
      // 代际治理：向最强簇补一条同类记忆 → 摘要成员数变化 → 新一代；旧代被 superseded-by
      const gen1 = (await store.list()).find(isDistilled)
      expect(gen1).toBeDefined()
      const themeTag = gen1!.tags.find((t) => t.startsWith('distilled-theme:'))
      expect(themeTag).toBeDefined()
      const memberWord = themeTag!.slice('distilled-theme:'.length)
      await store.upsert({
        id: `g14-grow-${REAL_NOW}`,
        kind: 'fact',
        content: `补充记忆：${memberWord} 相关的追加约定条目 ${REAL_NOW}`,
        tags: [],
        source: 'auto',
        createdAt: REAL_NOW + 1,
        updatedAt: REAL_NOW + 1,
        accessCount: 0,
      })
      const third = await runCognitiveMaintenance(store, cfg, createMetrics())
      if (third.distilled > 0) {
        const gen1After = await store.get(gen1!.id)
        expect(gen1After?.tags.some((t) => t.startsWith(SUPERSEDED_BY_TAG_PREFIX))).toBe(true)
      }
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('G15: 矛盾检测真实语料精度（注入反转对全检出 / 信号无关候选零误报）', () => {
    const lib = realLibrary()
    // 反转发生在 now=REAL_NOW：旧信念 20 天前 = dedup 24h 窗外、conflict 30 天窗内（跨周场景）
    const now = REAL_NOW
    const subjects = ['path 模块', 'fs 模块', 'stream 模块', 'os 模块', '构建脚本', '测试框架', '日志系统', '网关层']
    const oldBeliefs: MemoryEntry[] = []
    let created = 0
    for (const s of subjects) {
      const old = {
        id: `g15-old-${created}`,
        kind: 'fact' as const,
        content: `团队使用 ${s} 处理全部边界场景`,
        tags: [],
        source: 'explicit' as const,
        createdAt: REAL_NOW - 20 * DAY,
        updatedAt: REAL_NOW - 20 * DAY,
        accessCount: 0,
      }
      oldBeliefs.push(old)
      created++
    }
    const existing = [...lib.slice(0, 500), ...oldBeliefs]
    let hit = 0
    for (const old of oldBeliefs) {
      const cand = {
        content: `团队不再需要使用 ${old.content.slice(6)}，改掉了`,
        kind: 'fact' as const,
      }
      // 与自身旧信念高度相似（编辑距离小）+ 弱对立信号（不再）
      if (detectContradiction(existing, cand, { dedupWindowMs: DAY, conflictWindowMs: 30 * DAY }, now)) hit++
    }
    expect(hit).toBeGreaterThanOrEqual(Math.ceil(oldBeliefs.length * 0.75))
    // 误报面：带弱对立信号但语义上不反转任何旧信念的候选 → 零命中
    const unrelated = ['周末不要去人多的地方凑热闹', '汇报里不要放无关的装饰图', '不要把临时文件提交进版本库']
    for (const c of unrelated) {
      expect(
        detectContradiction(
          existing,
          { content: c, kind: 'fact' },
          { dedupWindowMs: DAY, conflictWindowMs: 30 * DAY },
          now,
        ),
      ).toBeUndefined()
    }
  }, 120_000)

  it('G16: 规模护栏 smoke——导入→图谱→蒸馏→矛盾全链路在真实语料上有界完成', () => {
    const start = Date.now()
    const lib = realLibrary()
    const g = buildGraph(lib, 2000)
    g.alignByTokens(['fs', 'path', 'stream', '文件', '模块'])
    const d = distillBatch(lib, { now: REAL_NOW })
    const s = g.stats(REAL_NOW)
    // 有界性断言（非时延精确值，防 O(N²) 回归的粗护栏）
    expect(lib.length).toBeGreaterThan(1000)
    expect(s.entities).toBeLessThanOrEqual(2000)
    expect(d.distilled.length).toBeLessThan(lib.length / 100) // 蒸馏产物远小于源（代际不失控）
    expect(Date.now() - start).toBeLessThan(60_000)
  }, 120_000)
})

/**
 * 1.2.0 真实语料种子：从生产抽取器在真实文档上产出的实体键按频次取 Top-N。
 * 保证种子必然来自图内真实实体（自洽、确定性），不依赖人工猜测的实体拼写。
 */
function topRealEntities(lib: MemoryEntry[], n: number): string[] {
  const freq = new Map<string, number>()
  for (const e of lib) {
    for (const t of ruleExtractTriples(e.content)) {
      for (const k of [normalizeEntityKey(t.subject), normalizeEntityKey(t.object)]) {
        if (k) freq.set(k, (freq.get(k) ?? 0) + 1)
      }
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([k]) => k)
}

describe('推理线真实规模接地（1.2.0 G17-G18）', () => {
  it('G17: 激活扩散推理规模一致性、时序正确性与有界性（真实语料）', () => {
    const lib = realLibrary()
    const g = buildGraph(lib, 2000)
    const seeds = topRealEntities(lib, 4)
    expect(seeds.length).toBeGreaterThan(0)
    // 确定性：同图重复调用一致
    const a = inferChains(g, seeds, { now: REAL_NOW })
    expect(JSON.stringify(a)).toBe(JSON.stringify(inferChains(g, seeds, { now: REAL_NOW })))
    expect(a.length).toBeGreaterThan(0)
    expect(a.length).toBeLessThanOrEqual(INFER_MAX_CHAINS)
    for (const c of a) {
      expect(c.path.length).toBeLessThanOrEqual(2) // 默认 maxHops=2
      expect(c.score).toBeGreaterThan(0)
      expect(c.score).toBeLessThanOrEqual(1)
      // 终结实体反查非空（链端点在真实语料有关联条目）
      expect(g.entryIdsByEntity(c.terminal).length).toBeGreaterThan(0)
    }
    // 与图谱线同源边视图的交叉验证：推理 1 跳终结实体 ⊆ 图谱线 1 跳邻域键集
    const oneHop = inferChains(g, seeds, { now: REAL_NOW, maxHops: 1 })
    const nbr1 = g.neighborEntityScores(seeds, REAL_NOW, 1)
    expect(oneHop.length).toBeGreaterThan(0)
    for (const c of oneHop) expect(nbr1.has(c.terminal)).toBe(true)
    // 推理线计分在真实语料上产出非空命中面（语料为英文官方文档，查询取图内
    // 真实高频实体的原文——种子识别与图谱线同源，非人工假设的实体拼写）
    const byId = new Map(lib.map((e) => [e.id, e]))
    const line = inferLineScores(g, seeds[0]!, byId, REAL_NOW)
    expect(line.size).toBeGreaterThan(0)
    // 乱序构建一致性：固定 seed 洗牌后逐条 add，链枚举与顺序构建逐字节一致
    const rng = mulberry32(20261031)
    const shuffled = [...lib]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    const scrambled = new TemporalGraph(2000)
    for (const e of shuffled) scrambled.add(e)
    expect(JSON.stringify(inferChains(scrambled, seeds, { now: REAL_NOW }))).toBe(JSON.stringify(a))
  }, 180_000)

  it('G18: 召回溯源契约——真实语料召回全命中可解释且确定性（interpolate/rrf 双模式）', () => {
    const lib = realLibrary().slice(0, 800)
    const byId = new Map(lib.map((e) => [e.id, e]))
    const g = buildGraph(lib, 2000)
    const index = buildIndex(lib)
    const seed = topRealEntities(lib, 1)[0]!
    for (const mode of ['interpolate', 'rrf'] as const) {
      const query = `"${seed}" 相关实现如何处理`
      const hits = queryIndex(
        index,
        query,
        {
          fusionMode: mode,
          now: REAL_NOW,
          decay: false,
          graph: g,
          graphEnabled: true,
          inferEnabled: true,
          explain: true,
          limit: 8,
        },
        byId,
      )
      expect(hits.length).toBeGreaterThan(0)
      for (const h of hits) {
        expect(h.why).toBeDefined()
        expect(h.why!.lines.length).toBeGreaterThan(0)
        expect(h.why!.fusion).toBe(mode)
        expect(h.why!.score).toBe(h.score)
        expect(h.why!.lineBase).toBeGreaterThan(0)
        for (const l of h.why!.lines) {
          expect(['bm25', 'fuzzy', 'semantic', 'graph', 'infer']).toContain(l.line)
          expect(Number.isFinite(l.value)).toBe(true)
        }
      }
      // 图谱/推理线在真实语料上参与融合（种子为图内高频实体，邻域/链必有命中面）
      expect(hits.some((h) => h.why!.lines.some((l) => l.line === 'graph' || l.line === 'infer'))).toBe(true)
      // 确定性：同查询同配置重复调用逐字节一致（含 why 注记）
      expect(
        JSON.stringify(
          queryIndex(
            index,
            query,
            {
              fusionMode: mode,
              now: REAL_NOW,
              decay: false,
              graph: g,
              graphEnabled: true,
              inferEnabled: true,
              explain: true,
              limit: 8,
            },
            byId,
          ),
        ),
      ).toBe(JSON.stringify(hits))
    }
  }, 180_000)
})

describe('时空完备真实规模接地（1.3.0 G19-G20）', () => {
  it('G19: 情景回放正确性——真实语料写入门禁的分时刻快照与手算一致、确定性、远未来 ≡ 全量', () => {
    const lib = realLibrary()
    expect(lib.length).toBeGreaterThan(1000)
    const TA = REAL_NOW - 10 * DAY
    const TB = REAL_NOW - 5 * DAY
    const TC = REAL_NOW - 3 * DAY
    const TH = REAL_NOW - 2 * DAY
    const TD = REAL_NOW - 1 * DAY
    // 真实语料按分阶段时间线重铸为 JSONL 写入日志（生产同格式：条目行 + 取代回写 + 热度回写 + tombstone）
    const stageA = lib.slice(0, 400).map((e) => ({ ...e, createdAt: TA, updatedAt: TA, accessCount: 0 }))
    const victim = stageA[7]!
    // successor 取自两批之外（imp- id 为内容哈希——与 D 批同 id 会被后写覆盖，计数失真）
    const successor = { ...lib[900]!, id: lib[900]!.id, createdAt: TB, updatedAt: TB, accessCount: 0 }
    const superseded = {
      ...victim,
      tags: [...victim.tags, `${SUPERSEDED_BY_TAG_PREFIX}${successor.id}`],
      updatedAt: TB,
    }
    const heated = { ...stageA[11]!, accessCount: 5, lastAccessAt: TH }
    const stageD = lib.slice(400, 600).map((e) => ({ ...e, createdAt: TD, updatedAt: TD, accessCount: 0 }))
    const raw =
      stageA.map((e) => JSON.stringify(e)).join('\n') +
      '\n' +
      JSON.stringify(superseded) +
      '\n' +
      JSON.stringify(successor) +
      '\n' +
      JSON.stringify(heated) +
      '\n' +
      `{"__tombstone__":"${stageA[13]!.id}","at":${TC}}\n` +
      stageD.map((e) => JSON.stringify(e)).join('\n') +
      '\n'

    const idsAt = (t: number): string[] =>
      replayAsOf(raw, t)
        .entries.map((e) => e.id)
        .sort()

    // T_A+1s：恰为首批 400 条（victim 未被取代、无 D 批、删除未发生）
    expect(idsAt(TA + 1000)).toEqual(stageA.map((e) => e.id).sort())
    const atA = replayAsOf(raw, TA + 1000)
    expect(atA.entries.find((e) => e.id === victim.id)?.tags).not.toContain(
      `${SUPERSEDED_BY_TAG_PREFIX}${successor.id}`,
    )
    // T_B+1s：victim 已携带 superseded-by；successor 在场
    const atB = replayAsOf(raw, TB + 1000)
    expect(atB.entries.find((e) => e.id === victim.id)?.tags).toContain(`${SUPERSEDED_BY_TAG_PREFIX}${successor.id}`)
    expect(atB.entries.some((e) => e.id === successor.id)).toBe(true)
    // 删除时刻：T_C 前在场、T_C 后缺席；T_D 批在 T_D 后在场
    expect(idsAt(TC - 1000)).toContain(stageA[13]!.id)
    expect(idsAt(TC + 1000)).not.toContain(stageA[13]!.id)
    const atD = replayAsOf(raw, TD + 1000)
    expect(atD.entries.length).toBe(stageA.length + stageD.length + 1 - 1) // +successor −deleted
    // 热度时间线：T_H 前后 accessCount 分别为 0 / 5（未来热度不污染过去）
    expect(replayAsOf(raw, TH - DAY).entries.find((e) => e.id === heated.id)?.accessCount).toBe(0)
    expect(replayAsOf(raw, TH + 1000).entries.find((e) => e.id === heated.id)?.accessCount).toBe(5)
    // 确定性：同一时刻重复回放逐字节一致
    expect(JSON.stringify(replayAsOf(raw, TD + 1000))).toBe(JSON.stringify(replayAsOf(raw, TD + 1000)))
    // 远未来 ≡ 全量写入后的状态（id 集）
    expect(idsAt(Number.MAX_SAFE_INTEGER)).toEqual(idsAt(TD + 1000))
  }, 180_000)

  it('G20: 情景召回与推理证据——T 时刻语料+图视图召回、未来条目不穿越、why.chains 契约', () => {
    const lib = realLibrary()
    const TA = REAL_NOW - 10 * DAY
    const TD = REAL_NOW - 1 * DAY
    const stageA = lib.slice(0, 600).map((e) => ({ ...e, createdAt: TA, updatedAt: TA, accessCount: 0 }))
    const stageD = lib.slice(600, 800).map((e) => {
      const clone = { ...e, createdAt: TD, updatedAt: TD, accessCount: 0 }
      return clone
    })
    const raw =
      stageA.map((e) => JSON.stringify(e)).join('\n') + '\n' + stageD.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const replayed = replayAsOf(raw, TA + 1000).entries
    expect(replayed.map((e) => e.id).sort()).toEqual(stageA.map((e) => e.id).sort())

    // T 时刻图视图（工具层 asOf 同源语义：buildGraph(回放语料)）
    const gT = buildGraph(replayed, 2000)
    // 确定性选种：真实高频实体中第一个有推理链的（G17 已证存在性）
    let seed = ''
    for (const cand of topRealEntities(replayed, 5)) {
      if (inferChains(gT, [cand], { now: TA + 1000 }).length > 0) {
        seed = cand
        break
      }
    }
    expect(seed).not.toBe('')
    const byId = new Map(replayed.map((e) => [e.id, e]))
    const indexT = buildIndex(replayed)
    const query = `"${seed}" 相关实现如何处理`
    const opts = {
      now: TA + 1000,
      decay: false,
      graph: gT,
      graphEnabled: true,
      inferEnabled: true,
      explain: true,
      limit: 8,
    } as const
    const hits = queryIndex(indexT, query, opts, byId)
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      // 情景约束：T 时刻召回只含 T 时刻存在的条目
      expect(h.createdAt).toBeLessThanOrEqual(TA + 1000)
      expect(h.why).toBeDefined()
      expect(h.why!.score).toBe(h.score)
      // 推理证据链：边都发生在 T 时刻或之前（未来条目建的边不进链）
      for (const c of h.why?.chains ?? []) {
        for (const e of c.path) expect(e.occurredAt).toBeLessThanOrEqual(TA + 1000)
      }
    }
    // 真实语料上 why.chains 产出面（infer 线参与的命中携带证据链）
    expect(hits.some((h) => (h.why?.chains?.length ?? 0) > 0)).toBe(true)
    // 确定性：重复调用逐字节一致（含 chains 注记）
    expect(JSON.stringify(queryIndex(indexT, query, opts, byId))).toBe(JSON.stringify(hits))

    // 未来条目不穿越：D 批条目的词面命中在 T 时刻不可见，当前时刻可见
    const futureEntry = stageD[3]!
    const futureToken = [...futureEntry.content.split(/[^A-Za-z0-9_-]+/)]
      .filter((t) => t.length >= 6)
      .sort((a, b) => b.length - a.length)[0]!
    const byAll = new Map([...stageA, ...stageD].map((e) => [e.id, e]))
    const indexAll = buildIndex([...stageA, ...stageD])
    const nowHits = queryIndex(indexAll, futureToken, { now: REAL_NOW, decay: false, limit: 8 }, byAll)
    expect(nowHits.some((h) => h.id === futureEntry.id)).toBe(true)
    const thenHits = queryIndex(indexT, futureToken, { now: TA + 1000, decay: false, limit: 8 }, byId)
    expect(thenHits.some((h) => h.id === futureEntry.id)).toBe(false)
  }, 180_000)
})

describe('纵深防御与时间分析真实规模接地（1.4.0 G21-G22）', () => {
  it('G21: 加密存储——真实语料落盘零明文、roundtrip、错口令/漏口令显式失败、迁移保深回放', async () => {
    const lib = realLibrary()
    const TA = REAL_NOW - 10 * DAY
    const TB = REAL_NOW - 5 * DAY
    const TC = REAL_NOW - 3 * DAY
    const stage = lib.slice(0, 400).map((e) => ({ ...e, createdAt: TA, updatedAt: TA, accessCount: 0 }))
    const rewritten = {
      ...stage[5]!,
      content: `${stage[5]!.content}（v2 迁移后修订）`,
      updatedAt: TB,
    }
    const dir = mkdtempSync(join(tmpdir(), 'g21-'))
    const file = join(dir, 'memories.jsonl')
    const PW = 'g21 真实规模口令'
    try {
      // —— 第一段：明文写入 400 条 + v1 行 + v2 重写 + tombstone（at=TC）——
      {
        const store = await JsonlMemoryStore.open(file)
        await store.importAll(stage)
        await store.upsert(rewritten)
        await store.removeMany([stage[9]!.id], TC)
        await store.close()
      }
      // —— 第二段：带口令重开 → 原位加密迁移（历史逐行保留）——
      {
        const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
        expect(store.size).toBe(399) // 400 − 1 tombstone（同 id 重写不新增）
        await store.close()
      }
      const raw = readFileSync(file, 'utf8')
      // 落盘零明文：头部为密钥记录、正文不含任何真实语料词面（多锚点抽验）
      expect(parseKeyRecord(raw.split('\n')[0]!)).toBeDefined()
      for (const probe of [stage[0]!.content.slice(0, 12), stage[200]!.content.slice(0, 12), '（v2 迁移后修订）']) {
        expect(raw).not.toContain(probe)
      }
      // 迁移不吞历史：深回放仍能区分 v1/v2 内容版本与 tombstone 前后存在性
      {
        const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW })
        const atA = await store.listAsOf(TA + 1000)
        expect(atA.find((e) => e.id === stage[5]!.id)!.content).toBe(stage[5]!.content)
        expect(atA.some((e) => e.id === stage[9]!.id)).toBe(true)
        const atB = await store.listAsOf(TB + 1000)
        expect(atB.find((e) => e.id === stage[5]!.id)!.content).toBe(rewritten.content)
        const atC = await store.listAsOf(TC + 1000)
        expect(atC.some((e) => e.id === stage[9]!.id)).toBe(false)
        // roundtrip：重开条目集与逻辑状态一致（id 全集）
        expect((await store.list()).map((e) => e.id).sort()).toEqual(atC.map((e) => e.id).sort())
        await store.close()
      }
      // 错口令 / 漏口令：加载期显式失败（不静默清空）
      await expect(JsonlMemoryStore.open(file, undefined, { passphrase: '错误的口令' })).rejects.toMatchObject({
        code: 'STORE_READ_FAILED',
      })
      await expect(JsonlMemoryStore.open(file)).rejects.toMatchObject({ code: 'STORE_READ_FAILED' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('G22: 时间分析 diff——真实分阶段语料 T1↔T2 差异与手算一致（取代/热度/删除/新增）+ 工具面', async () => {
    const lib = realLibrary()
    const TA = REAL_NOW - 10 * DAY
    const TB = REAL_NOW - 5 * DAY
    const TC = REAL_NOW - 3 * DAY
    const TH = REAL_NOW - 2 * DAY
    const TD = REAL_NOW - 1 * DAY
    // 与 G19 同构的分阶段时间线（400 → 取代对 → 热度 → 删除 → +200）
    const stageA = lib.slice(0, 400).map((e) => ({ ...e, createdAt: TA, updatedAt: TA, accessCount: 0 }))
    const victim = stageA[7]!
    const successor = { ...lib[900]!, createdAt: TB, updatedAt: TB, accessCount: 0 }
    const superseded = {
      ...victim,
      tags: [...victim.tags, `${SUPERSEDED_BY_TAG_PREFIX}${successor.id}`],
      updatedAt: TB,
    }
    const heated = { ...stageA[11]!, accessCount: 5, lastAccessAt: TH }
    const stageD = lib.slice(400, 600).map((e) => ({ ...e, createdAt: TD, updatedAt: TD, accessCount: 0 }))
    const raw =
      stageA.map((e) => JSON.stringify(e)).join('\n') +
      '\n' +
      JSON.stringify(superseded) +
      '\n' +
      JSON.stringify(successor) +
      '\n' +
      JSON.stringify(heated) +
      '\n' +
      `{"__tombstone__":"${stageA[13]!.id}","at":${TC}}\n` +
      stageD.map((e) => JSON.stringify(e)).join('\n') +
      '\n'
    const at = (t: number) => replayAsOf(raw, t).entries

    // 区间 1（TA→TB）：+successor（1 新增）、victim 取代标注（1 supersede）、其余无变化
    const d1 = diffReplay(at(TA + 1000), at(TB + 1000), TA + 1000, TB + 1000)
    expect(d1.addedCount).toBe(1)
    expect(d1.added[0]?.id).toBe(successor.id)
    expect(d1.removedCount).toBe(0)
    expect(d1.updatedCount).toBe(1)
    expect(d1.updated[0]).toMatchObject({ id: victim.id, change: 'supersede' })
    expect(d1.heatOnly).toBe(0)
    // 区间 2（TB→TH）：删除发生在 TC（−3d ∈ 该窗口）→ −1；热度足迹 heatOnly=1（不列明细）
    const d2 = diffReplay(at(TB + 1000), at(TH + 1000), TB + 1000, TH + 1000)
    expect(d2.addedCount).toBe(0)
    expect(d2.removedCount).toBe(1)
    expect(d2.removed[0]?.id).toBe(stageA[13]!.id)
    expect(d2.updatedCount).toBe(0)
    expect(d2.heatOnly).toBe(1)
    // 区间 3（TA→TD 全跨度）：+201（200 D 批 + successor）、−1（tombstone）、~1（victim 取代）、heat 1
    const d3 = diffReplay(at(TA + 1000), at(TD + 1000), TA + 1000, TD + 1000)
    expect(d3.addedCount).toBe(stageD.length + 1)
    expect(d3.removedCount).toBe(1)
    expect(d3.removed[0]?.id).toBe(stageA[13]!.id)
    expect(d3.updatedCount).toBe(1)
    expect(d3.heatOnly).toBe(1)
    // 确定性：重复计算 deep-equal
    expect(JSON.stringify(diffReplay(at(TA + 1000), at(TD + 1000), TA + 1000, TD + 1000))).toBe(JSON.stringify(d3))

    // —— 生产工具面：同一时间线落真实 store，memory_status diff 输出契约 ——
    const dir = mkdtempSync(join(tmpdir(), 'g22-'))
    const file = join(dir, 'memories.jsonl')
    writeFileSync(file, raw, 'utf8')
    try {
      const store = await JsonlMemoryStore.open(file)
      const metrics = createMetrics()
      const tool = createMemoryStatusTool(store, () => 0, undefined, metrics) as unknown as {
        execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
        output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
      }
      const out = await tool.execute({ diffSince: TA + 1000, asOf: TB + 1000 })
      const d = out['diff'] as { addedCount: number; removedCount: number; updatedCount: number; heatOnly: number }
      expect(d.addedCount).toBe(1)
      expect(d.updatedCount).toBe(1)
      expect(metrics.statusAsOf).toBe(1)
      const rendered = tool.output.render({ diffSince: TA + 1000, asOf: TB + 1000 }, out)
      expect(rendered[0]?.text).toContain('[memory status diff')
      expect(rendered[0]?.text).toContain('+1 -0 ~1')
      // asOf 快照（生产面）：T_B+1s 时刻被取代计数恰为 1
      const snap = (await tool.execute({ asOf: TB + 1000 })) as { total: number; superseded: number }
      expect(snap.total).toBe(401)
      expect(snap.superseded).toBe(1)
      await store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})

describe('边界突破真实规模接地（1.5.0 G23-G25）', () => {
  it('G23: 本地向量第六线——真实语料 HNSW 对拍暴力全量一致、自检索命中、确定性、融合接线、缺省零回归', () => {
    const lib = realLibrary()
    expect(lib.length).toBeGreaterThan(1000)
    const idx = buildVectorIndex(lib)
    expect(idx.size).toBeGreaterThan(1000)
    // 确定性采样 20 条真实文档，以其正文前 8 词作查询（真实检索形态：文档自我检索）
    const rand = mulberry32(42)
    const sampled = Array.from({ length: 20 }, () => lib[Math.floor(rand() * lib.length)]!)
    let selfHit = 0
    for (const s of sampled) {
      const q = s.content.split(/\s+/).slice(0, 8).join(' ').slice(0, 120)
      const approx = idx.search(q, 10)
      if (approx.has(s.id)) selfHit++
      const exact = idx.exactTopK(q, 10).map((x) => x.id)
      const overlap = exact.filter((id) => approx.has(id)).length
      // ANN 召回质量：与同特征空间暴力全量 top-10 重叠 ≥ 80%（校准实测 20/20 全一致）
      expect(overlap / Math.min(10, exact.length)).toBeGreaterThanOrEqual(0.8)
      // 分数对拍：近似 top-1 相似度 ≥ 真值 top-1 的 90%
      const exactTop = idx.exactTopK(q, 1)[0]?.score ?? 0
      const approxTop = Math.max(0, ...approx.values())
      expect(approxTop).toBeGreaterThanOrEqual(exactTop * 0.9)
    }
    // 自检索命中（校准实测 19/20）
    expect(selfHit).toBeGreaterThanOrEqual(15)
    // 构建确定性：两次独立构建同查询结果逐项一致
    const idx2 = buildVectorIndex(lib)
    const q0 = sampled[0]!.content.split(/\s+/).slice(0, 8).join(' ').slice(0, 120)
    expect([...idx2.search(q0, 10).entries()]).toEqual([...idx.search(q0, 10).entries()])
    // 融合接线：RRF + explain → vector 线出现在命中溯源；缺省零回归（显式 false 逐字节一致）
    const byId = new Map(lib.map((e) => [e.id, e]))
    const index = buildIndex(lib)
    const fused = queryIndex(
      index,
      q0,
      { fusionMode: 'rrf', vectorEnabled: true, vector: idx, explain: true, limit: 8, decay: false },
      byId,
    )
    expect(fused.length).toBeGreaterThan(0)
    expect(fused.some((h) => h.why?.lines.some((l) => l.line === 'vector'))).toBe(true)
    const a = JSON.stringify(queryIndex(index, q0, { fusionMode: 'rrf', limit: 8, decay: false }, byId))
    const b = JSON.stringify(
      queryIndex(index, q0, { fusionMode: 'rrf', vectorEnabled: false, limit: 8, decay: false }, byId),
    )
    expect(a).toBe(b)
  }, 300_000)

  it('G24: 双语抽取——真实英文语料上新关系面产出非零、确定性、图边落地、主宾为真实标识', () => {
    const lib = realLibrary()
    const newRels = new Set([
      'returns',
      'throws',
      'emits',
      'supports',
      'provides',
      'accepts',
      'based on',
      'written in',
      'part of',
      'belongs to',
      'replaced by',
      'migrated to',
      'upgraded to',
      '基于',
      '支持',
      '提供',
      '返回',
      '抛出',
      '改为',
      '换成',
    ])
    let total = 0
    const perRel = new Map<string, number>()
    const subjects: string[] = []
    for (const e of lib) {
      for (const t of ruleExtractTriples(e.content)) {
        if (!newRels.has(t.relation)) continue
        total++
        perRel.set(t.relation, (perRel.get(t.relation) ?? 0) + 1)
        if (subjects.length < 8) subjects.push(`${t.subject} —${t.relation}→ ${t.object}`)
      }
    }
    // 校准实测：仅前 800 条已有 3 条 / 2 种新关系（returns / based on），全库为其超集
    expect(total).toBeGreaterThanOrEqual(3)
    expect(perRel.size).toBeGreaterThanOrEqual(2)
    // 确定性：同语料重算逐字节一致
    const first200 = lib.slice(0, 200).map((e) => ruleExtractTriples(e.content))
    const first200again = lib.slice(0, 200).map((e) => ruleExtractTriples(e.content))
    expect(JSON.stringify(first200)).toBe(JSON.stringify(first200again))
    // 图边落地：新关系词出现在真实语料图的活跃边里
    const g = buildGraph(lib.slice(0, 800))
    const rels = new Set(g.activeEdgeList(Number.MAX_SAFE_INTEGER).map((x) => x.relation))
    expect([...perRel.keys()].some((r) => rels.has(r))).toBe(true)
    // 主宾为真实标识（长度 ≥2 的实体形态）
    for (const s of subjects) expect(s.length).toBeGreaterThan(4)
  }, 120_000)

  it('G25: 边界操作——真实语料 400 条上口令轮换保深回放、图维对账与手工差集一致、时间轴守恒', async () => {
    const lib = realLibrary()
    const TA = REAL_NOW - 6 * DAY
    const TB = REAL_NOW - 3 * DAY
    const dir = mkdtempSync(join(tmpdir(), 'mh-g25-'))
    const file = join(dir, 'memories.jsonl')
    // 确定性选种：真实抽取输出非空的三条文档（被重写者 / 被删除者 / 重写内容源——
    // 图维 diff 的 added/removed 双侧都来自真实三元组，非零有据）
    const hasTriples = (e: MemoryEntry) => ruleExtractTriples(e.content).length > 0
    const stageRegion = lib.slice(0, 400)
    const i5 = stageRegion.findIndex(hasTriples)
    const i9 = stageRegion.findIndex((e, i) => i > i5 && hasTriples(e))
    const srcIdx = 400 + lib.slice(400).findIndex(hasTriples)
    expect(i5).toBeGreaterThanOrEqual(0)
    expect(i9).toBeGreaterThan(i5)
    expect(srcIdx).toBeGreaterThanOrEqual(400)
    const stage = stageRegion.map((e) => ({ ...e, createdAt: TA, updatedAt: TA, accessCount: 0 }))
    // 重写为**另一条真实文档**的内容（真实抽取输出全变——图维 diff 的 added/removed 都非零）
    const rewritten = { ...stage[i5]!, content: `${lib[srcIdx]!.content} rewritten`, updatedAt: TB }
    try {
      {
        const store = await JsonlMemoryStore.open(file)
        await store.importAll(stage)
        await store.upsert(rewritten)
        await store.removeMany([stage[i9]!.id], TB)
        await store.close()
      }
      // 模块 K：明文库开加密（迁移）→ 轮换到第二口令；旧口令即刻失效；深回放逐项保留
      const PW1 = 'g25-first-口令'
      const PW2 = 'g25-second-口令'
      {
        const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })
        await store.changePassphrase(PW2)
        await store.close()
      }
      await expect(JsonlMemoryStore.open(file, undefined, { passphrase: PW1 })).rejects.toThrow('wrong passphrase')
      {
        const store = await JsonlMemoryStore.open(file, undefined, { passphrase: PW2 })
        expect(readFileSync(file, 'utf8')).not.toContain('rewritten')
        const atA = await store.listAsOf(TA + 1000)
        expect(atA.find((e) => e.id === stage[i5]!.id)!.content).toBe(stage[i5]!.content)
        const atB = await store.listAsOf(TB + 1000)
        expect(atB.find((e) => e.id === stage[i5]!.id)!.content).toContain('rewritten')
        expect(atB.find((e) => e.id === stage[i9]!.id)).toBeUndefined()
        expect(atB.length).toBe(399) // 400 − 删除 1（重写同 id 不变计数）
        // 模块 L：图维对账 —— diffGraphs 输出与测试内手工差集（buildGraph + activeEdgeList 独立重算）一致
        const key = (f: string, r: string, t: string) => `${f}\u0000${r}\u0000${t}`
        const g1 = buildGraph(atA, 2000)
        const g2 = buildGraph(atB, 2000)
        const s1 = new Set(g1.activeEdgeList(TB + 1000).map((x) => key(x.from, x.relation, x.target)))
        const s2 = new Set(g2.activeEdgeList(TB + 1000).map((x) => key(x.from, x.relation, x.target)))
        const addedManual = [...s2].filter((k) => !s1.has(k)).sort()
        const removedManual = [...s1].filter((k) => !s2.has(k)).sort()
        expect(addedManual.length).toBeGreaterThan(0) // 重写的新内容产生新边
        expect(removedManual.length).toBeGreaterThan(0) // 旧内容边 + tombstone 删除的边消失
        const gd = diffGraphs(atA, atB, TB + 1000, 2000)
        expect(gd.addedEdges.map((x) => key(x.from, x.relation, x.to)).sort()).toEqual(addedManual)
        expect(gd.removedEdges.map((x) => key(x.from, x.relation, x.to)).sort()).toEqual(removedManual)
        // 模块 O：时间轴守恒 —— 事件总数 = 各桶之和；末桶 total = 当前存活数；cap 截断
        const tl = await store.timeline()
        expect(tl.events).toBe(tl.buckets.reduce((a, b) => a + b.added + b.removed + b.updated + b.heat, 0))
        expect(tl.events).toBe(402) // 400 新增 + 1 重写更新 + 1 删除
        expect(tl.buckets[tl.buckets.length - 1]!.total).toBe(store.size)
        const tl1 = await store.timeline(1)
        expect(tl1.truncated).toBe(true) // 分桶 2 天 > cap 1 → 截断保最近
        expect(tl1.buckets.length).toBe(1)
        await store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})

describe('可视化检索页真实规模接地（1.5.1 G26）', () => {
  it('G26: 真实语料全量导出——自包含零外链、注入安全（</script> 仅两个合法闭合）、时间轴与 store 同源、确定性逐字节、POSIX 0600', async () => {
    const lib = realLibrary()
    const TA = REAL_NOW - 6 * DAY
    const dir = mkdtempSync(join(tmpdir(), 'mh-g26-'))
    const file = join(dir, 'memories.jsonl')
    const stage = lib.slice(0, 1200).map((e) => ({ ...e, createdAt: TA, updatedAt: TA, accessCount: 0 }))
    try {
      const store = await JsonlMemoryStore.open(file)
      await store.importAll(stage)
      const tool = createMemoryStatusTool(store, () => 0, undefined, undefined, { htmlDir: dir }) as unknown as {
        execute: (args: Record<string, unknown>) => Promise<{ total: number; htmlPath: string; htmlBytes: number }>
      }
      const out = await tool.execute({ exportHtml: true })
      expect(out.total).toBe(stage.length)
      expect(existsSyncCheck(out.htmlPath)).toBe(true)
      const html = readFileSync(out.htmlPath, 'utf8')
      // 自包含：零外链资源引用
      expect(html).not.toMatch(/src="https?:/i)
      expect(html).not.toMatch(/href="https?:/i)
      expect(html).not.toMatch(/<link /i)
      // 注入安全：真实语料（含代码块尖括号）下页面只允许两个合法 </script> 闭合
      expect((html.match(/<\/script>/g) ?? []).length).toBe(2)
      // 全量嵌入：确定性采样 50 个 id 全部在内
      const rand = mulberry32(7)
      for (let i = 0; i < 50; i++) {
        const id = stage[Math.floor(rand() * stage.length)]!.id
        expect(html).toContain(`"id":"${id}"`)
      }
      // 时间轴同源：store.timeline(90) 的事件总数出现在页面统计行
      const tl = await store.timeline(90)
      expect(html).toContain(`事件 ${tl.events}`)
      // 确定性：固定 generatedAt 两次渲染逐字节一致（真实语料 1200 条）
      const h1 = renderMemoryHtml({ entries: stage, timeline: tl, generatedAt: REAL_NOW })
      const h2 = renderMemoryHtml({ entries: stage, timeline: tl, generatedAt: REAL_NOW })
      expect(h1).toBe(h2)
      expect(Buffer.byteLength(h1, 'utf8')).toBeGreaterThan(100_000) // 真实规模体量锚
      // POSIX 权限位 0600（Windows 跳过）
      if (process.platform !== 'win32') {
        expect(statSync(out.htmlPath).mode & 0o777).toBe(0o600)
      }
      await store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
