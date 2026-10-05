# INNOVATION-0.5：dsh-memory-hub 深度创新升级方案

> 版本：0.5.0 ｜ 状态：设计定稿 ｜ 基线：0.4.0（141 测试全绿，lines 93.04 / branches 88.91）
>
> 总纲：**让记忆更像"长期记忆"**——检索不再只看词面精确命中，而是"容错可问、近似可感、价值可辨、热度有生命"；

---

## 1. 升级目标

在 0.4.0（BM25 排序检索 + IndexCache 内容指纹 + 存储自愈 + exportAll 迁移闭环）基础上，针对"插件需求"做**深度创新升级**，五大创新点：

| 编号 | 创新点                                     | 一句话价值                                                         | 解决的用户痛点                                       |
| ---- | ------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| A1   | **模糊查询扩展（fuzzy query expansion）**  | 查询词含错字/近拼变体也能召回精确记忆                              | "我上次说的 deploy 是 delpoy 拼错了，还能找到吗"     |
| A2   | **MinHash 近似语义召回**                   | 措辞不同但 token 语义相近的记忆被兜底召回                          | "说了一件事但没记住原话，换个说法也能回忆起来"       |
| A3   | **记忆价值感知评分（significance-aware）** | 指令/决策/显式记忆天然权重更高                                     | "重要的事别被流水账事实淹没"                         |
| A4   | **记忆生命周期自适应热度**                 | 陈旧高频记忆热度回落，近期验证过的记忆保持热度                     | "3 个月前的高频琐事不再长期霸榜，新记忆有机会被想起" |
| A5   | **离线质量评估套件（eval harness）**       | 黄金语料 + recall@k/NDCG/MRR + 参数网格，`npm run eval` 一键可复算 | "升级有没有变好，用量化指标证明，而不是靠感觉"       |

**硬约束（must，全程不得违反）**：

- `memory_store` / `memory_recall` / `memory_forget` / `memory_status` 四工具的函数签名与输出 schema 完全不变；
- `MemoryEntry` 数据契约不变（不新增/删除/改名任何字段）；
- 安装方式不变（tgz + `dsh plugin add` / 桌面插件页）；
- 质量门槛不降：既有 141 测试全部保持通过，测试数量只增不减；覆盖率不低于 lines 93.04 / branches 88.91；
- 全部新增逻辑保持**纯函数、零外部服务依赖**（不引入 embedding 服务、不回退内存数据库）。

---

## 2. 现状盘点与前沿差距（0.4.0 → 目标）

### 2.1 检索引擎（engine.ts）

| 能力     | 0.4.0 现状                                   | 前沿参考                                                                                           | 差距                   |
| -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| 词项匹配 | BM25 精确词项匹配（NFKC + 停止词）           | 现代检索引擎（Lucene/ES）普遍支持**模糊查询（fuzzy）**（编辑距离 ≤N 的变体匹配）                   | 拼写偏差/近拼词零召回  |
| 语义召回 | 无（纯词面）                                 | 本地 MinHash / SimHash 近似 Jaccard 召回（无需外部 embedding 的轻量语义层）                        | 措辞不同即漏           |
| 记忆价值 | score = BM25 × decay × heat，无类型/来源区分 | 记忆系统（MemGPT/Letta/Zep）普遍做**显著性（salience）加权**：指令/决策权重高于流水账              | 重要记忆被平凡记忆淹没 |
| 热度     | `heat = 1 + 0.1·log1p(accessCount)` 单调不减 | 记忆管理讲究**遗忘曲线（Ebbinghaus）与热度冷却**：久未访问的高频记忆应降温，让新相关信息有出头机会 | 陈旧高频记忆长期霸榜   |
| 可评估性 | bench 仅 top@1 单一语料                      | 搜索引擎/推荐系统标准：**离线评估套件**（黄金语料 + recall@k / NDCG@k / MRR + 参数敏感性网格）     | 无系统化质量回归资产   |

