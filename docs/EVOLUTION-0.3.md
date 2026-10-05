# dsh-memory-hub 世界级升维审查与方案（0.2.0 → 0.3.0）

> 审查日期：2026-10-05 ｜ 对象：`src/`（index/config/errors/memory/_/tools/_）、`test/`、工程配置、文档
> 目标：保持功能、安装方式与 `MemoryEntry` 数据契约不变，把 0.2.0 工程整体升维到**世界级生产可用**水准——
> 核心是四大支柱：**并发安全与读一致性、有界背压、索引与快照缓存（性能）、可观测指标（运维）**，并补齐 CI/CHANGELOG 等工程护栏。

---

## 1. 审查结论摘要

| 维度     | 0.2.0 现状                                              | 差距（世界级标准）                                                         | 等级 |
| -------- | ------------------------------------------------------- | -------------------------------------------------------------------------- | ---- |
| 写一致性 | `upsert` 先改内存后落盘，失败再回滚                     | 并发读者可能读到"半途状态"；应先落盘成功再入内存                           | P1   |
| 读性能   | `list()` 每次全量拷贝 + 排序                            | 应维护快照缓存 + 脏标记，仅脏时重建（O(1) 热路径）                         | P1   |
| 召回性能 | 每次 `recall` 全量 `buildIndex` O(N·tokens)             | 应按存储版本号缓存倒排索引，版本变化才重建                                 | P1   |
| 去重性能 | `isDuplicate` 全库编辑距离扫描                          | 先精确 `contentHash` 命中加速 + 长度窗口预筛相似度候选                     | P2   |
| 内存有界 | 捕获队列 promise 链无上限，事件洪水时 backlog 无界      | 应有界队列 + 丢弃策略 + dropped 计数（背压）                               | P1   |
| 可观测性 | 仅字符串日志，无运行指标                                | 应有 `Metrics`（捕获/入库/拒绝/召回/遗忘/错误/丢弃），`memory_status` 可查 | P1   |
| 批量运维 | TTL 清理逐条 `remove` → N 次 append + 多次 compact 判定 | 应有 `removeMany(ids)` 批量 tombstone + 单次 compact 判定                  | P2   |
| 工程护栏 | 无 CI 配置；无 all-in-one check 脚本；无 CHANGELOG      | 世界级仓库标配：GitHub Actions + check 脚本 + CHANGELOG                    | P2   |
| 错误分级 | 已有 `MemoryHubError` 覆盖工具层                        | 保持；不加新错误码                                                         | -    |
| 数据契约 | `MemoryEntry` 运行时守卫 + 契约纯净                     | 已达标，**本轮不改动**                                                     | -    |

---

## 2. P1（正确性 / 性能 / 可观测性 —— 本轮核心）

### 2.1 写一致性：先落盘后入内存（store.ts）

现状：`upsert` 先 `entries.set(entry)` 再 `appendLine`，失败回滚。并发读者在 append 进行中
（写失败回滚前）会短暂看到新内容，随后回滚消失——读不一致。

方案：调整顺序为 **`appendLine` 成功 → `entries.set`**；append 失败直接抛错、内存不变。

- `remove` 同理：成功 append tombstone 后才从 Map 删除。
- `importAll` 保持"预拷贝 + 成功追加后合并"，改为先批量 append、成功后再批量 set。
- 收益：读者永远只看到"已确认落盘"的状态；写失败天然无残留（原回滚逻辑可移除，语义更强）。
- 兼容性：既有测试（写失败不残留、append-only 两行、30 并发写）全部语义不变。

### 2.2 快照缓存：list() 热路径 O(1)（store.ts）

现状：`snapshots()` 每次 `[...values].sort(...)` 全量重建。

方案：

- 新增 `private snapshotCache: MemoryEntry[] | undefined` 与 `private dirty = true`；
- `upsert/remove/importAll/loadLines/compact` 置脏；
- `list()` 在 clean 时直接返回缓存数组（防御性浅拷贝由调用方承担语义不变），脏时重建一次；
- store 新增只读 `revision`（number，每次结构性变更 +1，供 2.3 索引缓存失效使用）。

