# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.10.0] - 2026-10-05

### Added（真实数据接地，G6 真实数据门）

- **G6 真实数据门（real-data grounding gate）**（`eval/realdata.ts` + `eval/realdata/`）：把离线质量评估从"固定 seed 合成黄金语料自证"升级为"**真实数据验证 + 合成语料回归**"双轨——
  - **真实可信语料**：Node.js 官方 API 文档（path / os，**固定 tag v26.10.0** 快照，SHA-256 固化在 `eval/realdata/MANIFEST.md`），随仓库分发、评测不联网、跨机器逐字节可复现；
  - **生产同路径入库**：真实文档文本走 `planImport`（`splitDocument` 切块 → kind 推断 → 敏感过滤 → 长短校验 → 内容哈希幂等 id）→ `MemoryEntry[]`，与插件启动时 `importSources` 的真实数据接入路径**完全一致**，验证的不是"评估自证"而是"插件对接真实数据"本身；
  - **真实问句 + 语义锚标注**：24 个真实 API 使用问句（英文），以 API 专名/关键短语为**语义空间锚**标注相关记忆（涵盖标题块/描述块/示例块，避免切块错位低估真实召回）；锚点完整性守卫（任一查询锚命中为空即门禁红，语料漂移可检测）；
  - **保守可复算门限**：实测基线 recall@1=0.792 / recall@3=0.875 / recall@5=0.958 / MRR=0.854，门限冻结为 **recall@1 ≥ 0.75 / recall@3 ≥ 0.85 / recall@5 ≥ 0.95**——真实文档含代码块/多段落，不可能像合成语料那样 100% 第一答命中，但 top-3/top-5 必须高置信；
  - **报告并入**：`npm run eval` 生成的质量报告新增 G6 场景段落（条目数/查询数/全指标），G1–G5 合成语料门限**全部保持**（兼容性零回归）。

### Changed（改进）

- 既有 324 项测试全部保持通过并扩展至 **325 项**（新增 G6 真实数据门断言 + G6 报告场景）；覆盖率 **lines 100 / branches 97.89 / functions 100 / statements 100**（branches 97.87 → 97.89 微升）；
- `.prettierignore` 新增 `eval/realdata/` 与 `eval/reports/`：固化语料逐字节不可变（MANIFEST 哈希一致性），生成物不参与格式门；
- `npm run eval` 六门限 → **七门限**（G1–G6），`npm test` / CI `quality-eval` job 自动涵盖真实数据门；
- 文档同步：README / docs/ARCHITECTURE 更新至 0.10.0，真实数据接地全过程与实测对比见 `docs/GROUND-0.10.md`。

### 兼容性

- 四工具签名（memory_store / memory_recall / memory_forget / memory_status）、`MemoryEntry` 数据契约、`cordis.patch.yml` 安装方式**完全不变**；
- **纯函数零外部依赖**立场不变（G6 语料随包分发，不新增任何 npm 依赖、评测不联网）；既有 324 项测试逐项复证（325 项全绿）；
- 合成语料评估（G1–G5）门限与报告格式不变，仅追加 G6 段落；不配置 `importSources` 的运行时行为与 0.9.0 完全一致。

## [0.9.0] - 2026-10-05

### Added（16 项薄弱项深度闭环）

