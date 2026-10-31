# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
历史版本的设计全文见 `docs/history/`；本文件只保留**面向使用者的变更摘要**。

## [1.6.0] - 2026-10-31

应用级出口版：roadmap 最后一项「跨平台 GUI 记忆管理（桌面级应用：编辑/导入导出 UI/多库管理）」
以**独立应用级交付物**关闭。本仓库侧变更刻意最小——新增 `./core` 纯库子路径导出，
领域语义单一事实源不变。设计全文见 `docs/DESIGN-1.6.md`；应用见同级仓库 `dsh-memory-hub-gui`。

### Added

- **`./core` 纯库子路径导出**：`JsonlMemoryStore` / `recall` / `summarize` / `clusterThemes` /
  `makeEntry`（取代协议）/ `planImport` / `renderMemoryHtml` / `parseKeyRecord` /
  `containsSensitive` / 矛盾标注 / 数据模型守卫 / `MemoryHubError`——GUI 桌面端消费的
  全部领域语义经此单一出口；零新增逻辑零副作用，主出口 `lib/index.js` 字节不变
  （tsup 双入口独立打包）；
- **导出面锁定测试**：`test/core-export-1.6.test.ts`（导出形态 + 最小闭环，防止重构静默漂移）。

### External

- **`dsh-memory-hub-gui` 1.0.0**（同级独立仓库，MIT）：Electron 跨平台桌面记忆管理——
  多库管理（默认库与插件共享 `~/.dsh/memory-hub`）/ 编辑与取代协议 / 六线检索 + why 溯源 /
  三源导入（预览→提交，内容级幂等）/ JSON 迁移包 + 可视化 HTML 双导出 / 加密口令全生命周期
  （解锁·加密·轮换·解密回退·锁库）/ 维护统计视图；37 项单元测试 + 16 步无头 E2E 冒烟
  （截图门禁，隔离 userData 可重复运行）+ Windows/macOS/Linux 三 OS 打包与 CI 矩阵。

## [1.5.1] - 2026-10-31

可视化检索页版：roadmap「记忆时间轴 / 可视化检索页」项以仓库内可交付形态关闭。
设计全文见 `docs/DESIGN-1.5.md` §9（模块 P）。

### Added

- **模块 P 可视化检索页（HTML 导出）**：`memory_status { exportHtml: true }` 导出单个
  **自包含静态 HTML**（零外部依赖/零网络引用/可离线打开）写入存储目录
  `memories-view.html`（0600，与记忆库同权限保护）并返回 `htmlPath`/`htmlBytes`——
  记忆时间轴柱状视图（服务端确定性渲染，纯 HTML/CSS，新增/更新/热度/删除分色 +
  悬停全量计数，≤90 桶窗口）+ 检索页（全量语料安全 JSON 内嵌，浏览器本地即时评分
  排序——idf 加权拉丁词 + CJK 2-gram，类型过滤，DOM textContent 构建，不上传任何数据）；
  确定性（同 payload 逐字节可复算）、注入安全（内嵌 JSON `\u003c` 转义——真实语料含
  代码块尖括号下页面只允许两个合法 `</script>` 闭合）、`metrics.htmlExports` 观测；
  导出为明文观看工件（与加密存储正交）；缺省（exportHtml 缺席）输出与 1.5.0 逐字节一致。
- **评估门禁扩至 G1-G26**：G26 真实语料 1200 条全量导出——自包含零外链、注入安全、
  确定性采样 50 id 全嵌入、时间轴与 `store.timeline(90)` 同源、固定 generatedAt 两次
  渲染逐字节一致、POSIX 0600。

### Changed

- `createMemoryStatusTool` 新增 `opts.htmlDir`（插件入口注入存储目录；未配置时
  exportHtml 显式失败）；`memory_status` 参数面新增 `exportHtml`（缺省输出形状不变）。

### 工程纪律

- 单元测试 601 → 612（新增 11：纯函数 5 / 工具面 6），eval 69 → 70，总量 670 → 682；
  覆盖率门禁维持 ≥98/93/98。

