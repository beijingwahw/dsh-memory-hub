/**
 * dsh-memory-hub 核心能力库出口（`./core` 子路径导出，1.6.0）
 *
 * 为独立应用级交付物（dsh-memory-hub-gui 跨平台桌面端）提供的纯库 API：
 * 存储 / 检索 / 条目工厂 / 导入 / 导出 / 加密形态探测 / 敏感过滤。
 * 与插件主出口（`.`，cordis apply 入口）正交——本出口零新增逻辑、零副作用，
 * 仅 re-export 既有模块的公共面；主出口字节不变。
 */
export { JsonlMemoryStore } from './memory/store'
export type { MemoryStore } from './memory/types'

// 检索引擎：混合召回（六线融合）+ 统计 + 主题聚类 + 库内查重
export { recall, summarize, clusterThemes, findDuplicate } from './memory/engine'
export type { ThemeCluster } from './memory/themes'

// 条目工厂与取代协议
export {
  makeEntry,
  safeSlice,
  SUPERSEDE_TAG_PREFIX,
  SUPERSEDED_BY_TAG_PREFIX,
  isSuperseded,
  supersedeTargetId,
  supersededByTargetId,
} from './memory/entry-factory'
export type { EntryInput } from './memory/entry-factory'

// 批量导入（Markdown 文档 / 会话 JSONL → 内容级幂等入库计划）
export { planImport, splitDocument, extractSessionText, inferKind } from './memory/importer'
export type { DocumentSource, SessionSource, ImportOptions, ImportStats, ImportPlan } from './memory/importer'

// 可视化检索页（自包含 HTML，纯函数渲染）
export { renderMemoryHtml } from './memory/html-export'

// 加密形态探测（GUI 打开库前判定是否需要口令；不解密、不派生密钥）
export { parseKeyRecord, isEncryptedEnvelope } from './memory/crypto'

// 敏感过滤（与 memory_store 工具/自动捕获同一条防线）
export { containsSensitive } from './memory/capture'

// 矛盾共存标注（UI 徽标用）
export { isConflicted, conflictPeerIds, CONFLICTS_WITH_TAG_PREFIX, CONFLICT_OF_TAG_PREFIX } from './memory/conflict'

// 数据模型
export {
  isMemoryEntry,
  parseMemoryEntry,
  toMemoryEntry,
  type MemoryEntry,
  type MemoryKind,
  type MemorySource,
  type MemoryHit,
  type MemoryStats,
  type RecallOptions,
  type MemoryTimeline,
  type TimelineBucket,
} from './memory/types'

// 错误基础设施（GUI 按 code 映射本地化提示）
export { MemoryHubError, ErrorCodes } from './errors'
