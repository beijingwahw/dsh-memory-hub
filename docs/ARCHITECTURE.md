# dsh-memory-hub 架构设计说明

> DeepSeek Harness 插件 — 智能会话记忆中心
> 版本：1.0.0（本地优先 · 前沿工程化 · 记忆生命周期与冲突感知（supersede）· 双引擎混合检索（RRF）· 统一内容指纹去重 · 可观测性升维 · 评估门禁 G1-G8 全绿）｜语言：TypeScript｜许可证：MIT

---

## 0. 版本演进（0.1.0 → 1.0.0）

| 维度 | 0.1.0 | 0.2.0 | 0.3.0（上轮） | 0.4.0（世纪级升级） | 0.5.0（深度创新） | 0.6.0（真实数据接入） | 0.7.0（世界级质量升级） | 0.8.0（全模块薄弱项升维） 0.9.0（薄弱项深度闭环） 0.10.0（真实数据接地） 1.0.0（世纪升维，见 DESIGN-1.0） |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ --- |
| 检索引擎 | 集合 Jaccard（无词频/IDF） | **TF·IDF 倒排索引 + cosine**，稀有词提权、词频加权，评分基准可注入（可复算） | **`IndexCache` 倒排索引缓存**：按存储 `revision` 复用，语料未变召回免全量重建；`isDuplicate` 精确短路 + 长度窗口预筛 | **Okapi BM25（k1=1.2, b=0.75）**：词频饱和 + 文档长度归一化，长尾文档不再压过精炼记忆；查询/索引 NFKC 规范化 + 英文停止词；`IndexCache` 增加**内容指纹**（sha256）双重失效判定（热度更新复用、内容变化才重建） | **A1 容错检索**（编辑距离 ≤1 变体 ×0.5 兜底）+ **A2 语义召回**（字符 3-gram + MinHash 签名缓存 + 精确覆盖率 0.3 权重）+ **A3 价值感知**（kind×source 权重）+ **A4 热度生命周期**（半衰期指数冷却/复活），全部为 `RecallOptions` 可注入 | 不变（0.5.0 已达标） | 不变（0.5.0 已达标） | 不变（0.5.0 已达标）；engine 防御分支闭环（18 处守卫直测）+ 三类不可达死代码经不变式证明移除（branches 100%） 不变（0.5.0 已达标）；**MinHash 签名预筛落地**（大查询先 O(K) 签名剪枝再精确评分，小查询零变化）；significanceWeight 兜底移除改由 Record 全键在编译期拦截 | 不变（0.9.0 已达标）；**G6 真实数据门复用同一引擎口径**（planImport 入库真实语料 → IndexCache.query 召回），无引擎改动即通过真实数据验证 |
| 数据接入 | —（仅事件捕获） | — | — | `exportAll()` 迁移闭环（与 `importAll` 对称） | — | **真实数据导入层**（`importer.ts`）：Markdown 记忆文档切块 + 会话 JSONL 宽容解析 + `imp-` 内容哈希幂等 id + kind 信号词推断；插件可选配置 `importSources` 启动导入，失败仅告警 | 不变（0.6.0 已达标）；文本文块提取归一至 `text.ts` 唯一实现、捕获入库管线拆出 `ingest.ts` 独立可测 | 不变（0.6.0 已达标）；importer 非对象 JSON 行、`toMemoryEntry` 可选字段拷贝分支补齐 不变（0.6.0 已达标）；**说话者感知分类**（`inferSpeakerKind`：isUser 消费，助手复述偏好降 generic、指令保持）+ **mode 三档推断强度**（`inferKindWithMode`，ImportOptions.mode 落地，默认 balanced 零变化） **G6 真实数据门（0.10.0）**：真实官方文档快照（Node.js v26.10.0 path/os）经**生产同路径** `planImport` 入库——评估验证的是"插件对接真实数据"而非合成语料自证 |
| 存储 | 全量重写 O(n) | **append-only（O(1) 追加）+ tombstone 逻辑删除 + compact 原子重建**，写失败内存回滚 | **先落盘后入内存**（读者只见已确认状态，写失败零残留）；**快照缓存**（list 热路径 O(N) 拷贝）；**`removeMany` 批量删除**；`revision` 版本号 | **损坏行隔离留证**（跳过时备份原文至 `<file>.corrupt`，失败仅告警）；**compact 自检**（重建后重读行数核对）；**`exportAll()` 迁移闭环**（与 `importAll` 对称，跨设备导出/导入无色差） | 不变（0.4.0 已达标） | 不变（0.4.0 已达标） | 不变（0.4.0 已达标）；compact 写失败 / 自检 mismatch / 自检读失败 / 隐私 chmod 失败**四类容错路径故障注入直测**（store-fault-0.8） **零拷贝快照**（`snapshots()` 返回共享引用 + 写置脏后写时重建，读路径 O(1)）；**`.corrupt` 幂等留证**（重启不重复追加；store branches 93.13 → 100） |
| 可观测性 | 仅字符串日志 | —（无运行指标） | **`HubMetrics` 十项指标**（捕获/存储/召回命中/遗忘/敏感拒绝/去重拒绝/清理/丢弃/错误）；`memory_status` 输出 `metrics` + `diagnostics`；卸载汇总日志 | 不变（0.3.0 已达标） | 不变（0.3.0 已达标） | 不变（0.3.0 已达标）；导入统计（planned/short/sensitive/corrupt）经 `log.info` 输出 | 不变（0.3.0 已达标）；**工具输出契约白盒化**：四工具 `render` 全分支直调单测（函数覆盖 71.42 → 100），输出可断言 不变（0.3.0 已达标）；**recall 热度回写错误上浮**（flush 失败计 `metrics.errors` + logger，不再被 allSettled 吞）；strict 遗忘抛 NOT_FOUND（错误码首次消费） |
| 捕获行为 | 事件并发无背压 | promise 链串行捕获队列（失败续链、不风暴） | **有界背压队列**（上限 256，洪水丢早期任务计 `dropped`），内存永远有界 | 不变（0.3.0 已达标） | 不变（0.3.0 已达标） | 不变（0.3.0 已达标） | 不变（0.3.0 已达标）；队列背压 256 边界（260 事件恰好 256 入库、越限即丢）与捕获失败链不中断真实驱动 不变（0.3.0 已达标）；**批内瞬时去重**（双候选同文 → 1 条 + rejectedDuplicate++）；**dispose 捕获栅栏**（await captureChain 排空后再 close，卸载竞态消除） |
| 数据契约 | 运行时无守卫；recall 热度更新把 `score` 落盘 | `isMemoryEntry`/`parseMemoryEntry`/`toMemoryEntry` 守卫；热度更新显式 pick 契约字段 | 契约不变（must）；`MemoryStore` 新增成员均为**可选**（`removeMany?`/`revision?`/`diagnostics?`），自定义实现向后兼容 | 契约不变（must）；`MemoryStore` 新增 `exportAll?` 可选成员，既有可选成员语义不变，自定义实现仍向后兼容 | 契约不变（must）；`RecallOptions` 新增 A1-A4 开关与参数均为可选注入 | 契约不变（must）；`MemoryHubConfig` 新增 `importSources?` **可选**配置键（默认空对象，未配置零行为变化） | 不变（must）；四工具签名 / `MemoryEntry` 契约 / `cordis.patch.yml` 全程未动（0.8.0 复证对象） 不变（must）；`RecallOptions` 新增 `decay`/`decayHalfLifeMs`（默认关闭/7d 显式化）、`memory_forget` 新增可选 `strict`（默认 off，渲染/契约零变化） |
| 捕获安全 | 敏感过滤可被全角/异体绕过 | **NFKC 归一化 + 小写折叠**；新增 AWS/GitHub/Slack/GCP 模式；显式记忆也拒绝敏感明文 | 不变（0.2.0 已达标） | 不变（0.2.0 已达标） | 不变（0.2.0 已达标） | 不变（0.2.0 已达标）；**导入内容同样过敏感拦截与短块丢弃**（离线批量不绕过隐私防线） | 不变（0.2.0 已达标） 不变（0.2.0 已达标）；**autoTags 配置正式消费**（false 清空自动标签，死配置变真实开关） |
| 召回能力 | 无过滤参数 | — | `memory_recall` 新增可选 `kind` 过滤（decision/fact/preference/instruction/generic） | 不变（0.3.0 已达标）；查询规范化使全角用户输入也可命中半角记忆 | 不变（0.3.0 已达标） | 不变（0.3.0/0.5.0 已达标）；导入的真实记忆直接进入 BM25/容错/语义/热度/价值全评分链路 | 不变（0.3.0/0.5.0 已达标） 不变（0.3.0/0.5.0 已达标）；recall `kind` 参数 schema enum 收紧（非法 kind 统一 `ToolArgsError`，与 store 同形态） |
| 错误处理 | 错误无分类、部分吞没 | `MemoryHubError` + 稳定错误码；存储非 ENOENT 读取错误不再吞没 | 写失败统一 `STORE_WRITE_FAILED`（修复 append 失败未包装问题）；compact 失败仅告警不反噬已成功写入 | 损坏隔离/compact 自检/迁移失败等新路径延续"仅告警不吞写"容错哲学；closed 态 `exportAll` 抛稳定 `STORE_CLOSED` | 不变（0.4.0 已达标） | 导入源路径不存在/读取失败/解析异常**仅告警计数**，插件照常启动（延续"失败不阻断"哲学） | **统一错误基础设施**：`errorMessage` 为全局唯一错误信息入口（MemoryHubError→`CODE: message`）、`toMemoryHubError` 规整包装，专项测试 errors.ts **100% 覆盖** | 不变（0.7.0 已达标）；错误路径全分支（工具注册失败不阻断 / store open 失败仅告警 / close 失败仅告警）直测闭环 不变（0.7.0 已达标）；NOT_FOUND 由「定义未用」变为 strict 路径真实抛出 |
| 工程工具链 | tsc + tsup | eslint 9（typescript-eslint）+ prettier + vitest 覆盖率阈值 + prepack 守护 | **GitHub Actions CI**（node 18/20/22）+ `npm run check` 一键全检 + **CHANGELOG.md** | 不变（0.3.0 已达标）；bench 新增 BM25 vs cosine 质量对比与热度更新复用基准 | 不变（0.3.0 已达标）；`npm run eval` 评估入口 + vitest include 纳入 `eval/` | 不变（0.3.0/0.5.0 已达标） | **阈值与实测对齐**（lines ≥94.71 / branches ≥89.71 / functions ≥95.14，杜绝守门虚设）；**CI 新增独立 `quality-eval` job 纳入 `npm run eval` 门限**；bench 质量命中率真实落 stdout；eval 报告版本自动从 package.json 读取 | **阈值再升与实测同步冻结**（lines ≥96.5 / branches ≥95 / functions ≥97 / statements ≥96.5，实测 100 / 96.1 / 100 / 100）；`mountPlugin()` 显式组装适配 vitest ESM 环境，disposer 链真实驱动 不变（阈值冻结 96.5 / 95 / 97 / 96.5）；实测 branches 96.1 → 97.87、测试 294 → 324，与 0.9.0 实测对齐 不变（阈值冻结不变）；实测 branches 97.87 → **97.89**、测试 324 → **325**、eval 六门限 → **七门限（G1–G6）**；`.prettierignore` 固化语料与生成物（MANIFEST 哈希一致性） |
| 测试 | 38 个 | **77 个** | **100 个**（索引缓存、removeMany/revision、写失败错误码、背压丢弃、metrics、kind 过滤、status diagnostics） | **141 个**（BM25 质量/词频饱和/长度归一化/评分可复算、NFKC 查询、停止词边界、指纹缓存复用与重建、长文本 Jaccard 退化、损坏隔离留证、compact 自检、exportAll 往返、size 诊断） | **186 个**（engine-0.5 25 + heat-0.5 9 + significance-0.5 5 + eval 6：容错变体/语义覆盖/热度冷却/价值权重/参数网格 oracle） | **207 个**（importer-0.6 19 项：文档切块/会话提取/kind 推断/幂等/敏感过滤/真实语料端到端 + load 新增 2 项启动导入冒烟） | **236 个**（errors-0.7 11：错误码契约/包装/信息提取；text-0.7 11：提取边界 + re-export 等价；ingest-0.7 7：入库管线敏感/去重/组装/截断/workspace/指标全分支） | **294 个**（新增 58）：engine-guard-0.8 18 / store-fault-0.8 5 / edge-0.8 12 / tools-render-0.8 12 / index-lifecycle-0.8 11：守卫兜底 / 容错故障注入 / 渲染契约 / 生命周期与错误路径 **324 个**（新增 30）：upgrade-0.9 14（B/C/E/F/G/H/J/K/L/M/N/O/Q 探针转正 + mode 三档/strict 遗忘）+ store-fault +6 + index-lifecycle +3——16 项薄弱项逐项锚定 **325 个**（新增 1）：G6 真实数据门（真实语料还原度守卫 + recall@1/3/5 门限 + 报告场景） |
| 可维护性 | — | — | — | — | —（功能不断累积，重复与入口职责问题开始积累） | `index.ts` 328 行同时承担接线与 ingest 逻辑；`blocksToText`/`extractTextBlocks` 双份实现；src 非空断言 69 处 | **抽象提纯**：重复实现合并（grep 确认单一出处）、ingest 自 index 拆出（index 聚焦"接线"）、**src 非空断言 69→4 处**（降幅 94%，剩余附算法不变式证明注释） | **断言清零质变**：status 双断言提纯为 `DiagnosticsProvider` 类型守卫、recall 输出契约抽 `RecallOutput` 接口复用、index 注册类型精确化消除 disposer 断言、capture 强度词抽常量消除重复表；测试侧消除 `as never` 强转 **16 项薄弱项全闭环**：词法单源编译派生 / workspace 语义唯一化 / 批内去重 / MinHash 兑现注释承诺 / 死配置三件套（autoTags/isUser/mode）落地 / 死兜底消亡 / 契约显式化 |
| 真实数据 | — | — | — | — | —（合成黄金语料自证） | **真实文档端到端验收**：测试读取仓库真实 `README.md`+`CHANGELOG.md` 走「导入→importAll→buildIndex→queryIndex」，断言真实词可召回 | 不变（0.6.0 已达标） 不变（0.6.0 已达标） **G6 真实数据门（0.10.0）**：真实官方文档快照（Node.js v26.10.0 path/os，SHA-256 固化、随仓库分发、评测不联网）→ 生产同路径 `planImport` → 329 条真实记忆 + 24 个真实问句（语义锚标注）→ recall@1 ≥ 0.75 / @3 ≥ 0.85 / @5 ≥ 0.95 实测 0.7917 / 0.8750 / 0.9583（方案见 [`GROUND-0.10.md`](GROUND-0.10.md)） |

