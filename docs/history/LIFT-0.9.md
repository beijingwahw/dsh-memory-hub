# dsh-memory-hub 全模块薄弱项升维（0.8.0 → 0.9.0）

> 定位：对 DEEP-AUDIT（七维度深度静态通读 × 动态探针）实锤的 **16 项薄弱项（P0×3 / P1×6 / P2×7）逐项闭环**，
> 以六个「前沿创新主题」为方法论——不是打补丁，而是把每个缺陷的根因用架构手段消灭。
> 版本：0.9.0（薄弱项深度闭环）｜许可证：MIT｜硬约束：9 项全程守护（见 §6）

---

## 1. 基线（0.8.0 终态，DEEP-AUDIT 实测）

| 维度   | 0.8.0 终态                                              | 0.9.0 要解决                             |
| ------ | ------------------------------------------------------- | ---------------------------------------- |
| 测试   | **294 项全绿**（31 文件）                               | 每项薄弱项都有专属测试锚定，探针全部转正 |
| 覆盖率 | lines **100** / branches **96.1** / functions 100       | 不降，且补齐项位（store.ts 93.13 → 100） |
| 薄弱项 | 16 项：B/J/Q（语义）、C/F/D/K/L/N（健壮/性能）、7 项 P2 | 16 项全部闭环                            |

DEEP-AUDIT 探测实验精选证据（0.8.0 实锤，0.9.0 已修复）：

| 探针  | 0.8.0 实测                                                  | 修复后                                                      |
| ----- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| B2    | conservative 单强词「务必使用 pnpm」→ **`[]` 未捕获**       | 裸「务必/一定」并入信号源 → 捕获且 kind=preference          |
| J1/J2 | 同一数据集 recall 不排除无 ws 条目、status 排除 → 语义相反  | 统一「未标注 ws = 全局共享」，两工具同数据同结论            |
| Q1    | 60 天前记忆 score = 1 天前的 **1/4000**，默认不可召回       | 默认 ttlDays=0 时**关闭评分衰减**，长期记忆真正可召回       |
| C1    | 同批两条同文候选 → **2 条入库**                             | 批内瞬时去重 → 1 条入库，rejectedDuplicate++                |
| F1    | `Use pnpm` + `for installs` → **`Use pnpmfor installs`**    | 词边界感知分隔 → `Use pnpm for installs`                    |
| N     | 每次召回 N 条 fire-and-forget 写 N 次，错误被 allSettled 吞 | 同 id 合并回写（抗刷），rejected 上浮 metrics.errors + 日志 |

---

## 2. 六个前沿创新主题（升维方法论）

| 主题                                           | 覆盖项               | 核心理念                                                      | 前沿性                                                     |
| ---------------------------------------------- | -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| T1 漂移免疫词法（Drift-proof Lexicon）         | B、M                 | 强度词分级**单一事实源**，正则/数组由词表编译派生             | 词表与消费者之间的漂移从「运行期 bug」变成「编译期不可能」 |
| T2 共享默认隔离（Shared-by-default Isolation） | J                    | 未标注 workspace = 全局共享；双捕获路径按 Agent 会话 cwd 溯源 | 多项目环境隔离语义唯一化，工具结果记忆首次获得真实归属     |
| T3 双尺度时间语义（Dual-timescale Scoring）    | Q                    | 评分衰减与 TTL 清理解耦：decay 可关闭 / 半衰期可注入          | 「永不过期」从"不删除"升级为"可检索"，默认零惩罚           |
| T4 写入路径工程化（Write-path Engineering）    | C、D、N              | 批内瞬时去重 + 捕获栅栏 + 热度合并回写                        | 写放大的三个源头（重复入库/卸载竞态/热度刷写）全部封堵     |
| T5 签名候选预筛（Signature Pre-screening）     | K、O                 | MinHash 从预留落地为真实剪枝；快照共享 + 写时重建             | 万级语料读路径零拷贝、语义兜底前先 O(K) 签名过滤           |
| T6 契约显式化（Contract Explicitness）         | E、G、H、A'、S、F、L | 死字段/死配置/死兜底逐一落地语义或去除冗余                    | 每个"看起来有效"的配置/字段/注释都有真实行为兑现           |