- **漂移免疫词法（B/M）**：`STRONG_TERMS` / `BALANCED_STRONG_TERMS` / `BASIC_TERMS` 单一事实源，`STRONG_HINTS` / `BALANCED_STRONG_HINTS` / `PREFERENCE_HINTS` 全部由词表编译派生——裸「务必/一定」conservative 漏记修复（探针 B2 `[]` → 捕获，kind=preference），跨表漂移从运行期 bug 变为编译期不可能；`ImportOptions.mode` 落地为 `inferKindWithMode` 三档推断强度（conservative 仅强信号 / balanced 默认现状 / aggressive），文档分支真实消费。
- **共享默认隔离（J）**：未标注 workspace = 全局共享——`memory_status` 过滤改为 `e.workspace === undefined || e.workspace === args.workspace` 与引擎对齐；tools/result 捕获按 `exec.agent.session.header.cwd` 溯源真实 workspace（不再永远为全局），session/event 捕获继续沿用 `session.header.cwd`。
- **双尺度时间语义（Q）**：`RecallOptions` 新增 `decay`（默认 true）与 `decayHalfLifeMs`（默认 7d 显式化）可注入；插件默认 `recallDecayHalfLifeDays=0` **关闭评分衰减**——`ttlDays=0`「永不过期」升级为「可检索」，60 天记忆不再被写死半衰期压到 1/4000 而不可召回。
- **写入路径工程化（C/D/N）**：ingest 批内瞬时去重（同批同文只入库 1 条，`rejectedDuplicate++`）；dispose 捕获栅栏（先 `await captureChain` 排空在途捕获再 `close()`，卸载丢写竞态消除）；recall 热度合并回写（同 id 窗口内只写一次，抗刷）+ flush 失败计入 `metrics.errors` + logger（不再被 allSettled 吞）。
- **签名候选预筛（K）**：MinHash 从预留落地为真实候选剪枝——大查询（特征集 > `MINHASH_K`）先 O(K) 签名预筛（保守阈值 = 覆盖率×2/3），只剪不相干文档、评分语义不变；小查询路径零变化。
- **契约显式化（E/G/H/A'/O/S/F/L）**：`.corrupt` 幂等留证（重启不重复追加）；`extractSessionText.isUser` 正式消费（`inferSpeakerKind`：助手复述偏好降 generic、指令保持 instruction）；`memory_forget` 新增可选 `strict`（未命中抛 NOT_FOUND，错误码首次真实使用）；recall `kind` 参数 schema enum 收紧（非法 kind 统一 `ToolArgsError`，与 store 同形态）；`snapshots()` 零拷贝共享 + 写时重建（读路径 O(1)）；`significanceWeight` 的 `?? 1` 兜底移除（Record 全键在编译期拦截）；`extractTextBlocks` 词边界感知分隔（英文跨块补空格，中文/标点逐字节不变）；`autoTags` 从死配置变为真实开关（false 清空自动标签）。

### Testing（测试纵深）

- 既有 294 项测试全部保持通过并扩展至 **324 项**（新增 30）：`upgrade-0.9.test.ts`（14 项探针转正：B/C/E/F/G/H/J/K/L/M/N/O/Q + mode 三档 + strict 遗忘）、store-fault 扩充 +6（corrupt 幂等 / 容错 Error 与 String 双分支 / closed 后三操作抛错）、index-lifecycle +3（捕获栅栏时序 / decay 挂载分支）与其他细化；
- 覆盖率 **lines 100 / branches 97.87 / functions 100 / statements 100**（branches 96.1 → 97.87，store.ts 93.13 → 100 —— 15 个 src 文件 lines 全 100）；阈值保持 lines ≥96.5 / branches ≥95 / functions ≥97 / statements ≥96.5 不变；
- `tsc（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）/ eslint 9 / prettier / eval（G1–G5 六门限全绿，recall@1=1.0）/ bench（BM25 top@1 命中率 100%，80/80）` 全过。

### 兼容性

- 四工具签名（memory_store / memory_recall / memory_forget / memory_status）、`MemoryEntry` 数据契约、`cordis.patch.yml` 安装方式**完全不变**；
- **纯函数零外部依赖**立场不变（不新增任何 npm 依赖）；既有 294 项测试逐项复证（324 项全绿）；
- 渲染文本与错误码**逐字节不变**（render 函数与既有错误码常量零改动；NOT_FOUND 仅显式 `strict:true` 才抛出）；新增配置键（`recallDecayHalfLifeDays`）默认 0 与工具可选参（strict）默认关闭，未配置时行为与 0.8.0 完全一致。

## [0.8.0] - 2026-10-05

### Changed（全模块薄弱项升维）

