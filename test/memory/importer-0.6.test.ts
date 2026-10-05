import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractSessionText,
  extractTextBlocks,
  inferKind,
  planImport,
  splitDocument,
  type DocumentSource,
} from '../../src/memory/importer'
import { buildIndex, queryIndex } from '../../src/memory/engine'
import { JsonlMemoryStore } from '../../src/memory/store'
import { contentHash } from '../../src/memory/store'

let dirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh0.6-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('splitDocument 真实文档切块（0.6.0）', () => {
  it('标题/列表各自成块，连续普通行聚合为段落', () => {
    const blocks = splitDocument(
      '# 第一标题\n\n按照惯例部署到 prod 环境。\n第二行继续同段。\n\n- 列表项甲\n- 列表项乙\n\n## 第二标题\n\n1. 有序甲\n2. 有序乙',
    )
    expect(blocks[0]).toBe('第一标题')
    expect(blocks[1]).toContain('按照惯例部署到 prod 环境')
    expect(blocks[1]).toContain('第二行继续同段')
    expect(blocks).toContain('列表项甲')
    expect(blocks).toContain('列表项乙')
    expect(blocks).toContain('第二标题')
    expect(blocks[2]).toBe('列表项甲')
    expect(blocks).toContain('有序甲')
    expect(blocks).toContain('有序乙')
  })
  it('纯链接索引行跳过（MEMORY.md 索引是元数据）', () => {
    const blocks = splitDocument('- [a](a.md) — 甲条\n- [b](b.md) — 乙条\n- [pure](pure.md)\n普通正文段落。')
    expect(blocks).not.toContain('[pure](pure.md)')
    expect(blocks.some((b) => b.includes('甲条'))).toBe(true)
    expect(blocks.some((b) => b === '普通正文段落。')).toBe(true)
  })
  it('空行与分隔线作为段落边界', () => {
    const blocks = splitDocument('甲段\n\n---\n\n乙段')
    expect(blocks).toEqual(['甲段', '乙段'])
  })
  it('短块（<8 字符）不直接参与块产出判定由 planImport 丢弃', () => {
    const blocks = splitDocument('# 短\n\n正文较长的一段内容填写完整。')
    expect(blocks).toContain('短')
    expect(blocks).toContain('正文较长的一段内容填写完整。')
  })
})

describe('extractTextBlocks 会话内容块提取（0.6.0）', () => {
  it('text 块提取纯文本', () => {
    expect(
      extractTextBlocks([
        { type: 'text', text: '你好' },
        { type: 'text', text: '世界' },
      ]),
    ).toBe('你好世界')
  })
  it('tool-result 递归提取，未知类型忽略', () => {
    const blocks = [
      { type: 'text', text: '结果：' },
      { type: 'tool-result', content: [{ type: 'text', text: '共 12 条' }] },
      { type: 'unknown', anything: 1 },
    ]
    expect(extractTextBlocks(blocks)).toBe('结果：共 12 条')
  })
  it('非块结构（null/标量）返回空串', () => {
    expect(extractTextBlocks(null)).toBe('')
    expect(extractTextBlocks('plain')).toBe('')
    expect(extractTextBlocks(42)).toBe('')
  })
})

describe('extractSessionText 会话 JSONL 提取（0.6.0）', () => {
  it('user/message 取 data.content', () => {
    const line = JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '记住要用 pnpm' }] } })
    expect(extractSessionText(line)).toEqual({ ok: true, text: '记住要用 pnpm', isUser: true })
  })
  it('assistant/message 取 data.message.content（缺省回退 data.content）', () => {
    const a = JSON.stringify({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '建议 8 个连接池' }] } },
    })
    expect(extractSessionText(a)).toEqual({ ok: true, text: '建议 8 个连接池', isUser: false })
    const b = JSON.stringify({ type: 'assistant/message', data: { content: [{ type: 'text', text: '回退路径' }] } })
    expect(extractSessionText(b)).toEqual({ ok: true, text: '回退路径', isUser: false })
  })
  it('JSON 损坏记 corrupt，非目标/空文本记 unhandled', () => {
    expect(extractSessionText('{"type": broken')).toEqual({ ok: false, reason: 'corrupt' })
    expect(extractSessionText(JSON.stringify({ type: 'turn/start', data: { turn: 1 } }))).toEqual({
      ok: false,
      reason: 'unhandled',
    })
    expect(extractSessionText(JSON.stringify({ type: 'user/message', data: { content: [] } }))).toEqual({
      ok: false,
      reason: 'unhandled',
    })
    expect(extractSessionText('not-json-line')).toEqual({ ok: false, reason: 'corrupt' })
  })
})

describe('inferKind 离线 kind 推断（0.6.0）', () => {
  it('指令性信号 → instruction', () => {
    expect(inferKind('永远不要在提交里泄露密钥')).toBe('instruction')
    expect(inferKind('always run tests before push')).toBe('instruction')
  })
  it('偏好性信号 → preference', () => {
    expect(inferKind('记住视频导出用 1080p 默认值')).toBe('preference')
    expect(inferKind('prefer pnpm over npm')).toBe('preference')
  })
  it('无信号 → generic', () => {
    expect(inferKind('数据库连接池大小 8')).toBe('generic')
  })
})