## [1.5.0] - 2026-10-31

边界突破版：1.2-1.4 设计文档明文划出的**全部剩余边界**逐项收敛——口令轮换、图维 diff、
本地 HNSW 向量第六召回线、双语实体抽取、记忆时间轴（roadmap 两项未勾选项落地）。
设计全文见 `docs/DESIGN-1.5.md`。

### Added

- **模块 K 口令轮换与解密回退（DESIGN-1.4 未来工作收敛）**：`JsonlMemoryStore.changePassphrase`
  ——逐行原序重写（深回放历史完整保留，仅换密钥外衣；损坏行原样换新外衣仍走隔离留证）；
  加密→新口令（同口令再轮换 = 换盐密钥卫生）/ 加密→空口令（解密回明文）/ 明文→新口令 /
  明文→明文 no-op 四态语义矩阵；tmp+fsync+rename 原子替换，失败文件保持原状且**不毒化写链**
  （后续写入与 close 不受影响）；写锁被外部存活实例持有拒绝整文件重写（真子进程锁测试锁定）；
  `DSH_MEMORY_NEW_PASSPHRASE` 环境变量启动期触发一次（换口令 / 空串解密回退 / 明文库启用加密三臂）。
- **模块 L 图维时间对账（DESIGN-1.4 未来工作收敛）**：`TemporalGraph.activeEdgeList` +
  `diffGraphs` 纯函数（双侧 buildGraph 重建 + 活跃边差集——added = 新关系确立 /
  removed = tombstone 或取代失效）；`memory_status graphDiff` 参数（计数完整 + 边样本 ≤10，
  渲染 `graph: entities B→A, +E −R edge(s)`）；缺省 diff 输出与 1.4.0 逐字节一致。
- **模块 M 本地向量第六召回线（roadmap「向量召回后端（本地 HNSW）」落地）**：零依赖
  确定性 HNSW——层指派 fnv1a 哈希驱动（无 Math.random）、**近邻多样性选择**（论文
  Algorithm 4 + keepPruned 回填——单纯最近 M 个裁剪在簇状语料上图坍缩为不可达子图，
  此为本次实现的关键工程发现）、底层度上限 2M、贪心下降 + ef 束搜索；向量空间与 A2
  语义线同源（字符 3-gram + CJK 2-gram，sublinear TF·IDF + L2 归一化余弦）；interpolate
  线性叠加（权重 0.3）/ RRF 第六条秩融合（仅向量可达候选补录 + 同 id max 合并）/
  why.lines 溯源追加 `vector` 线；`VectorIndexCache` 按 (revision, 指纹) 复用；`vectorEnabled`
  配置 + `memory_recall vector` 参数 + `metrics.vectorHits`；真实规模校准：3333 真实文档
  HNSW vs 暴力全量 top-10 重叠 20/20 全一致、自检索 19/20、构建 7.2s/层高 3。
- **模块 N 双语实体抽取（DESIGN-1.2 §5 / DESIGN-1.3 §4 独立课题收敛）**：关系词表双语扩展
  （英文技术关系面 returns/throws/emits/supports/based on/written in/part of… + 中文对应面
  基于/支持/返回/抛出/改为/换成…）；宾语连词拆分（`A uses B and C` / `A 使用 B、C` 逐并列
  产出）；宾语前导冠词剥除 + 主语尾部系动词剥除 + **标识符内部点不再当句分隔**（node.js /
  fs.readfile 主宾语保形——补全 1.1.1「专名入图」承诺）；1.1.1 锁定语义全部保持
  （裸 the app 主语保留 / 词边界 / 置信度下限 / 去重）；无裸 is 关系（存现句不进图）。