- **插件生命周期与错误路径全量可测**（L1–L4，`src/index.ts` 分支 70.21 → 85.07）：以真实 `Context` + 可注入故障的 MockStore 驱动插件级测试——正常卸载/close 失败卸载、工具注册失败不阻断其余、store open 失败仅告警、pruneOnce 三路径（ttlDays≤0 早退 / removeMany 批量 / 逐个 remove 回退 / prune 失败）、捕获队列背压 256 边界（260 事件冲刷恰好 256 入库、越限即丢）、捕获任务失败链不中断、ttlDays>0 定时器注册与卸载清理；
  - **测试环境适配**：vitest ESM 转换下 `ctx.plugin(import * as plugin)` 不采用 apply 返回的 disposer（Node 原生 ESM 直跑对照组验证为环境特性），`mountPlugin()` 包装器显式组装 `{ name, apply, inject }` 对象后挂载，disposer 链（监听/工具注销、store close）恢复真实驱动，并消除了测试侧 `as never` 强转。
- **工具输出契约从黑盒变白盒**（L5–L8，工具函数覆盖 71.42 → 100）：四个工具的 `render` 全分支直调单测（dsh-tools 允许 `render(args, value)` 直调）——status 空库/全形态/diagnostics 缺省、recall 零命中/多命中/token 预算、forget removed/not found、store workspace 注入与 tags 清洗截断边界。
- **engine 防御分支闭环 + 死代码移除**（L9）：18 处守卫分支专项测试（`engine-guard-0.8.test.ts`：minhash 签名/覆盖率守卫、df 缺失 IDF 平滑兜底、空查询、windowMs≤0、ttlDays≤0、未知 kind 兜底）；经**不变式证明**移除三处不可达分支（`minhashCoverage` 的 `inter≤0`、`similarity` 的 `maxLen===0`、`levenshtein` 的 `!a.length`/`!b.length` 空串分支）并留证注释，engine.ts branches 100%。
- **store 容错告警路径故障注入**（L10）：`vi.mock('node:fs/promises')` 包装真实实现后注入 compact 写失败 / 自检行数 mismatch / 自检读失败 / 隐私文件 chmod 失败四类故障，断言告警且条目不受损。
- **capture 强度词语义去重**（L11）：conservative/balanced 两处内联强度词正则抽为共享 `STRONG_HINTS` / `BALANCED_STRONG_HINTS` 常量（语义各自保留、grep 无重复列表），强弱信号分支补齐直测。
- **剩余分支与类型断言清零**（L12–L15）：importer 非对象 JSON 行、`toMemoryEntry` 可选字段拷贝分支补齐；`memory-status.ts` 双断言 `as unknown as { diagnostics? }` 提纯为 `DiagnosticsProvider` 接口 + `'diagnostics' in store` 类型守卫；`memory-recall.ts` 抽 `RecallOutput` 接口复用 execute 返回与 schema 形状；`src/index.ts` 工具注册类型精确为 `Array<() => () => void>` 消除 disposer 断言——**src 断言计数不增，质变点全部落测试**。
- **覆盖率阈值与 0.8.0 实测同步冻结**：`vitest.config.ts` 阈值提升至 **lines ≥96.5 / branches ≥95 / functions ≥97 / statements ≥96.5**（杜绝"门槛与实测脱节"重演）。

### Testing（测试纵深）

- 既有 236 项测试全部保持通过并扩展至 **294 项**（新增 58）：engine-guard-0.8（18 项守卫/兜底）、store-fault-0.8（5 项容错故障注入）、edge-0.8（12 项 capture 强弱信号/importer 回落/toMemoryEntry 拷贝）、tools-render-0.8（12 项四工具 render 全分支 + workspace/tags/截断/错误码守卫）、index-lifecycle-0.8（11 项生命周期/错误路径/背压/定时器）；
- 覆盖率 **lines 100 / branches 96.1 / functions 100 / statements 100**（新阈值 96.5 / 95 / 97 / 96.5 达标），较 0.7.0 全维度上升；`engine.ts`、`importer.ts`、`text.ts`、`metrics.ts`、`ingest.ts`、`types.ts`、`memory-store.ts` 均 **100%**；
- `tsc（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）/ eslint 9 / prettier / tsup / bench（BM25 top@1 命中率 100%）/ eval（G1–G5 六门限全绿，recall@1=1.0）` 全过。

### 兼容性

