/**
 * 可视化检索页 HTML 导出（1.5.1，DESIGN-1.5 模块 P）行为锁定。
 *
 * 覆盖面：
 * - renderMemoryHtml 纯函数：确定性（同 payload 逐字节一致）、自包含（零 http(s) 资源
 *   引用）、注入安全（内嵌 JSON `</script>` 转义 + 正文 HTML 转义 + 页面 DOM textContent）、
 *   条目按 (createdAt, id) 排序嵌入、kind 统计、时间轴柱（含空库臂/截断标记）；
 * - 工具面 exportHtml 参数：文件落盘（存储目录 memories-view.html）+ htmlPath/htmlBytes
 *   输出 + 渲染行 + metrics.htmlExports + workspace 过滤 + 未配置 htmlDir 显式失败 +
 *   降级 store（无 timeline 成员）近似时间轴 + 写失败 STORE_WRITE_FAILED；
 * - 缺省零回归：exportHtml 缺席时输出无 htmlPath 键。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { embedJson, escapeHtml, renderMemoryHtml } from '../../src/memory/html-export'
import { createMetrics } from '../../src/memory/metrics'
import { JsonlMemoryStore, timelineFromRaw } from '../../src/memory/store'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import type { MemoryEntry, MemoryStore, MemoryTimeline } from '../../src/memory/types'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const G = 1_710_000_000_000 // 固定 generatedAt（确定性断言的关键）

const DAY0 = new Date(T0).toISOString().slice(0, 10)
const DAY1 = new Date(T0 + DAY).toISOString().slice(0, 10)

function e(id: string, content: string, at: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return freshEntry({ id, content, createdAt: at, updatedAt: at, ...overrides })
}

function timelineOf(entries: readonly MemoryEntry[], raw?: string): MemoryTimeline {
  if (raw !== undefined) return timelineFromRaw(raw)
  return timelineFromRaw(entries.map((x) => JSON.stringify(x)).join('\n') + '\n')
}

type StatusTool = {
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
}

describe('renderMemoryHtml 纯函数（1.5.1 模块 P）', () => {
  const entries = [
    e('b', '缓存 使用 Redis 做主存', T0),
    e('a', '网关 使用 Nginx 做入口', T0),
    { ...e('a2', '旧文', T0), content: '网关 升级到 Nginx v2', updatedAt: T0 + DAY },
  ]

  it('确定性：同 payload 两次渲染逐字节一致；条目按 (createdAt, id) 排序嵌入', () => {
    const p = { entries, timeline: timelineOf(entries), generatedAt: G }
    const h1 = renderMemoryHtml(p)
    const h2 = renderMemoryHtml(p)
    expect(h1).toBe(h2)
    // 排序锚：createdAt 升序（a/a2 同日按 id，b 同日…… a < a2 < b 字典序）
    const idxA = h1.indexOf('"id":"a"')
    const idxA2 = h1.indexOf('"id":"a2"')
    const idxB = h1.indexOf('"id":"b"')
    expect(idxA).toBeGreaterThan(0)
    expect(idxA).toBeLessThan(idxA2)
    expect(idxA2).toBeLessThan(idxB)
  })

  it('自包含：零 http(s) 资源引用（无外链 script/link/img/src/href）', () => {
    const h = renderMemoryHtml({ entries, timeline: timelineOf(entries), generatedAt: G })
    expect(h).not.toMatch(/src="https?:/i)
    expect(h).not.toMatch(/href="https?:/i)
    expect(h).not.toMatch(/<link /i)
    expect(h).toContain('<style>')
    expect(h).toContain('window.__MH__=')
  })

  it('注入安全：正文 HTML 转义 + 内嵌 JSON </script> 转义（两端都不产生可执行标签）', () => {
    const evil = [e('x1', '<script>alert(1)</script> 与 "引号" <b>加粗</b>', T0)]
    const h = renderMemoryHtml({ entries: evil, timeline: timelineOf(evil), generatedAt: G })
    // 服务端渲染的标题/文本：HTML 实体
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    expect(embedJson({ a: '<script>' })).toBe('{"a":"\\u003cscript>"}')
    // 页面正文区域不含原始 <script>alert（内嵌 JSON 中 < 已转义为 \u003c）
    expect(h).not.toContain('<script>alert(1)</script>')
    expect(h).toContain('\\u003cscript>')
    // 页面只允许两个我们自己的 <script> 块（数据 + 逻辑）
    expect((h.match(/<script>/g) ?? []).length).toBe(2)
  })

  it('时间轴柱：桶日/统计行渲染；空库输出空态提示；truncated 标记渲染', () => {
    const h = renderMemoryHtml({ entries, timeline: timelineOf(entries), generatedAt: G })
    expect(h).toContain(DAY0)
    expect(h).toContain('事件 3') // added×2 + updated×1
    expect(h).toContain('class="chart"')
    expect(h).toContain('class="legend"')
    // 空库臂
    const empty = renderMemoryHtml({ entries: [], timeline: timelineOf([]), generatedAt: G })
    expect(empty).toContain('无时间锚事件')
    // 截断标记臂
    const many = Array.from({ length: 40 }, (_, i) => e(`n${i}`, `条目 ${i}`, T0 + i * DAY))
    const truncated = renderMemoryHtml({ entries: many, timeline: timelineOf(many, undefined), generatedAt: G })
    expect(truncated).toContain('仅保留最近 ')
  })

  it('kind 统计与元信息：标题/条数/生成时刻渲染', () => {
    const h = renderMemoryHtml({ entries, timeline: timelineOf(entries), generatedAt: G })
    expect(h).toContain('dsh-memory-hub 记忆可视化')
    expect(h).toContain('3 条记忆')
    expect(h).toContain(new Date(G).toISOString())
    expect(h).toContain('&quot;fact&quot;:3') // kinds 统计经 HTML 实体转义渲染
  })
})

describe('memory_status exportHtml 工具面（1.5.1 模块 P）', () => {
  it('导出落盘：memories-view.html 写入 htmlDir、输出 htmlPath/htmlBytes、渲染行、metrics 计数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-html-'))
    const file = join(dir, 'memories.jsonl')
    const store = await JsonlMemoryStore.open(file)
    await store.upsert(e('a', '缓存 使用 Redis', T0))
    await store.upsert(e('b', '网关 使用 Nginx', T0 + DAY))
    const metrics = createMetrics()
    const tool = createMemoryStatusTool(store, () => 0, undefined, metrics, { htmlDir: dir }) as unknown as StatusTool
    const out = await tool.execute({ exportHtml: true })
    const htmlPath = out['htmlPath'] as string
    expect(htmlPath).toBe(join(dir, 'memories-view.html'))
    expect(existsSync(htmlPath)).toBe(true)
    const html = readFileSync(htmlPath, 'utf8')
    expect(html).toContain('缓存 使用 Redis')
    expect((out['htmlBytes'] as number) - Buffer.byteLength(html, 'utf8')).toBe(0)
    expect(out['total']).toBe(2)
    expect(metrics.htmlExports).toBe(1)
    const rendered = tool.output.render({ exportHtml: true }, out)
    expect(rendered[0]?.text).toContain('[memory status html] exported 2 entries →')
    expect(rendered[0]?.text).toContain('self-contained, offline-ready')
    // 时间轴与 store.timeline 同源（90 桶窗口）
    expect(html).toContain('事件 2')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('workspace 过滤：导出语料按统一隔离语义过滤（时间轴仍为库级视图）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-html-ws-'))
    const store = await JsonlMemoryStore.open(join(dir, 'memories.jsonl'))
    await store.upsert(e('g', '全局 条目', T0))
    await store.upsert(e('w', '工作区 条目', T0, { workspace: 'proj-a' }))
    await store.upsert(e('o', '其他工作区 条目', T0, { workspace: 'proj-b' }))
    const tool = createMemoryStatusTool(store, () => 0, undefined, undefined, { htmlDir: dir }) as unknown as StatusTool
    const out = (await tool.execute({ exportHtml: true, workspace: 'proj-a' })) as { total: number; htmlPath: string }
    expect(out.total).toBe(2) // 全局共享 + proj-a
    const html = readFileSync(out.htmlPath, 'utf8')
    expect(html).toContain('全局 条目')
    expect(html).toContain('工作区 条目')
    expect(html).not.toContain('其他工作区 条目')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('未配置 htmlDir：显式失败（INTERNAL + 指引信息）', async () => {
    const store = await JsonlMemoryStore.open(join(mkdtempSync(join(tmpdir(), 'mh-html-nd-')), 'memories.jsonl'))
    const tool = createMemoryStatusTool(store, () => 0) as unknown as StatusTool
    await expect(tool.execute({ exportHtml: true })).rejects.toThrow('exportHtml requires htmlDir')
    await store.close()
  })

  it('降级 store（无 timeline 成员）：按 createdAt 近似时间轴仍可导出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-html-deg-'))
    const rows = [e('d1', '降级 条目 甲', T0), e('d2', '降级 条目 乙', T0 + DAY)]
    const store = {
      upsert: (x: MemoryEntry) => Promise.resolve(x),
      list: () => Promise.resolve([...rows]),
      get: (id: string) => Promise.resolve(rows.find((r) => r.id === id)),
      remove: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    } as unknown as MemoryStore
    const tool = createMemoryStatusTool(store, () => 0, undefined, undefined, { htmlDir: dir }) as unknown as StatusTool
    const out = (await tool.execute({ exportHtml: true })) as { total: number; htmlPath: string }
    expect(out.total).toBe(2)
    const html = readFileSync(out.htmlPath, 'utf8')
    expect(html).toContain('降级 条目 甲')
    expect(html).toContain(DAY1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('写失败：目录不可写（路径被目录占用）→ STORE_WRITE_FAILED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-html-wf-'))
    // 预占导出路径：建一个同名目录 → writeFile 得 EISDIR
    const blocker = join(dir, 'memories-view.html')
    await import('node:fs').then((fs) => fs.mkdirSync(blocker))
    const store = await JsonlMemoryStore.open(join(dir, 'memories.jsonl'))
    await store.upsert(e('a', '写失败 条目', T0))
    const tool = createMemoryStatusTool(store, () => 0, undefined, undefined, { htmlDir: dir }) as unknown as StatusTool
    await expect(tool.execute({ exportHtml: true })).rejects.toThrow('failed to write memory view html')
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('缺省零回归：exportHtml 缺席时输出无 htmlPath 键', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-html-def-'))
    const store = await JsonlMemoryStore.open(join(dir, 'memories.jsonl'))
    await store.upsert(e('a', '缺省 形状', T0))
    const tool = createMemoryStatusTool(store, () => 0, undefined, undefined, { htmlDir: dir }) as unknown as StatusTool
    const out = await tool.execute({})
    expect(out['htmlPath']).toBeUndefined()
    expect(out['total']).toBe(1)
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