- **模块 O 记忆时间轴（roadmap「记忆时间轴」落地）**：`timelineFromRaw` 纯函数——append-only
  日志单遍回放出按 UTC 日分桶的新增/删除/更新/纯热度事件流 + 存活总量走势（时钟偏斜钳 0、
  旧格式 tombstone 折算首桶前基线、复活计 added）；`store.timeline`（加密库解码后分桶）；
  `memory_status timeline` 参数（柱状渲染 `day │ ████ +A −R ~U (hH) = total`、≤31 桶截断）；
  降级 store 按 createdAt 近似；`metrics.statusTimeline`。
- **评估门禁扩至 G1-G25**：G23 向量真实规模（HNSW vs 暴力全量对拍 + 自检索 + 确定性 +
  融合接线 + 缺省零回归）；G24 双语抽取真实规模（新关系面产出非零 + 确定性 + 图边落地）；
  G25 边界操作真实规模（400 真实条目轮换保深回放 + diffGraphs 与手工差集一致 + 时间轴守恒）。

### Changed

- `fnv1a`/`semanticFeatures`（+ 计数版 `semanticFeatureCounts`）下沉 tokenize.ts、
  `fingerprint` 下沉 hash.ts（engine re-export 零调用方变更——vector.ts 位于 engine 之下，
  共享叶子设施避免循环依赖）；`MemoryStore` 可选新成员 `timeline?(cap?)`；
  `memory_recall`/`memory_status` 参数面新增 `vector`/`graphDiff`/`timeline`（缺省输出形状
  与 1.4.0 逐字节一致）。

### 工程纪律

- 缺省零回归：全部新能力默认关闭；开启前（含 vectorEnabled 显式 false）输出与 1.4.0
  逐字节一致（bit-exact 断言 + 固定 now 全等门）；
- 单元测试 528 → 601（新增 73：轮换 13 / 图维 8 / 时间轴 15 / 双语 11 / 向量 25），
  eval 66 → 69，总量 594 → 670；覆盖率 98.4/93.09/98.9/98.4（门槛 98/93/98 维持）。

## [1.4.0] - 2026-10-31

纵深防御与时间分析版：roadmap 最后一项（会话级加密存储）+ DESIGN-1.3 两项未来工作（status 历史视图 / 回放 diff）落地。设计全文见 `docs/DESIGN-1.4.md`。

### Added

- **模块 I 会话级加密存储（可选 passphrase，roadmap 收官）**：`passphrase` 配置或
  `DSH_MEMORY_PASSPHRASE` 环境变量开启后，记忆文件逐行 AES-256-GCM 认证加密落盘
  （scrypt N=16384 派生密钥，密钥记录头存盐与 KDF 参数，AAD 绑定格式版本）——
  **静态保密**（除头外零明文）+ **逐行防篡改**（认证失败走损坏行隔离留证通道）；
  错口令/漏口令加载期显式失败（绝不表现为空库）；**明文库原位加密迁移逐行原序重写**
  （append-only 深回放历史——旧内容版本/tombstone 删除时刻——逐行保留，仅换密文外衣）；
  compact 与加密共存（解码合并后统一编码重写 + 头保留）；混合文件容忍（迁移中间态可读写，
  compact 收敛全密文）；`diagnostics.encrypted` 加密形态可观测；口令绝不写日志。
- **模块 J 时间分析**：`memory_status asOf` 历史快照视图（该时刻的记忆库统计——只含
  当时存在的记忆/当时内容版本与取代矛盾状态，语料层字段封闭不掺运行时观测，冷热分层
  以 asOf 为现在）；`memory_status { diffSince, asOf? }` T1↔T2 diff 视图（新增/消失/
  内容变更/取代矛盾/纯热度六类归因，`diffReplay` 纯函数确定性，明细 ≤20 样本计数完整，
  渲染 `[memory status diff ISO₁ → ISO₂] +A −R ~U (heat H)`）；`metrics.statusAsOf` 观测。
- **评估门禁扩至 G1-G22**：G21 加密真实规模接地（400 条真实语料落盘零明文多锚点抽验、
  迁移保深回放、错口令/漏口令显式失败）；G22 时间分析真实规模接地（G19 同构分阶段时间线
  三分区 diff 与手算一致 + 工具面输出契约）。