describe('planImport 真实数据规范化（0.6.0）', () => {
  const doc: DocumentSource = {
    label: '/home/u/memory-hub/USER.md',
    text: '# 用户偏好\n\n记住包管理统一用 pnpm。\n\n- 不要修改生产数据库\n- 常用语言是 TypeScript',
  }
  it('文档导入：explicit 来源、imported 标签、`imp-` 幂等 id、kind 推断', () => {
    const plan = planImport({ documents: [doc], options: { now: 1234 } })
    expect(plan.stats.imported).toBeGreaterThanOrEqual(3)
    expect(plan.entries.every((e) => e.source === 'explicit')).toBe(true)
    expect(plan.entries.some((e) => e.content.includes('pnpm') && e.kind === 'preference')).toBe(true)
    expect(plan.entries.some((e) => e.content.includes('生产数据库') && e.kind === 'instruction')).toBe(true)
    expect(plan.entries.every((e) => e.id.startsWith('imp-') && e.createdAt === 1234)).toBe(true)
    expect(plan.entries.every((e) => e.tags.includes('imported') && e.tags.includes('USER.md'))).toBe(true)
  })
  it('会话导入：auto 来源、session 标签，损坏行计数', () => {
    const lines = [
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '记住用 pnpm' }] } }),
      'corrupt-line-not-json',
      JSON.stringify({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '结论：推荐 8 连接池' }] } },
      }),
    ]
    const plan = planImport({ sessions: [{ label: 's.log', lines }] })
    expect(plan.stats.corruptLines).toBe(1)
    expect(plan.stats.imported).toBeGreaterThanOrEqual(2)
    expect(plan.entries.every((e) => e.source === 'auto' && e.tags.includes('session'))).toBe(true)
  })
  it('内容级幂等：同内容跨来源/重复导入合并为同 id', () => {
    const a = planImport({ documents: [{ label: 'x.md', text: '记住用 pnpm。' }] })
    const b = planImport({ documents: [{ label: 'y.md', text: '记住用 pnpm。' }] })
    expect(a.entries[0]!.id).toBe(b.entries[0]!.id)
    expect(a.entries[0]!.id).toBe(`imp-${contentHash('记住用 pnpm。')}`)
    // 同一 plan 内重复块只保留一条（空行分隔成两个同名块）
    const dup = planImport({ documents: [{ label: 'z.md', text: '记住用 pnpm。\n\n记住用 pnpm。' }] })
    expect(dup.entries.filter((e) => e.content === '记住用 pnpm。').length).toBe(1)
  })
  it('敏感过滤与短块丢弃、total 恒等式', () => {
    const plan = planImport({
      documents: [
        { label: 's.md', text: '短\n\n令牌 sk-abcdefghijklmnopqrstuvwxyz123456 不应入库。\n\n正常段落内容足够长。' },
      ],
    })
    const sensitive = plan.entries.find((e) => e.content.includes('sk-'))
    expect(sensitive).toBeUndefined()
    expect(plan.stats.droppedSensitive).toBeGreaterThanOrEqual(1)
    expect(plan.stats.droppedShort).toBeGreaterThanOrEqual(1)
    expect(plan.stats.total).toBe(plan.stats.imported + plan.stats.droppedShort + plan.stats.droppedSensitive)
  })
  it('maxChars 截断超长块', () => {
    const long = 'x'.repeat(2000)
    const plan = planImport({ documents: [{ label: 'l.md', text: long }], options: { maxChars: 100 } })
    expect(plan.entries[0]!.content.length).toBe(100)
  })
})

describe('真实语料端到端（0.6.0 接地验收）', () => {
  const readReal = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
  it('仓库真实 README/CHANGELOG 导入→索引→检索全链路', async () => {
    const readme = readReal('../../README.md')
    const changelog = readReal('../../CHANGELOG.md')
    const plan = planImport({
      documents: [
        { label: 'README.md', text: readme },
        { label: 'CHANGELOG.md', text: changelog },
      ],
    })
    expect(plan.stats.imported).toBeGreaterThan(20) // 真实文档切成数十条记忆
    const dir = freshDir()
    const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
    const added = await store.importAll(plan.entries)
    expect(added).toBe(plan.entries.length)
    // 幂等：再导一次 added=0
    expect(await store.importAll(plan.entries)).toBe(0)

    const entries = await store.list()
    const index = buildIndex(entries)
    const byId = new Map(entries.map((e) => [e.id, e]))
    for (const q of ['BM25', 'dsh-memory-hub', 'memory_recall']) {
      const hits = queryIndex(index, q, { limit: 3 }, byId)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]!.score).toBeGreaterThan(0)
    }
    // 真实记忆确在检索结果中可见（非模拟语料）
    const readmeHit = queryIndex(index, 'BM25', { limit: 1 }, byId)
    expect(readmeHit[0]!.content.length).toBeGreaterThan(0)
    await store.close()
  })
})
