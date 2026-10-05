# dsh-memory-hub 1.1 认知记忆系统设计（DESIGN-1.1）

> 版本：1.1.0（认知升维版）｜前置基座：1.0.0（世纪升维版）｜定位：在 1.0.0「契约极稳、纯函数优先、可复算至上」的基座上，把记忆从**平面仓库**升维为**认知记忆系统**——层次化（蒸馏抽象）、时间感知（巩固与遗忘）、关系结构（时序知识图谱）、信念演化（冲突共存与修正），对标 2025-2026 记忆系统前沿（MemGPT 层次记忆、GraphRAG/HippoRAG 图增强召回、Zep Graphiti 时序图谱、Generative Agents 反思蒸馏、间隔重复巩固），且全部以**零依赖规则引擎 + 纯函数**落地，无需模型调用，产出市面上 Harness 插件目录中不存在的「记忆认知层」。

---

## 1. 目标与验收锚点

| #   | 目标                                 | 验收锚点（对应 requirement）                                                                        |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| G1  | 记忆层次化：从零散事实蒸馏出抽象原则 | 蒸馏批处理可复算；产物带 `distilled-from` 源引用（G9 可追踪率=100%）；召回可向下展开                |
| G2  | 时间感知：遗忘曲线驱动的巩固调度     | 巩固状态机收敛（G11：模拟时间轴下巩固后预测可召回率提升 ≥ 门限）；默认关闭零行为变化                |
| G3  | 关系结构：时序知识图谱成为第四召回线 | 图邻域扩展召回命中（G10 ≥ 门限）；图谱随写入增量维护；纯零依赖抽取                                  |
| G4  | 信念演化：矛盾共存 + 修正时间线      | 矛盾对检测精度（G12 ≥ 门限）；冲突显式标注输出而非静默降权                                          |
| G5  | 完整交付可复算                       | 压缩包含 src/test/eval/bench/docs；`npm run check` + `npm run eval` 全绿；G1-G8（1.0.0 门禁）不回归 |

硬约束（全程继承 1.0.0，不可破坏）：

- **MemoryEntry 持久化契约零变更**（id/kind/content/tags/source/sessionId?/workspace?/createdAt/updatedAt/accessCount/lastAccessAt?）——如 `toMemoryEntry` 会对未知字段执行丢弃规整，严禁在 MemoryEntry 上直接加字段；一切新机制走 **tags 协议 + 独立运行时索引**（与 1.0.0 的 supersede 协议同构）。
- 四工具签名与输出 schema 不破坏性变更（仅新增**可选**参数/字段，旧调用逐字节兼容）。
- 零新增运行时第三方依赖（仅 node 内置 + 既有 peer）。
- **新增能力默认全部关闭**（distillMode/graphMode/consolidation/conflictMode 缺省 off 或 false），缺省配置下行为与 1.0.0 逐字节一致。
- 覆盖率阈值不降（lines≥96.5 / branches≥95 / functions≥97 / statements≥96.5）。
- 327 项既有测试 + eval G1-G8 全绿；params 默认值语义不变。

---

## 2. 现状盘点与升维差距（1.0.0 → 1.1.0）

| 维度     | 1.0.0 现状                                                  | 认知系统应有形态（1.1.0 目标）                                | 差距                                            |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| 记忆层次 | 单层平面：所有记忆同权存放                                  | 事实(episodic) → 抽象(abstract) → 程序性(procedural) 分层     | 无蒸馏，概括类问题只能靠多条命中的词面拼凑      |
| 时间感知 | 指数衰减（decay）+ 热度半衰期，均为**单调冷却**，无复习机制 | 遗忘曲线 + 间隔巩固：成功召回拉长间隔、到期复习提权           | 无「巩固」概念，高频访问只涨热度不涨记忆强度    |
| 关系结构 | 无实体/关系建模；召回只看查询与条目文本                     | 实体-关系-时间 图谱；查询实体→邻域扩展→跨条目推理             | 「问 A 带出 B（A-B 关系）」完全不支持           |
| 信念演化 | supersede 强制取代：对立则旧条目降权、同查同现时剔除        | 矛盾共存：相近不可判取代的对立事实**并存**并显式标注 + 时间线 | 事实漂移场景（数据变更≠观点推翻）被强制取代误伤 |
| 融合线数 | 三线（精确/容错/语义）RRF 融合                              | 三线 + **图谱线** = 四线融合                                  | 图谱线缺口                                      |
| 可观测   | status 六计数字段 + superseded/themes/hot/cold              | + distilled/consolidation due/graph 统计/conflict 计数        | 认知层状态不可见                                |