演进审查与逐项方案见 [`DESIGN-1.0.md`](DESIGN-1.0.md)（0.10.0 → 1.0.0 世纪升维：生命周期/混合检索/指纹/可观测性/评估方法论）、[`GROUND-0.10.md`](GROUND-0.10.md)（0.9.0 → 0.10.0 真实数据接地）、[`LIFT-0.9.md`](LIFT-0.9.md)（0.8.0 → 0.9.0 薄弱项深度闭环）与 [`QUALITY-0.9.md`](QUALITY-0.9.md)（质量门实测）、[`LIFT-0.8.md`](LIFT-0.8.md)（0.7.0 → 0.8.0 全模块薄弱项升维）、[`QUALITY-0.7.md`](QUALITY-0.7.md)（0.6.0 → 0.7.0 世界级代码质量升级）、[`REALDATA-0.6.md`](REALDATA-0.6.md)（0.5.0 → 0.6.0 真实数据接入）、[`INNOVATION-0.5.md`](INNOVATION-0.5.md)（0.4.0 → 0.5.0 深度创新）、[`CENTURY-0.4.md`](CENTURY-0.4.md)（0.3.0 → 0.4.0 世纪升级）、[`EVOLUTION-0.3.md`](EVOLUTION-0.3.md)（0.2.0 → 0.3.0）与 [`EVOLUTION.md`](EVOLUTION.md)（0.1.0 → 0.2.0）。