### Changed

- `JsonlMemoryStore.open` 增加可选第三参 `{ passphrase? }`（缺省明文，与 1.3.0 逐字节一致）；
  `memory_status` 参数面增加 `asOf`/`diffSince`（缺省输出形状与字节不变）；
  `memory_recall asOf` 语义不变（模块 J 与之同源）。

### 工程纪律

- 缺省零回归：无口令 + 无时间参数时全部输出与 1.3.0 逐字节一致（plainCodec 恒等 +
  时间分支缺席，既有 bit-exact 门全绿）；
- 单元测试 495 → 528（新增 33：编解码 9 / 加密集成 13 / 时间视图 11），eval 64 → 66，
  总量 559 → 594；覆盖率门禁维持 ≥98/93/98（新增源文件全路径覆盖）。

## [1.3.0] - 2026-10-30

时空完备版：从「图谱时间线回放」到「记忆库全量情景回放」。设计全文见 `docs/DESIGN-1.3.md`。

### Added

- **模块 G 情景回放（episodic replay）**：`memory_recall asOf` 深化——回到任意过去时刻召回，
  语料为该时刻的**精确知识状态**（`replayAsOf` 纯函数按文件序回放 append-only JSONL 日志：
  存在性 / 内容版本 / 取代与矛盾标注 / 访问热度全维度；写入时刻由既有写入协议锚定
  `max(updatedAt, lastAccessAt)`）；图谱按回放语料全量重建 T 时刻图视图（未来条目的边
  不存在、取代状态即当时快照——运行时图的 occurredAt 会被标记回写推高，深回放下不可靠）；
  只读回放（不写热度，绕过索引缓存不污染当前语料指纹）；`metrics.asOfRecalls` 观测；
  渲染前缀 `[memory recall @<ISO8601>]`；无 `listAsOf` 实现的存储降级为 createdAt 过滤。
- **模块 H 推理证据链（`why.chains`）**：召回溯源从「infer 线贡献了分」升维到「凭什么
  推理」——infer 线参与融合的命中附带至多 3 条推理链（路径逐边
  `from/relation/to/confidence/occurredAt` 可回放 A—使用→B—依赖→C）；渲染追加
  `（推理: A —使用→ B —依赖→ C (0.42)）`；收集机制为纯出参（chainsOut），评分路径零改动。
- **G19-G20 真实规模时空门禁**（`eval/cognitive-scale.test.ts`）：3333 条真实文档语料
  按分阶段时间线（批次写入/取代/热度/删除）重铸为生产格式日志，分时刻快照与手算一致 +
  热度时间线 + 确定性 + 远未来≡全量（G19）；T 时刻语料+图视图召回全命中 createdAt≤T +
  why.chains 产出面与契约 + 未来条目词面/图边不穿越 + 逐字节确定性（G20）；
  `test/memory/replay-asof.test.ts` 16 项 + `infer.test.ts` 新增 5 项行为锁定。
- tombstone 行携带删除时刻（`{"__tombstone__":"id","at":…}`，读取侧向后兼容旧格式）；
  `MemoryStore.removeMany` 可选 `now` 参数；`MemoryStore.listAsOf` 可选成员。

### Changed

- **asOf 参数语义深化**（1.1.0 引入时仅回放图谱时间线与评分时钟）：现在同时回放条目层
  知识状态——这是对该参数文档意图的补全而非破坏（无 asOf 的缺省路径行为与 1.2.0
  逐字节一致）。

### 工程纪律

- **缺省零回归**：无 asOf / 无 explain 时输出与 1.2.0 逐字节一致（回放与链收集代码
  缺省不触达；why.chains 为 explain×infer 交集上的可选字段）。