### 2.3 倒排索引缓存：recall 免全量重建（engine + 新 recall 缓存）

现状：`recall(entries, query)` 每次都 `buildIndex` —— 同一语料反复 `list()` + 全量建索引。

方案（保持 `engine` 纯函数不变，缓存放调用层）：

- 新增轻量 `IndexCache`（可放 tools/memory-recall.ts 内或独立模块）：
  `{ revision, entries: MemoryEntry[], index: MemoryIndex, byId: Map<string, MemoryEntry> }`；
- `memory_recall` 工具持有 cache：每次执行先 `store.list()` 并比对 `store.revision`，
  相同则复用 `index/byId`，不同才重建（`buildIndex` 仍来自 engine，语义零变化）；
- 热度更新走后台上卷（见 2.5），不触发修订（`revision` 只在内容/增删变化时自增，
  可提供 `touchRevision` 语义：accessCount/lastAccessAt 变化不使索引失效——索引只依赖 content/tags/kind/createdAt/accessCount? 当前评分含 accessCount 与 createdAt，所以热度上卷会改变评分 → 严格说需要失效。折中：热度上卷确实改变 heat 因子，但为了性能，允许缓存偏差一小段时间？
  不——**评分正确性优先**：`revision` 在 upsert（含热度上卷）后都必须 +1，热度上卷只发生在 recall 命中条目，频次低，重建成本可接受。方案回归简单正确：任何 upsert/remove 都 `revision++`，cache 按 revision 失效。）

### 2.4 有界捕获队列（背压，index.ts）

现状：`captureChain = captureChain.then(task)` 无上限，洪水事件 backlog 无界。

方案：

- 新增 `private pendingCaptures = 0` 与常量 `MAX_PENDING_CAPTURES = 256`；
- `enqueueCapture` 入口 `if (pending >= MAX) { metrics.dropped(); return }`（丢早期事件、保留近期）；
- 任务开始 `pending++`，`finally` 中 `pending--`；
- dropped 计入指标，日志 warn（限频）。

### 2.5 Metrics 可观测体系（新增 src/memory/metrics.ts）

新增纯 JS 计数聚合器（无依赖、可注入、可快照）：

```ts
interface HubMetrics {
  captured: { total: number } // 自动捕获入库成功
  stored: { explicit: number } // memory_store 显式入库
  recalls: { total: number; hits: number } // 召回次数与命中总数
  forgotten: number
  rejected: { sensitive: number; duplicate: number }
  errors: number
  pruned: number
  dropped: number // 背压丢弃
  ops: { storedAt: number } // 最后操作时间（进程存活证明）
}
```

- `memory_status` 输出新增 `metrics` 字段（output schema 增加 properties，向后兼容）；
- 插件 dispose 时以结构化日志输出最终指标摘要；
- 工具层可选注入 metrics（默认 no-op，不影响现有测试构造）。

---

## 3. P2（运维效率 / 工程护栏）

### 3.1 批量删除 removeMany(ids)（store.ts）

- `removeMany(ids: string[]): Promise<number>`：单次 append 多行 tombstone + 单次 compact 判定；
- TTL 清理改用 `removeMany`（一次 prune 一次落盘批次）。

### 3.2 去重加速（engine.ts）

- `isDuplicate` 入口先按 `contentHash === contentHash(content)` 精确命中（O(1)，保留 24h 窗口）；
- 相似度候选加长度预筛：`|lenA - lenB| <= 0.1 * maxLen` 才进编辑距离（Jaccard 分支已限长文本）；
- 语义不变（阈值不变），大库去重显著提速。

### 3.3 工程护栏