- 四工具签名（memory_store / memory_recall / memory_forget / memory_status）、`MemoryEntry` 数据契约、`cordis.patch.yml` 安装方式**完全不变**；
- **纯函数零外部依赖**立场不变（不新增任何 npm 依赖）；既有 236 项测试逐项复证（294 项全绿）；
- 源码升维全部为**行为等价重构**（常量提取/类型提纯/接口抽取/死代码移除），工具输出文本与错误码语义逐字节不变（render 直测复证）。

## [0.7.0] - 2026-10-05

### Changed（世界性代码质量升级）

- **守门强度与实测对齐**（U1）：`vitest.config.ts` 覆盖率阈值从 0.4.0 时代的 `93.04/85/88.91/90` 提升至 **lines 94.71 / branches 89.71 / functions 95.14 / statements 94.71**（对齐用户硬约束并留实测安全垫），杜绝"功能函数可删 10 个百分点而不被 CI 拦截"的守门虚设；README / ARCHITECTURE / QUALITY-0.7 全文档数值一致，消除文档-配置双重漂移。
- **重复实现合并去重**（U2）：`src/index.ts` 私有 `blocksToText` 与 `src/memory/importer.ts` 的 `extractTextBlocks` 是同一逻辑两份实现，现归一到**唯一实现** `src/memory/text.ts`（导出 `extractTextBlocks`），index.ts / importer.ts 复用，`importer.ts` re-export 保持既有导入路径兼容；新增 text 专项测试 + re-export 等价性测试 11 项，text.ts 覆盖率 100%。
- **错误基础设施沉淀**（U3）：`errorMessage` 从 index.ts 私有函数提升为 `src/errors.ts` 全局导出唯一入口（MemoryHubError → `CODE: message` 保留稳定错误码、Error → message、其余 → String 兜底），index.ts 9 处告警日志统一复用；`toMemoryHubError` 补齐专项测试，**errors.ts 覆盖率 100%**（此前 71.42%）。
- **评估管线版本自动读取**（U4）：`eval/eval.test.ts` 从 `package.json` 读取 `version` 注入报告，消除 0.6.0 已漏改的硬编码漂移（报告标题将自动跟随版本）。
- **CI 纳入评估门限**（U5）：`.github/workflows/ci.yml` 新增独立 `quality-eval` job 执行 `npm run eval`（离线质量门限，可复算、确定性），评估不再游离于任何 CI 路径之外；bench 按既有设计注释保持不进 CI。
- **bench 质量对比可观察**（U6）：`bench/recall.bench.ts` 无操作占位 `recordRatio` 替换为真实输出——BM25 与 cosine 基线 top@1 命中率以 `[bench]` 前缀直接落 stdout（vitest bench 模式下 afterAll 不执行，故改为任务内输出 + 去重），消除不可观察死代码。
- **类型断言提纯**（U7）：`engine.ts` 的 `minhashSignature` 改 `MINHASH_SEEDS.entries()` 迭代、`fuzzyVariants` 改 `charAt` 消除下标断言，src 非空断言从 **69 处降至 4 处**（降幅 94%，超额完成 ≥40% 目标），剩余 4 处均为 `levenshtein` 滚动数组且带算法不变式证明注释；typecheck 零错误。
- **ingest 拆分与直接单测**（U8）：捕获入库管线（敏感过滤 / 窗口去重 / 超长截断 / 防污染 id / workspace 注入 / 指标计数）自 `src/index.ts` 拆出为 `src/memory/ingest.ts`（导出 `ingestCaptured` + `IngestOptions`，行为严格等价），index.ts 聚焦"接线"；新增 ingest 专项测试 7 项覆盖全部分支，**ingest.ts 覆盖率 100%**。

### Testing（测试纵深）

- 既有 207 项测试全部保持通过并扩展至 **236 项**：errors-0.7（11 项错误码契约 / MemoryHubError / toMemoryHubError / errorMessage 全覆盖）、text-0.7（11 项提取边界 + importer re-export 等价性）、ingest-0.7（7 项入库管线全分支）；
- 覆盖率 **lines 95.59 / branches 91.19 / functions 96.07 / statements 95.59**（新阈值 94.71 / 89.71 / 95.14 / 94.71 达标），较 0.6.0 全面上升；新增模块 errors.ts / text.ts / ingest.ts 覆盖率均 **100%**；
- `tsc（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）/ eslint 9 / prettier / tsup / bench / eval` 全过。

