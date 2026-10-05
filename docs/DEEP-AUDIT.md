# dsh-memory-hub 全模块薄弱项深度分析（0.8.0 终态审计）

> 定位：对插件**全部模块**（入口/配置/错误 3 文件、memory 七子模块、tools 四工具）做七维度深度审计，
> 识别 0.8.0 升维（LIFT-0.8，294 项测试、lines 100 / branches 96.1）**之后仍然存在的真实不足**。
> 已闭环项（L1–L15）不在本报告重复，仅在与新发现交叉处标注边界。
>
> 方法：全源码逐行静态通读 × 探针实验动态验证 × check 全链/覆盖率复算复核（21:41–21:43 实测）。
> 版本口径：0.8.0（package.json）｜许可证：MIT

---

## 1. 审计基线（本轮实测，与 0.8.0 冻结一致）

| 维度       | 实测                                                                             | 说明                                                   |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 源码       | 15 文件 **2368 行**（含配置与错误，无遗漏）                                      | `src/` 全量通读                                        |
| 测试       | **294 项全绿**（31 文件）                                                        | `npm run check` 全链通过（typecheck+lint+format+test） |
| 覆盖率     | lines **100** / branches **96.1** / functions 100 / statements 100               | v8 provider 复算                                       |
| 未覆盖分支 | index.ts 85.07（43,92-93,114,200-202,212,231-234）、store.ts 93.13、recall 84.37 | 均为防御兜底行，见 §6 边界                             |

七维度审计口径：**正确性 / 健壮性 / 性能 / 可观察性 / 类型安全 / 测试深度 / 维护性**。

---

## 2. 探测实验证据（static 读码 → 动态验证，剔除误报）

| #   | 探针                                | 输入构造                           | 实测输出                                                                              | 判定                                             |
| --- | ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A1  | `memory_store` 非法 kind            | `{kind:'not-a-kind', content:'x'}` | `ToolArgsError: invalid arguments: "kind" must be one of [5 值]`，`stored kinds = []` | **排除**：dsh-tools schema enum 前置拦截，非缺陷 |
| B1  | conservative `务必...` 句           | `务必把所有日志写到统一目录`       | 命中 preference，入库                                                                 | **放行（但见 B2 反例）**                         |
| B2  | conservative 单强词 `务必使用 pnpm` | 仅含"务必"，无 PREFERENCE_HINTS 词 | **返回 `[]`，未捕获**                                                                 | **实锤 B**：STRONG_HINTS 单独出现失效            |
| B3  | conservative `一定不要漏掉这个配置` | 含"不要"                           | 命中入库                                                                              | 与 B2 对照：靠"不要"规避                         |
| B4  | balanced `一定不要漏掉这个配置`     | 同句，balanced 模式                | **返回 `[]`**                                                                         | 同句两模式决策相反，词汇表语义漂移               |
| C1  | 同批候选互相重复                    | 同 content 两条候选                | **2 条入库**，id 尾缀不同（cb3/038）                                                  | **实锤 C**：same-batch 去重缺失                  |
| F1  | 多文本块拼接                        | `Use pnpm` + `for installs`        | **`Use pnpmfor installs`**（无分隔粘连）                                              | **实锤 F**：拼接丢语义                           |
| R1  | recall 非法 kind                    | `{kind:'not-a-kind'}`              | `MemoryHubError: invalid kind`                                                        | 与 store 错误类型不一致（观察点）                |
| Q1  | 时间衰减数值                        | 同文 1 天前 vs 60 天前             | score **0.21732 vs 0.00005**（≈4000×）                                                | **实锤 Q**：默认"永不过期"下 60 天记忆不可召回   |
| J1  | workspace 过滤                      | ws=ws-x 查询，含一条无 ws 条目     | **无 ws 条目 b 未被过滤，一并召回**                                                   | **实锤 J**：queryIndex 不排除无 ws 条目          |
| J2  | status workspace 过滤对照           | 同数据走 `===` 过滤                | 仅 a 保留，无 ws 条目被排除                                                           | **两工具语义相反**（同数据不同结果）             |

---

## 3. 实锤薄弱项清单（按优先级）

### P0 — 语义/正确性缺陷（建议 0.9.0 必修）

