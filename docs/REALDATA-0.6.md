# REALDATA-0.6：真实数据接入层设计方案

> 版本：0.6.0（draft → 定稿）
> 关联：README.md / ARCHITECTURE.md / CHANGELOG.md / INNOVATION-0.5.md
> 硬约束：4 工具签名不变 · MemoryEntry 契约不变 · cordis.patch.yml 安装方式不变 · 既有 186 项测试全绿 · 覆盖率不降（lines ≥93.74 / branches ≥88.97）· 纯函数核心零外部依赖

## 1. 背景与缺口

dsh-memory-hub 0.5.0 的记忆来源只有两条**在线**路径：

1. 事件驱动自动捕获（session/event 火线 + tools/result 管线）——只对未来**新发生**的会话有效；
2. `memory_store` 工具显式记忆——依赖 Agent/用户在会话中主动调用。

两条路径都**无法利用用户已经沉淀的真实数据资产**：换工作区、迁移机器、接入既有 Agent 工程时，历史记忆全部丢失，必须重新开始积累。这使插件停留在"演示级自证"（合成黄金语料评估），没有真正"接地"。

## 2. 真实数据形态盘点（DeepSeek Harness / Cordis 生态）

| 形态         | 落盘形态                                                                                          | 结构化程度                                       | 现实示例                                |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------- |
| 记忆文档     | Markdown / 纯文本（`AGENTS.md`、`MEMORY.md`、`USER.md`、`SOUL.md`、`*.md`）                       | 标题/列表/段落                                   | Harness 工作区中的 agent 指令与记忆文件 |
| 会话事件日志 | JSONL 单行事件（`SessionEvent` 序列化，含 `user/message`、`assistant/message`、`tool/result` 等） | 每行一个事件，`data.content` 为 `ContentBlock[]` | dsh-session 持久化日志                  |
| 既有记忆库   | JSONL（`memories.jsonl`，既有 MemoryEntry 行 + tombstone 行）                                     | 可 `parseMemoryEntry` 逐行解析                   | 旧版本 / 其他机器 / 备份文件            |

## 3. 目标与边界

**目标**：让插件在启动时即可把用户已有的真实数据批量接入记忆库，复用 0.5.0 全部检索能力（BM25+容错+语义+热度+价值），真正"开箱即有记忆"。

**明确不做**（避免越权与破坏）：

- 不新增/修改任何工具（4 工具签名严格不变）；
- 不修改 MemoryEntry 字段与 `isMemoryEntry` 校验；
- 不改 `cordis.patch.yml`（安装方式不变；新增配置为**可选**键，缺失时行为与 0.5.0 完全一致）；
- 不做自动扫描目录（只导入用户显式配置的路径，避免误读隐私文件）；
- 不引入任何外部依赖（解析全部为纯函数）。

## 4. 架构设计

### 4.1 模块划分

```
src/memory/importer.ts    # 纯函数核心：文档切块 / 会话文本提取 / kind 推断 / 幂等规划
src/index.ts              # 插件接线：可选配置 importSources → 启动导入（容错、只告警）
```

### 4.2 纯函数核心 API（`src/memory/importer.ts`）

```ts
export interface DocumentSource {
  label: string
  text: string
} // label 常为文件路径
export interface SessionSource {
  label: string
  lines: string[]
} // JSONL 原始行
export interface ImportOptions {
  mode?: CaptureMode // 默认 'balanced'（与插件默认捕获一致）
  maxChars?: number // 默认 1000（对齐 maxEntryChars）
  now?: number // 时间戳注入，保证可复算
}
export interface ImportStats {
  total: number // 全部候选条目数（文档块 + 会话事件文本）
  imported: number // 进入 entries 的条数（内容级幂等合并后）
  droppedShort: number // 长度 < 8 的噪声块
  droppedSensitive: number // 命中敏感模式的块（不入库）
  corruptLines: number // 会话日志 JSON 损坏行
}
export interface ImportPlan {
  entries: MemoryEntry[]
  stats: ImportStats
}

export function splitDocument(text: string): string[] // Markdown/文本 -> 语义块
export function extractTextBlocks(blocks: unknown): string // 宽容递归：ContentBlock[] -> 纯文本
export function extractSessionText(line: string): { text: string; isUser: boolean } | undefined // JSONL 单行
export function inferKind(text: string): MemoryKind // 信号词推断 preference/instruction/generic
export function planImport(input: {
  documents?: DocumentSource[]
  sessions?: SessionSource[]
  options?: ImportOptions
}): ImportPlan
```

### 4.3 关键语义（每条都可复算）

**文档切块 `splitDocument`**（稳定、无状态）：

- 逐行扫描，行类型：标题（`^#+\s`）/ 无序列表（`^\s*[-*+]\s`）/ 有序列表（`^\s*\d+\.\s`）/ 普通文本；
- 标题行、列表行各自成块；**连续普通文本行聚合成一段**（直至遇到标题/列表/空行）；
- 纯链接索引行（`- [name](url)` 整行）跳过（MEMORY.md 索引是元数据而非记忆正文）；
- 块 trim 后长度 <8 记 `droppedShort`；>maxChars 截断。