### 兼容性

- `MemoryEntry` 数据契约、4 个工具名与参数、安装方式（tgz + `dsh plugin add` / 桌面插件页）完全不变；
- `cordis.patch.yml` 安装方式不变；不新增任何 npm 依赖（纯函数零外部依赖立场不变）；
- U2 的 `extractTextBlocks` 同时保留 `src/memory/importer.ts` re-export 与 `src/memory/text.ts` 直导，既有导入路径全部兼容；U8 的 `ingestCaptured` 与原私有 ingest 行为严格等价（既有 236 项测试逐项复证）。

## [0.6.0] - 2026-10-05

### Added（真实数据接入，接地）

- **真实数据接入层**（`src/memory/importer.ts`，方案见 `docs/REALDATA-0.6.md`）：让插件**开箱即有记忆**——把用户已经沉淀的真实数据资产批量接入记忆库，三条路径全部为纯函数、零外部依赖：
  - **Markdown 记忆文档导入**（AGENTS.md / MEMORY.md / USER.md / 任意 `.md`/`.txt`）：`splitDocument()` 稳定切块（标题/列表/连续段落聚合，纯链接索引行跳过），推断 `instruction`/`preference`/`generic` kind，`source: 'explicit'`；
  - **Harness 会话事件日志导入**（JSONL）：`extractSessionText()` 宽容解析 `user/message`（取 `data.content`）与 `assistant/message`（取 `data.message.content`，缺省回退 `data.content`），损坏行只计数不阻断，`source: 'auto'`；
  - **内容级幂等**：id = `imp-${contentHash(content)}`，同一内容跨文件/跨时间重复导入自动合并（`importAll` 天然去重），重复导入第二次新增数为 0；
- **插件启动导入接线**（`src/index.ts` + `src/config.ts`）：新增**可选**配置键 `importSources`（`documents?` / `sessionLogs?`），store 就绪后逐个读文件 → `planImport` → `importAll`；路径不存在/解析失败**仅告警计数，绝不阻断插件启动**；**未配置时行为与 0.5.0 完全一致**（默认空数组）；`memory_recall` 可直接召回导入的真实记忆（复用 0.5.0 全部 BM25/容错/语义/热度/价值评分）；
- **真实语料端到端验收**：测试读取仓库**真实** `README.md` + `CHANGELOG.md` 走「导入 → importAll → buildIndex → queryIndex」全链路（assert 真实词 `BM25`/`dsh-memory-hub`/`memory_recall` 可召回），不再是合成黄金语料自证。

### Changed（改进）

- 既有 186 项测试全部保持通过并扩展至 **207 项**：importer-0.6（19 项切块/会话提取/kind 推断/幂等/敏感过滤/真实语料端到端）、load 新增 2 项启动导入冒烟（导入成功 + 路径不存在仅告警）；
- 覆盖率 **lines 94.71 / branches 89.71 / functions 95.14**（门槛 lines 93.74 / branches 88.97 / functions 85 达标，`vitest.config.ts` 固化），`importer.ts` 自身 lines 100% / branches 98.59%；
- Hook 接线零侵入：仅在 `index.ts` 增加一个 `importSources()` 内部函数（可选配置读取后即返回），既有事件捕获、工具注册、TTL 清理、disposer 链路未改一行；
- 文档同步：`README` / `docs/ARCHITECTURE` 更新至 0.6.0，方案全文见 `docs/REALDATA-0.6.md`。

### 兼容性

- `MemoryEntry` 数据契约、4 个工具名与参数、安装方式（tgz + `dsh plugin add` / 桌面插件页）完全不变；
- `importSources` 为 schemastery **可选**配置键（`Schema.object(...)`，默认 `{ documents: [], sessionLogs: [] }`）：不配置即零导入、与 0.5.0 逐项行为一致（既有 186 项测试逐项复证）；不新增任何 npm 依赖；
- 导入产出的 `MemoryEntry` 与实时捕获共享受检：敏感过滤（NFKC 归一化）、短块（<8 字符）丢弃、`maxChars` 截断——离线批量导入不绕过任何隐私与质量防线。