#### B. 强度词表与信号词表漂移：`STRONG_HINTS` 的"务必/一定"实际失效

- 位置：`src/memory/capture.ts:24-64`
- 事实：`STRONG_HINTS=/务必|一定|永远|始终|never|always/`（注释称 conservative **命中单个即放行**），
  但 `capture.ts:105-106` 先执行 `PREFERENCE_HINTS.filter(...)`，`hits.length===0` 时**提前 return**，
  强度词检查（`capture.ts:109`）根本不会运行。而 `PREFERENCE_HINTS` 数组内仅有"请务必""请一定"（带"请"），
  无裸词"务必/一定"。
- 后果：**单独出现"务必/一定"的强指令句在 conservative 下不捕获**（探测 B2 实测 `[]`）；
  而 balanced 模式（`BALANCED_STRONG_HINTS` 无"务必/一定"）对同一句也拒绝（探测 B4），
  同一语义在两种模式决策相反，且与文件内注释承诺直接矛盾。
- 影响面：用户"务必/一定"类高置信指令漏记 → 召回链路缺失 → 后续会话丢失关键偏好/规则。
- 建议：把裸词"务必/一定"并入 `PREFERENCE_HINTS`（或把 STRONG 检查提前到空命中守卫之前；
  二选一，保持 0.8.0 行为等价约束下改为**新增**捕获面，旧测试全部保持）。

#### J. workspace 隔离语义不一致：recall 不排除无 ws 条目，status 却排除

- 位置：`src/memory/engine.ts:421`（`if (options.workspace && entry.workspace && entry.workspace !== ...) continue`）
  vs `src/tools/memory-status.ts:104`（`e.workspace === args.workspace`）
- 事实：engine 的过滤条件是 `entry.workspace` 有值才比较 → **无 workspace 的记忆在指定 workspace 召回时不会被排除**；
  status 用严格相等 → 无 ws 条目被排除。同一数据集两个工具产生**相反结论**（探测 J1/J2 实测）。
- 更隐蔽的成因：`src/index.ts:241` 的 tools/result 捕获**固定传 `workspace: undefined`**，
  而 session/event 捕获传 `session.header.cwd`（`index.ts:196`）→ 工具结果类事实记忆**永远没有 workspace**，
  在按 workspace 隔离的多项目环境中会被任意项目召回（如果按引擎语义），或被 status 统计漏掉（按 status 语义）。
- 影响面：多工作区隔离失效或统计失准，语义分叉。
- 建议：统一语义为"未标注 ws 的记忆视为全局共享"（引擎现状），status 侧改为 `e.workspace === undefined || e.workspace === args.workspace`；
  或二选一方向并在工具 description 中明示。

#### Q. 时间衰减不可配置，与默认"永不过期"（ttlDays=0）冲突

- 位置：`src/memory/engine.ts:444-445`（`decay = exp(-ageMs / 7d)`），`config.ts:49`（`ttlDays: 0`）
- 事实：decay 半衰期 **7 天写死**，`RecallOptions` 无 decay 开关；默认配置 `ttlDays=0` 宣称"永不过期"，
  但 60 天前记忆 score 只剩 1 天前的 1/4000（探测 Q1：0.21732 vs 0.00005），
  在 `limit=8 / maxTokens=800` 裁剪下**实际不可召回**——"永不过期"只是"不删除"，不是"可检索"。
- 影响面：默认配置下长期记忆名存实亡；`ttlDays` 与 decay 双重时间惩罚叠加，用户无法关闭降温。
- 建议：`RecallOptions` 增加 `decay?: boolean`（或 `decayHalfLifeMs`），`ttlDays=0` 时默认关闭 decay；
  保持 0.8.0 语义时默认值不变，仅新增可选项。

### P1 — 健壮性/一致性/性能缺陷（建议修复）

#### C. `ingestCaptured` 同批候选互相重复不检测（same-batch 去重缺失）

- 位置：`src/memory/ingest.ts:36-60`
- 事实：`existing` 是入参 `store.list()` 的**一次性快照**，同批 `cands` 之间的重复不互检；
  两条相同 content 会生成不同 id（contentHash+随机后缀，`ingest.ts:48`）并**双写入库**（探测 C1：entries=2）。