- `.github/workflows/ci.yml`：node 18/20/22 × typecheck/lint/format/test/build（prepack 已含前四）；
- `npm run check` = `typecheck + lint + format:check + test`（all-in-one）；
- `CHANGELOG.md`（0.3.0 条目，Keep a Changelog 风格）；
- 覆盖率阈值维持：lines ≥70 / functions ≥70 / branches ≥60 / statements ≥70（先实测再定是否上调）。

---

## 4. 明确不做（保持规模与风险可控）

| 候选                                 | 原因                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| 向量召回（embedding/HNSW）           | 需要外部模型与依赖，违反"零外部服务"定位；Roadmap 保留 |
| 会话级加密                           | Roadmap 项，涉及密钥管理，另行设计                     |
| 多进程文件锁                         | dsh 单进程模型内运行，无需锁；README 已声明            |
| 改 `MemoryEntry` 契约 / 工具既有字段 | must 约束，绝不触碰                                    |
| `estimateTokens` LRU                 | 收益微小，避免无界缓存内存风险                         |

---

## 5. 实施顺序与验证要求

1. **store.ts**：先落盘后入内存 + 快照缓存 + `revision` + `removeMany`（不破坏 37 既有存储相关测试）；
2. **engine.ts**：`isDuplicate` 加速（既有 TF·IDF 测试全绿）；
3. **tools/memory-recall.ts**：IndexCache 接入（engine 语义不变）；
4. **index.ts**：有界捕获队列 + metrics 注入 + prune 走 removeMany；
5. **metrics.ts + memory-status**：指标与输出扩展（schema 增字段，向后兼容）；
6. **护栏**：CI / check 脚本 / CHANGELOG；
7. **测试**：新增覆盖以上行为的测试，锁定 77+new 全绿；tsc/eslint/prettier/build 全过；
8. **文档与打包**：README/ARCHITECTURE 同步 0.3.0，版本声明一致，原地重打包 zip 校验导出。

> 质量红线：任何改动不得让既有 77 测试变红；`MemoryEntry`、工具名、安装方式、默认配置语义不变。

---

## 6. 实施结果（2026-10-05 落地记录）

本节记录方案实际落地与计划差异，保证文档如实反映代码：

- **Metrics 结构简化**：方案稿（2.5）原设计 `captured: { total }` 嵌套结构，实施时改为**扁平
  `HubMetricsSnapshot`**（`capturedTotal/explicitStored/recallCalls/recallHits/forgotten/
rejectedSensitive/rejectedDuplicate/pruned/dropped/errors` 十项纯数字）——扁平结构 JSON 序列化
  更直接、status schema 生成更简单，且保留"幂等可快照"的设计意图。
- **`isDuplicate` 预筛阈值**：方案稿（3.2）写 `0.1 * maxLen`，实施采用 `|lenA-lenB| > 0.08*maxLen+1`
  才跳过编辑距离——0.08 是 0.92 相似度阈值的精确上界（`similarity = 1 - d/maxLen > 0.92 ⟹ d < 0.08*maxLen`），
  `+1` 吸收浮点边界，语义与 0.2.0 完全等价且预筛更紧。
- **store 重写**：`upsert/removeMany/importAll` 全部改为先落盘后入内存；原回滚逻辑移除（不再需要）；
  `remove` 变为 `removeMany([id])` 的薄封装。
- **测试**：新增 23 个（metrics-0.3 × 3、store-0.3 × 9、tools-0.3 × 7、load-0.3 × 2、
  store-evolve 增补写失败错误码），总计 **100 个全绿**；实测覆盖率
  **lines 91.6 / functions 90 / branches 87.4 / statements 91.6**，远超阈值。
- **工程护栏**：新增 `.github/workflows/ci.yml`（node 18/20/22 × typecheck/lint/format/test/build +
  coverage）与 `npm run check` 一键全检；新增 `CHANGELOG.md`（0.3.0 / 0.2.0 / 0.1.0 条目）。
- **未做项**（维持方案第 4 节）：向量召回、会话加密、多进程锁继续留在 Roadmap。