### 0.1 0.5.0 深度创新（让记忆更像"长期记忆"）

0.5.0 不改变存储/捕获/工具契约，全部创新落在**引擎评分路径**（纯函数、可注入、可复算）：

| 编号 | 创新点                 | 一句话价值                                              | 落地位置（`engine.ts`）                                    |
| ---- | ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| A1   | 模糊查询扩展           | 拼写/近拼变体也能召回精确记忆                           | `fuzzyVariants()`（Damerau-Levenshtein ≤1）× 五折兜底      |
| A2   | MinHash 近似语义召回   | 措辞不同但词根/形态相近的记忆被兜底召回                 | 字符 3-gram 特征 + k=16 MinHash 签名缓存 + 精确覆盖率评分  |
| A3   | 记忆价值感知评分       | 指令/决策/显式记忆天然权重更高，不被流水账淹没          | `significanceWeight()`（type × source 常量权重，可关闭）   |
| A4   | 记忆生命周期自适应热度 | 陈旧高频记忆热度按遗忘曲线冷却，近期验证的记忆保持热度  | `heatScore()`（`exp(−Δ/halfLife)`，`heatHalfLifeMs` 注入） |
| A5   | 离线质量评估套件       | 升级有没有变好用量化指标证明，`npm run eval` 一键可复算 | `eval/`（黄金语料 + recall@k/MRR/NDCG + 27 参数网格）      |

五项硬约束全程满足：四工具签名、`MemoryEntry` 契约、安装方式、`MemoryIndex`/`RecallOptions` 仅内部可选扩展、纯函数零外部依赖。设计定稿全文见 [`INNOVATION-0.5.md`](INNOVATION-0.5.md)。

### 0.2 0.6.0 真实数据接入（让插件"开箱即有记忆"）

0.6.0 新增**真实数据接入层**（`src/memory/importer.ts`，方案全文见 [`REALDATA-0.6.md`](REALDATA-0.6.md)），把用户已经沉淀的真实数据资产批量接入记忆库，复用 0.5.0 全部检索能力：

| 能力                  | 实现                                                                                                                           | 语义                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Markdown 记忆文档导入 | `splitDocument()`（标题/列表/连续段落聚合、纯链接索引行跳过）                                                                  | `source: 'explicit'`；信号词推断 `instruction`/`preference`（其余 `generic`） |
| 会话事件 JSONL 导入   | `extractSessionText()`（宽容解析 `user/message`→`data.content`、`assistant/message`→`data.message.content`，损坏行计数不阻断） | `source: 'auto'`                                                              |
| 内容级幂等            | id = `imp-${contentHash(content)}` + `importAll` 天然去重                                                                      | 同一内容跨文件/跨时间重复导入自动合并，第二次新增数为 0                       |
| 启动接线              | 可选配置 `importSources`（`documents?`/`sessionLogs?`），store 就绪后逐个 `readFile`→`planImport`→`importAll`                  | 未配置零行为变化；路径缺失/解析失败仅告警不阻断                               |

**零豁免防线**：导入内容与实时捕获共享受检——敏感模式拦截（NFKC 归一化）、短块（<8 字符）丢弃、`maxChars` 截断；离线批量导入不绕过任何隐私防线。

### 0.3 0.7.0 世界级代码质量升级（让工程本身成为护城河）

0.7.0 不新增用户侧功能，聚焦**工程质量治理**（审查全文见 [`QUALITY-0.7.md`](QUALITY-0.7.md)），把"功能正确、覆盖率高"推进到"守门强度与实测一致、零重复、错误基础设施统一、断言可证明、评估可复算进 CI、基准可观察"：

| #   | 升级项                | 价值                                                            | 落地与验收                                                                                                        |
| --- | --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| U1  | 覆盖率阈值对齐实测    | 消除"可删 10 个百分点而不被 CI 拦截"的守门虚设                  | 阈值提升至 lines 94.71 / branches 89.71 / functions 95.14 / statements 94.71，文档四处数值一致                    |
| U2  | 文本提取合并去重      | 同一逻辑不再双份维护（`blocksToText` vs `extractTextBlocks`）   | 归一至 `src/memory/text.ts` 唯一实现，importer re-export 兼容既有导入路径，新模块覆盖 100%                        |
| U3  | 错误基础设施沉淀      | 全局唯一错误信息入口，告警/日志可归类                           | `errorMessage` 提升至 errors.ts（`CODE: message` / message / String 三分支），errors.ts 覆盖 100%                 |
| U4  | eval 版本自动读取     | 杜绝报告版本硬编码漂移（0.6.0 已漏改）                          | 报告标题版本 == `package.json` version，eval 全绿                                                                 |
| U5  | CI 纳入评估门限       | 离线质量门限不再游离于任何 CI 路径之外                          | `quality-eval` job 执行 `npm run eval`；bench 按既有设计不进 CI                                                   |
| U6  | bench 质量对比可观察  | 消除无操作占位死代码，检索质量可复算对照                        | BM25 vs cosine top@1 命中率以 `[bench]` 前缀真实落 stdout（vitest bench 的 afterAll 不执行，故任务内输出 + 去重） |
| U7  | 类型断言提纯          | 绝大多数 `!` 断言可证明消除                                     | src 非空断言 **69→4 处**（降幅 94%，超额完成 ≥40% 目标）；剩余为滚动数组收敛断言，附算法不变式证明注释            |
| U8  | ingest 拆分与直接单测 | 入库管线从 328 行入口文件拆出，纯逻辑可直接单测而不必绕事件链路 | `src/memory/ingest.ts` 导出 `ingestCaptured`，行为与原私有实现严格等价，新模块覆盖 100%，index.ts 聚焦"接线"      |

五项进展最终以 **236 项测试**（新增 29）与覆盖率 **lines 95.59 / branches 91.19 / functions 96.07**（较 0.6.0 全维度上升）固化；四工具签名、`MemoryEntry` 契约、`cordis.patch.yml` 安装方式、纯函数零外部依赖的硬约束全程未动。

### 0.4 0.8.0 全模块薄弱项升维（让"高覆盖率"经得起逐行推敲）

0.8.0 不新增用户侧功能，对**全部模块**的薄弱项逐一识别并升维（方案全文见 [`LIFT-0.8.md`](LIFT-0.8.md)）：把"功能正确、覆盖率高"推进到"插件生命周期与错误路径可测、工具输出契约可断言、防御分支全闭环、断言可证明、阈值与实测同步冻结"：

