# DESIGN-1.5 边界突破版（1.5.0）

> 主题：把 1.2-1.4 版设计文档中**明文划出的一切剩余边界**逐项收敛——口令轮换（DESIGN-1.4
> 未来工作）、图维 diff（DESIGN-1.4 未来工作）、本地 HNSW 向量第六召回线（roadmap 未勾选）、
> 双语实体抽取（DESIGN-1.2 §5 / DESIGN-1.3 §4 独立课题）、记忆时间轴（roadmap 未勾选）。
> 纪律不变：**缺省零回归**（全部新能力默认关闭，开启前输出与 1.4.0 逐字节一致）、
> 纯函数可复算、零第三方依赖、真实语料门禁接地（G23-G25）。

## 0. 模块总览

| 模块                 | 边界出处                      | 交付                                                                            |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| K 口令轮换与解密回退 | DESIGN-1.4 §4 未来工作        | `JsonlMemoryStore.changePassphrase` + `DSH_MEMORY_NEW_PASSPHRASE` 启动期接线    |
| L 图维时间对账       | DESIGN-1.4 §4 未来工作        | `TemporalGraph.activeEdgeList` + `diffGraphs` + `memory_status graphDiff`       |
| M 本地向量第六召回线 | README roadmap 未勾选         | `vector.ts`（确定性 HNSW）+ 引擎第六线（RRF/interpolate/溯源）+ `vectorEnabled` |
| N 双语实体抽取       | DESIGN-1.2 §5 / DESIGN-1.3 §4 | 关系词表双语扩展 + 宾语连词拆分 + 冠词/系动词/标识符点三修复                    |
| O 记忆时间轴         | README roadmap 未勾选         | `timelineFromRaw` 纯函数 + `store.timeline` + `memory_status timeline`          |

## 1. 模块 K：口令轮换与解密回退

### 1.1 语义矩阵

| 起态 → 终态   | 行为                                                             |
| ------------- | ---------------------------------------------------------------- |
| 加密 → 新口令 | 逐行原序重加密（新盐 + 新派生密钥；同口令再轮换 = 密钥卫生换盐） |
| 加密 → 空口令 | 解密回退：信封剥除回明文，密钥记录头不再写出                     |
| 明文 → 新口令 | 等价 open 期原位加密迁移（运行期启用路径）                       |
| 明文 → 空口令 | no-op（目标态与现状一致，免无谓重写）                            |

### 1.2 工程纪律

- **逐行原序重写**：与 `encryptInPlace` 同纪律——不合并、不去重、不丢 tombstone/历史版本/
  损坏行（损坏密文行解密失败后原样换新外衣，下次加载仍走隔离留证）；append-only 深回放
  历史逐行保留，仅「密钥外衣」更换；
- **原子性与失败语义**：tmp + fsync + rename；失败抛出且**文件保持原状**，运行态
  （codec/salt/headerWritten）只在 rename 成功后切换；**失败不毒化写链**（catch 派生新尾，
  后续写入与 close 不受影响——库保持原口令/原形态可用）；
- **多进程护栏**：整文件重写与 compact 同级风险，写锁被其他存活实例持有时拒绝执行
  （STORE_WRITE_FAILED，真子进程锁占用测试锁定）；
- **空库特例**：文件不存在时仅武装编解码器（headerWritten 保持 false，首写按新形态落盘）；
- **接线**：`DSH_MEMORY_NEW_PASSPHRASE` 定义且不等于当前有效口令时启动期触发一次
  （非空 = 换新口令/启用加密；空串 = 解密回退；旧口令仍由 open 正常校验——错口令在
  轮换前就显式失败）。改完应移除该变量。

## 2. 模块 L：图维时间对账

- `TemporalGraph.activeEdgeList(now)`：时刻 now 的活跃边全量清单，
  (from, relation, target) 字典序确定性排序（失效/复活时间线语义与推理线一致）；
- `diffGraphs(before, after, until, maxEntities)` 纯函数：两个回放快照各自 `buildGraph`
  重建图视图后对活跃边集合做差集——added = 新关系确立（新条目抽取或重断言复活），
  removed = 关系消失（唯一携带条目被 tombstone，或其条目被取代标注失效）；
  与条目维 `diffReplay` 互补（「知识图谱发生了什么」的实体/关系级答案）；