**会话文本提取 `extractTextBlocks`**：递归遍历 `{type:'text',text}`、`{type:'tool-result',content}` 与嵌套数组，其余类型忽略（与 index.ts 的 `blocksToText` 语义一致，但作为独立纯函数供导入与复用）。

**会话事件行提取 `extractSessionText`**：

- `user/message` → 取 `data.content`；`assistant/message` → 取 `data.message?.content ?? data.content`；
- 结构宽容：缺字段视为不可提取；非 `user/message` / `assistant/message` 事件跳过；
- JSON 解析失败计 `corruptLines`（沿用 0.4.0"损坏行隔离不计入"哲学，此处只计数不乱写文件）。

**kind 推断 `inferKind`**（信号词子集，与 capture.ts 语义对表）：

- 含指令性信号（`不要/别/避免/禁止/必须/务必/始终/永远/never/always/do not`）→ `instruction`；
- 含偏好性信号（`记住/以后/优先/偏好/喜欢/习惯/remember/prefer`）→ `preference`；
- 其余 → `generic`。
- 不产 `fact`/`decision`（离线文档无工具执行上下文，无法可靠判定，宁缺毋滥）。

**来源与幂等**：

- 文档导入 → `source: 'explicit'`（人工维护的记忆文件视为显式知识）；
- 会话日志导入 → `source: 'auto'`（机器从历史事件提取）；
- id = `imp-${contentHash(content)}`——纯内容哈希前缀，**同一内容多次导入（含不同文件、不同时间）幂等合并**，`importAll` 天然去重；
- tags：文档块 `['imported', label 的 basename]`；会话块 `['imported', 'session']`。

### 4.4 插件接线（`src/index.ts`）

新增**可选**配置键（缺失时行为与 0.5.0 完全一致）：

```ts
importSources?: {
  documents?: string[]   // Markdown/文本记忆文件路径
  sessionLogs?: string[] // 会话事件 JSONL 日志路径
}
```

store 就绪后（与工具注册并行）：对每个配置路径 `readFile(utf8)` → `planImport` → `store.importAll(entries)`；
读文件失败 / 路径不存在 / 导入异常 → **仅告警计数，绝不阻断插件启动**（延续 0.3 起"失败不阻断"哲学）。

## 5. 兼容性论证（逐条对硬约束）

| 硬约束                        | 论证                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 4 工具签名不变                | 不新增/修改工具；`memory_store/recall/forget/status` 的 name/params/schema 零改动                                   |
| MemoryEntry 契约不变          | 导入产出仍是既有 MemoryEntry（kind/content/tags/source/timestamps/accessCount）；不新增字段；`isMemoryEntry` 不触碰 |
| cordis.patch.yml 安装方式不变 | patch 内容不改；`importSources` 为 schema 可选键，缺省 undefined，默认行为零变化                                    |
| 既有 186 测试全绿             | 纯新增模块与新增可选分支；现有测试路径不进入任何新分支（仅 index.ts 的配置读取处不变）                              |
| 覆盖率不降                    | 新增模块自带完整单测（覆盖文档切块/会话提取/kind/幂等/端到端）                                                      |
| 纯函数零外部依赖              | importer 仅依赖 `node:crypto`（contentHash 同 store）与既有 types/capture；无新增 dependency                        |

## 6. 测试与验收

新增 `test/memory/importer-0.6.test.ts`（预计 15-20 项）：

1. **真实语料端到端**（本条是本轮"接地"的直接验收）：
   - 读取仓库**真实** `README.md` 与 `CHANGELOG.md`（fs 相对路径，非合成样本）；
   - `planImport` → `JsonlMemoryStore.importAll` → `buildIndex`/`recall`；
   - 断言：真实内容（如 "BM25"、"dsh-memory-hub"、"memory_recall" 等真实出现的词）可被召回，且命中条目确实来自真实文档块。
2. 文档切块：标题/列表/连续段聚合、索引行跳过、短块丢弃、超长截断；
3. 会话提取：user/assistant 事件取文、缺字段宽容、损坏行计数、非事件行跳过；
4. kind 推断：instruction/preference/generic 三类信号；
5. 幂等：同一文档 planImport 两次 → entries.id 完全一致、importAll 第二次 added=0；
6. 敏感过滤：含 token 的块 droppedSensitive 且不入库；
7. 配置接线：`importSources` 缺省时 0.5.0 行为逐项不变（可由既有 186 测试保证）。

验收命令：`npm run format && npm run typecheck && npm test && npm run eval && npm run test:coverage && npm run lint && npm run bench`。

## 7. 风险与回退

| 风险                               | 缓解                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------- |
| 文档切块过细产生噪声记忆           | 连续纯文本段聚合 + <8 字符丢弃 + 幂等 id，可随时 `memory_forget` 清理   |
| 会话日志行结构随 dsh 版本变化      | 宽容取值（多重 fallback）+ 损坏行只计数；未知结构只跳过，不影响既有功能 |
| 大文件导入阻塞启动                 | 导入与工具注册并行、异常只告警；`importSources` 由用户显式控制规模      |
| 配置 schema 新增键影响 Cordis 面板 | 可选键（schemastery optional）；文档注明"未配置则零影响"                |