> 哲学转变：1.0.0 回答「我记住了什么、能找回来吗」；1.1.0 回答「我**如何组织**这些记忆、如何**像人一样**随时间巩固、推理与修正」。

---

## 3. 模块 A —— 记忆层次蒸馏（Hierarchical Memory Distillation）

> 前沿对标：Generative Agents 的 reflection tree（观察→洞见）、MemGPT 层次记忆、LangMem abstract。本模块用**零依赖规则**复刻「从具体观察蒸馏出抽象洞察」的能力。

### A1 蒸馏批处理（distillBatch，纯函数）

输入：候选条目集合 + 蒸馏配置（主题簇划分、最小簇大小、时间窗）。输出：蒸馏产物描述（含新建抽象条目、跳过原因），**不直接落盘**，由调用方决定写入策略（幂等，可复算）。

流程（三阶段）：

1. **簇划分**：复用 1.0.0 主题聚类（共享 token 并查集），要求 `memberCount ≥ distillMinCluster`（默认 3）才可蒸馏；簇按最高频 token 命名。
2. **归纳**：对簇内条目提取「共鸣面」——
   - **行为/偏好模式**：簇内高频动词 + 对象（如 `使用|构建|工具` → 「用户构建工具时……」），产出 abstract 断言；
   - **命令/约束模式**：kind∈{instruction,preference} 占比 ≥ 阈值时，产出 procedural 规则（「始终优先 X；避免 Y」——由对立信号词面收敛）。
   - 归纳公式可复算：`abstract = 簇主题词 + 高频谓词 + 出现次数 ≥ 阈值的实体`，模板化生成自然语言，不损失可读性。
3. **冲突守卫**：簇内若存在 supersede/conflict（模块 D）对立对，跳过蒸馏并计数（防止把矛盾事实揉成一条伪原则）。

### A2 抽象条目协议（tags，零 schema 变更）

蒸馏产物为一条新的普通 MemoryEntry（kind 取簇内主导 kind），tags 追加：

- `distilled-layer:abstract` / `distilled-layer:procedural`——分层标记（唯一事实源：本模块常量）；
- `distilled-from:<id1>,<id2>,...`——**源记忆完整引用**（G9 可追踪率 100% 的落点）；
- `distilled-theme:<簇名>`——主题追溯。

### A3 召回向下展开（expand）

`memory_recall(..., expand: true)`（可选，默认 false）：命中蒸馏条目时，解析 `distilled-from` 源 id，把源条目内容作为子项附在命中后返回（`hits[].expanded` 输出字段，**新输出字段为可选**，旧调用零影响）。语义：抽象层命中 → 给出支撑证据链，型如「原则 + 其下事实」。

### A4 成本与维护

- 蒸馏为显式触发（memory_store/recall 之外的**空闲批处理**或 status 时按 `distillMode` 控制，默认 off）；
- 源条目被遗忘（memory_forget）时，蒸馏条目保留但 `distilled-from` 无效引用在召回展开处跳过（收缩性行为）；
- metrics 新增 `distilled` / `distilledAbstract` / `distilledProcedural` / `distillSkips`。

### A5 验收门限（G9）

| 项         | 门限                                                   |
| ---------- | ------------------------------------------------------ |
| 蒸馏可复算 | 相同输入两遍产出 id 一致（纯函数）                     |
| 源可追踪率 | 100%（每个蒸馏条目都存在有效源引用）                   |
| 冲突守卫   | 含 supersede/conflict 对的簇 0 蒸馏                    |
| 召回展开   | expand=true 时展开源条目数 = distilled-from 有效引用数 |

---

## 4. 模块 B —— 认知巩固与遗忘曲线（Consolidation & Ebbinghaus)

> 前沿对标：间隔重复（SRS，SuperMemo/Anki 的 SM-2 家族）、记忆巩固理论、大脑「用进废退」的检索强度。把 1.0.0 的单调热量替换为**自适应记忆强度**。

### B1 记忆强度模型（retrievability，纯函数）

每条记忆维护 `strength` 派生状态（不落盘新字段，由 `accessCount/lastAccessAt/createdAt` 在召回/巩固时**重算**，可复算）：