| #       | 升维项                       | 价值                                                                       | 落地与验收                                                                                                                                                                                  |
| ------- | ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1–L4   | 插件生命周期/错误路径可测    | index.ts 分支 70.21 是最大薄弱点——卸载链、错误路径、背压、定时器几乎零覆盖 | 真实 Context + 可注入故障 MockStore 驱动插件级测试：正常/异常卸载、工具注册失败不阻断、store open 失败仅告警、prune 三路径、背压 256 边界、捕获失败链、ttlDays 定时器（index 分支 → 85.07） |
| L5–L8   | 工具输出契约白盒化           | 工具函数覆盖仅 71.42%，render 输出是黑盒                                   | 四工具 `render(args, value)` 直调全分支单测：status 空库/全形态、recall 零/多命中、forget removed/not found、store workspace/tags/截断（函数覆盖 → 100）                                    |
| L9      | engine 防御闭环 + 死代码移除 | 18 处守卫分支未闭环；3 处分支经算法不变式证明不可达                        | engine-guard-0.8 18 项守卫直测；`minhashCoverage`/`similarity`/`levenshtein` 不可达分支移除并留证（branches → 100%）                                                                        |
| L10     | store 容错路径故障注入       | compact 失败/自检 mismatch/自检读失败/chmod 失败 4 条告警路径未测          | `vi.mock('node:fs/promises')` 包装真实实现故障注入，断言告警且条目不受损                                                                                                                    |
| L11     | capture 强度词语义           | conservative/balanced 两处内联强度词表存在漂移风险                         | 抽共享 `STRONG_HINTS`/`BALANCED_STRONG_HINTS` 常量（语义各自保留），强弱信号分支直测                                                                                                        |
| L12     | importer/types 剩余分支      | 非对象 JSON 行、可选字段拷贝分支缺测                                       | edge-0.8 12 项补齐                                                                                                                                                                          |
| L13–L15 | 类型断言清零                 | status 双断言、recall 重复声明、index disposer 断言                        | `DiagnosticsProvider` 类型守卫 + `RecallOutput` 接口复用 + 注册类型精确化——src 断言计数不增，质变全部落测试                                                                                 |

八项升维最终以 **294 项测试**（新增 58）与覆盖率 **lines 100 / branches 96.1 / functions 100 / statements 100** 固化（阈值同步升至 lines ≥96.5 / branches ≥95 / functions ≥97 / statements ≥96.5，与实测冻结、杜绝守门虚设重演）；四工具签名、`MemoryEntry` 契约、`cordis.patch.yml` 安装方式、纯函数零外部依赖的硬约束全程未动。

### 0.5 0.9.0 薄弱项深度闭环（让"没有薄弱项"成为架构性质）

DEEP-AUDIT 以七维度审计 × 动态探针实锤 0.8.0 遗留的 **16 项薄弱项**（P0×3 / P1×6 / P2×7），0.9.0 以六个前沿主题逐一闭环（方案全文见 [`LIFT-0.9.md`](LIFT-0.9.md)）：

| 主题              | 覆盖项         | 核心落地                                                                        |
| ----------------- | -------------- | ------------------------------------------------------------------------------- |
| T1 漂移免疫词法   | B/M            | 强度词单一事实源编译派生（裸「务必/一定」修复）；ImportOptions.mode 三档落地    |
| T2 共享默认隔离   | J              | workspace「未标注 = 全局共享」唯一语义；tools/result 捕获按 Agent 会话 cwd 溯源 |
| T3 双尺度时间语义 | Q              | decay 可关闭、半衰期可注入；默认 0 = 永不过期且真正可检索                       |
| T4 写入路径工程化 | C/D/N          | 批内瞬时去重 + dispose 捕获栅栏 + recall 热度合并回写与错误上浮                 |
| T5 签名候选预筛   | K/O            | MinHash 从预留落地为真实剪枝；快照零拷贝 + 写时重建                             |
| T6 契约显式化     | E/G/H/A'/S/F/L | 死字段/死配置/死兜底全部落地或消亡，NOT_FOUND 首次真实使用                      |

十六项闭环最终以 **324 项测试**（新增 30）与覆盖率 **lines 100 / branches 97.87 / functions 100 / statements 100**（branches 96.1 → 97.87，store.ts 93.13 → 100）固化，eval 六门限（recall@1=1.0）与 bench（BM25 top@1 100%）全过，渲染文本与错误码逐字节不变——四工具签名、`MemoryEntry` 契约、`cordis.patch.yml` 安装方式、纯函数零外部依赖的硬约束全程未动（质量门明细见 [`QUALITY-0.9.md`](QUALITY-0.9.md)）。

### 0.6 0.10.0 真实数据接地（让"评估自证"变成"数据验证"）

0.10.0 把离线质量评估从"固定 seed 合成黄金语料自证"升级为**真实数据验证 + 合成语料回归**双轨（方案全文见 [`GROUND-0.10.md`](GROUND-0.10.md)）：

| 要素           | 0.9.0（合成自证）                     | 0.10.0（真实数据接地）                                                          |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| 语料来源       | mulberry32 固定 seed 构造的理想语料   | **真实公开文档**：Node.js 官方 API 文档（path/os），**固定 tag v26.10.0 快照**  |
| 可复现性       | seed 固定可复算                       | SHA-256 固化的本地快照随仓库分发，评测不联网、跨机器逐字节可复现                |
| 入库路径       | 直接构造 `MemoryEntry[]`              | **生产同路径** `planImport`（切块→kind 推断→敏感过滤→长短校验→内容哈希幂等 id） |
| 查询           | 合成错拼/词根变体                     | **24 个真实 API 使用问句**（英文自然问法）                                      |
| 相关标注       | 构造时已知的 id                       | **语义空间锚**：API 专名/关键短语为锚，含锚块均相关（标题/描述/示例块全覆盖）   |
| 门限           | recall@1 ≥ 0.95/0.90/0.80（理想场景） | recall@1 ≥ 0.75 / @3 ≥ 0.85 / @5 ≥ 0.95（真实噪声，保守冻结）+ 锚点完整性守卫   |
| 实测（0.10.0） | G1–G5 全绿（recall@1=1.0）            | **0.7917 / 0.8750 / 0.9583 / MRR 0.8542**（329 条真实记忆、24 查询）            |

关键设计：实验结果在合成语料上"100% 完美"恰恰是自我证明的弱点——真实数据含代码块、多段落、同义表达，第一答命中不可能 100%。G6 用保守门限 + 完整性守卫，让"对接真实数据后依然可靠"成为可复算的工程事实，而不是宣传语。

0.10.0 以 **325 项测试**（新增 G6 真实数据门）与覆盖率 **lines 100 / branches 97.89 / functions 100 / statements 100**（branches 97.87 → 97.89）固化，eval 六门限 → **七门限**，`.prettierignore` 新增固化语料与生成物豁免（MANIFEST 哈希一致性），四工具签名、`MemoryEntry` 契约、纯函数零外部依赖硬约束全程未动。

### 0.7 1.0.0 世纪升维（记忆生命周期与冲突感知 + 双引擎混合检索 + 指纹去重根治，方案全文见 [`DESIGN-1.0.md`](DESIGN-1.0.md)）

1.0.0 承接 DEEP-AUDIT 遗留的 10 项疑点 + 架构短板，把"会存会查的记忆库"升维为"**有生命周期的记忆系统**"——多数竞品只解决"存与查"，无人解决"旧约定如何被新约定取代""哪些记忆值得保留"。四个模块全部**默认关闭/零行为变化**，向后兼容旧配置与旧数据：

