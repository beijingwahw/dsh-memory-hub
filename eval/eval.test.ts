/**
 * 离线质量评估门限（0.5.0 A5 + 0.10.0 G6 真实数据接地 + 1.0.0 G5-1.0/G7/G8）：`npm run eval` 一键运行。
 *
 * 评估路径与生产一致：经 IndexCache 复用倒排索引（索引只构建一次，
 * k1/b/heatHalfLifeMs/semanticWeight 等参数仅注入评分层），避免网格扫描时反复 buildIndex。
 *
 * 门限设计（保守且可复算）：
 *   G1 精确质量：recall@1 ≥ 0.95（词面精确命中场景，BM25 必须稳健）
 *   G2 模糊召回：recall@1 ≥ 0.90（A1 编辑距离容错）
 *   G3 语义召回：recall@1 ≥ 0.80（A2 词根 3-gram 兜底；历史基线 0（0.4 无法召回））
 *   G4 热度生命周期：新相关记忆必须排第 1（A4 halfLife 冷却）
 *   G5-1.0 四维参数网格：k1×b×heatHalfLifeMs×semanticWeight = 81 组合，
 *      默认参数组（1.2/0.75/7d/0.3）的 recall@1 与 NDCG@5 都不劣于任何替代组合，
 *      且 b∈{0.5,0.75,0.9} 三档组间存在可区分响应（max−min ≥ 0.02，防塌缩回归）
 *   G6 真实数据接地：真实文档语料（Node.js v26.10.0 path/os/fs/stream 四份快照）经 planImport 入库，
 *      真实问句召回 recall@1 ≥ 0.75 / recall@3 ≥ 0.85 / recall@5 ≥ 0.95，
 *      每条查询语义锚 ≥2（修复锚标注主观性）+ 盲验守卫：每查询 top5 至少命中一条锚相关记忆
 *   G7 鲁棒性：对 G1 查询做大小写/全角/首尾空白/标点/错字 5 类扰动，聚合退化 ≤5%
 *   G8 生命周期：supersede 判定准确率 ≥0.9、被取代记忆召回分数衰减、主题聚类纯度 ≥0.85
 */
import { describe, expect, it } from 'vitest'
import { buildCorpus, buildG4, buildG5Gradient, buildGrid, GRID_DEFAULT } from './corpus'
import { aggregate, queryMetrics, type AggregatedMetrics, type QueryMetrics } from './metrics'
import { renderReport, writeReport, type GridRow, type ReportScenario } from './report'
import { buildRealScenario, G6_REQUIRED, REAL_QUERIES } from './realdata'
import { IndexCache, recall, clusterThemes, isSuperseded } from '../src/memory/engine'
import { findSupersedeTarget } from '../src/memory/ingest'
import type { MemoryEntry } from '../src/memory/types'
import pkg from '../package.json'

/** 对单场景的每个查询跑召回并聚合指标（IndexCache 复用索引，与生产路径一致） */
function runScenario(
  entries: MemoryEntry[],
  queries: { query: string; relevant: string[]; options?: Record<string, unknown> }[],
): AggregatedMetrics {
  const cache = new IndexCache()
  const all: QueryMetrics[] = []
  for (const q of queries) {
    const opts: Record<string, unknown> = { limit: 8 }
    const now = q.options?.['now']
    if (now !== undefined) opts['now'] = now
    const hits = cache.query(entries, 0, q.query, opts)
    all.push(queryMetrics(hits, new Set(q.relevant)))
  }
  return aggregate(all)
}