### 2.2 存储 / 捕获 / 工具层

0.4.0 的存储自愈与迁移闭环、捕获启发式与敏感过滤、四工具契约已达标且稳定，本轮**不改动这些层面的公开行为**；捕获/存储层仅在内部保持兼容（A1-A4 全部落在 engine 层纯函数，`MemoryIndex`/`RecallOptions` 的新增成员均为**内部可选扩展**，不触碰存储格式与工具 schema）。

---

## 3. 五大创新设计

### 3.1 A1 模糊查询扩展（fuzzy query expansion）

**算法**：对查询 token 中的**英文纯字母词**（长度 ≥4，避免短词变体爆炸）生成 **Damerau-Levenshtein 距离 ≤1** 的变体集合（插入/删除/替换/相邻交换），过滤停止词与已在词典中的原词；对中文查询不生成变体（中文按 2-gram 切分，天然容忍部分单字差异）。

**评分（关键设计——不干扰精确命中排序）**：

```
bm25_effective = bm25_exact               // 存在任何精确词项命中
               = 0.5 × bm25_variant       // 精确命中为 0 时，变体命中按五折计入
```

只有精确得分恒为 0 的条目才参与变体计分，因此**精确命中条目的排序完全不变**，模糊扩展仅**扩大召回面**（兜底），变体折扣 0.5 保证其排在精确命中之后。

**可复算性**：变体生成规则确定（同一查询词同语料产出同一变体集），纯函数完全确定。

**成本**：仅对查询词做 O(字母数²) 的变体枚举 + 对变体集合查 `index.df` 预筛（df=0 的变体直接丢弃），不进主循环；命中条目受限，开销可忽略。

**开关**：`RecallOptions.fuzzy?: boolean`（默认 true，实测验证后确定；工具侧不传即默认开启，签名不变）。

### 3.2 A2 MinHash 近似语义召回

**动机**：BM25 是词面匹配，用户换一种说法（同义/反义/近义结构）时零召回。引入**纯本地 MinHash** 近似 token 集合 Jaccard——无 embedding 服务、无网络、无第三方依赖，保持"零外部服务"底线。

**算法**：

```
k = 8 个独立 hash（FNV-1a 变体，seed 0..7）
signature(doc) = [ min_{t∈tokenSet(doc)} hash_i(t)  |  i ∈ 0..7 ]
jaccard ≈ |{ i : sig_doc[i] == sig_query[i] }| / k
```

- `buildIndex` 在构建时对每条条目计算 8 维签名，存入 `MemoryIndex.minhash: Map<id, number[]>`（内部字段，不触碰数据契约）；
- `queryIndex` 对查询 token 集算签名；**仅当条目 `bm25_effective == 0`** 且 `jaccard ≥ MINHASH_THRESHOLD`（默认 0.35，可调常量）时进入语义兜底候选；
- 语义候选得分 = `0.3 × jaccard × decay × heat × significance`（A3），因乘性折扣低于任何词面命中，**不改变精确/模糊命中的相对顺序**；
- 签名随索引缓存一并缓存（IndexCache 复用旧索引即复用签名；内容指纹变化才重建，与 0.4 失效语义一致）。

**为何选 MinHash 而非向量**：本地 8× 哈希 O(1) 内存（每条 8 个 number），10K 条目签名构建毫秒级；Jaccard 近似对"部分词重叠"的语义近似（换词不换意）足够灵敏，且**完全可复算、无外部服务**。

**开关**：`RecallOptions.semantic?: boolean`（默认 true）。

### 3.3 A3 记忆价值感知评分（significance-aware scoring）

score 公式演进：

```
0.4.0: score = bm25            × decay × heat
0.5.0: score = bm25_effective  × decay × heat × significance
```

其中：

