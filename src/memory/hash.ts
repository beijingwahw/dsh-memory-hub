/**
 * 内容指纹（1.1.1 自 store.ts 下沉的独立 util）。
 *
 * 下沉动机：contentHash 是纯函数，却被评分（engine/dedup）、工厂（entry-factory）、
 * 蒸馏（distill）等多层消费——此前从 store.ts（存储实现）导入形成层次倒置；
 * 拆出后 store.ts 反向 re-export 保持既有导入路径兼容。
 */
import { createHash } from 'node:crypto'

/** 生成短哈希 id：内容 + 盐 + 时间，保证幂等去重用内容哈希、唯一性用完整 id */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * 语料内容指纹：id+content+tags 的轻量哈希（非密码学用途，仅缓存失效判定）。
 * 1.5.0 自 engine.ts 下沉：IndexCache（engine）与 VectorIndexCache（vector.ts）
 * 双方共享的失效信号——下沉避免 engine↔vector 循环依赖
 * （engine re-export 保持既有导入路径零变更）。
 */
export function fingerprint(entries: readonly { id: string; content: string; tags: readonly string[] }[]): string {
  const h = createHash('sha256')
  for (const e of entries) {
    h.update(e.id)
    h.update('\u0000')
    h.update(e.content)
    h.update('\u0000')
    for (const t of e.tags) h.update(t + '\u0000')
  }
  return h.digest('hex')
}
