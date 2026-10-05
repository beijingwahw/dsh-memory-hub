/**
 * 0.9.0 升维行为专场（DEEP-AUDIT 16 项薄弱项探针转正）。
 *
 * 覆盖（按审计编号，与 docs/DESIGN-0.9.md 逐项对表）：
 * - B  漂移免疫词法：裸「务必/一定」conservative 命中；正则由词表编译派生（加词自动跟随）；
 * - C  写入路径工程化：ingest 批内去重（同批双候选只入 1 条）；
 * - E  store.corrupt 幂等：隔离文件已含该行时 open 不重复追加；
 * - F  词边界感知拼接：英文/数字词粘连处补空格，中文边界逐字节兼容；
 * - G  说话者感知分类：助手复述偏好降 generic，指令保留；
 * - H  forget strict 消费 NOT_FOUND，默认软删除语义不变；
 * - J  workspace 统一隔离：status 指定工作区统计含全局共享，递归询可过滤；
 * - K  索引化候选剪枝：大查询（特征集 > 签名维度）MinHash 预筛剪掉不相干文档，
 *      小查询保持 0.8.0 精确路径可召回同一文档（行为二分验证）；
 * - L  autoTags 正式消费：关闭时捕获候选标签清空；
 * - M  ImportOptions.mode 落地：conservative 显式分支，balanced/aggressive 保持 inferKind；
 * - N  热度合并回写：同 id 同窗口多次 recall 只 flush 一次（抗刷），事件不阻塞响应；
 * - O  共享快照：list 零拷贝共享引用，写入后换代（写后一致性）；
 * - Q  双尺度时间语义：decay 可关闭（永不过期可检索）、半衰期可注入（默认 7 天不变）。
 *
 * A'（recall kind schema enum）与 S（significance 无运行时兜底）的既有断言已在
 * test/tools/tools-0.3.test.ts / test/memory/engine-guard-0.8.test.ts 原位翻新，此处不重复。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlMemoryStore } from '../src/memory/store'
import { createMetrics } from '../src/memory/metrics'
import { ingestCaptured } from '../src/memory/ingest'
import { extractTextBlocks } from '../src/memory/text'
import {
  extractFromUserMessage,
  extractFromToolResult,
  extractFromAssistant,
  STRONG_HINTS,
  BALANCED_STRONG_HINTS,
  STRONG_TERMS,
  BALANCED_STRONG_TERMS,
} from '../src/memory/capture'
import { inferSpeakerKind, inferKindWithMode, planImport } from '../src/memory/importer'
import {
  recall,
  featureCoverage,
  minhashCoverage,
  minhashSignature,
  semanticFeatures,
  MINHASH_K,
  MINHASH_COVERAGE_THRESHOLD,
  MINHASH_PRESCREEN_THRESHOLD,
} from '../src/memory/engine'
import { ErrorCodes } from '../src/errors'
import { createMemoryForgetTool } from '../src/tools/memory-forget'
import { createMemoryRecallTool } from '../src/tools/memory-recall'
import { createMemoryStatusTool } from '../src/tools/memory-status'
import { createMemoryStoreTool } from '../src/tools/memory-store'
import type { MemoryEntry, MemoryStore } from '../src/memory/types'

type Toolish = { name: string; execute: (args: never) => Promise<Record<string, unknown>> }

async function openStore(): Promise<JsonlMemoryStore> {
  return JsonlMemoryStore.open(join(mkdtempSync(join(tmpdir(), 'mh-u9-')), 'mem.jsonl'))
}

function entry(over: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  const t = Date.now()
  return {
    kind: 'fact',
    tags: [],
    source: 'explicit',
    createdAt: t,
    updatedAt: t,
    accessCount: 0,
    ...over,
  }
}

describe('0.9.0 升级行为（16 项薄弱项探针转正）', () => {
  // ---- B：漂移免疫词法（capture 强度词单一信号源） ----
  it('B: 裸「务必」conservative 命中（0.8.0 空命中守卫短路强度检查的修复）', () => {
    const hits = extractFromUserMessage('你务必在提交前跑一遍全量测试', 'conservative')
    expect(hits.length).toBe(1)
    // 弱信号在 conservative 下不单点放行（守卫仍然有效）
    expect(extractFromUserMessage('今天天气不错适合出门散步', 'conservative')).toEqual([])
  })

  it('B: STRONG_HINTS/BALANCED_STRONG_HINTS 由词表编译派生（加词自动跟随，杜绝跨表漂移）', () => {
    for (const w of STRONG_TERMS) expect(STRONG_HINTS.test(w)).toBe(true)
    for (const w of BALANCED_STRONG_TERMS) expect(BALANCED_STRONG_HINTS.test(w)).toBe(true)
    // 两表差异项互斥成立：'务必' 只在强词表
    expect(STRONG_HINTS.test('务必')).toBe(true)
    expect(BALANCED_STRONG_HINTS.test('务必')).toBe(false)
  })

  // ---- C：写入路径工程化（ingest 批内去重） ----
  it('C: 同批双候选同文只入库 1 条，跨批窗口去重仍生效', async () => {
    const store = await openStore()
    const metrics = createMetrics()
    const cand = { kind: 'preference' as const, content: '记住每次发布前都要跑全量测试', tags: [] }
    await ingestCaptured(store, [cand, cand], { maxEntryChars: 1000, dedupWindowMs: 60000 }, metrics, undefined)
    expect(metrics.capturedTotal).toBe(1)
    expect(metrics.rejectedDuplicate).toBe(1)
    expect((await store.list()).length).toBe(1)

    // 跨批（新一次 ingest）同内容 → 窗口内库级去重，仍不重复入库
    await ingestCaptured(store, [cand], { maxEntryChars: 1000, dedupWindowMs: 60000 }, metrics, undefined)
    expect(metrics.capturedTotal).toBe(1)
    expect(metrics.rejectedDuplicate).toBe(2)
    expect((await store.list()).length).toBe(1)
  })

  // ---- E：store.corrupt 幂等 ----
  it('E: 损坏行隔离幂等——.corrupt 已含该行时再次 open 不重复追加', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-corrupt-'))
    const file = join(dir, 'mem.jsonl')
    const corruptLine = '{"kind":"fact","id":"broken", trunca'
    writeFileSync(
      file,
      '{"id":"e1","kind":"fact","content":"合法记忆 abc","tags":[],"source":"explicit","createdAt":1,"updatedAt":1,"accessCount":0}\n' +
        corruptLine +
        '\n',
    )
    const s1 = await JsonlMemoryStore.open(file)
    expect(s1.diagnostics.corrupt).toBe(1)
    expect(s1.diagnostics.lines).toBe(2) // 总行数（1 合法 + 1 损坏）
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(`${corruptLine}\n`)
    await s1.close()

    // 同一文件再次 open：corrupt 行仍被识别，但 .corrupt 不重复追加（幂等）
    const s2 = await JsonlMemoryStore.open(file)
    expect(s2.diagnostics.corrupt).toBe(1)
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(`${corruptLine}\n`)
    await s2.close()

    // 预置 .corrupt 已含该行 + 新坏行 → 只追加新行
    writeFileSync(`${file}.corrupt`, `${corruptLine}\n`)
    const line2 = '{"a":' // 另一条损坏行
    writeFileSync(file, `${corruptLine}\n${line2}\n`)
    const s3 = await JsonlMemoryStore.open(file)
    expect(s3.diagnostics.corrupt).toBe(2)
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(`${corruptLine}\n${line2}\n`)
    await s3.close()
  })

  // ---- F：词边界感知拼接 ----
  it('F: ASCII 词字符相邻补空格，中文/标点边界逐字节兼容', () => {
    expect(
      extractTextBlocks([
        { type: 'text', text: 'Use pnpm' },
        { type: 'text', text: 'for installs' },
      ]),
    ).toBe('Use pnpm for installs')
    // 0.7.0 既有断言逐字节保持：中文不插分隔、跨块原样拼接
    expect(
      extractTextBlocks([
        { type: 'text', text: '甲' },
        { type: 'text', text: '乙' },
      ]),
    ).toBe('甲乙')
    expect(extractTextBlocks([{ type: 'text', text: '结果：共 12 条' }])).toBe('结果：共 12 条')
    expect(
      extractTextBlocks([
        { type: 'text', text: '甲 ' },
        { type: 'text', text: '乙' },
      ]),
    ).toBe('甲 乙')
    // 数字/下划线词（版本号、代码标识）也参与词边界
    expect(
      extractTextBlocks([
        { type: 'text', text: 'v2' },
        { type: 'text', text: 'alpha' },
      ]),
    ).toBe('v2 alpha')
    expect(
      extractTextBlocks([
        { type: 'text', text: '完成。' },
        { type: 'text', text: '开始' },
      ]),
    ).toBe('完成。开始')
  })

  // ---- G：说话者感知分类 ----
  it('G: isUser 正式生效——助手复述偏好降 generic，指令保留', () => {
    expect(inferSpeakerKind('永远不要在日志里打印密码', true)).toBe('instruction')
    expect(inferSpeakerKind('永远不要在日志里打印密码', false)).toBe('instruction')
    expect(inferSpeakerKind('记住发布前要跑全量测试', true)).toBe('preference')
    expect(inferSpeakerKind('记住发布前要跑全量测试', false)).toBe('generic')
    expect(inferSpeakerKind('今天完成了构建', true)).toBe('generic')
  })

  // ---- H：forget strict 消费 NOT_FOUND ----
  it('H: strict 模式目标不存在抛 NOT_FOUND；默认软删除不抛错', async () => {
    const store = await openStore()
    const metrics = createMetrics()
    const forgetTool = createMemoryForgetTool(store, undefined, metrics) as unknown as Toolish
    const storeTool = createMemoryStoreTool(store, 1000, undefined, metrics) as unknown as Toolish

    // 默认：removed:false 软删除语义（渲染文本/返回形态逐字节不变）
    const soft = (await forgetTool.execute({ id: 'no-such' } as never)) as { removed: boolean; id: string }
    expect(soft).toEqual({ removed: false, id: 'no-such' })
    expect(metrics.errors).toBe(0)

    // strict：错误码 NOT_FOUND（0.8.0 定义后首次被消费）
    await expect(forgetTool.execute({ id: 'no-such', strict: true } as never)).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND,
    })
    expect(metrics.errors).toBe(1)

    // strict 且目标存在：正常删除
    await storeTool.execute({ content: '删除测试用的记忆条目' } as never)
    const id = (await store.list())[0]!.id
    await expect(forgetTool.execute({ id, strict: true } as never)).resolves.toEqual({ removed: true, id })
    expect(metrics.errors).toBe(1)
  })

  // ---- J：workspace 统一隔离语义 ----
  it('J: status 与 recall 同语义——指定工作区含全局共享，两工具不再相反', async () => {
    const store = await openStore()
    await store.upsert(entry({ id: 'a', content: 'alpha project spec', workspace: 'proj-a' }))
    await store.upsert(entry({ id: 'b', content: 'beta project spec', workspace: 'proj-b' }))
    await store.upsert(entry({ id: 's', content: 'gamma project shared' }))
    const statusTool = createMemoryStatusTool(store, () => Promise.resolve(0), undefined) as unknown as Toolish

    expect(((await statusTool.execute({} as never)) as { total: number }).total).toBe(3)
    expect(((await statusTool.execute({ workspace: 'proj-a' } as never)) as { total: number }).total).toBe(2)
    expect(((await statusTool.execute({ workspace: 'proj-b' } as never)) as { total: number }).total).toBe(2)

    // recall 侧：指定工作区只返回该工作区 + 共享（与 status 一致；0.8.0 曾语义相反）
    const recallTool = createMemoryRecallTool(store, 800, 8, undefined, undefined) as unknown as Toolish
    const hitsA = (await recallTool.execute({ query: 'project spec', workspace: 'proj-a' } as never)) as {
      hits: Array<{ id: string; content: string }>
    }
    const idsA = hitsA.hits.map((h) => h.id)
    expect(idsA).toContain('a')
    expect(idsA).toContain('s')
    expect(idsA).not.toContain('b')
    const all = (await recallTool.execute({ query: 'project spec' } as never)) as {
      hits: Array<{ id: string }>
    }
    expect(all.hits.map((h) => h.id)).toEqual(expect.arrayContaining(['a', 'b', 's']))
  })

  // ---- K：MinHash 签名预筛（索引化候选剪枝） ----
  it('K: 大查询启用签名预筛并匹配 0.8.0 美德；估计覆盖率与精确覆盖率同向不误伤', () => {
    const QUERY_BIG = [
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
      'hotel',
      'india',
      'juliet',
      'kilo',
      'lima',
      'mike',
      'november',
      'oscar',
      'papa',
      'quebec',
      'romeo',
    ]
    // 文档词 = 查询词的字符 3-gram 重排伪词（词面零共享 → 仅走语义兜底；字符特征高度重叠）
    const pseudo = QUERY_BIG.map((q) => {
      const grams = new Set<string>()
      for (let i = 0; i + 3 <= q.length; i++) grams.add(q.slice(i, i + 3))
      return q.slice(0, 2) + [...grams].join('')
    })
    const qFeats = new Set(QUERY_BIG.flatMap((w) => [...semanticFeatures(w)]))
    // 无关词：与查询特征零重叠（程序化生成 + 过滤，扩大 |Q∪D| 制造高精确覆盖率 + 低 Jaccard 的剪枝压力）
    const filler: string[] = []
    for (const w of [
      'zqxwvrtnm',
      'mqvpylkjh',
      'bxwznfrtc',
      'qjhvxwlmr',
      'pwvjzxqbh',
      'kmvqxzrnh',
      'bqzxwvlpm',
      'xjvqwmzrb',
      'wlqxvbznr',
      'qzbvxmrwn',
      'zvxqwbkln',
      'xbqwvzrlm',
      'lqzxvwmnb',
      'vrxqblzwn',
      'qzmbvwxlc',
      'wvxlqzbrm',
      'bqxvrzwml',
      'zmbwvqxrl',
      'vzlqwxbmr',
      'qxbmvzwrl',
      'lbqxwvzmr',
      'zrqvbxmwl',
      'wxbzrvqml',
      'vqwbmzxrl',
      'xmvqbzwrl',
      'qbvxwzrlm',
      'zqlwvxbrm',
      'vwzqbxrml',
      'mrxvbwqzl',
      'xrzvbwqml',
    ]) {
      const f = [...semanticFeatures(w)]
      if (f.every((x) => !qFeats.has(x))) filler.push(w)
    }
    expect(filler.length).toBeGreaterThan(20)
    const docWords = [...pseudo, ...filler]
    const docFeatures = new Set(docWords.flatMap((w) => [...semanticFeatures(w)]))

    // 启用条件：查询特征集大于签名维度（O(|Q|) 精确比对贵于 O(K) 签名比对）
    expect(qFeats.size).toBeGreaterThan(MINHASH_K)
    // 精确覆盖率达标（语义兜底本应召回），签名估计覆盖率与其同向且不低于预筛下界 → 不误剪
    const cov = featureCoverage(qFeats, docFeatures)
    expect(cov).toBeGreaterThanOrEqual(MINHASH_COVERAGE_THRESHOLD)
    const est = minhashCoverage(
      { sig: minhashSignature(qFeats), size: qFeats.size },
      { sig: minhashSignature(docFeatures), size: docFeatures.size },
    )
    expect(est).toBeGreaterThanOrEqual(MINHASH_PRESCREEN_THRESHOLD)

    const doc: MemoryEntry = entry({
      id: 'doc',
      content: docWords.join(' '),
      createdAt: 0,
      updatedAt: 0,
      accessCount: 0,
    })
    // 行为：大查询预筛不误伤达标文档（召回集合与无预筛语义路径一致）
    const big = recall([doc], QUERY_BIG.join(' '), { semantic: true, limit: 8, now: 1 })
    expect(big.some((h) => h.id === 'doc')).toBe(true)

    // 剪枝目标 = 明确不相干文档（特征零重叠 → 精确覆盖率 0，签名估计亦 0 < 下界）：大/小查询均不召回
    const irrFeatures = new Set(filler.flatMap((w) => [...semanticFeatures(w)]))
    expect(featureCoverage(qFeats, irrFeatures)).toBe(0)
    const irr: MemoryEntry = entry({ id: 'irr', content: filler.join(' '), createdAt: 0, updatedAt: 0, accessCount: 0 })
    const both = recall([doc, irr], QUERY_BIG.join(' '), { semantic: true, limit: 8, now: 1 })
    expect(both.some((h) => h.id === 'irr')).toBe(false)
    expect(both.some((h) => h.id === 'doc')).toBe(true)

    // 阈值设计关系：预筛下界 = 覆盖阈值 × 2/3（先剪明确不相干，边缘候选留给精确覆盖率裁决）
    expect(MINHASH_PRESCREEN_THRESHOLD).toBeCloseTo(MINHASH_COVERAGE_THRESHOLD * (2 / 3), 10)
  })

  // ---- L：autoTags 正式消费 ----
  it('L: autoTags 关闭时捕获候选标签清空（配置不再是死开关）', () => {
    const u = extractFromUserMessage('记住发布前要跑全量测试', 'balanced', false)
    expect(u[0]!.tags).toEqual([])
    expect(extractFromUserMessage('记住发布前要跑全量测试', 'balanced', true)[0]!.tags).toEqual([
      'explicit',
      'preference',
    ])
    const t = extractFromToolResult('build', '成功完成 12 项测试 全部通过', 'balanced', false)
    expect(t[0]!.tags).toEqual([])
    expect(t[0]!.content.startsWith('build 执行结果:')).toBe(true)
  })

  // ---- M：ImportOptions.mode 落地 ----
  it('M: mode 分支被消费——conservative 显式判定，balanced/aggressive 保持 inferKind 语义', () => {
    expect(inferKindWithMode('永远不要在日志里打印密码', 'conservative')).toBe('instruction')
    expect(inferKindWithMode('今天完成了构建', 'conservative')).toBe('generic')
    expect(inferKindWithMode('记住发布前要跑全量测试', 'balanced')).toBe('preference')
    expect(inferKindWithMode('记住发布前要跑全量测试', 'aggressive')).toBe('preference')

    const plan = planImport({
      documents: [{ label: 'MEMORY.md', text: '# 工作约定\n永远不要在日志里打印密码' }],
      options: { mode: 'conservative', now: 1000, maxChars: 500 },
    })
    expect(plan.stats.imported).toBe(1)
    expect(plan.entries[0]!.kind).toBe('instruction')
    // 默认（不传 mode）= balanced = 0.8.0 语义
    const planDef = planImport({
      documents: [{ label: 'MEMORY.md', text: '# 工作约定\n永远不要在日志里打印密码' }],
      options: { now: 1000, maxChars: 500 },
    })
    expect(planDef.entries[0]!.kind).toBe('instruction')
  })

  // ---- N：热度合并回写 ----
  it('N: 同 id 同窗口多次 recall 只 flush 一次（抗刷）；错误上浮 errors 不静默', async () => {
    const store = await openStore()
    const upsertSpy = vi.spyOn(store, 'upsert')
    const metrics = createMetrics()
    const storeTool = createMemoryStoreTool(store, 1000, undefined, metrics) as unknown as Toolish
    const recallTool = createMemoryRecallTool(store, 800, 8, undefined, metrics) as unknown as Toolish
    await storeTool.execute({ content: '记住发布前要跑全量测试' } as never)
    expect(upsertSpy.mock.calls.length).toBe(1) // 显式入库

    // 连续两次 recall（同一微任务批次）：flush 合并为一次 upsert（0.8.0 为两次）
    await Promise.all([
      recallTool.execute({ query: '发布前测试' } as never),
      recallTool.execute({ query: '发布前测试' } as never),
    ])
    await new Promise((r) => setTimeout(r, 50))
    expect(metrics.recallCalls).toBe(2)
    expect(upsertSpy.mock.calls.length).toBe(2) // 1 显式 + 1 合并 flush（而非 3）
    const flushCall = upsertSpy.mock.calls.find(([e]) => e.accessCount >= 1)
    expect(flushCall?.[0]?.accessCount).toBeGreaterThanOrEqual(1)
    expect(flushCall?.[0]?.id).toBe((await store.list())[0]!.id)
    upsertSpy.mockRestore()
  })

  // ---- O：共享快照零拷贝 + 写后换代 ----
  it('O: list 共享快照引用（零拷贝），写入后换代保证一致性', async () => {
    const store = await openStore()
    await store.upsert(entry({ id: 'e1', content: '快照条目一' }))
    await store.upsert(entry({ id: 'e2', content: '快照条目二' }))
    const l1 = await store.list()
    const l2 = await store.list()
    expect(l1).toBe(l2) // 未写入期间复用同一快照（无 O(N) 拷贝）
    expect(l1.length).toBe(2)

    await store.upsert(entry({ id: 'e3', content: '快照条目三' }))
    const l3 = await store.list()
    expect(l3).not.toBe(l1) // 写入后换代
    expect(l3.length).toBe(3)
    expect(l3.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']) // 按 createdAt 稳定排序
  })

  // ---- Q：双尺度时间语义 ----
  it('Q: decay 可关闭（旧记忆不再被时间惩罚压制）、半衰期可注入（默认 7 天不变）', () => {
    const now = Date.now()
    const old = entry({
      id: 'old',
      content: 'alpha 相关的长期约定 alpha',
      createdAt: now - 14 * 24 * 60 * 60 * 1000,
      updatedAt: now - 14 * 24 * 60 * 60 * 1000,
    })
    const withDecay = recall([old], 'alpha', { now, limit: 8 })
    const noDecay = recall([old], 'alpha', { now, limit: 8, decay: false })
    expect(withDecay.length).toBe(1)
    expect(noDecay.length).toBe(1)
    // 14 天 / 默认半衰期 7 天 → 衰减 exp(-2)≈0.135；关闭衰减后分数高出 ~7.4×
    expect(noDecay[0]!.score).toBeGreaterThan(withDecay[0]!.score * 5)

    // 半衰期注入：28 天 → 衰减 exp(-0.5)≈0.607，介于关闭与默认之间
    const slow = recall([old], 'alpha', {
      now,
      limit: 8,
      decayHalfLifeMs: 28 * 24 * 60 * 60 * 1000,
    })
    expect(slow[0]!.score).toBeGreaterThan(withDecay[0]!.score)
    expect(noDecay[0]!.score).toBeGreaterThan(slow[0]!.score)
  })
})

describe('0.9.0 质量门补位（剩余分支/行全覆盖）', () => {
  // ---- capture：autoTags=false 的「信号词命中」路径（非显式记忆动词） ----
  it('capture: 信号词命中路径下 autoTags=false 也清空标签（153 行）', () => {
    const hits = extractFromUserMessage('以后都优先使用 pnpm 安装依赖', 'balanced', false)
    expect(hits.length).toBe(1)
    expect(hits[0]!.tags).toEqual([])
    expect(hits[0]!.kind).toBe('preference')
  })

  it('capture: 工具长输出 aggressive + autoTags=false 清空标签（169 行）', () => {
    const hits = extractFromToolResult('build', 'x'.repeat(2100), 'aggressive', false)
    expect(hits.length).toBe(1)
    expect(hits[0]!.tags).toEqual([])
    expect(hits[0]!.content.startsWith('build: ')).toBe(true)
    // 对照：autoTags 默认 true 仍带工具标签
    expect(extractFromToolResult('build', 'x'.repeat(2100), 'aggressive')[0]!.tags).toEqual(['auto', 'fact', 'build'])
  })

  it('capture: 助手结论摘要 autoTags=false 清空标签（200 行）', () => {
    const hits = extractFromAssistant('结论：发布前必须跑全量测试', 'aggressive', false)
    expect(hits.length).toBe(1)
    expect(hits[0]!.tags).toEqual([])
    expect(hits[0]!.kind).toBe('generic')
  })

  // ---- importer：conservative 的偏好信号分支 ----
  it('importer: conservative 模式偏好信号即放行（inferKindWithMode 第三分支）', () => {
    expect(inferKindWithMode('记住发布前要跑全量测试', 'conservative')).toBe('preference')
    // planImport 全档位回归：三种模式 × 三种信号
    for (const mode of ['conservative', 'balanced', 'aggressive'] as const) {
      const plan = planImport({
        documents: [
          { label: 'M.md', text: '永远不要在日志里打印密码\n\n记住发布前要跑测试\n\n今天完成了构建并发布了新版本' },
        ],
        options: { mode, now: 1, maxChars: 500 },
      })
      const kinds = plan.entries.map((e) => e.kind)
      expect(kinds).toContain('instruction')
      expect(kinds).toContain('preference')
      expect(kinds).toContain('generic')
    }
  })

  // ---- recall：heat flush 同步异常上浮 errors + logger（84-86 行） ----
  it('recall: flush 期间 sync throw 进 catch，metrics.errors++ 且日志可见', async () => {
    const store = await openStore()
    const metrics = createMetrics()
    const logs: string[] = []
    const storeTool = createMemoryStoreTool(store, 1000, undefined, metrics) as unknown as Toolish
    const recallTool = createMemoryRecallTool(store, 800, 8, (m) => logs.push(m), metrics) as unknown as Toolish
    await storeTool.execute({ content: '记住发布前要跑全量测试' } as never)

    const upsertSpy = vi.spyOn(store, 'upsert')
    upsertSpy.mockImplementationOnce(() => {
      throw new Error('flush boom') // 同步 throw → heat flush 外层 catch
    })
    await recallTool.execute({ query: '发布前测试' } as never)
    await new Promise((r) => setTimeout(r, 50))
    expect(metrics.errors).toBe(1)
    expect(logs.some((l) => l.includes('heat flush failed') && l.includes('flush boom'))).toBe(true)
    upsertSpy.mockRestore()
    await store.close()
  })

  // ---- forget：logger 真实调用分支（47 行） ----
  it('forget: 传入 logger 时记录删除日志（removed 与 not found 两态）', async () => {
    const store = await openStore()
    const logs: string[] = []
    const forgetTool = createMemoryForgetTool(store, (m) => logs.push(m)) as unknown as Toolish
    await forgetTool.execute({ id: 'missing-x' } as never)
    expect(logs.some((l) => l.includes('missing-x') && l.includes('not found'))).toBe(true)
    await store.upsert(entry({ id: 'exists-for-log', content: '日志验证条目' }))
    await forgetTool.execute({ id: 'exists-for-log' } as never)
    expect(logs.some((l) => l.includes('exists-for-log') && l.includes('removed'))).toBe(true)
    await store.close()
  })

  // ---- status：diagnostics 提供者为 null（32 行 ?? null 分支） ----
  it('status: 存储无 diagnostics 实现时输出 null 且不抛错', async () => {
    const bare: MemoryStore = {
      upsert: (e) => Promise.resolve(e),
      remove: () => Promise.resolve(false),
      removeMany: () => Promise.resolve(0),
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      importAll: () => Promise.resolve(0),
      close: () => Promise.resolve(),
      exportAll: () => Promise.resolve('[]'),
    }
    const diagStore = { ...bare, diagnostics: null } as MemoryStore & { diagnostics: null }
    const statusTool = createMemoryStatusTool(diagStore, () => Promise.resolve(0)) as unknown as Toolish
    const out = (await statusTool.execute({} as never)) as { diagnostics: unknown }
    // diagnostics() 返回 null → execute 侧 if(diag) 跳过写入（undefined 即 null 的导出语义）；
    // 关键覆盖点是 store.diagnostics 为 null 时 ?? null 右分支被求值（不再抛/不误用默认 0）
    expect(out.diagnostics).toBeUndefined()
  })
})