| 模块                      | 能力                                                                                                                                                                                   | 默认                                              | 市面对照                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| **A1 supersede 取代协议** | 识别"改用/升级到/instead of"对立信号（单一事实源词表编译派生），新记忆打 `supersede:`、旧记忆打 `superseded-by:`；被取代记忆召回**降权**（`supersededPenalty` 可调）、同现**去重**剔除 | `off`                                             | 社区记忆插件无取代语义，"旧约定"永久存活污染召回             |
| **A2 主题自动聚类**       | `status`/`recall` 输出聚合主题视图（memory_count/token/updated），运行时计算、零持久化                                                                                                 | `themes: false`                                   | 竞品仅平铺列表，无法回答"我记了哪些主题"                     |
| **A3 价值感知淘汰**       | `maxEntries` 超限时按「冷热分 + 显著性」淘汰最低价值记忆，**instruction 永不自动淘汰**                                                                                                 | `maxEntries: 0`（不限）+ `autoEvict: false`       | 无限膨胀 vs 无脑 FIFO 之间缺少"价值"尺度                     |
| **B 双引擎混合检索**      | 词面（BM25）/ 容错（fuzzy）/ 语义（MinHash 覆盖率 + 两级守卫）三线评分；`interpolate` 线性插值或 `rrf`（k=60）融合；语义线可**叠加**而非仅兜底                                         | `semanticBoost: false`、`fusionMode: interpolate` | 语义近似仅在词面零命中兜底（0.10.0）→ 可叠加提升真实问句召回 |
| **C UF-1.0 统一指纹**     | 三写入路径同一指纹协议 + `superseded-by` 前缀互认 + 导入前库内跨 id 去重                                                                                                               | 始终生效                                          | 修复疑点 7：不同 id 前缀的同内容可重复入库                   |
| **D 可观测性升维**        | `status` 输出覆盖率/安全垫量化、召回链路 stage 流水、配置快照                                                                                                                          | 始终生效                                          | 召回劣化可解释而非黑箱                                       |

**评估方法论升维（模块 E）**：门禁从七门限（G1–G6）扩至**八门限（G1–G8）**——

- **G5 参数网格 4 维 81 组**：默认参数组每维不劣于任何组合 + b 三档（0.5/0.75/0.9）spread ≥ 0.02（0.9.0 曾曝光 b=0.5 网格塌缩，1.0.0 以梯度语料 + 锚词×3 + 长填充词根治）；
- **G6 真实数据门扩至 49 问句 × 4 份语料**（path/os/fs/stream，Node v26.10.0 官方 tag，SHA-256 固化）：每问句语义锚 ≥ 2 + 盲验守卫（top5 必须含锚相关记忆），门限 recall@1 ≥ 0.75 / @3 ≥ 0.85 / @5 ≥ 0.95 全绿；
- **G7 鲁棒性**：大小写 / 全角 / 空白 / 标点 / 错字五类扰动聚合退化 ≤ 5%（扰动字符设计规避跨查询碰撞）；
- **G8 生命周期与聚类**：supersede 判定准确率 ≥ 0.9、被取代降权衰减、同现去重剔除、主题聚类纯度 ≥ 0.85（主题内容全专属 token，杜绝公共叙述词跨主题并簇）。

1.0.0 以 **327 项测试**（eval 九个场景断言，test 318 + eval 9）固化，check 链（verify:realdata → typecheck → lint → format:check → test）全绿，tsup / bench（BM25 top@1 100%、10K 索引热命中缓存复用）通过；四工具签名、`MemoryEntry` 契约、`cordis.patch.yml` 安装方式、纯函数零外部依赖硬约束全程未动。

---

## 1. 产品定位与市场空白论证

### 1.1 DeepSeek Harness 是什么