- 首次创建：`strength = S0`（默认 1.0）；
- 成功召回（accessCount 增长）：`strength += Δ(accessCount)`，递增长度随次数饱和（前 3 次增幅大，之后趋缓——间隔重复的核心：**越熟的记忆复习间隔越长**）；
- 时间遗忘：预测可召回率 `R(t) = strength × e^(-Δt / τ(strength))`，其中 `τ(strength) = τ0 × strength`（强度越高遗忘越慢，Ebbinghaus 语义）；
- 到期判定：`R(t) < recallThreshold`（默认 0.4）且条目高价值（significance ≥ 阈值，复用 1.0.0 权重表）→ 进入巩固队列。

### B2 巩固调度（consolidation，空闲批处理）

- 触发：`consolidationMode: 'off' | 'auto'`（默认 off）；auto 时在 status/recall 之外的空闲窗口对有 `due` 的条目执行**巩固复习**：模拟一次成功召回（`accessCount+1`、`lastAccessAt=now`），从而 `τ` 增大、间隔拉长——**不改变内容只更新访问历史**，纯协议内操作。
- 与 heat flush 复用同一合并回写通道（coalesced upsert），不新增存储写入路径。
- 也可显式 `memory_recall(..., reinforce: true)` 对命中条目立即巩固（SRS 的「复习日」语义客户端触发）。

### B3 可观测

- `memory_status` 新增（可选字段）：`dueCount`（到期应巩固）、`strengthSummary`（均值/分位）、`consolidationRuns`；
- metrics 新增 `consolidated` / `consolidationDue`。

### B4 验收门限（G11）

| 项         | 门限                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| 收敛性     | 模拟时间轴 100 步：目标条目 R(t) 在巩固后不落入 < 0.2 区间（对照不巩固则跌落） |
| 间隔拉伸   | 连续巩固 5 次后单次巩固间隔 ≥ 首次巩固间隔 × 1.5（间隔重复特征）               |
| 零行为回归 | consolidationMode 缺省 off 时 status/recall 输出与 1.0.0 逐字节一致            |
| 存储纯净   | 巩固全程不新增 MemoryEntry 字段、不改变 content                                |

---

## 5. 模块 C —— 时序知识图谱召回线（TKG: Temporal Knowledge Graph Line）

> 前沿对标：Microsoft GraphRAG（图结构 + 社区摘要）、HippoRAG（图增强记忆检索）、Zep Graphiti（时序知识图谱）。本模块用**零依赖规则引擎**把记忆之间的事实关系建成图，并把「图谱线」接入既有融合架构，成为**第四召回线**——这是市面上记忆插件没有的「关系级召回」。

### C1 零依赖三元组抽取（ruleExtractTriples，纯函数）

对每一条新写入记忆并行维护图（runtime 索引，不落盘实体字段）：

- **主语识别**：句首名词性短语（中文按名词词面库 + 大小写/引号名；英文按首词大写的专名、`a|an|the` 后的名词）；
- **关系识别**：双级模板库（复用 capture.ts 词表派生，单一事实源）：
  - 显式关系词：`是|属于|使用|喜欢|用|构建|运行|依赖|位于|来自|切换|替代|recommends|uses|built with|located in` 等；
  - 结构模式：`<主语> <关系> <宾语>`、`<主语> 的 <宾语>`、`<宾语>（主语 关系词）`；
- **宾语识别**：关系词后的名词短语 / 引号内容；
- **时序锚定**：抽取附带条目 `updatedAt` 作为 `occurredAt`，`supersede` 对旧实体关系标注 `invalidAt`（时间线可回放：查询`asOf` 时间点可见当时的关系）。

抽取质量兜底：仅保留「主语≠宾语、长度 ≥ 2 字符、主语 + 关系 + 宾语不含敏感词」的三元组；输出带置信度（模板层加权），低于阈值丢弃。

### C2 图谱运行时（TemporalGraph，增量维护）

- 结构：邻接表 `Map<entity, Map<relation, Set<{target, occurredAt, invalidAt?, entryIds}>>>`；
- 写入钩子：ingestCaptured / memory_store.execute / importer 三路径（与 UF-1.0 同位置）追加 `graph.add(entry)`；remove 时按 entryIds 反向清理（软删：标记 invalidAt）；
- 图谱规模控制：实体/边上限（`graphMaxEntities` 默认 2000），超限按时间戳淘汰最旧边（LRU 语义，纯函数可复算）。

### C3 图谱召回线（graphLine）

`memory_recall` 新召回阶段（`graphEnabled: true` 时启用，默认 false）：