## [0.5.0] - 2026-10-05

### Added（深度创新升级）

- **A1 模糊查询扩展（fuzzy query expansion）**（`engine.ts`）：查询中的英文纯字母词（长度 ≥4）生成编辑距离 ≤1 变体（删除/交换/替换/插入）并入候选词典；仅当精确 BM25 零命中时以 0.5 折扣兜底，绝不干扰精确命中排序——"拼错了也能找到那条记忆"（A1 代号，方案见 `docs/INNOVATION-0.5.md`）。
- **A2 MinHash 近似语义召回（semantic recall）**（`engine.ts`）：英文/数字 token 展开为字符 3-gram（首尾边界标记）作为语义特征空间，随 `buildIndex` 缓存 k=16 FNV-1a MinHash 签名（未来 LSH 剪枝资产）；评分采用**精确查询覆盖率**（|Q∩D|/|Q|，零估计误差，规避小特征集 MinHash 方差），覆盖率 ≥0.45 才进入 0.3 权重兜底——"没记住原话，换个说法也能回忆起"。
- **A3 记忆价值感知评分（significance-aware）**（`engine.ts`）：显著性权重 = 类型系数（指令 1.25 > 决策 1.15 > 偏好 1.05 > 事实 1.0 > 泛化 0.95）× 来源系数（显式记忆 1.1 > 自动 1.0），乘入运行时评分——"用户明说的指令/决策"天然高于流水账事实；`significance: false` 可关闭（可复算/调参）。
- **A4 记忆生命周期自适应热度（heat lifecycle）**（`engine.ts`）：`heat = 1 + 0.1·log1p(accessCount)·temporalDecay`，`temporalDecay = exp(−Δ/半衰期)`（默认 7 天，`heatHalfLifeMs` 可注入）——久未访问的高频旧记忆按 Ebbinghaus 遗忘曲线冷却、近期验证过的记忆保持热度，修复"3 个月前高频琐事长期霸榜"；`accessCount=0`/`lastAccessAt` 缺失的历史数据语义与 0.4.0 完全一致。
- **A5 离线质量评估套件（eval harness）**（`eval/`）：固定 seed 黄金语料四场景（G1 精确质量 80 组 / G2 模糊召回 30 组错拼 / G3 语义召回 9 组词根变体 / G4 热度冷却）+ recall@1/3/5、MRR、NDCG@k 指标 + k1×b×heatHalfLifeMs 27 组合参数网格敏感性；`npm run eval` 一键可复算，报告落盘 `eval/reports/quality-report.md`。

### Changed（改进）

- 既有 141 项测试全部保持通过并扩展至 **186 项**：engine-0.5（25 项模糊/语义/签名）、heat-0.5（9 项热度生命周期）、significance-0.5（5 项价值感知）、eval 门限（6 项含参数网格 oracle）；G1/G2/G3/G4 实测 recall@1 = 1.0；
- 覆盖率 **lines 93.74 / branches 88.97**（门槛 lines 93.04 / branches 88.91 达标），阈值已固化进 `vitest.config.ts`；
- `npm run eval` 评估入口、`tsconfig`/vitest include 纳入 `eval/`（tsc/eslint/prettier 全绿）；参数网格实测 b=0.5 全组合 recall@1 塌缩为 0，反证默认 b=0.75 的唯一最优性；
- 文档同步：`README` / `docs/ARCHITECTURE` 更新至 0.5.0，方案全文见 `docs/INNOVATION-0.5.md`。

### 兼容性

- `MemoryEntry` 数据契约、4 个工具名与参数、安装方式（tgz + `dsh plugin add` / 桌面插件页）完全不变；
- A1-A4 全部落在引擎内部评分路径（`fuzzy`/`semantic`/`heatHalfLifeMs`/`k1`/`b`/`significance` 均为 `RecallOptions` 可选注入），工具输出 schema 不变；词面精确命中场景的排序语义与 0.4.0 兼容（既有 141 项测试逐项复证）；
- **实现修正**：INNOVATION-0.5 §3.3 原设计的 density 维度（内容 <20 字符 ×0.9）在实现阶段发现与既有质量断言「精炼短记忆优先于长尾文档」（0.4.0 长度归一化）直接冲突——短小精悍的指令记忆恰是最高价值记忆，按硬约束（既有测试全绿）移除 density，A3 仅保留 kind × source 两维；保证短记忆价值不被惩罚。