- 工具面：`memory_status { diffSince, asOf?, graphDiff: true }` → diff 输出附
  `graph` 键（实体计数 + 边变化计数完整 + 边样本 ≤10）；渲染
  `graph: entities B→A, +E −R edge(s)` + 各至多 3 条 `+ from —rel→ to` 样本；
- 缺省（graphDiff 缺席）diff 输出与 1.4.0 逐字节一致。

## 3. 模块 M：本地向量第六召回线（HNSW）

### 3.1 向量空间

- 特征空间与 A2 语义线**同源**（`semanticFeatureCounts`——英文/数字词字符 3-gram +
  CJK 2-gram，单一事实源下沉 tokenize.ts）；权重 = sublinear TF × IDF（语料侧文档频率，
  未见特征按最大特异 idf 计权），稀疏表示 + L2 归一化，余弦 = 归一化点积；
- 与 A2（查询覆盖率，非对称）互补：向量线是**对称相似度**（文档侧特异性也参与计分），
  独立的第六条排序信号；零范数条目（纯标点正文）不进索引，词面/语义/图谱线不受影响。

### 3.2 确定性 HNSW（论文工程化）

- **层指派**：`fnv1a(id, seed)` → u ∈ (0,1] → level = ⌊−ln(u)·mL⌋（mL = 1/ln M）——
  不依赖 Math.random，同 id 集合与次序下图结构与查询结果可复算；
- **近邻多样性选择**（论文 Algorithm 4 + keepPrunedConnections 回填）：候选 e 仅当
  「到查询的距离 < 到任一已选近邻的距离」才入选。这是本版最关键的工程发现——
  单纯最近 M 个裁剪在簇状语料上会退化：簇内 hub 把新节点回链全量裁掉，图坍缩为
  不可达子图（300 节点语料上四查询两查询零命中）；多样性选择保留不同方向近邻，
  配合底层上限 2M（论文 M_max0）恢复导航性；
- **插入**：上层贪心下降定位 → 每层 efConstruct 束搜索 → 多样性选 ≤M 近邻互连 →
  对侧超限同规则裁剪；超越当前入口层高时更新入口；
- **查询**：贪心下降至底层 → ef 束搜索（ef 实际取 max(ef, k)）→ top-k（相似度降序、
  id 字典序兜底）；零相似度结果过滤（无特征交集的近邻不是向量命中）；
- **有界性**：每节点每层度 ≤ M（底层 2M）、候选 ≤ ef、结果 ≤ k；
- 常数缺省：M=16 / efConstruct=100 / ef=128 / 每查询 topK=24（hnswlib 同级 M）。

### 3.3 引擎接线（与图谱/推理线同形态）

- `RecallOptions.vector?: VectorRecallSource`（types.ts 接口约束）+ `vectorEnabled`
  （默认 false）+ `vectorWeight`（interpolate 权重 0.3）；
- interpolate：向量分线性叠加（排在推理线后）；RRF：第六条秩融合（`vector` 字段
  > 0 入线，仅向量可达的候选补录，同 id 就地 max 合并）；`why.lines` 追加 `vector`
  > 线（召回线固定序 bm25/fuzzy/semantic/graph/infer/vector——只追加末尾）；
- `metrics.vectorHits` 生效观测；
- 索引生命周期：工具层 `VectorIndexCache` 按 (revision, 内容指纹) 复用（构建
  O(N·efConstruct) 远贵于查询）；情景回放（asOf）语料一次性现建；`engine.recall`
  在启用未注入时自动构建；依赖方向纪律：engine → vector → tokenize/hash
  （fnv1a/semanticFeatures/fingerprint 为此下沉叶子模块，engine re-export 零调用方变更）。

### 3.4 真实规模校准（G23 锚）

3333 条真实文档语料：构建 7.2s / 91143 边 / 层高 3；20 条确定性采样文档以正文前
8 词自检索——**HNSW top-10 与暴力全量 top-10 重叠 20/20 全一致**、自检索命中 19/20、
两次独立构建查询结果逐项一致。门限：重叠 ≥ 0.8 / 分数对拍 ≥ 0.9×真值 / 自命中 ≥ 15/20。

## 4. 模块 N：双语实体抽取

- **词表双语扩展**（只增不改，超集兼容）：英文技术文档高频关系面
  returns/throws/emits/supports/provides/accepts/extends/implements/based on/powered by/
  written in/deployed on/migrated to/upgraded to/replaced by/part of/belongs to +
  中文对应面 基于/支持/提供/返回/抛出/发出/继承/实现/改为/换成；