DeepSeek Harness（简称 dsh）是 DeepSeek 官方于 2026-08-13 开源的 Agent 运行时框架，基于
[Cordis](https://github.com/cordiverse/cordis) 插件系统，核心理念 **"Everything is a Plugin"**
（一切皆插件），MIT 协议，TypeScript 编写。模型适配器、工具、会话存储、沙箱、界面、Agent Loop
均可通过插件树组合与替换。插件以 npm 包（bundle）形式分发，通过 `dsh plugin --profile <name> add <pkg>`
或桌面端插件管理页安装。截至 2026-10，GitHub 24 万+ Star，社区 dsh-plugin 话题仓库 1.6 万+。

### 1.2 为什么"会话记忆"是大多数用户的刚需

- 官方 v0.2 桌面版将产品定位从"开发者工具"明确扩展为"日常办公优先"（整理资料、分析表格、撰写文档、
  制作汇报），目标用户从程序员扩展到普通办公人群。
- 官方团队在 v0.2 发布说明中明确列出后续方向之一："**加入个性化的长期记忆**"（原话摘要：改善沙箱与
  安全性、完善智能体团队、加入个性化的长期记忆、浏览器/GUI 自动化、远程与移动端、会话分享与多人协作）。
  这说明官方承认当前版本**尚无成熟、可用的个性化长程记忆能力**。
- 社区对被截断记忆的普遍痛点：每次会话"从零开始"，用户偏好、项目事实、历史决策反复重述，上下文重复
  消耗 token，Agent 无法"越用越懂你"。

### 1.3 市面空白论证（差异化定位）

截至 2026-10-05，dsh-plugin 生态中记忆类插件现状：

| 项目                         | 状态                      | 缺口                                                                                                  |
| ---------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| dsh-memory-evolve            | 早期，跨会话记忆/后台演进 | 仓库标注"早期"，无独立使用证据                                                                        |
| dsh-noema                    | 早期 rc，本地优先记忆     | 依赖 Noema 外部生态，pre-release                                                                      |
| EverOS Memory for DSH        | 未发布 npm                | 依赖外部 EverOS 服务，延迟提取依赖未发布能力                                                          |
| **dsh-memory-hub（本插件）** | **本次交付**              | **本地优先、零外部服务、事件驱动自动捕获 + Agent 可主动调用的工具化记忆、自带完整测试与打包发布链路** |

**差异化结论**：市面上没有一款"开箱即用、本地优先、不依赖第三方云端、工具化（Agent 可主动读写）、
带完整测试与发布链路"的 dsh 记忆插件。dsh-memory-hub 填补这一空白。

---

## 2. 功能清单（面向大多数用户）

### 2.1 核心能力

| #   | 能力         | 说明                                                        | 形态                                   |
| --- | ------------ | ----------------------------------------------------------- | -------------------------------------- |
| 1   | 自动记忆捕获 | 监听会话/工具事件，自动提炼决策、事实、偏好并入库（可开关） | 事件驱动                               |
| 2   | 显式记忆     | Agent 或用户主动执行"记住：xxx"                             | `memory_store` 工具                    |
| 3   | 智能召回     | 按语义/关键词召回相关记忆，带 token 预算裁剪                | `memory_recall` 工具                   |
| 4   | 记忆治理     | 遗忘、查看统计、过期衰减                                    | `memory_forget` / `memory_status` 工具 |
| 5   | 本地优先     | JSONL 持久化，零外部服务，隐私安全                          | 存储层                                 |
| 6   | 可配置       | 开关、预算、存储路径、捕获策略均可由用户配置                | 配置 Schema                            |

### 2.2 使用场景（用户视角）

- **办公用户**：让 Harness 记住"我习惯用表格呈现汇总、报告要用中文、周报固定周二写"→ 之后每次对话
  Agent 自动遵循，无需重复交代。
- **开发者**：记住项目技术栈、既有约定（"这个仓库用 pnpm、禁止直接改 package-lock"）、常用命令 →
  新会话直接带入项目上下文，减少上下文重复消耗。
- **研究者**：记住研究方向、已读文献结论、写作偏好 → 深度研究连续多会话不丢上下文。

### 2.3 非目标（明确不做）

- 不做跨设备云同步（留给官方路线图与其他生态插件）。
- 不在本插件内做向量数据库/外部 embedding 服务（保持零外部依赖，检索用轻量评分方案，可通过接口
  预留未来扩展）。
- 不读取模型凭据、不监听敏感凭证内容。

---

## 3. 技术架构

### 3.1 技术选型

| 层         | 选型                                 | 理由                                                       |
| ---------- | ------------------------------------ | ---------------------------------------------------------- |
| 语言       | TypeScript 5.x（strict）             | dsh 官方生态为 TS，支持类型安全的 `defineTool` schema 推导 |
| 运行时框架 | @deepseek-ai/cordis                  | 官方插件逻辑，提供 `ctx.on()` 事件、`ctx.tools` 服务       |
| 工具注册   | @deepseek-ai/dsh-tools `defineTool`  | 官方推荐，参数校验/输出校验/渲染一站式                     |
| 存储       | 自研 JSONL Store（node:fs 原子写入） | 零依赖、易审计、可读、崩溃安全                             |
| 测试       | vitest                               | 与 dsh 官方一致，支持 Node 18+，单测快速                   |
| 构建       | tsup（esbuild）                      | 一行配置产出 ESM+bundle，tree-shaking 友好                 |
| 打包分发   | npm package（dsh.bundle manifest）   | 官方唯一安装通道（桌面端插件页/npm）                       |

### 3.2 分层架构

```
┌───────────────────────────────────────────────────────┐
│                    dsh 运行时 (Host)                    │
│   ctx.tools.register()         ctx.on() 事件总线        │
└───────────────┬───────────────────────┬────────────────┘
                │                       │
┌───────────────▼──────────────────┐   │  session/event、tools/result
│       表现层 (tools/)             │   │
│  memory_store / recall / forget  │   │
│  / status（defineTool 注册）      │   │
└───────────────┬──────────────────┘   │
                │ 调用                    ▼
┌───────────────▼────────────────────────────────────────┐
│                   核心层 (memory/)                      │
│  MemoryEngine                                          │
│    ├─ capture()   事件→记忆条目提炼（去重/分级/衰减）    │
│    ├─ recall()    评分检索 + token 预算裁剪             │
│    ├─ governance() 遗忘/统计/过期清理                   │
│    └─ importer.ts 真实数据接入（Markdown/JSONL→Entry）   │
└───────────────┬────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────┐
│                   存储层 (memory/store.ts)              │
│  MemoryStore（JSONL 追加写 + 内存索引 + 原子替换）       │
└────────────────────────────────────────────────────────┘
```

### 3.3 数据模型

```ts
interface MemoryEntry {
  // 持久化契约（运行时守卫 isMemoryEntry / parseMemoryEntry）
  id: string // 短哈希 id（自动捕获用 randomUUID 后缀 + contentHash，幂等去重）
  kind: 'decision' | 'fact' | 'preference' | 'instruction' | 'generic'
  content: string // 记忆正文（自然语言）
  tags: string[] // 标签，便于检索分组
  source: 'auto' | 'explicit' // 自动捕获 or 主动记忆
  sessionId?: string // 来源会话
  workspace?: string // 来源工作区（可选）
  createdAt: number // 创建时间戳（ms）
  updatedAt: number // 最近更新时间戳
  accessCount: number // 访问次数（召回热度）
  lastAccessAt?: number // 最近访问时间
  // 注意：score 是 MemoryHit 的运行时计算字段，绝不持久化
}
```

未知字段在读写时被守卫丢弃，保证向前兼容；`score` 只在召回结果中出现。

### 3.4 事件驱动的自动捕获（能力 1）

- 监听 dsh 持久化会话事件（`session/event`）与工具结果事件（`tools/result`），在合适的事件类型
  （如 `turn/*`、`tool/result`、`assistant/message`）上做启发式提炼：
  - 用户消息中包含"记住/以后/始终/不要/优先"等指令词 → 提炼为 `preference` / `instruction`；
  - 工具成功执行且有明确结论（写文件、跑测试、查数据等）→ 提炼为 `fact` 摘要；
  - 助手消息（仅 aggressive 模式）包含"结论/总结/要点"等信号 → 提炼为 `generic` 摘要；
  - **敏感信息前置拦截**：OpenAI key / JWT / 密码键值 / 私钥 / MongoDB 连接串 / AWS `AKIA` /
    GitHub `ghp_` / Slack `xox` / GCP `AIza` 等模式，匹配前经 **NFKC 归一化 + 小写折叠**，
    全角/异体字符无法绕过；命中即整条丢弃。
- **有界串行捕获队列（背压）**：所有事件捕获经 promise 链 FIFO 队列消化（单条失败 catch 后续链
  不中断），避免密集会话并发去重/并发写风暴；队列容量上限 **256**，超出即丢弃最早期任务并
  `metrics.dropped++`（warn 日志），进程内存永远有界；队列内以最新快照去重。
- 自动捕获得到的内容先经"内容哈希 + 语义相似度"去重，防止重复入库。
- **默认策略**：自动捕获默认开启但保守（仅对满足置信规则的内容入库），全部可配置关闭。

### 3.5 召回与 Token 预算（能力 3）

- `memory_recall(query, maxTokens?, kind?)`：
  1. 中文按 **2-gram + 英文按单词** 双路分词：查询与索引 token 统一经 **NFKC 规范化**（全角/异体英文等价）；英文**停止词过滤**（`the/a/is/of` 等不占索引槽，纯停止词查询安全返回空数组）；
  2. **Okapi BM25 评分**（k1=1.2, b=0.75）：词频饱和（`tf·(k1+1)/(tf + k1·(1 − b + b·len/avgdl))`）+ 文档长度归一化（精炼短记忆不被长尾文档压过） + 平滑 IDF（`log(1 + (N − df + 0.5)/(df + 0.5))`，df=0 不除零）；
     最终分数 = BM25 × 时间衰减（半衰期 7 天）× (1 + 0.1·log(1+访问次数))；
  3. **`kind` 可选过滤**：只召回指定类型（decision/fact/preference/instruction/generic），非法值拒绝；
  4. **`IndexCache` 索引缓存**：按存储 `revision` + **内容指纹**（id/content/tags 的 sha256）双重失效——revision 未变无条件复用（0.3 语义）；revision 变但指纹不变（纯热度更新）复用旧索引；内容变化才重建（同一工具实例持有 1 个缓存），高频会话内多次召回 O(查询) 完成；
  5. 按评分降序取前 N 条，按字符/token 估算逐条累加，直到超出 `maxTokens` 预算（默认 800 token）；
  6. 命中即更新 `accessCount` / `lastAccessAt`——热度更新显式 pick 契约字段重建条目，
     **运行时 `score` 绝不写回存储**。
- `now` 作为 `RecallOptions` 字段注入：评分基准时间固定时结果可复算，便于测试与评估；BM25 参数（k1/b）与停止词表为纯函数常量，质量对比可复算（bench 实测 cosine top@1 0% → BM25 100%，见 `CENTURY-0.4.md` 附录 A）。
- **0.5.0 评分扩展（A1-A4，全部为 `RecallOptions` 可选注入、默认开启、`score` 仍不落盘）**：
  1. **A1 容错检索**：对查询英文纯字母词（长度 ≥4）生成编辑距离 ≤1 变体（删除/相邻交换/替换/插入），过滤停止词与词典外词后并入候选；仅当该记忆精确 BM25 为零命中时按 **0.5 折扣**计入变体命中——精确命中排序不被弱化，拼写偏差（`delpoy`→`deploy`）可召回；
  2. **A2 近似语义召回**：`semanticFeatures()` 将英文/数字 token 展开为**字符 3-gram**（首尾边界标记 `^xx`/`xx$`，与 BM25 词面不同源，避免兜底死代码），随 `buildIndex` 缓存 k=16 FNV-1a `minhashSignature`（LSH 剪枝资产）与精确特征集；词面（含变体）全零命中时按**精确查询覆盖率** `|Q∩D|/|Q| ≥ 0.45` 以 **0.3 权重**兜底召回——小特征集下 MinHash 估计方差大，评分不依赖签名精度；
  3. **A3 记忆价值感知**：`significanceWeight(kind, source)` = 类型系数（instruction 1.25 > decision 1.15 > preference 1.05 > fact 1.0 > generic 0.95）× 来源系数（explicit 1.1 > auto 1.0），乘入最终评分——显式指令/决策不被流水账事实淹没；`significance: false` 可关闭；
  4. **A4 热度生命周期**：`heatScore(entry, now, halfLifeMs)` = `1 + 0.1·log1p(accessCount)·exp(−max(0,now−lastAccessAt)/halfLife)`（默认半衰期 7 天）——`accessCount=0` 恒 1（新记忆不惩罚）、`lastAccessAt` 缺失的历史数据不衰减（0.4.0 语义兼容）、其余按 Ebbinghaus 遗忘曲线指数冷却；命中经 `bumped()` 同步更新 `lastAccessAt` 形成冷却/复活闭环。
- 可选注入点：在会话开头（系统提示词组装前）将工作区相关的高分记忆注入上下文（通过
  `agent/pre-step` 或等价扩展点），默认关闭，可由用户开启并设预算。

### 3.6 存储可靠性

- 存储根目录：`~/.dsh/memory-hub/`（可由配置覆盖），文件 `memories.jsonl`。
- **append-only 追加写**：每次写入单行 O(1) 追加，不再全量重写；删除写 tombstone 行
  （`{"__tombstone__": id}`），内存即时删除，重开文件时不加载已删条目；
- **写一致性（先落盘后入内存）**：`upsert`/`removeMany`/`importAll` 全部**先 `appendFile` 成功，
  再变更内存 Map**——并发读者永远只看到已确认落盘的状态，写失败天然零残留（0.2.0 的回滚逻辑
  由此整体移除，语义更强）；`appendRaw` 失败统一包装 `MemoryHubError(STORE_WRITE_FAILED)`；
- **快照缓存**：`list()` 命中已排序缓存时 O(N) 拷贝返回（脏标记重建），高频召回/状态查询零浪费；
- **`revision` 版本号**：任何结构性写入 +1，供上层 `IndexCache` 精确失效；
- **`removeMany(ids)` 批量删除**：单次落盘多行 tombstone + 单次 compact 判定，TTL 清理一次批次
  完成（接口可选，自定义实现缺省时回退逐个 `remove`）；
- **compact 自动收敛**：条目数/文件行数超过 COMPACT_FACTOR 阈值（且超过最小行数）时，重建纯条目
  文件（临时文件 + rename 原子替换），崩溃不损坏旧数据；重建失败仅告警，绝不把已成功写入变成失败；
  **0.4.0 compact 自检**：重建后重读新文件核对行数与内存条目数，不一致仅告警（优化路径延续容错哲学）；
- **损坏行隔离留证（0.4.0）**：加载时跳过损坏 JSONL 行并计数的同时，将损坏行原文追加备份至
  `<file>.corrupt`（0600、失败仅告警、不影响既有 `corrupt` 计数语义），数据丢失可追溯、主库不受污染；
- **完整迁移闭环（0.4.0）**：`exportAll()` 全量导出（排序快照 JSON 数组，无 IO 副作用）与既有
  `importAll()` 对称——`JSON.parse(exportAll())` 可直接喂给新实例 importAll，跨设备迁移数据往返无损；
  closed 态调用抛稳定 `STORE_CLOSED`；接口可选成员，自定义存储实现不强制；
- **隐私权限**：记忆文件始终 0600（首写即生效：`appendFile` 显式 `mode: 0o600`，不依赖 umask）；
  目录 0700 **仅对本插件新建的目录**收紧（`mkdir recursive` 返回创建路径即判定新建），
  用户既有的共享目录保持原权限不动，避免无意的副效应；
- 兼容 0.1.0 旧文件：旧格式每行即完整条目，加载不迁移即兼容；损坏行自动跳过并计数（`diagnostics` 上报）。
- 会话级隔离：回忆支持按 `workspace` 过滤，避免不同项目记忆互相污染。

### 3.7 可观测性与运行时指标

- **`HubMetrics`（src/memory/metrics.ts）**：零依赖、纯数字、可 JSON 序列化的计数聚合器；
  十项指标：`capturedTotal`（自动捕获入库）/ `explicitStored`（显式存储）/ `recallCalls` + `recallHits` /
  `forgotten` / `rejectedSensitive` / `rejectedDuplicate` / `pruned`（TTL 清理）/ `dropped`（背压丢弃）/ `errors`；
- **注入路径**：插件入口创建实例，5 个工具与捕获链路共享注入（可选参数，缺省 no-op，不破坏既有测试构造）；
- **输出**：`memory_status` 返回 `metrics` 快照（深拷贝，后续累加不影响已返回值）与存储 `diagnostics`
  （`lines`/`corrupt`）；插件卸载（disposer）时以一行结构化摘要输出全部指标，是进程生命周期的健康佐证；
- **背压丢弃**：捕获队列上限 `MAX_PENDING_CAPTURES = 256`，超出即丢弃最早期任务并 `dropped++`（warn 日志），
  进程内存永远有界。

### 3.8 扩展预留

- 检索引擎以 `buildIndex` / `queryIndex` 纯函数暴露倒排索引构建与查询，`IndexCache` 作为调用层
  缓存（按 `revision` 失效），未来可无缝替换为向量检索（如接入本地 embedding）或按规模阈值启用索引化召回；
- 时间衰减策略、捕获启发式均以独立纯函数实现，便于替换与测试；
- `MemoryStore` 接口化：0.3.0 新增能力（`removeMany`/`revision`/`diagnostics`）与 0.4.0 新增
  `exportAll` 均为**可选成员**，
  未来可无侵入替换为 SQLite / 向量库 / MCP 后端。

---

## 4. 工程结构

```
dsh-memory-hub/
├── package.json          # dsh.bundle manifest（安装入口，版本 0.10.0）
├── cordis.patch.yml      # 插件注册 patch（装进 profile 的关键）
├── tsup.config.ts        # 构建配置（ESM）
├── tsconfig.json         # strict + exactOptionalPropertyTypes 等前沿开关
├── eslint.config.js      # eslint 9 flat config（typescript-eslint 严格 + prettier）
├── .prettierrc.json      # 格式约定
├── vitest.config.ts      # vitest + 覆盖率阈值（lines ≥96.5 / branches ≥95 / functions ≥97 / statements ≥96.5，与 0.10.0 实测对齐：100 / 97.89 / 100 / 100）
├── .github/workflows/ci.yml # GitHub Actions CI（node 18/20/22 × typecheck/lint/format/test/build + coverage + quality-eval 含 G6）
├── CHANGELOG.md          # Keep a Changelog 风格版本记录
├── README.md             # 安装/使用说明
├── docs/
│   ├── ARCHITECTURE.md   # 本文档（含 0.3.0/0.4.0/0.5.0/0.6.0/0.7.0/0.8.0/0.9.0/0.10.0 演进）
│   ├── GROUND-0.10.md    # 0.9.0 → 0.10.0 真实数据接地（G6 真实数据门）方案与实测
│   ├── LIFT-0.9.md       # 0.8.0 → 0.9.0 16 项薄弱项深度闭环审查与方案
├── QUALITY-0.9.md    # 0.9.0 全链质量门实测记录
├── LIFT-0.8.md       # 0.7.0 → 0.8.0 全模块薄弱项升维审查与方案
│   ├── QUALITY-0.7.md    # 0.6.0 → 0.7.0 世界级代码质量升级审查与方案
│   ├── REALDATA-0.6.md   # 0.5.0 → 0.6.0 真实数据接入审查与方案
│   ├── INNOVATION-0.5.md # 0.4.0 → 0.5.0 深度创新审查与方案
│   ├── CENTURY-0.4.md    # 0.3.0 → 0.4.0 世纪升级审查与方案
│   ├── EVOLUTION-0.3.md  # 0.2.0 → 0.3.0 世界级升维审查方案
│   └── EVOLUTION.md      # 0.1.0 → 0.2.0 演进审查方案
├── src/
│   ├── index.ts          # 插件入口 apply(ctx)：服务/工具/事件/有界捕获队列/metrics/生命周期/启动导入/mining 接线（0.6.0 启动导入，0.7.0 收敛为"接线"）
│   ├── config.ts         # 插件配置 Schema（schemastery；含可选 importSources）
│   ├── errors.ts         # MemoryHubError + 稳定错误码 + errorMessage/toMemoryHubError（0.7.0 统一错误基础设施）
│   └── memory/
│       ├── types.ts      # MemoryEntry 契约 + isMemoryEntry/parseMemoryEntry/toMemoryEntry 守卫
│       ├── store.ts      # append-only JSONL + tombstone + removeMany + compact 自检 + 损坏隔离 + exportAll + 快照缓存 + revision（先落盘后入内存）
│       ├── engine.ts     # 倒排索引 + BM25（NFKC 规范化/停止词）+ IndexCache 内容指纹 + 召回/预算/去重/衰减（纯函数；0.7.0 断言提纯 69→4）
│       ├── text.ts       # 0.7.0 内容块文本提取**唯一实现**（index/importer 共享，U2 去重）
│       ├── ingest.ts     # 0.7.0 捕获入库管线（敏感/去重/截断/workspace/指标，U8 拆分独立可测）
│       ├── metrics.ts    # HubMetrics 运行指标聚合器（零依赖、可快照、可序列化）
│       ├── importer.ts   # 真实数据接入：Markdown 文档切块 + 会话 JSONL 宽容解析 + kind 推断 + imp- 哈希幂等（纯函数）
│       └── capture.ts    # 事件→记忆提炼 + NFKC 归一化敏感过滤
│   └── tools/
│       ├── memory-store.ts    # 显式存储（metrics 注入）
│       ├── memory-recall.ts   # 召回（IndexCache + kind 过滤 + metrics 注入）
│       ├── memory-forget.ts   # 遗忘（metrics 注入）
│       └── memory-status.ts   # 统计 + metrics 快照 + diagnostics（metrics 注入）
└── test/
    ├── memory/*.test.ts  # 存储/引擎/捕获单元 + 演进测试（types/engine-evolve/store-evolve/capture-evolve/metrics-0.3/store-0.3/importer-0.6/text-0.7/ingest-0.7）
    ├── tools/*.test.ts   # 工具 schema 与行为（含契约纯净、kind 过滤、metrics 计数）
    └── load*.test.ts     # 真实 dsh 运行时加载冒烟（含捕获队列串行、背压丢弃、启动导入）
    └── errors-0.7.test.ts # 0.7.0 错误基础设施专项（错误码契约/包装/信息提取，errors.ts 100% 覆盖）
```

---

## 5. 验证与交付

- **236 个测试**全绿（vitest）：存储 append-only/tombstone/removeMany/revision/compact/写失败错误码/
  并发写、BM25 召回质量（长度归一化/词频饱和/评分可复算/稀有词 IDF）、IndexCache 复用与指纹失效、
  查询规范化（NFKC/停止词边界）、长文本 Jaccard 退化、损坏隔离留证、compact 自检、exportAll 往返、
  去重预筛语义等价、敏感绕过（NFKC/全角/云厂商 key）、捕获队列串行、背压丢弃计数、工具错误码、
  metrics 注入计数、kind 过滤、status metrics/diagnostics、契约纯净、真实 dsh 运行时加载冒烟、
  0.5.0 新增：容错召回（A1）、语义特征/签名与覆盖率（A2）、价值感知（A3）、热度生命周期（A4）、
  评估门限（A5，engine-0.5 25 + heat-0.5 9 + significance-0.5 5 + eval 6），
  0.6.0 新增 21 个（importer-0.6 19：文档切块/会话提取/kind 推断/内容级幂等/敏感过滤/短块丢弃/
  真实语料端到端「导入→索引→召回真实词」；load 新增 2：启动导入成功可召回、路径缺失仅告警不阻断），
  以及 0.7.0 新增 29 个（errors-0.7 11：ErrorCodes 契约/MemoryHubError 构造/toMemoryHubError 包装
  /errorMessage 三分支；text-0.7 11：text/tool-result/嵌套递归/标量与边界 + importer re-export 等价性；
  ingest-0.7 7：空候选零副作用/敏感拒绝/窗口去重/窗口外不判重/字段组装/超长截断/workspace 缺省），
  以及 0.9.0 新增 30 个（upgrade-0.9 14：探针转正 + mode 三档/strict 遗忘/词法派生一致性；
  store-fault +6：corrupt 幂等/容错双分支/closed 后操作抛错；index-lifecycle +3：捕获栅栏/decay 分支）——
  **325 项全绿**（0.10.0 新增 G6 真实数据门 1 项）；
- **A5 离线质量评估（`npm run eval`）**：固定 seed 黄金语料 G1 精确（80 查询）/G2 模糊（30 错拼）/
  G3 语义（9 词根变体）/G4 热度（冷却排序）四场景实测 **recall@1 = 1.0**；27 组合参数网格
  （k1×b×heatHalfLifeMs）实测**默认参数 k1=1.2/b=0.75/7d 不劣于任何组合**（b=0.5 全组合 recall@1 塌缩为 0，
  反证长度归一化系数的最优带），报告落盘 `eval/reports/quality-report.md`（标题版本自动取自 package.json）；
  0.10.0 新增 **G6 真实数据门**：Node.js v26.10.0 官方文档快照（SHA-256 固化）经生产同路径 `planImport`
  入库 329 条真实记忆 + 24 个真实问句（语义锚标注）——实测 recall@1=0.7917 / recall@3=0.8750 /
  recall@5=0.9583 / MRR=0.8542，门限冻结 recall@1 ≥ 0.75 / @3 ≥ 0.85 / @5 ≥ 0.95，锚点完整性守卫防语料漂移；
- 覆盖率阈值守护：`npm run test:coverage`（实测 lines 100 / branches 97.89 / functions 100 /
  statements 100，门槛 lines ≥96.5 / branches ≥95 / functions ≥97 / statements ≥96.5 固化于 `vitest.config.ts`）；
- 构建验证：`tsc --noEmit`（strict + exactOptionalPropertyTypes 等）零错误、`eslint` 零告警、
  `prettier --check` 全一致（固化语料/生成物入 ignore）、`tsup` 产出 ESM + d.ts、`npm run bench`
  （性能与检索质量对比基准通过，BM25 vs cosine top@1 命中率以 `[bench]` 前缀真实输出）；
- CI：`.github/workflows/ci.yml` 在 node 18/20/22 上全量执行 typecheck/lint/format/test/build + coverage，
  另有独立 `quality-eval` job 执行 `npm run eval` 离线质量门限（含 G6 真实数据门）；
- 打包交付：`npm pack` 产出 `dsh-memory-hub-0.10.0.tgz`，用户可
  `dsh plugin --profile web add ./dsh-memory-hub-0.10.0.tgz` 或"插件管理 → 输入包名"安装。

---

## 6. 风险与约束

- dsh 处于 developer preview，存在兼容性破坏变更；本插件 pinned 官方包 peer 版本范围
  （cordis ^4.0.1-rc.1 / dsh-tools ^0.0.1-rc.1），并在 README 给出版本适配说明。
- 自动捕获为启发式提炼，无法保证 100% 语义准确；提供开关与"显式记忆"作为可靠路径。
- 隐私边界：不采集模型凭据；默认不跨工作区投放记忆；敏感内容模式过滤。