- **覆盖率阈值修复与再冻结**：0.8.0 冻结的阈值自 1.1.1 防御性加固后未再实测
  （check 链不含 coverage，仅 CI 覆盖率任务执行），实际已跌至 lines 94.65 /
  branches 86.98——静默红灯两版。1.3.0 以五个定向补测文件
  （test/memory/coverage-1.3 与 coverage2-5）修复至实测 lines 98.5 / branches 93.4 /
  functions 99，并按「阈值与实测同步冻结」协议重设：lines/statements 98（收紧）、
  functions 98（收紧）、branches 93（校准——余留未达臂为 schema 前置校验后不可经
  公开面触达的纵深防御分支另一臂、竞态窗口与写入故障注入路径，非可测行为缺口）。
  单测总数 406→495，全套 559。

## [1.2.0] - 2026-10-30

推理升维版：从「检索记忆」到「基于记忆推理」。设计全文见 `docs/DESIGN-1.2.md`。

### Added

- **模块 E 激活扩散推理线**（`inferEnabled` / `inferMaxHops`，默认关闭）：认知科学 spreading activation
  的工程化落地——查询实体沿时序图谱**活跃**出边多跳扩散（每跳 ×0.5 衰减、每边 ×关系置信度、
  最旧边保守时效），每个终结实体保留最优路径链（`InferChain.path` 可回放：A—使用→B—依赖→C）；
  interpolate 线性叠加（权重 0.25）/ RRF 第五条秩融合（推理专属候选补录，与图谱补录同 id 双线合并）；
  asOf 时间线硬约束：推理不能穿越失效关系（含 reassertedAt 复活语义）；波束 16 + 链数 16 双护栏，
  hub 扇出有界；确定性（乱序构建对拍一致）。
- **模块 F 召回溯源**（`memory_recall explain` 参数）：每条命中附带 `why`——参与融合的召回线
  （bm25/fuzzy/semantic/graph/infer 固定序）、各线贡献（interpolate=实际加分的加权项系数；
  rrf=倒数秩贡献，`Σ贡献 × lineBase` 与最终分**逐位精确相等**）、公共权重因子、同源最终分；
  渲染追加 `（溯源: rrf ← bm25=0.0161 + infer=0.0164）`。纯读侧注记，评分算术路径零改动。
- **G17-G18 真实规模推理门禁**（`eval/cognitive-scale.test.ts`）：3333 条真实文档语料上的
  链确定性/有界性/1 跳邻域交叉验证/乱序构建一致性（G17）与溯源契约全命中可解释 + 逐字节
  确定性（G18）；`test/memory/infer.test.ts` 17 项行为锁定。
- `memory_recall infer` 参数（逐次开关推理线，与 `graphEnabled` 同形态：参数覆盖配置默认）；
  `metrics.inferHits` 可观测计数。

### 工程纪律

- **缺省零回归**：`inferEnabled`/`explain` 默认关闭，interpolate+rrf 双模式输出与 1.1.1 逐字节一致
  （bit-exact 门禁 + 单测双重锁定）；溯源注记不进入任何评分分支的算术路径。

## [1.1.1] - 2026-10-30

全量代码审计驱动的加固版本：修复 2 个 P0、12 个 P1 级缺陷，完成 engine 模块化重构、
中文分词根治与图谱实体归一层；新增 G13-G16 真实规模认知门禁与 18 项加固回归
（`test/memory/hardening-1.1.test.ts`）。

### Fixed

- **P0 黄金语料缺失**：`eval/realdata/`（Node.js v26.10.0 官方文档快照）此前从未入库，`check`/`test`/`eval`/CI 在干净克隆上必挂——现随 MANIFEST（SHA-256+字节双校验）一并提交；
- **P0 图谱种子缺失**：`buildGraph` 在生产代码零调用，重启后第四召回线对存量库完全失效——现启动时全量播种；
- **P1 多进程数据安全**：`<file>.lock` 单实例写锁（pid 存活探测）+ compact 回放式合并（并发进程追加的外部行在重建后保留）+ fsync 屏障；
- **P1 热度评分冻结**：IndexCache 纯热度更新后 `byId` 过期复用——现始终按最新 entries 重建；
- **P1 批内 supersede 覆盖丢失**：ingest 局部可见视图，双取代标记都保留；
- **P1 memory_store 近重复落穿**：`findDuplicate`（新 API，命中返回条目），>0.92 命中幂等返回；
- **P1 importSources 未处理拒绝**（可崩宿主）/ **dispose 竞态**（disposed 标志）/ **图边终身死亡**（reassertedAt 复活）/ **graphEnabled 配置不生效**（recallDefaults 注入）；
- **P1 detectDuplicate O(blocks×N) 哈希热点**：WeakMap 快照指纹缓存。