- **宾语连词拆分**：`A uses B and C` / `A 使用 B、C` / `A 使用 B 与 C` 逐并列产出
  （高精度取向：只拆空格连接的 and/or/与/和 与顿号「、」，不拆词内字）；
- **三处形态修复**：
  - 宾语前导冠词剥除（`returns a promise` → `promise`）；
  - 主语尾部系动词剥除（`fs is part of the core` 主语是 `fs` 而非 `fs is`）；
  - **标识符内部的点不是句分隔**（node.js / fs.readfile 主宾语保形——1.1.1
    「专名入图」承诺此前被句点分隔逻辑半途截断，本版补全）；
- 1.1.1 锁定语义保持：裸 `the app` 主语保留（只剥指示词前缀）、词边界匹配
  （use ≠ because）、置信度下限、同三元组去重；无裸 `is` 关系（存现句不进图）。

## 5. 模块 O：记忆时间轴

- `timelineFromRaw(raw, cap=31)` 纯函数：append-only 日志单遍回放出按 UTC 日分桶的
  事件流——条目行按写入时刻锚（max(updatedAt, lastAccessAt)，与 replayAsOf 同锚）：
  不在存活集 → added（含删除后复活）；存活且 content/tags/kind 变化 → updated；
  仅访问字段推进 → heat（召回巩固足迹）。tombstone 带 at → removed（仅当时存活 id）；
  旧格式（无 at）无时间锚 → 不计事件、保守作用于存活集（折算首桶前总量基线）；
- 总量走势：日序 running + added − removed，时钟偏斜负值钳 0；分桶超 cap 仅保留
  **最近** cap 桶（truncated=true）；
- `JsonlMemoryStore.timeline()`：只读，加密库整文件解码后分桶（与 listAsOf 同解码纪律）；
- 工具面：`memory_status { timeline: true }` → `{ timeline: {...} }` 独立视图；渲染
  `[memory timeline] 首日 → 末日 · N 天 · 事件 E` + 每日柱状行
  `day │ ████ +A −R ~U (hH) = total`（柱宽按当桶事件数相对最大桶缩放，≤12）；
  降级 store（无 timeline 成员）按 createdAt 近似（只有新增事件）；`metrics.statusTimeline`；
  观测口径声明：时间轴是宏观事件流视图，任意时刻精确状态仍以 replayAsOf 为准。

## 6. 验收门禁（G1-G25 中的新增三项）

| 门  | 内容                                                                                                                                                                                                                                                                   | 锚                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| G23 | 向量第六线真实规模：3333 真实文档 HNSW vs 暴力全量 top-10 重叠 ≥0.8（实测 20/20）、分数对拍 ≥0.9、自检索 ≥15/20（实测 19/20）、两次构建确定性、RRF+explain 的 why 含 vector 线、缺省零回归                                                                             | `eval/cognitive-scale.test.ts` |
| G24 | 双语抽取真实规模：真实英文语料新关系面三元组 ≥3 条 / ≥2 种（实测前 800 条即 3 条 2 种）、逐字节确定性、图活跃边含新关系、主宾真实标识                                                                                                                                  | 同上                           |
| G25 | 边界操作真实规模：400 真实条目明文→加密→轮换后深回放逐项保留（旧版本内容/tombstone 时刻）+ 旧口令即刻失效；diffGraphs 与测试内手工差集（buildGraph + activeEdgeList 独立重算）完全一致且双侧非零；时间轴事件守恒（402 = 各桶之和）+ 末桶 total = 当前存活数 + cap 截断 | 同上                           |

单元锁定（新增 73 项）：rotation 13 / graph-diff 8 / timeline 15 / bilingual 11 / vector 25
（稀疏向量底座 2 + HNSW 8 + 召回质量 6 + 缓存 1 + 引擎接线 5 + 工具面 3）。

## 7. 零回归与工程纪律

- **缺省零回归**：无新参数/新配置时全部输出与 1.4.0 逐字节一致（vectorEnabled=false
  显式传入亦逐字节一致——engine 源注入为唯一变量，固定 now 注入下 JSON 全等断言）；
- 依赖方向：engine → vector → tokenize/hash（无环）；types.ts 以 VectorRecallSource
  接口隔离类型层；`fnv1a`/`semanticFeatures(±Counts)`/`fingerprint` 下沉叶子模块并经
  engine re-export，既有导入路径零变更；
