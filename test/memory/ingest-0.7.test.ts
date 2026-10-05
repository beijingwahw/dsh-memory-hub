import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMetrics } from '../../src/memory/metrics'
import { ingestCaptured, type IngestOptions } from '../../src/memory/ingest'
import { JsonlMemoryStore, contentHash } from '../../src/memory/store'

const OPTS: IngestOptions = { maxEntryChars: 1000, dedupWindowMs: 86400000 }

let dirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh0.7-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('ingestCaptured 捕获入库管线（0.7.0, U8）', () => {
  it('空候选直接返回：不 list、不写库、指标全 0', async () => {
    const store = await JsonlMemoryStore.open(join(freshDir(), 'mem.jsonl'))
    const metrics = createMetrics()
    await ingestCaptured(store, [], OPTS, metrics, 'ws-a')
    expect(await store.list()).toEqual([])
    expect(metrics.capturedTotal).toBe(0)
    expect(metrics.rejectedSensitive).toBe(0)
    expect(metrics.rejectedDuplicate).toBe(0)
  })

  it('敏感内容拒绝入库并计数', async () => {
    const store = await JsonlMemoryStore.open(join(freshDir(), 'mem.jsonl'))
    const metrics = createMetrics()
    await ingestCaptured(
      store,
      [{ kind: 'fact', content: '这里有个 sk-abcdef1234567890abc 的 key 样例', tags: [] }],
      OPTS,
      metrics,
      undefined,
    )
    expect(await store.list()).toEqual([])
    expect(metrics.rejectedSensitive).toBe(1)
    expect(metrics.capturedTotal).toBe(0)
  })

  it('窗口内重复内容拒绝并计数', async () => {
    const store = await JsonlMemoryStore.open(join(freshDir(), 'mem.jsonl'))
    const content = '统一使用 pnpm 作为包管理器并保持 lockfile 提交。'
    await store.upsert({
      id: 'existing-1',
      kind: 'preference',
      content,
      tags: ['x'],
      source: 'explicit',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
    })
    const metrics = createMetrics()
    await ingestCaptured(store, [{ kind: 'preference', content, tags: ['x'] }], OPTS, metrics, undefined)
    expect(metrics.rejectedDuplicate).toBe(1)
    expect(metrics.capturedTotal).toBe(0)
    expect(await store.list()).toHaveLength(1)
  })

  it('窗口外的旧内容不判重（createdAt 早于窗口即视为新）', async () => {
    const store = await JsonlMemoryStore.open(join(freshDir(), 'mem.jsonl'))
    const content = '长期有效的团队约定：周一发布版本。'
    await store.upsert({
      id: 'old-1',
      kind: 'instruction',
      content,
      tags: [],
      source: 'explicit',
      createdAt: Date.now() - 3 * OPTS.dedupWindowMs,
      updatedAt: Date.now() - 3 * OPTS.dedupWindowMs,
      accessCount: 0,
    })
    const metrics = createMetrics()
    await ingestCaptured(store, [{ kind: 'instruction', content, tags: [] }], OPTS, metrics, undefined)
    expect(metrics.rejectedDuplicate).toBe(0)
    expect(metrics.capturedTotal).toBe(1)
    expect(await store.list()).toHaveLength(2)
  })

  it('正常入库：字段组装（id 前缀=内容哈希、kind/tags/source/热度字段）', async () => {
    const store = await JsonlMemoryStore.open(join(freshDir(), 'mem.jsonl'))
    const metrics = createMetrics()
    const content = '项目部署架构统一采用反向代理 + 容器编排。'
    await ingestCaptured(store, [{ kind: 'fact', content, tags: ['deploy', 'arch'] }], OPTS, metrics, 'ws-main')
    const list = await store.list()
    expect(list).toHaveLength(1)
    const entry = list[0]!
    expect(entry.id.startsWith(`${contentHash(content)}-`)).toBe(true)
    expect(entry.kind).toBe('fact')
    expect(entry.content).toBe(content)
    expect(entry.tags).toEqual(['deploy', 'arch'])
    expect(entry.source).toBe('auto')
    expect(entry.workspace).toBe('ws-main')
    expect(entry.accessCount).toBe(0)
    expect(entry.createdAt).toBe(entry.updatedAt)
    expect(metrics.capturedTotal).toBe(1)
  })

  it('超长内容按 maxEntryChars 截断', async () => {
    const store = await JsonlMemoryStore.open(join(freshDir(), 'mem.jsonl'))
    const metrics = createMetrics()
    const long = 'x'.repeat(3000)
    await ingestCaptured(
      store,
      [{ kind: 'generic', content: long, tags: [] }],
      { maxEntryChars: 500, dedupWindowMs: OPTS.dedupWindowMs },
      metrics,
      undefined,
    )
    const entry = (await store.list())[0]!
    expect(entry.content).toHaveLength(500)
    expect(entry.id.startsWith(`${contentHash(long)}-`)).toBe(true)
  })

  it('workspace 缺省时不带 workspace 字段（契约最小化）', async () => {
    const store = await JsonlMemoryStore.open(join(freshDir(), 'mem.jsonl'))
    const metrics = createMetrics()
    await ingestCaptured(
      store,
      [{ kind: 'fact', content: '无工作区上下文的通用记忆条目。', tags: [] }],
      OPTS,
      metrics,
      undefined,
    )
    const entry = (await store.list())[0]!
    expect('workspace' in entry).toBe(false)
  })
})