---

## 3. P0 三项（语义/正确性缺陷）逐项闭环

### B. 强度词表跨表漂移 → 单一信号源词法（T1）

- **根因**：`STRONG_HINTS` 含「务必/一定」但 `PREFERENCE_HINTS` 无裸词，`hits.length===0` 提前 return 使强度检查不可达。
- **0.9.0 落地**（`src/memory/capture.ts:36-86`）：`STRONG_TERMS`（含裸词「务必/一定」）为单一事实源；
  `STRONG_HINTS`/`BALANCED_STRONG_HINTS` 由词表 **join('|') 编译派生**；`PREFERENCE_HINTS` 由三级词表并集去重生成——词表与消费者永远同步。
- **语义变更**：conservative 修复裸「务必/一定」单强词漏记（B2 探针 `[]` → 捕获）；balanced/aggressive/off 行为零变化。
- **测试证据**：`test/upgrade-0.9.test.ts`：裸「务必使用 pnpm」→ 1 条 kind=preference；词表派生一致性断言；balanced 单词拒绝行为锚定。

### J. workspace 隔离语义分裂 → 共享默认 + 会话 cwd 溯源（T2）

- **根因**：engine 过滤"有值才比较"、status 严格相等、tools/result 捕获固定 `workspace: undefined` → 语义三处分裂。
- **0.9.0 落地**：
  - `src/tools/memory-status.ts:107`：`e.workspace === undefined || e.workspace === args.workspace`（未标注 = 全局共享，与 engine 对齐）；
  - `src/index.ts:250`：tools/result 捕获按 `exec.agent?.session?.header?.cwd` **溯源真实 workspace**；session/event 捕获沿用 `session.header.cwd`（index.ts:207）。
- **语义变更**：status 指定 workspace 时不再排除全局记忆；工具结果类记忆首次携带工作区归属。
- **测试证据**：同数据 recall 与 status 同结论；tools/result 经 exec mock 注入 cwd 断言；无 agent 回落 undefined 仍可入库。

### Q. 时间衰减不可配置 → 双尺度时间语义（T3）

- **根因**：decay 半衰期 7 天写死，默认 `ttlDays=0`「永不过期」下 60 天记忆 score 只剩 1/4000，实际不可召回。
- **0.9.0 落地**：`RecallOptions.decay?: boolean` 与 `decayHalfLifeMs?: number`（默认 `DECAY_HALF_LIFE_MS`=7d，engine.ts:458-460）；
  配置层 `recallDecayHalfLifeDays` **默认 0 = 关闭评分衰减**（与 ttlDays=0 哲学对齐），工厂追加可选第 6 参 `recallOverrides` 映射。
- **语义变更**：插件默认召回不再时间衰减（60 天记忆可召回）；显式配置 >0 恢复按天衰减；engine 纯函数默认仍 7d——eval G5 网格不受影响。
- **测试证据**：`decay:false` 时 60 天前与 1 天前同分；半衰期可注入数值断言；G5 默认组不劣回归。

---

## 4. P1 六项（健壮性/一致性/性能）逐项闭环

### C. 同批候选互不判重 → 两级去重（T4）

- `src/memory/ingest.ts:39-52`：循环外 `batchSeen: Set<string>`（content.trim() 精确键），批内重复 → `rejectedDuplicate++` 跳过，再走库内去重。
- **语义变更**：同批双候选同文只入库 1 条（C1 实锤 2→1）；指标 rejectedDuplicate 相应 +1。
- **测试证据**：双候选同文 → entries=1 + rejectedDuplicate=1；批内去重与库内去重叠加。

### F. 多块拼接粘连 → 词边界感知分隔（T6）

- `src/memory/text.ts:18-33`：`isWordChar` 判定，`out` 末字符与 `part` 首字符均为 ASCII word 字符（`[A-Za-z0-9_]`）时补一个空格。
- **语义变更**：英文单词跨块粘连被分隔；中文/标点边界逐字节不变（既有 `'甲乙'`、`'结果：共 12 条'` 等断言全部保持）。
- **测试证据**：`Use pnpm`+`for installs` → `'Use pnpm for installs'`；中文块不插空格；tool-result 递归边界生效。

