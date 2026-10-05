# dsh-memory-hub 1.0 世纪升维设计（DESIGN-1.0）

> 版本：1.0.0（升维版）｜前置基座：0.10.0｜定位：在既有「契约极稳、纯函数优先、可复算至上」的基座上，对行级遍历报告（CODE-WALKTHROUGH.html §8）冻结的 **10 项疑点与架构短板** 做系统性升维，并引入市面上没有的记忆生命周期闭环与双引擎检索，达成「DeepSeek Harness 大多数用户都需要的、市面上没有的」会话记忆中心。

---

## 1. 目标与验收锚点

| #   | 目标                               | 验收锚点（对应 requirement）                                                                               |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| G1  | 整体升维，补齐 10 项疑点与架构短板 | 疑点×方案映射表（§2）逐项落地 + 专项测试                                                                   |
| G2  | 既有机制与功能不回归               | 既有 325 项测试全绿；eval G1-G6 七门限全过（G6 recall@1≥0.75/@3≥0.85/@5≥0.95）                             |
| G3  | 前沿且市面上没有                   | A-F 六大模块（§4-§8）落地，关键机制有 bench/eval 实证                                                      |
| G4  | 大多数用户真实需求                 | 记忆冲突自动识别、近重复根治、主题导航、混合检索——覆盖 Harness 用户「记不住/找不回/记冲突/重复记」四大痛点 |
| G5  | 可运行可测试交付                   | 压缩包含 src/test/eval/bench/docs，`npm run check` + `npm run eval` 全绿                                   |

硬约束（全程继承 0.10.0）：

- **MemoryEntry 持久化契约零变更**（id/kind/content/tags/source/sessionId?/workspace?/createdAt/updatedAt/accessCount/lastAccessAt?）——旧存储文件逐字节可加载；升维机制全部落在运行时层 + tags 协议 + id 规范。
- 四工具签名与输出 schema 不破坏性变更（仅新增可选参数/字段，向后兼容）。
- 零新增运行时第三方依赖（仅 node 内置 + 既有 peer：cordis/dsh-tools/dsh-session/dsh-llm 类型）。
- 覆盖率阈值不降（lines≥96.5 / branches≥95 / functions≥97 / statements≥96.5，目标维持 100/97+/100/100）。

---

## 2. 10 项疑点 × 升维方案映射

