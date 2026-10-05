# dsh-memory-hub 全量代码审查与演进方案（0.1.0 → 0.2.0）

> 审查日期：2026-10-05 ｜ 对象：`src/`（config.ts、index.ts、memory/_、tools/_）、`test/`、工程配置 ｜
> 目标：在不破坏功能、安装方式与 `MemoryEntry` 数据契约的前提下，把全量代码演进到"最前沿、世界级"工程水准。

---

## 1. 审查结论摘要

| 维度        | 现状                                                                                                            | 差距等级 |
| ----------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| 类型系统    | strict 已开，但缺 `exactOptionalPropertyTypes` / `verbatimModuleSyntax` 等前沿开关                              | P1       |
| 构建/工具链 | 仅 tsc + tsup；无 lint / format / 覆盖率 / prepack 守护                                                         | P1       |
| 存储 IO     | 每次写全量重写文件 O(n)；无运行时条目校验；错误吞没                                                             | P1       |
| 检索质量    | 集合 Jaccard（无词频/IDF）；`now` 以第 4 参数外泄接口                                                           | P1       |
| 捕获安全    | **NFKC 全角/异体可绕过敏感过滤**（真实安全缺口）；敏感模式覆盖不全                                              | P0       |
| 捕获逻辑    | **assistant 消息误用 `extractFromToolResult` 而非 `extractFromAssistant`**（行为错位 + 死代码）；事件并发无背压 | P0       |
| 工具层      | **recall 热度更新把 `MemoryHit.score` 一并 upsert 进存储（污染数据契约）**；错误无分类                          | P0       |
| 生命周期    | 卸载 disposer 不等待 store close；注册失败半套注册；部分逻辑重复                                                | P2       |
| ID 生成     | 自动捕获用 `Math.random()` 后缀（非加密随机）                                                                   | P0       |
| 文件权限    | 记忆文件含隐私，未收敛为 0600                                                                                   | P2       |

---

## 2. P0（正确性 / 安全缺陷 —— 必须修复）

### 2.1 敏感过滤可被 Unicode 变体绕过 — `src/memory/capture.ts:34-47`

全角、异体字符（如 `ｐａｓｓｗｏｒｄ ＝ １２３`）可绕过全部 SENSITIVE_PATTERNS。
**方案**：新增 `normalizeForMatch(text)`（`NFKC` 归一化 + 小写折叠），`containsSensitive` 与信号词匹配统一基于归一化文本，原文保持原样入库。
同时扩充敏感模式：AWS `AKIA[0-9A-Z]{16}`、GitHub `ghp_` / `github_pat_`、Slack `xox[baprs]-`、GCP `AIza...`。

### 2.2 assistant 消息用错提取器 — `src/index.ts:96`

`extractFromToolResult('assistant', ...)` 套用在助手消息上，且 `src/memory/capture.ts:110 extractFromAssistant` 从未被使用。
**方案**：改调 `extractFromAssistant(text, 'aggressive')`，删除误导路径；补单测堵住该路径。

### 2.3 热度更新污染数据契约 — `src/tools/memory-recall.ts:64`

`store.upsert({ ...h, accessCount: h.accessCount + 1, ... })` 中 `h` 是 `MemoryHit`（含 `score`），会把 `score` 写进持久化存储，破坏 `MemoryEntry` 字段契约。
**方案**：显式 pick 六个契约字段构造更新条目；新增测试断言落盘字段集合恰为契约字段。

### 2.4 自动捕获 id 使用非加密随机 — `src/index.ts:175`

**方案**：改用 `randomUUID()`（与 `memory_store` 一致）。

### 2.5 事件捕获并发风暴 — `src/index.ts:81-119`

每个事件立即 `void (async…)` 并发执行，密集会话下并发 `store.list()` 全量去重 + 并发写。
**方案**：引入**串行化捕获队列**（promise 链 FIFO，含失败续链），全部捕获经队列处理；`ingest` 通过队列内串行保证去重基于最新快照。

---

## 3. P1（世界级核心演进）

