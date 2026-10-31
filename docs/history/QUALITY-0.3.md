# Quality-0.3：全量代码质量前沿化进化方案

> 主题：对 dsh-memory-hub 全部源码/测试/配置/文档做一次面向"最前沿工程质量标准"的静态审查，
> 输出**优先级排序**的改造清单，作为本轮实施的唯一依据。
>
> 审查基准：类型系统严格度、模块组织与依赖方向、健壮性边界、并发与性能、测试纵深、可移植性。
>
> 不变式（硬约束，任何改造不得破坏）：
>
> 1. 对外功能与 4 个工具（memory_store/recall/forget/status）签名、行为语义不变；
> 2. 安装方式与 `MemoryEntry` 数据契约不变；
> 3. 质量门槛不降：测试 ≥100 全绿、tsc/eslint/prettier/tsup 全过、覆盖率 threshold 维持或提升；
> 4. 工程版本保持 0.3.0，zip 沿用 `dsh-memory-hub-0.1.0.zip` 同名路径。

## 0. 审查范围与方法

- 源码全量通读：`src/` 13 文件 1724 行（index/store/engine/types/capture/metrics/config/errors + 4 个 tool）；
- 测试全量通读：`test/` 13 文件 1395 行；`eslint.config.js`（flat config）、`tsup.config.ts`、package scripts 复核；
- 依赖机制核实：阅读 `@deepseek-ai/dsh-tools` 源码确认 `defineTool` 内部通过
  `validateJsonSchemaValue` 对**一切 model 生成的参数**做严格运行时校验（含 enum），
  因此非法 `kind` 在工具边界即被拦截，无需在 store 层重复防御（结论见 P1-5 之外的确认项）。
- 每项改造方向均先 grep 既有断言，确认不破坏现有测试语义后再列入方案。

## 1. P1 正确性缺陷（必修，4 项）

### P1-1 · engine.queryIndex 空查询缺陷

- **位置**：`src/memory/engine.ts` `queryIndex()`
- **现状**：查询词全部 tokenize 为空时（如 `"???"`、`"！！"`），`qTf` 为空 → `qNorm = 0`；
  `score = (qNorm === 0 ? 0.01 : cosine) * decay * heat`，`score > 0` 恒成立 →
  **会把库中全部条目按热度排序返回**，语义错误（空查询应返回空结果）。
- **证据**：`engine.test.ts` 6 个 recall 用例均使用正常关键词，无空查询用例，修复不破坏断言。
- **修复**：`qNorm === 0 || qTf.size === 0` 时直接返回 `[]`。
- **验收**：新增用例——空查询/纯标点查询返回 `[]`；正常查询结果不变。

### P1-2 · store.open mkdir 失败未包装

- **位置**：`src/memory/store.ts` `open()`
- **现状**：`readFile` 失败已包装为 `STORE_READ_FAILED`，但前置的
  `mkdir(dirname(filePath), { recursive: true })` 失败会抛出**原生 Node 错误**
  （如只读文件系统的 EACCES），未纳入统一错误码体系。
- **证据**：`store-0.3.test.ts` 仅测写失败路径（STORE_WRITE_FAILED），无 mkdir 失败用例。
- **修复**：mkdir 用 try/catch 包装为 `STORE_WRITE_FAILED`（写入侧错误）。
- **验收**：新增用例——mkdir 失败时 rejects 且错误码为 STORE_WRITE_FAILED。

### P1-3 · store.secure 目录 0700 副效应（潜在破坏性）

- **位置**：`src/memory/store.ts` `secure()`
- **现状**：对 `dirname(filePath)` 无条件 `chmod(0o700)`。若用户 storageDir 指向
  既有共享目录（如 `/data`、家目录下共享子目录），会把**整个目录**权限收紧，
  影响目录内本插件之外的其他文件的可访问性——属于不可见副效应。
- **证据**：现有代码无任何测试断言目录权限行为；grep 确认无既有测试锁定旧语义。
- **修复**：仅当目录**由本插件新建**（mkdir 返回 created=true）时才收紧目录为 0700；
  既有目录保持原权限不动；**文件权限始终 0600**（隐私底线不降）。
- **验收**：新增用例——既有共享目录打开后目录权限保持不变；新建目录仍为 0700；文件始终 0600。

### P1-4 · memory-forget id trim 不一致

- **位置**：`src/tools/memory-forget.ts`
- **现状**：删除时用 `args.id.trim()`，但返回结果原样输出 `args.id`——
  上报的 id 与真实删除的 id 可能不一致（尾随空格场景）。
- **证据**：forget 既有用例均传无空格 id，修复不破坏断言。
- **修复**：统一使用 trim 后 id，返回值与副作用一致。
- **验收**：新增用例——传入 `" abc "` 删除的是 `"abc"` 且返回 `"abc"`。

