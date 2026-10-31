# dsh-memory-hub 世界级代码质量升级报告（0.6.0 → 0.7.0）

> 定位：把工程从"功能正确、覆盖率高"推进到"世界级工程质量"——守门强度与实测一致、无重复实现、错误基础设施统一、类型断言可证明、评估管线可复算可进 CI、基准可观察。
> 版本：0.7.0（质量升级）｜许可证：MIT

---

## 1. 审计基线（0.6.0 实测）

| 维度     | 实测                                                                        | 说明                 |
| -------- | --------------------------------------------------------------------------- | -------------------- |
| 测试     | **207 项全绿**（23 文件）                                                   | vitest run           |
| 覆盖率   | lines **94.7** / branches **89.71** / functions **95.14** / statements 94.7 | v8 provider          |
| 类型     | strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess 零错误       | tsc --noEmit         |
| 静态检查 | eslint 9 recommendedTypeChecked 零告警                                      | npm run lint         |
| 格式     | prettier 全一致                                                             | npm run format:check |
| 构建     | tsup ESM + d.ts 通过                                                        | npm run build        |
| 评估     | G1–G5 六门限全绿，recall@1 = 1.0（G1/G2/G3）                                | npm run eval         |
| CI       | node 18/20/22 × typecheck/lint/format/test/build + coverage                 | GitHub Actions       |

结论：0.6.0 的功能正确性与覆盖已经扎实；差距集中在**工程质量治理**（守门强度、重复代码、错误基础设施、评估管线自动化），而非功能缺陷。

---

## 2. 审计发现（按严重度排序）

### P0 — 守门强度与实测脱节（必须修复）

`vitest.config.ts` 覆盖率阈值仍为 0.4.0 时代的 `lines 93.04 / functions 85 / branches 88.91 / statements 90`，
而实测已达 94.7 / 95.14 / 89.71 / 94.7。威胁：

- **functions 阈值 85%** 形同虚设：实测 95.14%，意味着可删掉 10 个百分点分支而不被 CI 拦截；
- **文档-配置双重漂移**：`docs/ARCHITECTURE.md` 声称"门槛 lines ≥93.74 / branches ≥88.97 / functions ≥93.54 / statements ≥93.74 固化于 vitest.config.ts"，与配置实际值（93.04/88.91/85/90）不一致。

→ 修复：阈值提升到与实测对齐并留安全垫（lines 94.5 / branches 89.5 / functions 94.5 / statements 94.5），
全部文档（README/ARCHITECTURE/CHANGELOG）同步为同一组数值，杜绝三重漂移。

### P1 — 重复实现（必须修复）

`src/index.ts` 的 `blocksToText` 与 `src/memory/importer.ts` 的 `extractTextBlocks` 是**同一逻辑的两份实现**
（text 块 + tool-result 递归，trim 语义一致）。两份实现各自维护，后续若一方扩展块类型另一方必遗忘。

→ 修复：合并且归一到 `src/memory/text.ts` 共享模块（导出 `extractTextBlocks`），index.ts 复用，
对 `snapshot` 语义做等价性测试守护。

### P2 — 错误基础设施未沉淀（必须修复）

- `toMemoryHubError`（errors.ts）**无任何测试**：errors.ts 覆盖率仅 71.42%，42–49 行完全未覆盖；
- `errorMessage` 目前是 index.ts 私有函数，工具层各自拼日志串，无统一入口。

→ 修复：`errorMessage` 提升为 errors.ts 导出（MemoryHubError 带 code 前缀、Error 取 message、其余 String），
index.ts/tools 统一复用；新增 errors 专项测试使 errors.ts 覆盖达 100%。

### P3 — 评估管线版本硬编码（必须修复）

`eval/eval.test.ts:143` 把版本写死在 `renderReport(..., '0.5.0')`。每次升级都要手改，0.6.0 已漏改（报告仍称 v0.5.0）。

→ 修复：从 `package.json` 读取 `version` 注入报告，杜绝硬编码漂移。

### P4 — CI 未覆盖评估与测试门限（应当修复）

.github/workflows/ci.yml 的 quality job 未跑 `npm run eval`（离线质量门限，可复算、确定性）。
覆盖率 job 跑 `test:coverage`（带阈值，失败会阻断），但 eval 门限不在任何 CI 路径上。

→ 修复：quality job 增加 `npm run eval` 步骤；bench 保持不进 CI（既有设计注释说明环境抖动误报，合理保留）。

### P5 — bench 质量对比为占位死代码（应当修复）