- 影响面：多候选入口（未来扩展 / 批量捕获 / 用户工具链调用）产生重复记忆，挤占去重窗口后的召回空间。
- 建议：循环内维护批内 `seen` Set（参考 `importer.ts` 的 `push` 幂等写法），先批内去重再查库。

#### F. `extractTextBlocks` 多块拼接无分隔符，英文文本粘连

- 位置：`src/memory/text.ts:17-19`
- 事实：`out += b` 直接拼接，块间无空格/换行 → `Use pnpm` + `for installs` 变 `Use pnpmfor installs`（探测 F1）。
- 影响面：助手消息/工具结果多块内容入库后语义被破坏，tokenize 切词错误（`pnpmfor` 成词），召回精度下降。
- 建议：数组内联按项后以块间分隔（如按原块类型补 `\n` 或 ` `），需保证 0.7.0 提取去重语义（trim）不回归。

#### D. 卸载（dispose）不等待捕获队列，在途捕获存在丢写竞态

- 位置：`src/index.ts:161-188`（captureChain/pendingCaptures）与 `271-284`（dispose）
- 事实：dispose 只 `clearInterval` + 触发 disposers + `await store.close()`；
  **从未 `await captureChain`**。若卸载发生在事件风暴后、队列尚有 in-flight 任务时，
  队列任务的 `ingestCaptured → store.upsert` 可能撞上已关闭的 store（`STORE_CLOSED`）或写入半途。
- 影响面：卸载瞬间最后几条记忆丢失或报错，指标 `errors` 虚增；orca 热重载场景可复现。
- 建议：dispose 首段先移除事件监听，随后 `await captureChain` 再 `close()`；
  注意 `captureChain` 为链式 Promise，捕获引用后等待即可（同类 wait-for-chain 模式）。

#### K. MinHash 全量计算但查询路径从未使用：无效开销 + 文档承诺未兑现

- 位置：`src/memory/engine.ts:355`（buildIndex 逐条算 minhash）、`queryIndex`（388-484，遍历全 tf 未见剪枝）
- 事实：`minhashSignature / minhashJaccard / minhashCoverage` 只有独立测试引用，
  `queryIndex` 实际使用**精确特征集**（`features` + `featureCoverage`）做语义兜底，
  MinHash 签名从未参与任何候选剪枝——每条目 16 维 FNV 哈希是**纯浪费**，
  且 `engine.ts:107-112` 注释承诺"签名随索引缓存，用于快速候选剪枝"与实现不符。
- 影响面：万级语料下 buildIndex 多 ~16×N 次哈希运算，无任何收益；维护者按注释预期可剪枝会踩空。
- 建议：二选一——真实接入剪枝（minhash 近似过滤后再精确评分，需评估与 0.5.0 召回等价的边界），
  或移除 minhash 计算与导出（破坏面小但需同步删测试与文档），或明示"签名仅作未来预留"。

#### L. `autoTags` 是死配置：schema 存在、无任何消费点

- 位置：`src/config.ts:32,47,81`（定义/默认/schema）；grep 全 src **零消费**
- 事实：`capture.ts` 的候选 tags 硬编码 `['auto','preference']` 等，`ingest.ts` 原样透传 `cand.tags`；
  `cfg.autoTags`（"自动为捕获内容打标签"）从未被读取——用户配置 `autoTags:false` 无效。
- 影响面：配置面板出现"看起来有效"的开关，实为摆设；维护成本 + 用户困惑。
- 建议：实现消费（`autoTags:false` 时清空自动 tags）或从 schema/文档移除并在 CHANGELOG 声明。

#### N. recall 热度回写 fire-and-forget：写放大 + close 后错误被 allSettled 吞掉

- 位置：`src/tools/memory-recall.ts:126`（`void Promise.allSettled(hits.map(h => store.upsert(bumped(h))))`）
- 事实：每次召回命中 N 条即 fire-and-forget N 次 upsert → 每次 append N 行 + `version++`；
  高频 recall 下 JSONL 行数持续膨胀（热度行无端增多，触发更频繁 compact）；
  若恰逢 close，upsert 抛 `STORE_CLOSED` 被 `allSettled` 静默吞掉，**metrics.errors 不递增、无日志**。