1. 查询词实体识别（与 C1 相同的词面抽取，仅取主语侧）；
2. 图邻域扩展：`hop=1` 全部邻居实体、`hop=2` 的邻居（带路径权重 `w = 1/(hop × degree 惩罚)`，过深剪枝）；
3. 候选计分：凡 entryIds 落在任一扩展实体上的条目获得图谱线贡献 `graphScore = Σ w(扩展路径) × currentness(occurredAt 距 now 的时效)`；
4. 四线融合：`fusionMode='rrf'` 时图谱线作为第四条秩参与 `rrfFuseCandidates`（扩展 RrfCandidate 加 `graph` 字段，**新字段可选**，旧融合路径不变）；`interpolate` 时 `score += graphWeight × graphScore`（默认关闭，权重可注入）。

### C4 可观测与验收门限（G10）

- status 可选字段：`graph: { entities, edges, maxHop, staleEdges }`；metrics 新增 `graphEdges` / `graphHits`；
- 门限：
  | 项         | 门限                                                         |
  | ---------- | ------------------------------------------------------------ |
  | 抽取有效性 | 小语料上主观三元组召回命中 ≥ 80%（eval 语料含 5 份图谱夹具） |
  | 图召回命中 | 「A 相关 → 邻域 B」场景 graphHits > 0 且图谱线对 top5 有贡献 |
  | 增量一致性 | 写入/删除/取代后图顶点边数与全量重建一致（纯函数对拍）       |
  | 零行为回归 | graphEnabled 缺省 false 时召回结果与 1.0.0 逐字节一致        |

---

## 6. 模块 D —— 信念修正与冲突共存（Belief Revision & Contradiction Coexistence）

> 前沿对标：AGM 信念修正理论、事实漂移（fact drift）处理、矛盾感知记忆。修正 1.0.0 的**强制取代**为「**可判取代 → supersede；不可判 → 矛盾共存显式标注**」，把「数据更新」与「观点推翻」区分开。

### D1 矛盾对检测（detectContradiction，纯函数）

`conflictMode: 'off' | 'auto'`（默认 off）。写入新条目时（与 supersede 判定同一入口 findSupersedeTarget 之后的第二判定级）：

- 触发条件：与窗口内既有条目 **similarity > 0.55**（低于 supersede 的 0.85 强门槛——说明相近但非重复）且**语义对立**（对立信号词面：`不再|不要|禁止|停止|opposite|no longer|instead of|revert` 等，承 captures；此时相对 supersede 的 isOpposingSignal 使用**弱化对立集**，区分「明确改用」与「疑似反转」）；
- 排除：已 supersede 对的条目；kind=instruction 且含「必须/务必」的强指令（避免把止损指令判为矛盾）。

### D2 共存协议（tags）

- 新条目 tags 追加 `conflicts-with:<旧id>`；旧条目追加 `conflict-of:<新id>`（双向标注，倒查 O(1)）；
- **不降权、不剔除**——两条并存（信念修正中的「暂时共存，时间线裁决」），召回时显式呈现。

### D3 冲突感知召回与修正时间线

- `memory_recall` 输出命中条目时（新增可选输出字段 `conflicts: string[]`）：若命中条目带 `conflicts-with/conflict-of` tag，把对方 id 一并列出，渲染层显示 `⚠ 与 <id> 存在时间线冲突`（渲染文本加一行，旧调用可视化不变）；
- 排序：冲突对双方按 `updatedAt` 新者优先（时间锚定裁决），但**都保留**在 hits（不再像 supersede 那样剔除）；
- status 新增可选字段 `conflictPairs`（计数 + 最近对样本）。

### D4 验收门限（G12）

| 项                | 门限                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| 矛盾检出精度      | eval 冲突夹具：precision ≥ 0.8 / recall ≥ 0.7（互补 supersede 夹具） |
| 与 supersede 区分 | 「改用 X」类只走 supersede 不标 conflict（打标互斥测试）             |
| 并存语义          | 冲突对双方在召回中同时出现（不剔除），新者序先                       |
| 零行为回归        | conflictMode 缺省 off 时行为与 1.0.0 逐字节一致                      |

---

## 7. 模块 E —— 入口工具与可观测性升级