```
significance = kindWeight[kind] × sourceWeight[source] × density(length)
kindWeight:   instruction=1.25 / decision=1.15 / preference=1.05 / fact=1.0 / generic=0.95
sourceWeight: explicit=1.1 / auto=1.0
density:      content 长度 ∈ [20, 500] → 1；<20 → 0.90（过短语焉不详）；
              >500 → min(1, 500/len)（长文信息密度下降，微惩罚）
```

- 全部为**正的乘性常数因子**：不改变同类记忆（同 kind/source/长度档）之间的相对排序，既有"按相关度排序"的断言语义不变；
- "怎么做"（instruction/decision）与用户显式交代（explicit）天然排前，与人类记忆的显著性层级一致；
- 纯函数可复算；kind/source/len 均取自 `MemoryEntry` 既有字段，**不新增契约字段**。

### 3.4 A4 记忆生命周期自适应热度（heat lifecycle）

**动机**：`heat = 1 + 0.1·log1p(accessCount)` 对时间无感知——3 个月前被高频访问的陈旧记忆永远压过今日刚存入的相关记忆。引入**基于 Ebbinghaus 遗忘曲线的时间衰减热**：

```
heat = 1 + 0.1 · log1p(accessCount) · temporalDecay
temporalDecay = 1                                  // accessCount=0（新记忆恒 1，不衰减）
              = exp(−Δ / halfLife)                 // Δ = max(0, now − lastAccessAt)，lastAccessAt 缺失时视为 1
halfLife 默认 7 天（与既有 decay 半衰期同数量级），RecallOptions.heatHalfLifeMs 可注入
```

- `accessCount=0` 的条目天然 `heat=1`，新记忆不受衰减惩罚；
- 被命中过（lastAccessAt 新鲜）的条目保持热度，许久未命中的高频旧条目热度指数回落——"用进废退"，与记忆的遗忘曲线一致；
- 兼容性：既有测试构造的条目通常不带 `lastAccessAt`（temporalDecay=1），"访问热度增加权重"断言语义保持（同条件下 accessCount 大者 heat 仍更大）；
- 纯函数可复算；不新增 `MemoryEntry` 字段（lastAccessAt 是既有可选字段）。

### 3.5 A5 离线质量评估套件（eval harness）

**目标**：把"升级有没有更好"从主观感受变成可复算的量化指标，并作为**质量回归门槛**纳入工程链。

**资产结构**（新目录 `eval/`）：

```
eval/
├── corpus.ts       # 黄金语料构造器：固定 seed 的 PRNG，四组场景
│                   #   G1 精确质量（80 组，锚词 vs 长干扰，复用 0.4 bench 语料）
│                   #   G2 模糊召回（错字/近拼查询 vs 精确记忆）
│                   #   G3 语义召回（换词不换意 + token 部分重叠）
│                   #   G4 热度生命周期（陈旧高频 vs 新相关，验证 halfLife 效果）
├── metrics.ts      # recall@k / MRR / NDCG@k 纯函数实现（k=1/3/5）
├── report.ts       # 生成 Markdown 评估报告（eval/reports/quality-report.md）
└── eval.test.ts    # vitest 断言：门限（recall@1 ≥ 0.95 等），`npm run eval` 一键运行
```

**运行方式**：`npm run eval` = `vitest run eval/`（无需新增 ts 执行器依赖；vitest 已是 devDependency）→ 跑指标 + 写报告 + 断言门限。`npm run check` 追加 `eval`，保证每次提交都过质量回归。

**参数网格（敏感性）**：`k1 ∈ {1.0, 1.2, 1.5}`、`b ∈ {0.5, 0.75, 0.9}`、`heatHalfLifeMs ∈ {1d, 7d, 30d}` 三组各跑 G1，报告对比表——默认参数（k1=1.2/b=0.75/7d）必须不劣于任何替代组合（oracle 判定写入测试断言），参数可复算可调。

---

## 4. 兼容性论证（既有 141 测试全绿保障）