### D. 卸载不等待捕获队列 → 捕获栅栏（T4）

- `src/index.ts:293-294`：dispose 顺序改为 clearInterval → disposers → **`await captureChain`**（链尾 promise，等排空）→ `await store.close()`。
- **语义变更**：卸载瞬间在途捕获不再撞已关闭的 store（丢写竞态消除）；既有卸载断言（移除监听后 emit 不入库）保持。
- **测试证据**：`test/index-lifecycle-0.8.test.ts` D 项：注入慢速 upsert 验证「upsert → close」严格顺序，事件风暴后立即 dispose 无错误、metrics.errors 不虚增。

### K. MinHash 空转 → 签名候选预筛（T5）

- `src/memory/engine.ts:107,480`：语义兜底分支前置 **MinHash 预筛**——仅当查询特征集 > `MINHASH_K`（大查询，精确比对 O(|Q|) 贵于签名 O(K)）时启用；
  `minhashCoverage(querySig, docSig) < MINHASH_PRESCREEN_THRESHOLD`（= 覆盖率阈值×2/3 的保守下界）→ 跳过精确 featureCoverage。
- **语义变更**：预筛**只剪枝不相干文档**，通过预筛者仍走精确覆盖率 ≥0.45 评分（评分语义不变）；小查询路径零变化（旧 engine/语义测试全部不受影响）。
- **测试证据**：大查询（≥17 特征）不相干文档被剪、真实语义候选保留；预筛前后召回集一致性抽查；阈值常量导出。

### L. autoTags 死配置 → 自动标签开关（T6）

- `src/memory/capture.ts:119,128-129,150`：三个提取函数追加尾参 `autoTags: boolean = true`；`false` 时候选 `tags: []`（自动标签全部清空）；插件入口传入 `cfg.autoTags`。
- **语义变更**：`autoTags:false` 从摆设变为有效；`true`（默认）行为逐字节不变。
- **测试证据**：false 三路径（preference 命中 / 工具长输出 / 助手结论摘要）tags=[]；index 层配置传递；默认 true 回归。

### N. recall 热度 fire-and-forget → 合并回写 + 错误上浮（T4）

- `src/tools/memory-recall.ts:67-75,146`：`heatDirty: Map<id, MemoryEntry>`（同 id 覆盖合并，**抗刷**）+ `heatChain` 串行 flush 链；
  flush 取 batch → `Promise.allSettled` → **rejected 计入 `metrics.errors` + logger**（不再吞错）。
- **语义变更**：同一 id 在窗口内多次 recall 只写一次（accessCount 只 +1）；错误可观测。
- **测试证据**：spy store 两次 recall 同 id → upsert 仅 1 次；flush 失败 → metrics.errors++；不同 id 各写一次；score 仍不落盘。

---

## 5. P2 七项（维护性/一致性/性能细节）逐项闭环

| 编号 | 位置                        | 0.9.0 落地                                                                                                                                | 测试证据                                                                                       |
| ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| E    | `store.ts:118-133`          | `.corrupt` 幂等留证：先读已有行 Set 去重，只 append 未记录行；读失败仍追加（证据优先）                                                    | 两次 open 同一损坏行文件 → .corrupt 行数不增                                                   |
| G    | `importer.ts:184-197`       | `inferSpeakerKind(text, isUser)` 正式消费 isUser：用户句保持高置信推断；助手句偏好信号降为 `generic`、指令信号保持 `instruction`          | 用户句「记住要用 pnpm」→ preference；助手复述 → generic；助手「永远不要提交密钥」→ instruction |
| H    | `memory-forget.ts:13,40-42` | `strict?: boolean` 可选严格遗忘：未命中且 strict → 抛 `MemoryHubError(NOT_FOUND)`（错误码首次真实使用）；默认路径不变                     | strict=true 未命中 → NOT_FOUND；strict=false → `{removed:false}` 回归                          |
| M    | `importer.ts:197`           | `inferKindWithMode(text, mode)` 三档推断强度落地：conservative 仅强信号判 kind；balanced（默认）= inferKind 现状；planImport 文档分支消费 | 三档同文本 kind 断言；默认 balanced 行为不变                                                   |
| A'   | `memory-recall.ts:19`       | `kind` 参数增 `enum: [5 值]`，删除手工校验——非法 kind 由 dsh-tools 框架前置抛 `ToolArgsError`，与 memory_store 同形态                     | 非法 kind → ToolArgsError（消息含 'must be one of'）；5 种合法 kind 正常执行                   |
| O    | `store.ts:51,154-158`       | `snapshots()` 零拷贝：直接返回共享缓存引用；写操作置 dirty → 下次访问重建（copy-on-write）；接口注释声明只读约束                          | 多次 list 同引用（零拷贝）；写后外部旧引用修改不影响新 list                                    |
| S    | `engine.ts:641`             | `SIGNIFICANCE_KIND[kind]` 揭示 `?? 1` 兜底，由 Record 全键 + MemoryKind 联合在**编译期**拦截未来漂移                                      | 5 kind × 2 source 数值锚定测试；tsc 类型层保证                                                 |