- 影响面：存储写放大（行数虚增）、卸载窗口错误不可观测。
- 建议：热度更新限流/合并（同 id 只写一次），并将 allSettled 结果中 rejected 计入 `metrics.errors` + logger。

### P2 — 维护性/一致性细节（低成本改善）

| #   | 位置                                                        | 事实                                                                                                                     | 建议                                                                              |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| E   | `store.ts:117-127`                                          | `.corrupt` 审计注释称"幂等追加"，实现 `appendFile` 无幂等保护——损坏行每次加载都会**重复追加**进审计文件（行数×重启次数） | 按文件内已隔离行做去重（读现有内容比对，或按行哈希），并修订注释                  |
| G   | `importer.ts:62-63,142-156`                                 | `SessionTextResult.isUser` 提取后**从未被消费**（死字段）；kind 推断 `inferKind` 不看说话者身份                          | 在 `planImport` 中按 isUser 加权 kind（用户句可提 instruction），或删除字段并简化 |
| H   | `errors.ts:21`                                              | `NOT_FOUND` 错误码定义但全源码无使用（forget 以 `{removed:false}` 表达未命中，属合理设计）                               | 删除错误码，或为 forget 补可选的严格模式（抛 NOT_FOUND），文档注明                |
| M   | `importer.ts:33-34`                                         | `ImportOptions.mode` 注释"预留，当前不影响推断规则"——死配置                                                              | 落地 mode 语义或移除字段，避免"半成品配置"                                        |
| A'  | `tools/memory-store.ts:17-19` vs `memory-recall.ts:113-120` | 非法 kind 两工具错误形态不同：store 抛框架 `ToolArgsError`（schema 拦截）、recall 抛 `MemoryHubError`                    | 统一错误契约（recall 侧改 schema enum 或 store 侧补显式校验），错误码可归类       |
| O   | `store.ts:132-138` + `ingest.ts:36`                         | 每次 `list()` 全量 `[...snapshotCache]` 拷贝；每次捕获都 O(N) 全表拷贝 + isDuplicate O(N) 窗口扫                         | 万级库时捕获路径 O(N) 每事件；可对 ingest 用增量去重键（内容哈希前缀索引）减压    |
| S   | `engine.ts:592-618`                                         | `significanceWeight` 对 kind 缺失走 `?? 1` 兜底，与 `SIGNIFICANCE_KIND` 全键声明并存                                     | 类型上已由 `MemoryKind` 收紧，`?? 1` 属冗余兜底；可移除并加注释（轻微）           |

---

## 4. 模块 × 维度汇总

| 模块（文件）             | 正确性               | 健壮性         | 性能                                | 可观察性       | 类型安全 | 测试深度                        | 维护性                                 |
| ------------------------ | -------------------- | -------------- | ----------------------------------- | -------------- | -------- | ------------------------------- | -------------------------------------- |
| `index.ts`（入口）       | —                    | **D** 卸载竞态 | —                                   | —              | ✅       | 85.07 分支（防御行）            | —                                      |
| `config.ts`              | —                    | —              | —                                   | —              | ✅       | ✅ 100                          | **L** autoTags 死配置 / **M** 预留字段 |
| `errors.ts`              | —                    | —              | —                                   | —              | ✅       | ✅                              | **H** NOT_FOUND 未用                   |
| `memory/capture.ts`      | **B** 强度词失效     | —              | —                                   | —              | ✅       | 95.83（119,165 防御行）         | 词汇表重复易漂移                       |
| `memory/engine.ts`       | **Q** 衰减不可关     | —              | **K** MinHash 空转；**O** O(N) 路径 | —              | ✅       | ✅ 100                          | minhash 注释与实现不符                 |
| `memory/importer.ts`     | —                    | —              | —                                   | —              | ✅       | ✅ 100                          | **G** isUser 死字段                    |
| `memory/ingest.ts`       | **C** 批内去重缺失   | —              | **O** 每事件 list()                 | —              | ✅       | ✅ 100                          | —                                      |
| `memory/metrics.ts`      | —                    | —              | —                                   | ✅             | ✅       | ✅ 100                          | —                                      |
| `memory/store.ts`        | —                    | 容错路径完善   | 行膨胀（N 联动）                    | —              | ✅       | 93.13（防御行）                 | **E** corrupt 追加非幂等               |
| `memory/text.ts`         | **F** 拼接无水隙     | —              | —                                   | —              | ✅       | ✅ 100                          | —                                      |
| `memory/types.ts`        | —                    | —              | —                                   | —              | ✅       | ✅ 100                          | —                                      |
| `tools/memory-recall.ts` | —                    | —              | **N** 写放大                        | **N** 错误被吞 | ✅       | 84.37（48-49,91,96,111 防御行） | **A'** 错误形态不一致                  |
| `tools/memory-store.ts`  | —                    | —              | —                                   | —              | ✅       | ✅ 100                          | **A'**                                 |
| `tools/memory-status.ts` | **J** 与引擎语义相反 | —              | —                                   | ✅             | ✅       | ✅ 96                           | —                                      |
| `tools/memory-forget.ts` | —                    | —              | —                                   | —              | ✅       | 87.5（36 防御行）               | **H** 关联                             |