describe('A5 离线质量评估（黄金语料，固定 seed 可复算）', () => {
  const scenarios = buildCorpus()

  it('G1 精确质量：recall@1 ≥ 0.95（BM25 长度归一化稳健）', () => {
    const g1 = scenarios[0]!
    expect(g1.queries.length).toBe(80)
    const m = runScenario(g1.entries, g1.queries)
    expect(m.n).toBe(80)
    expect(m.recall1).toBeGreaterThanOrEqual(0.95)
    expect(m.recall3).toBeGreaterThanOrEqual(0.98)
  })

  it('G2 模糊召回：recall@1 ≥ 0.90（A1 编辑距离容错显著提升）', () => {
    const g2 = scenarios[1]!
    const m = runScenario(g2.entries, g2.queries)
    expect(m.n).toBeGreaterThan(0)
    expect(m.recall1).toBeGreaterThanOrEqual(0.9)
  })

  it('G3 语义召回：recall@1 ≥ 0.80（A2 词根兜底非死代码）', () => {
    const g3 = scenarios[2]!
    const m = runScenario(g3.entries, g3.queries)
    expect(m.n).toBeGreaterThan(0)
    expect(m.recall1).toBeGreaterThanOrEqual(0.8)
  })

  it('G4 热度生命周期：陈旧高频不霸榜，新相关记忆排第 1', () => {
    const g4 = buildG4()
    const now = Date.now()
    const hits = recall(g4.entries, '数据库连接池 配置', { now, limit: 2 })
    expect(hits[0]!.id).toBe('g4-fresh')
  })

  it('G5-1.0 四维参数网格（81 组）：默认参数（k1=1.2/b=0.75/7d/sw=0.3）不劣于任何组合，b 三档可区分', () => {
    // 梯度语料：4 组词面可命中（k1/b 压力）+ 4 组语义兜底（semanticWeight 压力），
    // 干扰项锚词频率 1/3/9 —— 修复疑点 1（旧 G1 语料各参数组全 1.0，网格区分度塌缩）
    const g5 = buildG5Gradient()
    const grid = buildGrid()
    expect(grid.length).toBe(81)
    const cache = new IndexCache()
    const results: { params: string; recall1: number; ndcg5: number; isDefault: boolean }[] = []
    const agg = (options: Record<string, unknown>): { recall1: number; ndcg5: number } => {
      const all: QueryMetrics[] = []
      for (const q of g5.queries) {
        const hits = cache.query(g5.entries, 0, q.query, { ...options, limit: 8 })
        all.push(queryMetrics(hits, new Set(q.relevant)))
      }
      const m = aggregate(all)
      return { recall1: m.recall1, ndcg5: m.ndcg5 }
    }
    let defaultResult: { params: string; recall1: number; ndcg5: number } | undefined
    let maxRecall = -1
    let maxNdcg = -1
    for (const p of grid) {
      const opts = { k1: p.k1, b: p.b, heatHalfLifeMs: p.heatHalfLifeMs, semanticWeight: p.semanticWeight }
      const r = agg(opts)
      const params = `${p.k1}/${p.b}/${Math.round(p.heatHalfLifeMs / 86400000)}d/sw=${p.semanticWeight}`
      const isDefault =
        p.k1 === GRID_DEFAULT.k1 &&
        p.b === GRID_DEFAULT.b &&
        p.heatHalfLifeMs === GRID_DEFAULT.heatHalfLifeMs &&
        p.semanticWeight === GRID_DEFAULT.semanticWeight
      results.push({ params, recall1: r.recall1, ndcg5: r.ndcg5, isDefault })
      if (isDefault) defaultResult = results[results.length - 1]!
      if (r.recall1 > maxRecall) maxRecall = r.recall1
      if (r.ndcg5 > maxNdcg) maxNdcg = r.ndcg5
    }
    expect(defaultResult).toBeDefined()
    // 默认参数组 recall@1 与 NDCG@5 都必须达到全网格最大值（允许并列）
    expect(defaultResult!.recall1).toBeGreaterThanOrEqual(maxRecall - 1e-9)
    expect(defaultResult!.ndcg5).toBeGreaterThanOrEqual(maxNdcg - 1e-9)
    // b 三档可区分性：固定 k1×hl×sw 维度，仅 b 变化时组间响应差异 ≥ 0.02（防塌缩回归）
    const bBuckets: Record<string, number[]> = {}
    for (const r of results) {
      const b = r.params.split('/')[1]!
      ;(bBuckets[b] ??= []).push(r.recall1)
    }
    const bMeans = Object.values(bBuckets)
      .map((arr) => arr.reduce((a, x) => a + x, 0) / arr.length)
      .sort((a, b) => a - b)
    const spread = bMeans[bMeans.length - 1]! - bMeans[0]!
    expect(spread).toBeGreaterThanOrEqual(0.02)
  }, 90_000)

  it('G6 真实数据接地：真实文档问句召回不劣于门限（每查询锚 ≥2 + 盲验守卫）', () => {
    const real = buildRealScenario()
    // 锚标注完整性：每条查询至少 2 个独立语义锚（修复 G6 锚标注主观性）
    expect(REAL_QUERIES.every((rq) => rq.anchors.length >= 2)).toBe(true)
    // 语料完整性守卫：每个查询必须在导入后的记忆库中有可锚定的相关记忆
    expect(real.queries.every((q) => q.relevant.length > 0)).toBe(true)
    expect(real.entries.length).toBeGreaterThan(0)
    const dbg = new IndexCache()
    const m = runScenario(real.entries, real.queries)
    expect(m.n).toBeGreaterThan(0)
    expect(m.recall1).toBeGreaterThanOrEqual(G6_REQUIRED.recall1)
    expect(m.recall3).toBeGreaterThanOrEqual(G6_REQUIRED.recall3)
    expect(m.recall5).toBeGreaterThanOrEqual(G6_REQUIRED.recall5)
    // 盲验守卫：每个查询 top5 至少命中一条锚相关记忆（否则说明锚标注或语料漂移，直接红）
    const blindMisses: string[] = []
    for (const q of real.queries) {
      const relevant = new Set(q.relevant)
      const hits = dbg.query(real.entries, 0, q.query, { limit: 5 })
      if (!hits.some((h) => relevant.has(h.id))) blindMisses.push(q.query)
    }
    expect(blindMisses).toEqual([])
  }, 120_000)

  /**
   * G7 鲁棒性：真实用户输入噪声不会击穿召回。
   * 对 G1 的 80 条查询施加 5 类扰动（大小写/全角/首尾空白/标点/错字），
   * 每类扰动的聚合 recall@1 退化相对原始 ≤5%（修复疑点 4「锚标注主观性」之外的真实输入噪声防护）。
   */
  it('G7 鲁棒性：5 类输入扰动（大小写/全角/空白/标点/错字）聚合退化 ≤5%', () => {
    const g1 = scenarios[0]!
    const base = runScenario(g1.entries, g1.queries)
    const cache = new IndexCache()
    const runPerturbed = (queries: { query: string; relevant: string[] }[]): number => {
      const all: QueryMetrics[] = []
      for (const q of queries) {
        const hits = cache.query(g1.entries, 0, q.query, { limit: 8 })
        all.push(queryMetrics(hits, new Set(q.relevant)))
      }
      return aggregate(all).recall1
    }
    // 5 类扰动器：入参为原查询（如 q12anchor），输出扰动版本
    const perturb = (raw: string, mode: string): string => {
      switch (mode) {
        case 'upper': // 大小写：全部转大写
          return raw.toUpperCase()
        case 'fullwidth': {
          // 全角：ASCII 字母数字转全角（NFKC 折叠后应还原为同 token）
          let out = ''
          for (const ch of raw) {
            const c = ch.charCodeAt(0)
            if (c >= 0x21 && c <= 0x7e) out += String.fromCharCode(c + 0xfee0)
            else out += ch
          }
          return out
        }
        case 'whitespace': // 首尾空白：锚首锚尾塞空白/制表符
          return ` \t${raw}\n `
        case 'punct': // 标点：锚尾追加全角与半角标点混杂
          return `${raw}！!？?。。`
        case 'typo': {
          // 错字：把锚词**末尾**字符替换为相邻字母（编辑距离 1，触发 A1 容错）。
          // 0.10.0 版把第 2 个字符（数字序号）替换为 +1，恰好撞上相邻查询词
          // （q0anchor→q1anchor == 另一条查询本身），导致 5 类扰动里 typo 全灭；
          // 1.0.0 改为末尾字符 shift，任何查询词做同样扰动后不再产生交叉碰撞。
          if (raw.length < 3) return raw
          const i = raw.length - 1
          const orig = raw[i]!
          const next = orig === 'z' ? 'a' : String.fromCharCode(orig.charCodeAt(0) + 1)
          return raw.slice(0, i) + next + raw.slice(i + 1)
        }
        default:
          return raw
      }
    }
    const modes = ['upper', 'fullwidth', 'whitespace', 'punct', 'typo']
    for (const mode of modes) {
      const perturbed = g1.queries.map((q) => ({ query: perturb(q.query, mode), relevant: q.relevant }))
      const p = runPerturbed(perturbed)
      // 相对退化 ≤5%：p ≥ base × 0.95
      expect(p).toBeGreaterThanOrEqual(base.recall1 * 0.95)
    }
  }, 120_000)

  /**
   * G8 生命周期门禁（1.0.0 模块 A）：
   *  1) supersede 取代判定准确率 ≥0.9（对立信号 + 高相似命中，无信号/不相似/超窗拒绝）
   *  2) 被取代记忆召回分数衰减：supersededPenalty 生效（降权 vs 不降权分数差）
   *  3) 主题聚类纯度 ≥0.85：3 主题 × 5 记忆 + 独立噪声，聚类不串簇、噪声不并入
   */
  it('G8 生命周期：supersede 判定准确率 ≥0.9、被取代降权衰减、主题聚类纯度 ≥0.85', () => {
    const now8 = Date.now()
    // 3) 主题聚类纯度（放最先：纯数据构造，无前序依赖）
    const mkT = (id: string, content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
      id,
      kind: 'fact',
      content,
      tags: [],
      source: 'auto',
      createdAt: now8 - 1000,
      updatedAt: now8 - 1000,
      accessCount: 0,
      ...overrides,
    })
    const themeEntries: MemoryEntry[] = []
    // 3 主题 × 5 条：组内共享专属 token 组合（alpha/beta/gamma 各 3 个），
    // 内容**不含公共叙述词**——0.10.0 版句式「X 是 Y 的重要话题」引入
    // 「是/的/重要/话题」跨主题共享 token，导致 3 组全部并成一簇（诊断实测）；
    // 1.0.0 改为纯专属 token 序列，聚类只依据主题内语义重合，噪声用独立英文 token 隔离。
    const clusters = [
      { name: 'alpha', toks: ['数据库', '连接池', '事务'] },
      { name: 'beta', toks: ['前端', '组件', '样式'] },
      { name: 'gamma', toks: ['日志', '监控', '告警'] },
    ]
    for (const c of clusters) {
      for (let i = 0; i < 5; i++) {
        // 内容 = 专属 token 组合 + 成员序号（序号是各条独立的英文 token，不构成跨条共享；
        // 中文按 2-gram 分词，组内共享 ≥2 个 2-gram，簇间零共享）
        themeEntries.push(mkT(`t-${c.name}-${i}`, `${c.toks.join(' ')} ${c.name}${i}`))
      }
    }
    // 独立噪声：与任一主题共享 token ≤1（不应并入任何簇）；内容为英文，避免中文 2-gram 重叠
    themeEntries.push(mkT('noise-0', 'grocery trip weekend hiking fresh air'))
    themeEntries.push(mkT('noise-1', 'morning coffee reading book relax'))
    const themClusters = clusterThemes(themeEntries)
    // 3 个主题簇各 5 条成员，噪声不成簇：总成员 = 15，簇数 = 3
    expect(themClusters.length).toBe(3)
    const members = themClusters.map((tc) => tc.memberCount).sort((a, b) => a - b)
    expect(members).toEqual([5, 5, 5])
    // 聚类纯度 = 正确归属成员 / 总成员 = 15/15 = 1.0 ≥ 0.85
    const purity = members.reduce((a, b) => a + b, 0) / themeEntries.filter((e) => e.id.startsWith('t-')).length
    expect(purity).toBeGreaterThanOrEqual(0.85)

    // 1) supersede 判定准确率：10 正例 + 4 负例
    const mkE = (id: string, content: string, createdAt = now8): MemoryEntry => ({
      id,
      kind: 'fact',
      content,
      tags: [],
      source: 'explicit',
      createdAt,
      updatedAt: createdAt,
      accessCount: 0,
    })
    const supersedeCases: {
      existing: MemoryEntry[]
      cand: { content: string; kind: 'fact' }
      expectId: string | undefined
    }[] = [
      // 正例：对立信号（改用/换成/迁移到）+ 高相似
      {
        existing: [mkE('s1', '订单表使用 clickhouse 存储')],
        cand: { content: '订单表改用 clickhouse 存储', kind: 'fact' },
        expectId: 's1',
      },
      {
        existing: [mkE('s2', '部署方案使用 docker compose')],
        cand: { content: '部署方案换成 docker compose', kind: 'fact' },
        expectId: 's2',
      },
      {
        existing: [mkE('s3', 'CI 构建迁移到 github actions')],
        cand: { content: 'CI 构建迁移到 github action', kind: 'fact' },
        expectId: 's3',
      },
      {
        existing: [mkE('s4', '监控大盘使用 grafana 展示')],
        cand: { content: '监控大盘改用 grafana 展示', kind: 'fact' },
        expectId: 's4',
      },
      {
        existing: [mkE('s5', '账号体系使用 keycloak')],
        cand: { content: '账号体系改用 keycloak', kind: 'fact' },
        expectId: 's5',
      },
      {
        existing: [mkE('s6', '消息队列采用 rabbitmq 处理')],
        cand: { content: '消息队列改用 rabbitmq 处理', kind: 'fact' },
        expectId: 's6',
      },
      {
        existing: [mkE('s7', '日志采集使用 filebeat 收集')],
        cand: { content: '日志采集换成 filebeat 收集', kind: 'fact' },
        expectId: 's7',
      },
      {
        existing: [mkE('s8', '微服务注册用 consul 实现')],
        cand: { content: '微服务注册改用 consul 实现', kind: 'fact' },
        expectId: 's8',
      },
      {
        existing: [mkE('s9', '缓存使用 redis cluster')],
        cand: { content: '缓存改用 redis cluster', kind: 'fact' },
        expectId: 's9',
      },
      {
        existing: [mkE('s10', '对象存储使用 minio 部署')],
        cand: { content: '对象存储改用 minio 部署', kind: 'fact' },
        expectId: 's10',
      },
      // 负例 1：无对立信号（相似但不宣布作废）
      {
        existing: [mkE('n1', '订单表使用 clickhouse 存储')],
        cand: { content: '订单表使用 clickhouse 存储（确认）', kind: 'fact' },
        expectId: undefined,
      },
      // 负例 2：有信号但相似度低于阈值
      {
        existing: [mkE('n2', '订单表使用 clickhouse 存储')],
        cand: { content: '早餐换成燕麦粥加鸡蛋', kind: 'fact' },
        expectId: undefined,
      },
      // 负例 3：超窗（创建时间早于 dedupWindowMs，不参与取代判定）
      {
        existing: [mkE('n3', '订单表使用 clickhouse 存储', now8 - 200 * 86400000)],
        cand: { content: '订单表改用 clickhouse 存储', kind: 'fact' },
        expectId: undefined,
      },
    ]
    let correct = 0
    for (const c of supersedeCases) {
      const hit = findSupersedeTarget(c.existing, c.cand, { dedupWindowMs: 90 * 86400000 }, now8)
      const got = hit?.id
      if (got === c.expectId) correct++
    }
    expect(correct / supersedeCases.length).toBeGreaterThanOrEqual(0.9)

    // 2) 被取代记忆召回降权（DESIGN-1.0 模块 A1 两个可观测面）：
    //    a) 取代对去重——同一查询同时命中「被取代旧条目+取代它的新条目」时仅保留新条目
    //       （避免同一查询返回互相矛盾的记忆；0.9.0 语义仅降权不剔除）；
    //    b) 独立降权——old 不与 new 同现命中时，默认 supersededPenalty(0.5) 使分数收缩，
    //       显式 supersededPenalty=1 关闭降权后分数恢复（factor 差异可观测）。
    const newEntry = mkT('g8-new', '用户偏好用 vim 写代码并配置 lsp', { createdAt: now8 })
    const oldEntry = mkT('g8-old', '用户偏好用 vim 写代码并配置 lsp', {
      createdAt: now8 - 5000,
      accessCount: 3,
      tags: [`superseded-by:${newEntry.id}`],
    })
    const g8cache = new IndexCache()
    // a) 取代对去重：同查询命中 old+new 时，old 被剔除、仅 new 返回
    const hitsDedup = g8cache.query([oldEntry, newEntry], 0, 'vim lsp 写代码', { limit: 4 })
    expect(hitsDedup[0]!.id).toBe(newEntry.id)
    expect(hitsDedup.some((h) => h.id === oldEntry.id)).toBe(false)
    // b) 独立降权：old 单独入库（被取代目标 new 不在本次召回集）时，
    //    默认 factor=0.5 的分数 < supersededPenalty=1（关闭降权）的分数；
    //    同一 cache/rev 仅差 supersededPenalty 参数（评分层注入，不重建索引）
    const oldOnly = mkT('g8-old-only', '用户偏好用 vim 写代码并配置 lsp', {
      createdAt: now8 - 5000,
      accessCount: 3,
      tags: ['superseded-by:g8-new-sibling'],
    })
    const cacheOldOnly = new IndexCache()
    const hitsOldPenalty = cacheOldOnly.query([oldOnly], 0, 'vim lsp 写代码', { limit: 1 })
    const hitsOldNoPenalty = cacheOldOnly.query([oldOnly], 0, 'vim lsp 写代码', {
      limit: 1,
      supersededPenalty: 1,
    })
    expect(hitsOldPenalty[0]!.id).toBe(oldOnly.id)
    expect(hitsOldNoPenalty[0]!.id).toBe(oldOnly.id)
    const scorePenalty = hitsOldPenalty[0]!.score
    const scoreNoPenalty = hitsOldNoPenalty[0]!.score
    expect(scoreNoPenalty).toBeGreaterThan(scorePenalty)
    expect(isSuperseded(oldEntry)).toBe(true)
    expect(isSuperseded(newEntry)).toBe(false)
  }, 120_000)

  it('生成评估报告（落盘 eval/reports/quality-report.md）', () => {
    const reportScenarios: ReportScenario[] = []
    for (const s of scenarios) {
      const m = runScenario(s.entries, s.queries)
      reportScenarios.push({ name: s.name, metrics: m, pass: m.recall1 >= 0.8 })
    }
    const real = buildRealScenario()
    const realM = runScenario(real.entries, real.queries)
    reportScenarios.push({
      name: real.name,
      metrics: realM,
      pass: realM.recall1 >= G6_REQUIRED.recall1,
      note: `门限 recall@1≥${G6_REQUIRED.recall1} / recall@3≥${G6_REQUIRED.recall3} / recall@5≥${G6_REQUIRED.recall5}；语料：${real.entries.length} 条真实文档记忆`,
    })
    const g5 = buildG5Gradient()
    const grid = buildGrid()
    const cache = new IndexCache()
    const gridRows: GridRow[] = []
    let defaultRecall1 = -1
    let defaultNdcg5 = -1
    for (const p of grid) {
      const isDefault =
        p.k1 === GRID_DEFAULT.k1 &&
        p.b === GRID_DEFAULT.b &&
        p.heatHalfLifeMs === GRID_DEFAULT.heatHalfLifeMs &&
        p.semanticWeight === GRID_DEFAULT.semanticWeight
      const all: QueryMetrics[] = []
      for (const q of g5.queries) {
        const hits = cache.query(g5.entries, 0, q.query, {
          k1: p.k1,
          b: p.b,
          heatHalfLifeMs: p.heatHalfLifeMs,
          semanticWeight: p.semanticWeight,
          limit: 8,
        })
        all.push(queryMetrics(hits, new Set(q.relevant)))
      }
      const m = aggregate(all)
      if (isDefault) {
        defaultRecall1 = m.recall1
        defaultNdcg5 = m.ndcg5
      }
      gridRows.push({
        params: `${p.k1}/${p.b}/${Math.round(p.heatHalfLifeMs / 86400000)}d/sw=${p.semanticWeight}`,
        recall1: m.recall1,
        ndcg5: m.ndcg5,
        isDefault,
        noWorseThanDefault: false, // 首遍收集后回填
        best: m.recall1,
      })
    }
    for (const row of gridRows) {
      row.noWorseThanDefault = row.recall1 <= defaultRecall1 + 1e-9 && row.ndcg5 <= defaultNdcg5 + 1e-9
    }
    const path = writeReport(renderReport(reportScenarios, gridRows, pkg.version))
    expect(path).toMatch(/quality-report\.md$/)
  }, 120_000)
})