`bench/recall.bench.ts` 的 `recordRatio` 是"无操作"占位，质量对比 bench 计算结果被丢弃。
质量断言职责本应归 eval（已正式化），bench 中这段遗留应改为**真实可观察输出**（afterAll 打印命中率），
或明确标注由 eval 替代。→ 修复为真实输出，消除不可观察的死代码。

### P6 — 类型断言提纯（应当修复）

`engine.ts` 存在一批仅在 noUncheckedIndexedAccess 下出现的 `!` 断言：

- `minhashSignature`：`MINHASH_SEEDS[i]!` / `sig[i]!` —— 可用 `entries()` 迭代消除；
- `fuzzyVariants`：`word[i]!` / `word[i + 1]!` —— 可先取局部变量 + 边界注释消解；
- `levenshtein`：`prev[b.length]!` 等已有不变式证明注释（可保留），
- `queryIndex`：`qTf` 迭代处。

→ 修复：对可证明安全的 `!` 优先用"迭代替代下标 + 局部变量"消除；确实需要收敛断言的沿用注释证明。
目标：src 下 `!` 计数下降 ≥ 40%，且不降低测试全绿与覆盖率。

### P7 — 入口文件职责过大（应当修复）

`src/index.ts` 328 行，兼事件监听、捕获队列、导入、清理、工具注册、ingest 逻辑。
其中 `ingest`（候选→敏感/去重/组装/入库）是纯逻辑且依赖简单（store/cfg/metrics），当前只能经事件链路间接测试。

→ 修复：`ingest` 与文本提取迁出至 `src/memory/ingest.ts`（ingest）+ `src/memory/text.ts`（extractTextBlocks），
新增 ingest 直接单测；index.ts 聚焦"接线"。

---

## 3. 升级清单与验收口径

| #   | 升级项               | 改动范围                                                                 | 验收口径                                                                                                |
| --- | -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| U1  | 覆盖率阈值对齐实测   | vitest.config.ts + README + ARCHITECTURE + CHANGELOG                     | `test:coverage` 通过；文档四处数值一致（lines 94.5 / branches 89.5 / functions 94.5 / statements 94.5） |
| U2  | 文本提取合并去重     | 新增 src/memory/text.ts；index.ts / importer.ts 复用                     | 无重复实现（grep 确认单一出处）；既有 capture/load/importer 测试全绿                                    |
| U3  | 错误基础设施沉淀     | src/errors.ts 增 errorMessage + toMemoryHubError 测试                    | errors.ts 覆盖率 100%；index.ts/tools 改用统一 errorMessage                                             |
| U4  | eval 版本自动读取    | eval/eval.test.ts + eval/report.ts                                       | 报告标题版本 == package.json version；eval 全绿                                                         |
| U5  | CI 纳入评估门限      | .github/workflows/ci.yml                                                 | quality job 含 `npm run eval`；CI 全绿模拟通过                                                          |
| U6  | bench 质量对比可观察 | bench/recall.bench.ts                                                    | afterAll 打印 BM25 vs cosine top@1 命中率；bench 正常运行                                               |
| U7  | 类型断言提纯         | src/memory/engine.ts                                                     | `!` 计数降 ≥40%；typecheck 零错误                                                                       |
| U8  | ingest 拆分与直测    | 新增 src/memory/ingest.ts + test/memory/ingest-0.7.test.ts               | ingest 单测覆盖敏感/去重/组装/截断各分支；load.test.ts 回归全绿                                         |
| U9  | 文档与版本同步       | package.json 0.7.0、README、ARCHITECTURE、CHANGELOG、docs/QUALITY-0.7.md | 全部文档无 0.5.0/0.6.0 残留硬编码；ARCHITECTURE 演进表含 0.7.0 列                                       |

## 4. 硬约束（全程守护）

- 四工具签名（memory_store / memory_recall / memory_forget / memory_status）不变；
- `MemoryEntry` 数据契约不变；
- `cordis.patch.yml` 安装方式不变；
- 纯函数零外部依赖（升级仅改既有依赖，不新增运行时依赖）；
- 既有 207 项测试保持全绿；
- 覆盖率不低于 baseline（新阈值 94.5 / 89.5 / 94.5 / 94.5 同时满足）；
- `npm run check`（typecheck+lint+format+test）通过，`npm run eval` 通过，`npm run bench` 可运行。

## 5. 回归策略