---

## 6. 硬约束全量映射（9 项 × 16 项，全部满足）

| 硬约束                        | 受影响项   | 保障手段                                                                        | 结果                          |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------- | ----------------------------- |
| 四工具签名不变                | J/A'/H/N/Q | 仅内部逻辑/尾参可选/schema enum 收窄；name/execute/render 逐字节不变            | ✅                            |
| MemoryEntry 契约不变          | 全部       | 不增删字段；热度 bump 仍显式重建契约字段                                        | ✅                            |
| cordis.patch.yml 安装方式不变 | 全部       | 未触碰                                                                          | ✅                            |
| 零新增依赖                    | 全部       | 仅 node 内置模块                                                                | ✅                            |
| 旧测试 294 项全绿             | 全部       | 语义兼容设计 + 全量回归                                                         | ✅（324 全绿）                |
| 覆盖率不降                    | 全部       | 新逻辑全量新增测试，store.ts 93.13 → 100                                        | ✅（100 / 97.87 / 100 / 100） |
| 渲染/错误码逐字节不变         | J/A'/H/F   | render 函数与既有错误码常量零改动；errors-0.7 / text-0.7 / 工具渲染专场断言全绿 | ✅                            |
| eval G1–G5                    | Q/K        | G5 网格不注入 decay（默认不变）；预筛阈值保底 G3                                | ✅ 六门限全绿                 |
| bench                         | K/O        | 剪枝/零拷贝为正收益                                                             | ✅ 通过，BM25 top@1 100%      |

---

## 7. 0.9.0 实测结果（对比 0.8.0）

| 门                    | 0.8.0             | **0.9.0 实测**                                                                                             | 结论          |
| --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------- |
| 测试                  | 294 项（31 文件） | **324 项全绿**（32 文件，新增 30：upgrade-0.9 专场 14 + store-fault 6 + index-lifecycle 2 + 细化 8）       | ✅ 探针全转正 |
| lines                 | 100               | **100**（15 src 文件全 100）                                                                               | ✅            |
| branches              | 96.1              | **97.87**（738/754；index 84.06 / recall 92.11 为防御兜底残余）                                            | ✅ 升         |
| functions             | 100               | **100**                                                                                                    | ✅            |
| statements            | 100               | **100**                                                                                                    | ✅            |
| typecheck/lint/format | 全绿              | **全绿**（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess；eslint 9 零告警；prettier 全库） | ✅            |
| eval                  | G1–G5 六门限      | **六门限全绿**（G1 recall@1=1.0 / G2 1.0 / G3 1.0 / G4 1.0 / G5 27 组合网格全不劣）                        | ✅            |
| bench                 | 8 项对比通过      | **8 项全过**，BM25 top@1 命中率 100%（80/80）                                                              | ✅            |

## 8. 交付

- 报告：`docs/LIFT-0.9.md`（本报告）、`docs/QUALITY-0.9.md`（质量门实测明细）；
- 安装：`npm pack` 产出 `dsh-memory-hub-0.9.0.tgz`，`dsh plugin --profile web add ./dsh-memory-hub-0.9.0.tgz`；
- 归档：zip 含 tgz + 双报告，与原 0.5–0.8 交付形态一致。
