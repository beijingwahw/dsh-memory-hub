import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlMemoryStore } from '../../src/memory/store'
import { createMemoryForgetTool } from '../../src/tools/memory-forget'
import { createMemoryRecallTool } from '../../src/tools/memory-recall'
import { createMemoryStatusTool } from '../../src/tools/memory-status'
import { createMemoryStoreTool } from '../../src/tools/memory-store'

type Toolish = { name: string; execute: (args: never) => Promise<Record<string, unknown>> }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-tools2-'))
  const store = await JsonlMemoryStore.open(join(dir, 'mem.jsonl'))
  return {
    store,
    storeTool: createMemoryStoreTool(store, 1000) as unknown as Toolish,
    recallTool: createMemoryRecallTool(store, 800, 8) as unknown as Toolish,
    forgetTool: createMemoryForgetTool(store) as unknown as Toolish,
    statusTool: createMemoryStatusTool(store, () => Promise.resolve(0)) as unknown as Toolish,
  }
}

const CONTRACT_FIELDS = [
  'accessCount',
  'content',
  'createdAt',
  'id',
  'kind',
  'lastAccessAt',
  'source',
  'tags',
  'updatedAt',
]

describe('memory 工具演进（0.2.0）', () => {
  it('recall 热度更新不把 score 写回存储（契约纯净）', async () => {
    const { storeTool, recallTool, store } = await setup()
    await storeTool.execute({ content: '记住以后汇报统一用中文', tags: ['汇报'] } as never)
    await recallTool.execute({ query: '汇报 中文' } as never)
    // 等后台热度更新完成
    await new Promise((r) => setTimeout(r, 80))

    const list = await store.list()
    expect(list).toHaveLength(1)
    const persisted = list[0]! as unknown as Record<string, unknown>
    // 落盘字段恰好是 MemoryEntry 契约字段，绝无 score
    expect(Object.keys(persisted).sort()).toEqual([...CONTRACT_FIELDS].sort())
    expect(persisted['score']).toBeUndefined()
    expect(persisted['accessCount']).toBeGreaterThanOrEqual(1)
  })

  it('空内容抛 EMPTY_CONTENT 错误码', async () => {
    const { storeTool, recallTool } = await setup()
    try {
      await storeTool.execute({ content: '   ' } as never)
      expect.unreachable('should reject')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('EMPTY_CONTENT')
    }
    try {
      await recallTool.execute({ query: '  ' } as never)
      expect.unreachable('should reject')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('EMPTY_CONTENT')
    }
  })

  it('显式记忆含敏感明文抛 SENSITIVE_CONTENT', async () => {
    const { storeTool } = await setup()
    try {
      await storeTool.execute({ content: '服务器登录 password: secret-p@ssw0rd' } as never)
      expect.unreachable('should reject')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SENSITIVE_CONTENT')
    }
  })

  it('forget 不存在的 id 返回 removed=false 而非报错', async () => {
    const { forgetTool } = await setup()
    const out = (await forgetTool.execute({ id: 'no-such-id' } as never)) as { removed?: boolean }
    expect(out.removed).toBe(false)
  })

  it('status 在空库下返回全量 0 键（byKind 可预测）', async () => {
    const { statusTool } = await setup()
    const out = (await statusTool.execute({} as never)) as { byKind?: Record<string, number> }
    expect(out.byKind).toEqual({ decision: 0, fact: 0, preference: 0, instruction: 0, generic: 0 })
  })

  it('forget 对带空格的 id 统一 trim（P1-4：删除与返回值一致）', async () => {
    const { store, forgetTool } = await setup()
    await store.upsert({
      id: 'trim-target',
      kind: 'fact',
      content: '带空格 id 的目标条目',
      tags: [],
      source: 'auto',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
    })

    const out = (await forgetTool.execute({ id: '  trim-target  ' } as never)) as {
      removed?: boolean
      id?: string
    }
    expect(out.removed).toBe(true)
    expect(out.id).toBe('trim-target') // 返回值不再保留原始带空格 id
    await expect(store.list()).resolves.toHaveLength(0)
  })
})