| 既有测试组                                          | 断言核心                   | A1-A4 下                                                                 |
| --------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `稀有词获得更高权重（IDF）`                         | rare 词命中优先            | ✓ 变体/语义仅"零命中"兜底，精确 IDF 排序不变                             |
| `词频更高的条目优先`                                | 4×「服务」 > 1×「服务」    | ✓ BM25 主路径不变                                                        |
| `按相关度排序，无关记忆不混入`                      | 无关无共现 → 不召回        | ✓ A2 语义召回有 jaccard ≥ 0.35 阈值硬门槛；A1 需变体命中；当前语料不触发 |
| `新鲜记忆权重更高（时间衰减）`                      | decay 因子                 | ✓ decay 保留                                                             |
| `访问热度增加权重`                                  | accessCount 大者排前       | ✓ 测试条目无 lastAccessAt → temporalDecay=1，heat 仍单调于 accessCount   |
| `index 与 recall 结果一致`                          | 同一评分语义               | ✓ queryIndex 与 recall 共享同一路径，新增逻辑在 queryIndex 内            |
| `token 预算裁剪 / limit / workspace / kind 过滤`    | 与评分无关                 | ✓ 逻辑层不变                                                             |
| `tokenize（英文/中文二字组）`                       | hello/typescript/前端/端工 | ✓ tokenize 不动                                                          |
| `空查询短路`                                        | 空/纯标点 → []             | ✓ 短路保留；停止词查询 qTf 空 → 短路在前                                 |
| `IndexCache revision/指纹语义（4 条）`              | 复用/重建/clear/缺省       | ✓ minhash 随 index 一起缓存，失效键（revision+指纹）不变                 |
| `similarity / isDuplicate`                          | 编辑距离/去重窗口          | ✓ 不走 recall 路径                                                       |
| store 全部测试（损坏隔离/exportAll/compact 自检等） | 存储语义                   | ✓ 本轮不改 store 公开行为                                                |
| tools 全部测试（4 工具 schema 与行为）              | 工具契约                   | ✓ 签名与 schema 不动                                                     |
| load 冒烟测试                                       | 真实 dsh 加载              | ✓ 无初始化路径变更                                                       |

新增测试（A1-A5 专项）预计 **+35～45** 个，总量升至 **176+**，覆盖率只增不减（新增纯函数分支全部有专项用例与边界用例）。

---

## 5. 实施清单

| 阶段              | 范围                                                                    | 验收                                           |
| ----------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| T1 方案           | 本文档                                                                  | 逐项论证 A1-A5 的兼容性与可复算性              |
| T2 检索引擎升级   | A1+A2（容错扩展 + MinHash 语义召回，engine.ts）                         | 引擎测试全绿、模糊/语义召回专项用例通过        |
| T3 价值与生命周期 | A3+A4（显著性 + 热度生命周期，engine.ts）                               | 热度回归与显著性排序测试通过                   |
| T4 评估套件       | A5（eval/ 黄金语料 + 指标 + 报告 + 网格）                               | `npm run eval` 全过、报告生成、门限断言成立    |
| T5 测试与护栏     | 既有 141 全绿 + 新增专项测试，覆盖率不降，check/bench 全过              | 测试 ≥141 全绿，lines ≥93.04 / branches ≥88.91 |
| T6 文档与打包     | README/ARCHITECTURE/CHANGELOG 同步 0.5.0，version 0.5.0，zip 同名重打包 | npm run check + eval 全过，zip 完整性 OK       |

## 附录 A：评估指标定义

- **recall@k**：对查询 q，前 k 条命中中相关记忆条数 / 语料中相关记忆总数（单目标场景 = 是否 top-k 命中）；
- **MRR（Mean Reciprocal Rank）**：`1/rank_of_first_relevant` 的平均；
- **NDCG@k**：DCG@k（相关度分数按位置对数折扣）除以理想 DCG@k 归一化；
- 相关度标注随黄金语料固化（corpus.ts 内建 relevance 映射），完全离线、可复算。