| #   | 疑点（行级报告 §8）                                                                                                               | 根因                             | 升维方案                                                                                                                                                                                                                                              | 落地位置                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | G5 参数网格区分度低（b=0.5 塌缩、其余全 1.0，k1/半衰期无压力）                                                                    | 网格只覆盖 G1 单一指标且语料饱和 | G5 升级为 4 维网格（k1×b×heat×**语义权重**=3×3×3×3=81 组），指标列 recall@1+NDCG@5；新增**梯度化语料**（锚词频率梯度 1/3/9，使 b 与 k1 产生可区分响应）                                                                                               | eval/corpus.ts、eval/eval.test.ts                                                                            |
| 2   | G6 锚标注主观、三方同源自证风险                                                                                                   | 查询/锚/语料同作者维护           | G6 升级：①语料扩为 4 份（+fs.md +stream.md，SHA 固化）；②查询扩至 40+ 条，问句全部改为**自然语言问法**（去 API 专名引导）；③锚改为「多锚 OR」+ 每条查询至少 2 个独立锚短语；④新增**盲验守卫**：若某查询召回全部 top5 均为非锚命中则门禁红（防锚过宽） | eval/realdata.ts、eval/eval.test.ts、eval/realdata/*                                                         |
| 3   | MinHash 预筛 0.30 下界可能剪掉 0.30-0.45 真实候选                                                                                 | 预筛阈值 2/3×精确阈值是保守近似  | 预筛改为**两级守卫**：签名覆盖率 ≥ 精确阈值(0.45) 直接进；< 精确阈值但 ≥ 硬下界(0.30) 时**仍进精确验证**（仅当 <0.30 才剪）——预筛永不排除精确验证本会通过的候选，消除理论漏召                                                                         | src/memory/engine.ts（queryIndex 语义分支）                                                                  |
| 4   | captureMode 语义在文档与代码间需细读才一致                                                                                        | README 无「模式×事件类型」矩阵   | README 增加模式×事件类型×提取器对照表，附行为断言测试引用                                                                                                                                                                                             | README.md、test/upgrade-1.0.test.ts                                                                          |
| 5   | 快照零拷贝共享引用存在隐含契约                                                                                                    | list() 契约未文档化              | MemoryStore 接口文档显式声明「list() 返回只读共享视图，调用方不得修改；需可变副本自行拷贝」，新增契约测试（外部修改旧引用不影响 store 后续状态）                                                                                                      | src/memory/types.ts、test/memory/store-contract-1.0.test.ts                                                  |
| 6   | 背压 FIFO 丢弃「最早期」，大导入后事件队列挤压待实测                                                                              | 已核对无竞态，仅缺实证           | bench 新增「10K 导入 + 并发事件捕获」冒烟基准，锁死无竞态；README 注明背压语义                                                                                                                                                                        | bench/recall.bench.ts                                                                                        |
| 7   | 导入(imp- 前缀)与捕获(randomUUID 后缀)同内容生成两条不同 id 记忆                                                                  | 去重链两套 id 规范不互认         | **统一内容指纹协议（UF-1.0）**：所有写入路径（捕获/显式/导入）共享 `contentHash(content)` 指纹做库内去重判定（isDuplicate 升级为跨 id 规范的内容级去重：先查「同指纹或相似度>0.92」再写入）；导入路径与捕获路径对同一文本互认重复                     | src/memory/ingest.ts、src/tools/memory-store.ts、src/memory/importer.ts、src/memory/engine.ts（isDuplicate） |
| 8   | 325 项断言一致性需复核                                                                                                            | 计数口径随版本漂移               | 升维后 README/CHANGELOG 统一写「实际运行计数（vitest）」，CI 增加 `npm test -- --reporter=verbose` 计数断言脚本（读 stdout 统计）                                                                                                                     | .github/workflows/ci.yml、package.json                                                                       |
| 9   | importer 依赖 capture 词表，但 importer 内联了**第二份**信号词正则（INSTRUCTION_HINTS/PREFERENCE_HINTS 与 capture.ts 词表不同源） | 词表单源化未覆盖导入侧           | importer 的 INSTRUCTION_HINTS/PREFERENCE_HINTS 改为**由 capture.ts 词表编译派生**（复用 STRONG/BALANCED/BASIC 词面 + 指令词面），彻底消灭双份词表漂移                                                                                                 | src/memory/importer.ts                                                                                       |
| 10  | 评估可复算域：语料 SHA 固化守卫已存在                                                                                             | 设计决策，需自动化               | 新增 `scripts/verify-realdata.mjs`：校验 MANIFEST 哈希与字节数，纳入 `npm run check` 前置（一破坏即红）                                                                                                                                               | scripts/verify-realdata.mjs、package.json                                                                    |

> 注：疑点 6/8/10 属「实证/一致性」性质，不修行为本身，补自动化守卫收口。

---

## 3. 六项薄弱点（架构短板，超越行级报告）

在疑点之外，读写全量后额外冻结 6 项结构性短板：

| #   | 短板                                           | 现状                                         | 升维                                                                                               |
| --- | ---------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S1  | 记忆「只见单条，不见关系」                     | 无冲突/取代/关联概念，新记忆与旧记忆并列存在 | 冲突感知（supersede 协议）+ 主题自动聚类视图                                                       |
| S2  | 召回单引擎（BM25 词面为主）                    | A1/A2 仅是零命中兜底的低权重旁路             | 混合检索：精确线 + 语义线 + 容错线 **RRF 分数融合**，可配权重                                      |
| S3  | 存储退化（tombstone 膨胀）依赖随机触发 compact | compact 阈值简单（2×/64 行）                 | 增加「写后聚合判定」与 compact 统计上报（reclaimed/ratio），status 输出冗余比建议                  |
| S4  | 热度回写逐条 upsert 全量 JSONL append          | heatDirty 合并已抗刷，但 upsert 全条目重写   | 热度回写保持合并 + 粒度压缩（仅 bump 字段的轻量 upsert 形态）——不改变契约，reduce 序列化字节约 60% |
| S5  | 导入/捕获/显式三条写入路径逻辑分散             | ingest.ts/store.ts/tools 各自组装 entry      | 抽取 `entryFactory(输入, 路径标识)` 统一组装 + UF-1.0 指纹；三路径行为测试对表                     |
| S6  | 测试五层纵深但缺「跨路径集成」层               | 单元/集成/冒烟/生命周期/专项齐全             | 新增 memory-integration-1.0.test.ts：捕获→导入→显式→召回→冲突→遗忘全链路单文件测试                 |

---

## 4. 模块 A —— 记忆生命周期与冲突感知（市面上没有）

### A1 supersede 取代协议（tags 兼容，零 schema 变更）

- **触发**：显式 memory_store 或导入写入时，若新内容与窗口内既有条目**语义对立**（对立信号协议，见下）或**主题相同且明确版本化措辞**（「改用/升级到/改为/现在是……不是……/use X instead of Y」），判定为取代关系。
- **落盘**：新条目 tags 追加 `supersede:<旧id>`；旧条目 tags 追加 `superseded-by:<新id>`（查找旧条目后更新）。
- **召回语义**：queryIndex 命中含 `superseded-by:` tag 的条目时，分数 ×0.5 衰减；若同一查询同时命中取代对双方，仅保留新条目（去重合并进 hits）。
- **状态可见**：memory_status 新增冲突计数（superseded 总数）；memory_recall 的 rendered 文本对取代对显示 `（已被更新版本取代）`。
- **对立信号协议**（单一事实源 capture.ts 词表派生）：`改用|换成|不再用|不要再用|升级到|迁移到|switch to|migrate to|replace|instead of|now use` 与 `必须|务必` 指令强关联时触发。

### A2 主题自动聚类（运行时视图，不持久化）

- **算法**：对全部条目计算共享 token 图（token→条目倒排），用**并查集连通分量**把共享 token 数 ≥2 的条目聚为「主题」，主题 id = 成员中 content token 频率最高的词（hash 去冲突）。
- **接口**：memory_status 增加 `themes: { id, label, memberCount, topKinds }[]`（可选）；memory_recall 增加可选 `theme` 过滤参数。
- **成本**：O(N·tokens) 一次，IndexCache 构建时并行计算并缓存（随索引失效），10K 条目实测 < 100ms（bench 项）。

### A3 冷热分层与价值感知淘汰

- **概念层（不迁移文件）**：召回分「优先层 = 未 superseded 且窗口内活跃」「候选层 = 其余」；status 报告 hot/cold 计数。
- **可选淘汰**：新增配置 `maxEntries`（默认 0 = 不限）；超过时按「价值分=significance×heat×recency」淘汰最低分非 instruction 记忆（instruction 永不自动淘汰），仅当用户在配置显式开启 `autoEvict: true`（默认 false，零行为变化）。

---

## 5. 模块 B —— 双引擎混合检索（RRF 融合）

### B1 三线召回

| 线     | 评分                                                 | 权重（默认） |
| ------ | ---------------------------------------------------- | ------------ |
| 精确线 | BM25（既有，k1/b 可注入）                            | 1.0          |
| 容错线 | A1 编辑距离≤1 变体 0.5 折扣（既有）                  | 0.5          |
| 语义线 | A2 字符 3-gram 精确覆盖率（既有阈值 0.45，权重 0.3） | 0.3 × 覆盖率 |

### B2 RRF 融合（升级评分架构）

- 现状：A2 仅在 `bm25 === 0` 时兜底——语义线永远不能与词面线**叠加贡献**。
- 升维：三段独立求分后 **Reciprocal Rank Fusion**（`score(id) = Σ_line 1/(60 + rank_line(id))`），再乘 significance × heat × decay。
  - 默认 `fusionMode: 'interpolate'` 时：`score = bm25 + 0.5·fuzzy + 0.3·cov`（可调）；`fusionMode: 'rrf'` 时启用 RRF。
  - **兼容性**：`fusionMode` 默认 `'interpolate'`，且 `fuzzy/semantic` 开关、既有阈值语义在精确线有命中时的排序保持逐字节等价（有断言锁定）；语义线仅在词面零命中或模糊零命中时叠加，作为**可选项**默认关闭叠加（`semanticBoost: false` 默认 → 行为与 0.10.0 完全一致），评估 G3/G6 验证开关开启时的增益。
- **收益**：G3 语义 recall@1 实测从 0.8 提升空间（eval 报告对比）；G6 真实问句 recall@1 提升（语义线弥补词面缺口）。

### B3 查询理解增强（分词升级）

- 数字/版本号保护：`path.extname` 等 API 专名中的 `.` 作为 token 边界保留（现有分词把 `path.extname` 拆成 `path`/`extname` 两个 token；升维为对 `\w+\.\w+` 模式输出**完整 token** + 分拆 token 双索引，召回 `path.extname` 时完整 token 优先得分）。
- 中文叠词/前缀统一：`2-gram` 保持不变（逐字节兼容），但查询侧 NFKC 后增加 `\u00b7`/`·` 归一为 `.`（版本号常见写法）。

### B4 可选 LLM 重排（tier-2，不默认开启）

- 若宿主上下文注入 dsh-llm 能力（类型上 `inject` 可选），提供 `memory_recall(..., rerank: true)`：对 top-K(≤16) 候选做 0/1 相关性重排，输出 order 调整。
- **不依赖**：功能存在即可用（kg 无 LLM 时自动回落纯工程排序），零行为回归；文档明示为进阶用法。

---

## 6. 模块 C —— 统一写入指纹与去重根治（修复疑点 7）

### C1 UF-1.0 内容指纹协议

- 所有路径写入前，先做**内容级库内去重**：`exactHash = contentHash(content)` 已存在（任意 id 前缀）→ 拒绝；否则对窗口内条目跑 `similarity > 0.92` → 拒绝。
- ingestCaptured / memory_store.execute / planImport 三处统一调用新增纯函数 `detectDuplicate(existing, content, windowMs)`（engine.ts 导出，isDuplicate 升级封装）。
- importAll 内部不重复；planImport 的 `imp-` 幂等保留（防重复导入），但导入**前**先查库内任意 id 的同指纹条目 → 计 droppedDuplicate。

### C2 写入路径统一

- 新增 `src/memory/entry-factory.ts`：`makeEntry({ content, kind, tags, source, workspace, sessionId?, now })`，统一 id 组装（`${contentHash}-${randomUUID 后缀}`）、tags 清洗、截断、敏感拒绝前置——三条路径行为对表单测。

---

## 7. 模块 D —— 可观测性升维

- `HubMetricsSnapshot` 增加 4 项（可选字段，向后兼容）：`superseded`、`rejectedDuplicateCrossPath`（跨路径去重拒绝数）、`fusionHits`、`themeBuilds`。
- `memory_status` 输出增加：`superseded`、`hot/cold` 计数、`themes` 数组、`duplicateRatio`（冗余行占比=lines/entries-1）、建议项（如「存在 12 条被取代记忆，可运行 memory_forget 清理」）。
- formatMetrics 保持一行摘要（追加新计数，旧字段顺序不变，逐字节向后兼容）。

---

## 8. 模块 E —— 评估方法论升维（修复疑点 1/2/10）

- **G5-1.0**：4 维网格 81 组合 + 梯度语料（见 §2 #1），指标 recall@1/NDCG@5，断言「默认组不劣于任何组合」且「b 梯度组间有可区分性（max-min ≥ 0.05）」（防塌缩回归）。
- **G6-1.0**：扩展语料（path/os/fs/stream 四份）、40+ 自然语言问句、多锚、盲验守卫（见 §2 #2）。
- **G7 鲁棒性（新增）**：对 G1 查询做扰动（大小写/全角/首尾空白/标点/错字 5 类×80 条），断言扰动召回退化 ≤ 5%（相对）。
- **G8 生命周期（新增）**：冲突/取代场景合成语料：supersede 判定准确率 ≥ 0.9、被取代记忆召回分数衰减、主题聚类纯度 ≥ 0.85。
- **verify-realdata**：脚本固化语料哈希校验，纳入 `npm run check`（修复疑点 10 的自动化缺口）。

---

## 9. 性能与工程（模块 F）

- **IndexCache 增量构建**：store 暴露 `lastInserted: MemoryEntry[]`（写链记录最近一次 upsert/importAll 的新条目）；IndexCache 检测到「仅新增」时增量追加 tf/df/docLen/features/minhash（O(新增 tokens)），不重扫全表；改动/删除才全量重建。bench 新增「10K 库 + 100 增量写入后热查询」对比项（预期较全量重建快 ≥10×）。
- **紧凑热度回写**：heatDirty flush 改为序列化精简形态（只写 changed 字段？—— MemoryEntry 契约要求整条 JSONL，因此改为**同 id 合并 upsert**（已有）并**批量 appendRaw**（一次 syscall 多行），减少 90% write call）。
- **compact 统计**：compact 后上报 `reclaimed = lines - entries` 与 `ratio`（status/指标）。

---

## 10. 兼容性论证（逐项）

| 变更点           | 兼容性                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| MemoryEntry 契约 | 零变更；supersede 走 tags 协议；theme 运行时计算不落盘                                                                                      |
| 四工具签名       | 仅新增可选参数（recall: rerank/theme/fusionMode；store: 无破坏；status: 输出追加字段）                                                      |
| 既有测试         | 325 项必须全绿：默认配置下所有新机制关闭或语义等价（supersede 仅显式对立词触发、semanticBoost 默认关、autoEvict 默认关、maxEntries 默认 0） |
| eval G1-G6       | 门限不降且加严（G5 防塌缩 + G6 加盲验）；新增 G7/G8 只加门禁                                                                                |
| 0.10.0 存储文件  | 逐字节可加载（契约未变、parse 未变）                                                                                                        |
| 覆盖率           | 新代码全分支直测，保持 lines 100 / branches ≥95 / functions 100                                                                             |

**行为默认值哲学**（继承 0.9.0）：所有可能改变既有排序/入库行为的创新默认关闭（`semanticBoost:false`、`supersedeMode:'off'`、`autoEvict:false`、`maxEntries:0`），用户显式开启即获得升维能力；开启后的行为变更全部有 eval/专项测试锚定。

---

## 11. 实现顺序与验收清单

实现顺序（P0→P1→P2，依赖序）：引擎与存储基座 → 工具与入口 → 评估 → 测试与文档。

1. **P0 基座**：UF-1.0 去重统一（engine.isDuplicate 升级 + entry-factory + 三路径接入）→ importer 词表单源化（疑点 9）→ MinHash 预筛两级守卫（疑点 3）→ IndexCache 增量构建
2. **P1 生命周期与检索**：supersede 协议（capture 词表派生信号 + engine 评分衰减 + status 计数）→ 主题聚类 → RRF/语义叠加（默认关）→ 查询理解（API 专名 token 保护）
3. **P2 观测与评估**：metrics 扩展 → status/themes/建议 → G5-1.0/G6-1.0/G7/G8 → verify-realdata 脚本 → README/CHANGELOG/文档同步 → 版本 1.0.0 打包

验收清单（对照 requirement 逐条）：

- [ ] 打包产物：src+test+eval+bench+docs 全量、`npm run check` 全绿
- [ ] 包名 dsh-memory-hub、工作目录原地迭代、压缩包交付
- [ ] 10 疑点 × 方案映射全部落地（§2 表）
- [ ] 既有测试 325 项全绿，G1-G6 七门限通过（G6 recall@1≥0.75/@3≥0.85/@5≥0.95）
- [ ] 新增 G7/G8、G5-1.0/G6-1.0 门禁全绿
- [ ] bench 8 项 + 新增 3 项（增量构建/主题聚类/大导入并发）可观察输出
- [ ] docs 全部同步（DESIGN-1.0/LIFT-1.0/QUALITY-1.0/GROUND-1.0/ARCHITECTURE 更新）

---

## 12. 文档边界

本设计为规划文档；实现过程中的实测结果、偏差与证据写入落地审查 `docs/LIFT-1.0.md`；质量门实测写入 `docs/QUALITY-1.0.md`；真实数据评测方法论写入 `docs/GROUND-1.0.md`。