### Changed

- **矛盾检测独立窗口**：新增 `conflictWindowMs`（默认 30 天）——跨周信念反转可检测；词表真互斥；
- **巩固召回锚定（真 SRS）**：只巩固被真实召回过的记忆；未使用记忆容许自然衰减；
- **蒸馏代际治理**：新代写入时旧代补 `superseded-by`，不再无限累积霸占召回；
- **中文分词根治**：连续 CJK 段切分（伪 bigram 消除）+ 扩展 A/B 区覆盖 + 标点半价 + `safeSlice` 代理对安全截断；
- **engine 模块化**：拆分 `tokenize/fuzzy/dedup/themes/hash` 五模块，导入路径零变更；
- **性能**：热度回写 `upsertMany` 批量化、RRF 补录 O(V²)→Set、预算裁剪 continue 填充、聚类/蒸馏 df>64 hub 护栏、容错线统一注入 k1；
- **图谱实体归一层**：实体规范键（大小写/空白/尾标点变体归一）+ token 对齐层（自然语言问句经共享特异 token 命中）+ `node.js`/`c++` 类专名入图 + 裸「是」降噪；
- **工具与配置防线**：memory_recall 数值参数钳制、memory_status metrics 分层输出（`verbose`）、normalizeConfig 运行时钳制。

### Added

- **G13-G16 真实规模认知门禁**（`eval/cognitive-scale.test.ts`）：3333 条真实文档语料上的图谱一致性/蒸馏幂等/矛盾精度/规模护栏。

### Removed

- 删除未使用的 `@deepseek-ai/dsh-llm`；peerDependencies 放宽；`@deepseek-ai/schemastery` 显式声明为 peer（不再内联进产物）。

### 工程

- 仓库卫生：17 个历史 tgz/zip 出库；`.gitignore` 补 `*.zip`/`eval/reports/`；CI 与本地 `check` 同链 + concurrency/timeout + Windows 矩阵；eslint Windows `tsconfigRootDir` 修复；engine 六个版本堆叠测试文件按行为合并为单一文件（91→79 用例去重 12 处）；`freshEntry` 四副本收编 `test/memory/utils.ts`；CHANGELOG 按 Keep a Changelog 全文重写；docs 13 篇版本快照归档 `docs/history/`。

## [1.1.0] - 2026-10-06

### Added

- **模块 A 记忆层次蒸馏**（`distillMode`）：重复行为/偏好簇蒸馏为抽象原则、指令簇为规则约束，`memory_recall(expand)` 展开源记忆证据链；
- **模块 B 认知巩固**（`consolidationMode` + `recallThreshold`）：Ebbinghaus 遗忘曲线 + 间隔巩固调度；
- **模块 C 时序知识图谱第四召回线**（`graphEnabled` + `graphMaxEntities`）：零依赖三元组抽取 + `asOf` 时间线回放；
- **模块 D 信念修正与矛盾共存**（`conflictMode`）：疑似反转事实双向标注并存，新者优先；
- 评估套件扩展：G9-G12 认知门禁 + `eval/bit-exact.test.ts` 逐字节零回归断言 + 图谱/蒸馏 bench。

## [1.0.0] - 2026-10-06

### Added