- 每项 U 完成后立即跑 `npm run typecheck && npm run lint && npm test`（快速门）；
- U1–U8 全部完成后跑全量 `npm run check && npm run test:coverage && npm run eval && npm run bench`；
- 覆盖率统计与 0.6.0 基线对比，只升不降；
- eval 报告与 bench 输出作为可复算证据随交付包保留。

---

## 6. 落地结果与验收对照（0.7.0 交付实证）

以下为升级实施完成后的最终实测证据（与第 3 节计划口径逐项对照；两处与计划不同，均为收敛改进）：

| 升级项 | 计划验收口径                                     | **落地实证**                                                                                                                                                                                                                                        | 判定 |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| U1     | 阈值 lines 94.5 / branches 89.5 / functions 94.5 | 阈值最终对齐**用户硬约束**并留实测安全垫：**lines 94.71 / branches 89.71 / functions 95.14 / statements 94.71**；实测 95.59 / 91.19 / 96.07 / 95.59 全维度超线；README/ARCHITECTURE/CHANGELOG/本报告四处数值一致                                    | ✅   |
| U2     | 单一出处 + 等价性测试                            | `src/memory/text.ts` 唯一实现，`grep -rn "blocksToText" src/` 0 命中；index.ts/importer.ts 复用，importer re-export 兼容；text-0.7 测试 11 项（含与 importer 导出的逐采样等价断言），text.ts 覆盖 100%                                              | ✅   |
| U3     | errors.ts 100%                                   | errors-0.7 测试 11 项覆盖 ErrorCodes 契约 / 构造 / toMemoryHubError 五分支 / errorMessage 三分支；**errors.ts 覆盖 100%**；index.ts 9 处告警统一走 errorMessage                                                                                     | ✅   |
| U4     | 报告版本 == package.json                         | `import pkg from '../package.json'` 注入，报告标题已输出 v0.6.0（source 正确读取），升版后自动变 v0.7.0                                                                                                                                             | ✅   |
| U5     | quality job 含 eval                              | `.github/workflows/ci.yml` 新增独立 `quality-eval`（node 20 + `npm run eval`）                                                                                                                                                                      | ✅   |
| U6     | afterAll 打印命中率                              | **与计划不同（收敛）**：vitest bench 模式下 afterAll 不执行（实测两轮均无输出），改为 bench 任务内 `process.stdout.write` + label 去重；实测输出 `[bench] BM25 0.4 top@1 命中率: 80/80 = 100.00%`、`[bench] cosine 基线 top@1 命中率: 0/80 = 0.00%` | ✅   |
| U7     | `!` 降 ≥40%                                      | src 非空断言 **69 → 4 处**（降幅 94%）；剩余 4 处均在 `levenshtein` 滚动数组，附算法不变式证明注释（grep 实证 4 处）                                                                                                                                | ✅   |
| U8     | ingest 直测全分支                                | ingest-0.7 测试 7 项：空候选零副作用 / 敏感拒绝 / 窗口去重 / 窗口外不判重 / 字段组装+workspace / 超长截断 / workspace 缺省契约最小化；**ingest.ts 覆盖 100%**；load.test.ts 回归全绿                                                                | ✅   |
| U9     | 文档版本 0.7.0 无残留                            | package.json 0.7.0；README/ARCHITECTURE/CHANGELOG/本报告同步；`grep -rn "0.6.0.tgz" README.md docs/` 0 命中（文档内残留仅存于历史版本段落说明）；ARCHITECTURE 演进表含 0.7.0 列                                                                     | ✅   |

**全量门最终状态**：

| 门            | 实测                                                                               | 通过 |
| ------------- | ---------------------------------------------------------------------------------- | ---- |
| 测试          | **236 项全绿**（26 文件，0.6.0 基线 207 + 新增 29）                                | ✅   |
| 覆盖率        | lines 95.59 / branches 91.19 / functions 96.07 / statements 95.59（超阈值）        | ✅   |
| typecheck     | tsc --noEmit strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess 零错误 | ✅   |
| lint / format | eslint 9 零告警 / prettier 全一致                                                  | ✅   |
| build         | tsup ESM + d.ts 通过                                                               | ✅   |
| eval          | G1–G5 六门限全绿 + 报告生成（版本自动读取）                                        | ✅   |
| bench         | 8 项基准 exit=0 + `[bench]` 质量命中率输出                                         | ✅   |

**硬约束守护**：四工具签名 / `MemoryEntry` 契约 / `cordis.patch.yml` / 纯函数零外部依赖 —— 全程未改；既有 207 项测试逐项复证（236 全绿即含全部旧用例）。