## [0.4.0] - 2026-10-05

### Added（世纪级升级）

- **Okapi BM25 排序检索**（`engine.ts`）：替换 TF·IDF cosine 为 BM25（k1=1.2, b=0.75）——词频饱和 + 文档长度归一化，长尾/泛化文档不再天然压过精炼短记忆；IDF 平滑（df=0 不除零）；空查询短路保持 0.3 语义。
- **查询规范化与停止词**：查询与索引 token 统一 NFKC 折叠（全角/异体英文与半角等价）；英文停止词过滤（`the/a/is/of` 等不占索引槽）；纯停止词查询返回空数组，不误召回全库。
- **`IndexCache` 内容指纹失效**：sha256 指纹（id+content+tags）叠加 revision 双重判定——revision 变但内容未变（纯热度更新）复用旧索引，内容变化才重建，缓存命中语义精确。
- **存储自愈：损坏行隔离留证**（`store.ts`）：跳过损坏 JSONL 行时自动备份原文至 `<file>.corrupt`（0600、追加写、失败仅告警），损坏数据可追溯、主文件不受污染、corrupt 计数语义不变。
- **compact 自检**：原子重建（tmp + rename）后重读新文件核对行数与内存条目数，不一致仅告警（延续"compact 是优化路径、绝不吞写"容错哲学）。
- **`exportAll()` 完整迁移闭环**：`MemoryStore` 新增可选成员，与既有 `importAll` 对称——`JSON.parse(exportAll())` 可直接喂给新实例 importAll，跨设备迁移数据往返无损（含空库与 closed 抛错边界）。

### Changed（改进）

- 既有 113 项测试全部保持通过并扩展至 **141 项**：BM25 质量回归（长度归一化/词频饱和单调/评分可复算/稀有词 IDF）、NFKC 查询规范化、停止词边界（过滤与纯停止词空结果）、指纹缓存复用（热度更新不重建）与重建、长文本 Jaccard 退化路径、损坏隔离留证（隔离文件到位 + 计数不变）、compact 自检、exportAll→importAll 往返、size 诊断等 28 项新增；
- 覆盖率 **lines 93.04 / branches 88.91**（门槛 91.68 / 87.91，达标）；`tsc / eslint / prettier / tsup / bench` 全过；
- `npm run bench` 新增"IndexCache 热度更新复用"与"BM25 vs cosine top@1 质量对比"基准（质量对比可复算：cosine 0% → BM25 100%）；
- 文档同步：`README` / `docs/ARCHITECTURE` / `docs/CENTURY-0.4.md` 全量更新至 0.4.0。

### 兼容性

- `MemoryEntry` 数据契约、4 个工具名与参数、安装方式（tgz + `dsh plugin add` / 桌面插件页）完全不变；
- `MemoryStore` 接口新增 `exportAll?` 可选成员（`removeMany?` / `revision?` / `diagnostics?` 保持既有可选语义），自定义实现仍向后兼容。

## [0.3.0] - 2026-10-05

### Added（新功能）

- **运行指标体系（`HubMetrics`）**：捕获入库 / 显式存储 / 召回次数与命中 / 遗忘 / 敏感拒绝 / 去重拒绝 / TTL 清理 / 背压丢弃 / 错误计数，全量 10 项指标；`memory_status` 输出 `metrics` 快照，卸载时输出结构化汇总日志。
- **有界捕获队列（背压）**：捕获队列上限 256，事件洪水时丢弃最早期任务并计数 `dropped`，保护进程内存有界。
- **`removeMany(ids)` 批量删除**：单次落盘多行 tombstone + 单次 compact 判定，TTL 清理一次 prune 一次落盘批次。
- **`memory_recall.kind` 过滤参数**：可按 `decision/fact/preference/instruction/generic` 精确召回。
- **存储诊断（`diagnostics`）**：`memory_status` 输出 `lines/corrupt` 存储健康信息。
- **`CHANGELOG.md` 与 CI 工作流**：GitHub Actions（node 18/20/22 × typecheck/lint/format/test/build）；`npm run check` 一键全检。