- 覆盖率：98.4 / 93.09 / 98.9 / 98.4（门槛 98/93/98 维持）；全套 670 测（单元 601 + eval 69）。

## 8. 边界与后续

- **口令恢复**：口令丢失 = 数据不可恢复（scrypt + AEAD 无后门）——轮换需要**旧口令
  先通过 open 校验**，不存在绕过路径；这是特性不是缺陷；
- **HNSW 质量**：正交簇（跨簇余弦恒 0）上贪心导航无梯度可用——真实嵌入空间连续
  无此病理；极端语料可注入更高 ef（评估网格注入位已留）；
- **时间轴**：compact 清除历史行后事件流退化为重建后的新事件（与深回放同边界）；
- **向量线**：特征空间为字符级（无预训练语义），与词面/语义/图谱/推理线同源字符特征
  是其上界——预训练 embedding 接入是后续课题（接口 VectorRecallSource 已预留）；
- **跨平台 GUI 记忆管理**（roadmap 未勾选余项）：独立应用级交付物，存储迁移闭环
  （exportAll/importAll）与加密/轮换管线已就绪，另案推进。

## 9. 增补：模块 P 可视化检索页（1.5.1）

「记忆时间轴 / 可视化检索页」roadmap 项以**仓库内可交付形态**关闭：`memory_status
{ exportHtml: true }` 导出单个自包含静态 HTML（`src/memory/html-export.ts` 纯函数渲染），
写入存储目录 `memories-view.html`（0600，与记忆库同权限保护）并返回路径。

### 9.1 页面构成

- **记忆时间轴柱状视图**：按天分桶的新增/更新/纯热度/删除事件柱（服务端确定性渲染，
  纯 HTML/CSS——禁 JS 也可读）；柱高按当桶事件数相对最大桶缩放，悬停提示含全量计数
  与当日存活总量；≤90 桶窗口 + truncated 标记；
- **检索页**：全量语料以安全 JSON 内嵌（`window.__MH__`），浏览器内即时评分排序
  （idf 加权词面评分：拉丁词 + CJK 相邻字 2-gram，与服务端 token 化同精神）+
  类型过滤，DOM 一律 textContent 构建；默认按访问热度展示前 50，输入查询后按评分降序。

### 9.2 工程纪律

- **确定性**：同 payload（含注入的 generatedAt）逐字节可复算——条目按 (createdAt, id)
  排序、固定键序序列化、模板无随机/时钟引用；
- **注入安全**：内嵌 JSON 经 `\u003c` 转义（页面全量只允许两个合法 `</script>` 闭合，
  G26 在真实语料上断言）；服务端模板文本全部经 escapeHtml；客户端 DOM textContent；
- **自包含**：零外部资源引用（无 http(s) src/href/link——G26 断言锚），可离线打开，
  检索在浏览器本地进行、不上传任何数据；
- **隐私边界**：导出为**明文观看工件**（与加密存储正交）——文件 0600 落存储目录、
  与记忆库同权限保护；不需要者不调用即不产生；
- **接线**：`createMemoryStatusTool` 新增 `opts.htmlDir`（插件入口注入存储目录）；
  未配置时 exportHtml 显式失败（INTERNAL + 指引）；写失败 STORE_WRITE_FAILED；
  workspace 过滤与普通视图同语义（时间轴为库级视图，不受工作区过滤影响）；
  `metrics.htmlExports` 观测；缺省（exportHtml 缺席）输出与 1.5.0 逐字节一致。

### 9.3 门禁

| 门  | 内容                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G26 | 真实语料 1200 条全量导出：自包含零外链、`</script>` 恰两个合法闭合（真实语料含代码块尖括号）、确定性采样 50 id 全嵌入、时间轴与 `store.timeline(90)` 同源、固定 generatedAt 两次渲染逐字节一致、体量锚 >100KB、POSIX 0600（Windows 跳过） |

单元锁定：`test/memory/html-export.test.ts` 11 项（纯函数 5 + 工具面 6）。

### 9.4 边界

- 「跨平台 GUI 记忆管理」整项（桌面级应用：编辑/导入导出 UI/多库管理等）仍为应用级
  交付物——本模块关闭其「可视化检索」半项；是否将整项纳入本目标范围由用户确认。