### 3.1 类型系统前沿化 — `tsconfig.json` + 全库

- 开启 `exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`noPropertyAccessFromIndexSignature`、`noImplicitReturns`、`erasableSyntaxOnly`（如 TS 版本支持），并系统性修复因此暴露的问题（`args.workspace || undefined` → 条件展开等）；
- 统一 `import type` 与纯类型导入；为 `MemoryEntry` 增加运行时类型守卫 `isMemoryEntry` / `parseMemoryEntry`。

### 3.2 存储演进为 append-only + tombstone + compact — `src/memory/store.ts`

- **兼容既有 0.1.0 文件**：旧文件每行即完整条目，逐行加载天然兼容；
- 写入：`O_APPEND` 单行追加（不再全量重写）；`remove` 写 tombstone 行（`{ "__tombstone__": id }`），内存即时删除；
- 加载：按 id 去重（后写覆盖）、识别 tombstone、跳过损坏行并计数上报；`ENOENT` 视为空库，其余读取错误**不再吞没**；
- **compact**：条目数 > 文件行数过阈值或文件大小 > 条目序列化体积 ×2 时触发，重建纯条目文件（rename 原子替换，错误分级处理）；
- 写失败回滚：persist/append 失败时回滚当次内存变更（upsert 还原旧值 / remove 还原）；
- 隐私：文件与目录 chmod 0600（失败仅告警不阻断）。

### 3.3 检索引擎升级为词频加权 — `src/memory/engine.ts`

- 集合 Jaccard → **TF·IDF cosine**：条目词频向量 × 查询词 IDF（语料由条目集合构造），保留 7 天指数衰减与访问热度权重；
- 接口收敛：`now` 并入 `RecallOptions`（移除第 4 参数），文档化"首条必含"预算语义；
- 导出 `buildIndex` / `queryIndex` 纯函数（倒排索引构建与查询），供未来索引化召回与测试验证；引擎层保持纯函数无 IO。

### 3.4 工程工具链

- 引入 `eslint`（flat config）+ `typescript-eslint` 严格配置 + `prettier`，新增 `lint` / `format` scripts；
- npm scripts：`prepack` 自动 typecheck+build；`test:coverage`（@vitest/coverage-v8，含阈值）；`pack` 统一 npm 命令；
- `engines.node >= 18`、`.npmrc`（engine-strict 等可选）；`summarize` 改为全量键 `Record<MemoryKind, number>`（0 填充），对齐 schema 可预测性。

### 3.5 错误分类与工具层

- 新增 `MemoryHubError`（code/message），工具错误带稳定 code（如 `EMPTY_CONTENT`）；
- 工具 output render 防御 undefined；`memory_store` 前置 `containsSensitive` 拒绝敏感明文入库（显式记忆也应防泄密）；
- 工具注册逐个 try/catch 独立注册（避免一个失败导致后续不注册）。

### 3.6 生命周期

- 卸载 disposer 改为 async，等待 `store.close()` 完成后才返回（fiber 会 await disposer）；
- 提取 `pruneOnce()` 供启动/周期共用；启动日志含条目数统计；
- 捕获候选对助手消息的聚合采用 `extractFromAssistant`；`ingest` 去重基于队列内最新快照。

---

## 4. P2（完善项 — 尽力达成）

> 类型守卫全量覆盖、日志查询词脱敏、`MemoryStore.dirty` 状态暴露、索引化召回接入工具层（规模触发）、捕获背压上限（队列长度阈值丢弃或合并）。

---

## 5. 回归策略

- 既有 38 个测试语义不变者必须全绿（其余改为断言新行为，**不允许删减降低覆盖**）；
- 新增测试组：NFKC 敏感绕过、assistant 提取路径、score 不落盘、append-only 兼容旧文件、tombstone/compact/写失败回滚、TF·IDF 排序质量、捕获队列串行化、工具错误分类、`isMemoryEntry` 守卫；
- 验证门：`tsc --noEmit`、`tsup`、`vitest run` 全绿、`eslint` 通过、产物 asar 加载冒烟（既有 load.test 保持通过）。