## 2. P2 类型纯度与代码组织（实施 1 项 + 维持 3 项决策）

### P2-1 · 消除全部非空断言（实施）

- **位置**：`capture.ts` `hits[0]!`（1 处）、`engine.ts` levenshtein 的 5 处 `!`
  （`prev[j]!`、`cur[j-1]!`、`prev[j-1]!`）。
- **现状**：断言在逻辑上安全（索引均有界），但违背"strict 下类型纯度最大化"。
- **修复**：
  - capture：先取 `const first = hits[0]` 再 `if (!first)` 短路；
  - engine：将反转两个数组拷贝的 `splice(...cur)` 改为显式 `prev[j] = cur[j]` 循环，
    使索引访问全部去断言化（不引入 `no-non-null-assertion` 全局规则，避免噪声，见 P2-2）。
- **验收**：`grep -rn '!'` 在 `src/` 中仅剩不可避免的少数场景（如有意为之的
  index signature 访问，逐处注释说明）。

### P2-2 · 决策：不开 `no-non-null-assertion` 全局规则（维持）

- 引擎 levenshtein 的断言属于数组索引标准实践，强开规则会引入无信息量的
  `as number` 噪声；改为代码级消除 + 行内注释，效果等同且零规则负担。

### P2-3 · 决策：IndexCache 热度失效权衡（记录不修）

- recall 热度 bump → upsert → revision++ → 下次 recall 重建索引。
  语义已确认正确（revision 不变时缓存与最新 list 等价）。改进方案需动
  `MemoryStore` 接口（引入负 space），超出"不改对外 API"不变式，仅在文档记录权衡。

### P2-4 · 决策：ingest 多候选去重为死增强（排除）

- 现有提取器（subject/workspace/fileText 三路）均返回 0/1 候选，无多候选路径；
  去重逻辑无触发条件，属死代码风险，排除。

### P2-5 · 已核实无需处理：非法 kind 参数

- `defineTool` 运行时强校验 enum（见审查范围），非法 kind 在工具边界被拦截，
  不会进入 store；`memory-recall.ts` 已有的手动 kind 校验作为纵深防御保留。

## 3. P3 性能资产与测试纵深（2 项）

### P3-1 · 大库召回一致性测试

- **内容**：1000 条随机条目（混入重复/过期/不同 kind/workspace）→ recall 预算裁剪、
  热度更新后 revision 变化与结果一致性断言。
- **目的**：验证大库下检索正确性（预算裁剪不越界、热度 bump 后索引失效机制正确）。

### P3-2 · `bench/recall.bench.ts` 基准

- **内容**：vitest bench（匹配 `*.bench.ts`，`npm run bench`，不 gate CI）：
  1K/10K 条目库 queryIndex 成本、IndexCache 冷/热命中延迟、预估 token 裁剪耗时。
- **目的**：性能热点可量化、可回归观察；不进 CI 断言（避免抖动误报）。

## 4. P4 测试补强清单（配合 P1/P2 实施）

| 用例                 | 关联 | 断言内容                        |
| -------------------- | ---- | ------------------------------- |
| 空/纯标点查询        | P1-1 | 返回 `[]`，正常查询不受影响     |
| mkdir 失败错误码     | P1-2 | rejects 且为 STORE_WRITE_FAILED |
| 既有目录权限不被破坏 | P1-3 | 目录权限保持不变，文件仍 0600   |
| 新建目录权限         | P1-3 | 新目录 0700                     |
| forget trim 一致性   | P1-4 | 删除与返回均用 trim 后 id       |
| 大库召回一致性       | P3-1 | 1000 条随机库召回正确           |

## 5. P5 文档同步（收尾）

- `ARCHITECTURE.md`：secure 权限语义细化（新建目录 0700 / 既有目录不动 / 文件 0600）、
  空查询语义、ID 规范化说明；
- `CHANGELOG.md`：并入 0.3.0 段落，登记本轮质量进化条目；
- `README.md`：权限策略小节同步；
- 版本保持 0.3.0；原地重打包 zip。

## 6. 验收清单（全部通过才算完成）

- [ ] P1 四项修复全部落地并有对应测试；
- [ ] P2-1 非空断言消除完成，逐处注释或证明；
- [ ] `npm run check`（tsc + eslint + prettier + tsup）全过；
- [ ] 测试 ≥100 全绿，覆盖率 threshold 不降（现 lines 91.6 / branches 87.4）；
- [ ] `npm run bench` 可运行且输出量化指标；
- [ ] 文档同步完成，版本 0.3.0，zip 原地重打包并完整性校验。