- **supersede 取代协议**（`supersedeMode`）：对立信号识别，被取代记忆召回降权 + 同现去重；
- **主题聚类视图**（`themes`）与**价值感知自动淘汰**（`maxEntries` + `autoEvict`，instruction 永不淘汰）；
- **双引擎混合检索**（`semanticBoost`/`fusionMode`）：词面 BM25 / 容错 / 语义三线，interpolate 或 RRF(k=60) 融合；
- **UF-1.0 统一内容指纹**：捕获/显式/导入三路同源去重；
- 评估方法论：G5 四维 81 组参数网格、G6 真实数据门扩至四语料 49 问句、G7 扰动鲁棒性、G8 生命周期与聚类。

## [0.10.0] - 2026-10-05

### Added

- **G6 真实数据门**：Node.js v26.10.0 官方文档快照（SHA-256 固化）经生产同路径 `planImport` 导入，真实问句 + 语义锚标注，门限 recall@1 ≥ 0.75 / @3 ≥ 0.85 / @5 ≥ 0.95。

## [0.9.0] - 2026-10-05

### Changed

- 16 项薄弱项深度闭环：词法单一事实源（编译期防漂移）、共享默认隔离（无 workspace = 全局）、工具结果按会话 cwd 溯源、热度合并回写（抗刷）、评分时间衰减双尺度（`recallDecayHalfLifeDays=0` 长期记忆真正可召回）、16 项探针转正。

## [0.8.0] - 2026-10-05

### Changed

- 全模块质量升维：插件生命周期与错误路径全量可测（L1-L4）、工具输出契约白盒化（render 全分支直测）、engine 守卫分支闭环 + 死代码不变式移除（L9）、store 故障注入（L10）、覆盖率阈值与实测同步冻结（lines ≥96.5 / branches ≥95）。

## [0.7.0] - 2026-10-05

### Changed

- 代码质量升级：覆盖率阈值对齐硬约束、重复实现合并（`text.ts` 单一实现）、`errorMessage` 沉淀 `errors.ts`、评估管线版本自动读取。

## [0.6.0] - 2026-10-05

### Added

- **真实数据接入层**（`importSources`）：Markdown 记忆文档与会话 JSONL 日志启动导入，内容级幂等（`imp-<contentHash>`），开箱即有记忆；未配置时行为与 0.5.0 完全一致。

## [0.5.0] - 2026-10-05

### Added

- **A1 容错检索**：编辑距离 ≤1 变体兜底（0.5 折扣，不干扰精确命中）；
- **A2 近似语义召回**：字符 3-gram 特征空间 + MinHash 签名 + 精确覆盖率评分（≥0.45 兜底）；
- **A3 价值感知评分**（kind × source 显著性权重）与 **A4 热度生命周期**（访问热度半衰期冷却）；
- **A5 离线评估套件**（`eval/`）：G1-G4 黄金曲库 + recall@k/MRR/NDCG + 参数网格。

## [0.4.0] - 2026-10-05

### Added

- **Okapi BM25 排序**（k1=1.2/b=0.75，长度归一化 + 词频饱和）；NFKC 查询规范化与英文停止词；
- 损坏行隔离留证（`.corrupt` 审计文件）、compact 自检、`exportAll` 迁移闭环。

## [0.3.0] - 2026-10-05

### Added

- `HubMetrics` 十项运行指标、有界捕获队列（背压 256）、`removeMany` 批量删除、`memory_recall.kind` 过滤、存储诊断、CI 工作流与 `npm run check`。

### Changed

- 写一致性升级（先落盘后变更内存）、`list()` 快照缓存、`IndexCache` 索引复用、空查询短路（不按热度误召回全库）。

## [0.2.0] - 2026-10-05

### Added

- TF·IDF 倒排索引检索、NFKC 归一化敏感过滤（防全角绕过）、`extractFromAssistant` 提取器、`MemoryHubError` 稳定错误码、目录 0700/文件 0600 隐私权限、eslint/prettier/覆盖率门槛。

## [0.1.0] - 2026-10-05

### Added

- 初始版本：JSONL append-only 存储（tombstone + compact）、四工具（memory_store / memory_recall / memory_forget / memory_status）、事件驱动自动捕获（四档力度）、TTL 清理。