### Changed（改进）

- **写一致性升级**：`upsert/removeMany/importAll` 改为**先落盘成功后再变更内存**，并发读者永远只看到已确认状态，写失败天然无残留（移除原回滚逻辑）。
- **快照缓存**：`list()` 热路径命中缓存 O(N) 拷贝返回，避免每次全量排序；任何结构性写入置脏。
- **倒排索引缓存（`IndexCache`）**：`memory_recall` 按存储 `revision` 复用索引，语料未变时召回免全量 `buildIndex`，显著降低高频召回开销。
- **去重加速**：`isDuplicate` 增加精确命中短路与长度窗口预筛（阈值语义不变），大库去重显著提速。
- **错误分级完整化**：存储写入失败统一抛 `MemoryHubError(STORE_WRITE_FAILED)`，与读取失败同级可编程处理；存储目录创建失败同样包装为 `STORE_WRITE_FAILED`。
- **compact 容错**：重建失败仅告警，绝不把"已成功写入"的调用变成失败。
- **全量代码质量前沿化**：
  - 空查询语义修正：tokenize 无检索词（纯标点/空白）的召回返回空数组，不再按热度误召回全库；
  - 隐私权限细化：记忆文件首次创建即 0600（`appendFile` 显式 mode，不依赖 umask）；目录 0700 仅对**本插件新建**的目录生效，既有共享目录权限保持不变；
  - `memory_forget` 对 id 统一 trim，删除副作用与返回值一致；
  - 类型纯度：capture 非空断言消除、引擎编辑距离滚动数组 O(1) 行交换（原 O(n) 拷贝）、`IndexCache` 构建零断言写法，保留断言均附算法不变式证明注释；
  - 性能资产：新增 `bench/recall.bench.ts`（vitest bench，`npm run bench`）量化 1K/10K 库召回/索引/缓存热点；
  - 测试纵深：新增空查询短路、mkdir 失败错误码、目录权限细化、首写即 0600、forget trim、千级大库召回一致性共 13 用例（113 全绿；覆盖率 lines 91.68 / branches 87.91，均较上版提升）。

### Fixed（缺陷修复）

- 修复 `appendRaw` 写失败未包装为稳定错误码的问题（此前为原始 `Error`）。

### 兼容性

- `MemoryEntry` 数据契约、4 个工具名与参数、安装方式（tgz + `dsh plugin add` / 桌面插件页）完全不变；
- `MemoryStore` 接口仅增加可选成员（`removeMany?` / `revision?` / `diagnostics?`），自定义实现仍可向后兼容。

## [0.2.0] - 2026-10-05

### Added

- TF·IDF 倒排索引检索（中文 2-gram + 英文单词分词、稀有词提权、评分基准可注入）；
- NFKC 归一化敏感过滤（防全角/异体字符绕过），新增 AWS/GitHub/Slack/GCP/私钥/连接串模式；显式记忆同样拒绝敏感明文；
- 专用 `extractFromAssistant` 提取器（aggressive 模式），修复 assistant 误用工具结果提取器；
- `randomUUID()` 身份、目录 0700 / 文件 0600 隐私权限；
- `MemoryHubError` 稳定错误码（EMPTY_CONTENT / SENSITIVE_CONTENT / STORE_* / NOT_FOUND / INTERNAL）；
- eslint 9（typescript-eslint）+ prettier + vitest 覆盖率阈值 + prepack 守护；
- 测试 77 个（并发写、tombstone/compact、召回质量、敏感绕过、捕获队列、契约纯净等）。

### Changed

- 存储从每次全量重写升级为 append-only JSONL + tombstone 逻辑删除 + compact 原子重建。

### Security

- 修复全角/异体字符绕过敏感过滤的 Unicode 安全问题。

## [0.1.0] - 2026-10-05

- 首个可安装版本：本地 JSONL 会话记忆库、四工具（store/recall/forget/status）、事件驱动自动捕获；
- 基础 TF·IDF 检索、去重窗口、TTL 清理；38 个测试。