| 工具          | 新增（全部可选，向后兼容）                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| memory_recall | 参数：`expand`(蒸馏展开)、`graphEnabled`(图谱线)、`reinforce`(巩固复习)、`asOf`(图谱时间线回放)；输出：`hits[].expanded`、`hits[].conflicts`（均为可选字段） |
| memory_store  | 无签名变化；内部：图谱写入钩子 + conflict/supersede 判定级联（distillMode/conflictMode 控制）                                                                |
| memory_forget | 无签名变化；内部：图谱软删 + 蒸馏源引用收缩                                                                                                                  |
| memory_status | 可选字段：`distilled`(分层计数)、`dueCount`/`strengthSummary`(巩固)、`graph`(图谱统计)、`conflictPairs`(矛盾计数)；prompt 保持 1.0.0 现有字段                |
| config        | 新键全部默认关闭：`distillMode:'off'                                                                                                                         | 'auto'`、`consolidationMode:'off' | 'auto'`、`graphEnabled:false`、`conflictMode:'off' | 'auto'`、`graphMaxEntities`、`distillMinCluster`、`recallThreshold` 等 |

**签名级兼容纪律**：四工具 `execute(args)` 的既有参数与返回字段逐字节不变；所有新增均为可选参数/可选输出字段；缺省配置下 `queryIndex` 主路径与 1.0.0 逐字节一致（有断言锁定）。

---

## 8. 模块 F —— 评测扩展（G1-G12 全链路）

### F1 既有门禁保持（G1-G8 不回归）

- 327 项测试全绿；eval G1-G6（召回 recall@1/3/5、参数网格、真实数据盲验）不回归；
- 新增「默认配置逐字节等价」断言：`distillMode=off ∧ graphEnabled=false ∧ consolidationMode=off ∧ conflictMode=off` 时召回/状态输出与 1.0.0 快照一致。

### F2 新增门禁（G9-G12）

| 门禁 | 模块     | 夹具                                                                  | 校验脚本                   |
| ---- | -------- | --------------------------------------------------------------------- | -------------------------- |
| G9   | 蒸馏     | 4 组蒸馏夹具（行为簇/偏好簇/指令簇/冲突簇）                           | eval/distill.test.ts       |
| G10  | 图谱     | 5 份图谱夹具（中英混合、含 supersede 时间线、含 zero-hop/2-hop 查询） | eval/graph.test.ts         |
| G11  | 巩固     | 模拟时间轴 100 步收敛脚本（对照/巩固两组）                            | eval/consolidation.test.ts |
| G12  | 冲突共存 | 冲突夹具（对立重建/数据更新/指令止损/真假矛盾）                       | eval/conflict.test.ts      |

统一并入 `npm run eval`（vitest run eval/），`check` 链前置 `verify:realdata` + typecheck + lint + format:check + 全量 test。

### F3 bench 扩展

- `bench/knowledge-graph.bench.ts`：10K 写入增量图构建耗时、邻域扩展 P95；
- `bench/distill.bench.ts`：1K 条目蒸馏批处理耗时、内存占用。

---

## 9. 版本与交付

- 版本号：**1.1.0**（minor：新增能力默认关闭的向后兼容升级）；
- 交付物：`dsh-memory-hub-1.1.0.zip` = `dsh-memory-hub-1.1.0.tgz`（npm pack）+ `DESIGN-1.1`（本文档）+ `quality-report-1.1.0`（G1-G12 全量评测报告 + 覆盖率 + bench 摘要）；
- 代码位置：新增 `src/memory/distill.ts`（模块 A）、`src/memory/consolidation.ts`（模块 B）、`src/memory/graph.ts`（模块 C）、`src/memory/conflict.ts`（模块 D）、`src/memory/cognitive.ts`（A-D 的入口聚合与空闲调度）；改动 `src/config.ts`、`src/tools/*`（新增可选参数/字段）、`src/memory/engine.ts`（四线融合扩展点）、`src/memory/metrics.ts`（新计数）。

---

## 10. 风险与缓解

| 风险                                       | 缓解                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| 蒸馏产出低质抽象（规则启发式）             | 冲突守卫 + 簇大小门槛 + 最小共鸣面阈值；质量以 G9 夹具与可读性人工抽样双保险 |
| 图谱抽取噪音（谓词误判）                   | 词表单一事实源派生 + 置信度阈值 + 实体/边上限；质量以 G10 夹具锁定           |
| 巩固调度误伤高频活跃记忆                   | recallThreshold 保守默认 + 仅高价值条目入队 + consolidationMode 默认 off     |
| 矛盾共存导致召回噪音（对立信息混淆 Agent） | 渲染显式标注 + 时间锚定排序 + conflictMode 默认 off；文档明示权衡            |
| 四线融合排序漂移                           | 默认关闭所有新线；rrf 融合扩展为可选新字段，旧路径逐字节兼容（断言锁定）     |
| 纯函数约束被破坏（副作用泄漏）             | 新模块全部导出纯函数 + storage 副作用集中在 store 层；lint + 测试保障        |