合计：**P0 × 3（B/J/Q）、P1 × 6（C/F/D/K/L/N）、P2 × 7（E/G/H/M/A'/O/S）**。

---

## 5. 与 LIFT-0.8 的边界（不重复项说明）

- L1–L4（index 生命周期/错误路径/背压/定时器测试）：已闭环——本轮 **D** 是 L1 未覆盖的**新角度**
  （dispose 不等待 captureChain，与 close 失败测试正交）。
- L11（强度词提取共享常量）：已把两处 STRONG 词表收敛为共享常量——本轮 **B** 是更深一层：
  共享的只是"表内一致性"，`PREFERENCE_HINTS` 与 `STRONG_HINTS` **跨表内容漂移**未处理。
- L9/L10/L13–L15（守卫分支/容错/断言清零）：已闭环，本轮未复述。
- 未覆盖分支（index 85.07 / store 93.13 / recall 84.37 等）经 coverage-final 逐行核验均为**防御兜底行**
  （并行注册失败、移除容错、render 缺省值等），与 LIFT-0.8 结论一致，不计为独立薄弱项。

---

## 6. 建议的排期与验收口径（0.9.0 候选）

| 批次               | 项                                     | 验收口径建议                                                                                                                                             |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一批（语义 bug） | B / J / Q                              | 新增探针测试：裸"务必"句 conservative 命中；无 ws 条目按统一语义过滤（构造 recall 与 status 同数据同结果断言）；decay 关闭选项单测 + 60 天记忆可召回断言 |
| 第二批（一致性）   | C / F / D                              | 批内去重测试（双候选同文 → 1 条）；多块拼接含空格断言；dispose 等待 captureChain 的时序测试（注入慢 store）                                              |
| 第三批（清理）     | K / L / N / E / G / H / M / A' / O / S | 各自单测/文档同步；`npm run check` + `test:coverage` 不降，纯函数零外部依赖立场不变                                                                      |

> 硬约束复述（同 LIFT-0.8 §3，本审计结论不改变）：四工具签名、`MemoryEntry` 契约、`cordis.patch.yml`
> 安装方式、纯函数零外部依赖、旧测试全绿、覆盖率不降——本报告全部建议均在该约束内可落地。

---

## 7. 结论

0.8.0 在**测试深度、类型安全、可观测计数**上已达到生产级（294 tests / 100·96.1·100 / 全链门禁）。
但静态通读 + 动态探针发现三类**真实语义缺口**仍存在：

1. **捕获面**：强度词"务必/一定"因跨表漂移在 conservative 下失效，高置信指令存在系统性漏记（B）；
2. **隔离面**：workspace 过滤两工具语义相反且工具结果类记忆永远无 ws（J），多项目隔离名存实亡；
3. **时间语义**：默认 ttlDays=0"永不过期"与写死的 7 天 decay 冲突，长期记忆实际不可召回（Q，数值证据 1/4000）。

另有 6 项 P1（批内去重、文本拼接、卸载竞态、MinHash 空转、autoTags 死配置、热度写放大）与 7 项 P2 细节。
上述 16 项全部可经"新增测试 + 行为等价重构"在 0.9.0 内闭环，不破坏任何既有契约。
