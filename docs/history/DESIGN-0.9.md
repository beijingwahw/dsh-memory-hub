# dsh-memory-hub 0.9.0 创新升维设计方案（16 项薄弱项闭环）

> 目标：用世界级创新架构解决 DEEP-AUDIT 实锤的 16 项薄弱项（P0×3 / P1×6 / P2×7），
> 全程守住 9 项硬约束：四工具签名、MemoryEntry 契约、cordis.patch.yml 安装方式、
> 纯函数零外部依赖、旧测试全绿、覆盖率不降（lines 100 / branches ≥96.1 / functions 100 / statements 100）、
> 渲染文本与错误码逐字节不变、eval G1–G5、bench。
>
> 本文档为设计定稿（含语义变更点、硬约束映射、新增测试计划），实现按 P0→P1→P2 顺序落地。

---

## 设计总览：六个「前沿创新主题」

| 主题                                           | 覆盖项               | 核心理念                                                                                    |
| ---------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| T1 漂移免疫词法（Drift-proof Lexicon）         | B、M                 | 信号词强度分级单源建模，正则/数组由词表驱动派生，跨表漂移在编译期免疫                       |
| T2 统一隔离语义（Shared-by-default Isolation） | J                    | 未标注 workspace = 全局共享；两工具与双捕获路径共用同一语义，工具结果按 Agent 会话 cwd 溯源 |
| T3 双尺度时间语义（Dual-timescale Scoring）    | Q                    | 评分衰减与 TTL 清理解耦：decay 可关闭/可调半衰期，「永不过期」真正可检索                    |
| T4 写入路径工程化（Write-path Engineering）    | C、D、N              | 批内瞬时去重 + 捕获栅栏 + 热度合并回写（抗刷），写放大的三个源头全部封堵                    |
| T5 索引化候选剪枝（Signature Pre-screening）   | K、O                 | MinHash 从预留落地为真实剪枝；快照共享 + 写时重建，读路径零拷贝                             |
| T6 契约显式化（Contract Explicitness）         | E、G、H、A'、S、F、L | 死字段/死配置/死兜底全部显式化：要么落地语义，要么去除冗余                                  |

---

## P0 三项（语义/正确性缺陷）

### B. 强度词跨表漂移 → 单一信号源词法（T1）

- **根因**：`STRONG_HINTS` 含「务必/一定」但不在 `PREFERENCE_HINTS`，`hits.length===0` 提前 return 使强度检查不可达。
- **设计**：capture.ts 重构为分级词表（**单一事实源**）：
  - `STRONG_TERMS = ['务必','一定','永远','始终','never','always']`（高置信，conservative 单命中放行）
  - `MID_TERMS = ['记住','以后','优先','偏好','习惯','remember','prefer']`（中置信，balanced 单命中放行）
  - `BASIC_TERMS = [...]`（其余现状词面）
  - `PREFERENCE_HINTS = [...STRONG_TERMS, ...MID_TERMS, ...BASIC_TERMS]`（**裸词并入** → hits 永不为 0 时强度检查可达；与现状数组比较仅新增「务必/一定」两词）
  - `STRONG_HINTS` 由 `STRONG_TERMS.join('|')` **派生**（导出形态不变）；`BALANCED_STRONG_HINTS` 词面不变（**balanced 行为零变化**）
- **语义变更点**：保守模式修复「务必/一定」单强词漏记（B2 实锤 `[]` → 捕获）；balanced/aggressive/off 行为不变。
- **硬约束映射**：capture.ts 纯函数零依赖不变；无旧测试断言裸「务必/一定」拒绝（edge-0.8 断言「请务必」不受影响）；`MemoryKind`/契约不变。
- **新增测试**：裸「务必使用 pnpm」conservative → 1 条捕获且 kind=preference；裸「一定」conservative 同理；「务必/一定」balanced 行为锚定（与 0.8.0 一致：单词拒绝）；词表派生一致性（STRONG_HINTS 与 STRONG_TERMS 全词命中）。

### J. workspace 隔离语义分裂 → 默认共享 + 会话 cwd 溯源（T2）

- **根因**：engine 过滤 `entry.workspace` 有值才比较（无 ws 条目不过滤）；status 严格相等；tools/result 捕获固定传 undefined。
- **设计**：
  1. **统一语义**：无 workspace = 全局共享记忆（任何工作区可见）。engine 现状即此语义，**注释/文档明示**；`tools/memory-status.ts` 过滤改为 `e.workspace === undefined || e.workspace === args.workspace`。
  2. **tools/result 携带 workspace**：`exec.agent?.session?.header?.cwd`（ToolExecution.agent → Agent.session.header 均为公开只读），工具结果类记忆获得真实 workspace 溯源，不再永远为全局。
- **语义变更点**：status 指定 workspace 时不再排除全局记忆（J2 反例修正）；tools/result 捕获的记忆带上了 cwd 标注（新增捕获面信息）。
- **硬约束映射**：四工具 schema 不变（status 过滤逻辑内部变化，渲染/输出形状不变）；MemoryEntry 契约不变；engine 查询行为不变（旧测试全绿）。
- **新增测试**：同数据 recall 与 status 指定 ws 结果一致（无 ws 条目都被视为全局）；tools/result 捕获经 Agent session header cwd 注入 workspace（构造 exec mock）；无 agent 时回落 undefined 仍可入库。

### Q. 时间衰减不可配置 → 双尺度时间语义（T3）

- **根因**：decay 半衰期 7 天写死（engine.ts:445），与默认「永不过期」（ttlDays=0）冲突，60 天记忆 score 降至 1/4000 实际不可召回。
- **设计**：
  1. `RecallOptions` 新增 `decayHalfLifeMs?: number`（默认导出常量 `DECAY_HALF_LIFE_MS = 7d`）与 `decay?: boolean`（默认 true）。
  2. engine.queryIndex：`decay = ageMs <= 0 || options.decay === false ? 1 : Math.exp(-ageMs / (options.decayHalfLifeMs ?? DECAY_HALF_LIFE_MS))`。
  3. 配置层：`MemoryHubConfig` 新增 `recallDecayHalfLifeDays: number`（**默认 0 = 关闭评分衰减**，与 ttlDays=0「永不过期」哲学对齐）；`createMemoryRecallTool` 追加第 6 参 `recallOverrides`（`Pick<RecallOptions,'decay'|'decayHalfLifeMs'>`），插件入口映射。
- **语义变更点**：插件**默认召回**不再时间衰减（60 天记忆可召回 ✓）；显式配置 `recallDecayHalfLifeDays>0` 恢复按天衰减；engine 纯函数默认仍为 7d（旧测试、eval G5 网格不受影响——G5 的 agg 只注入 k1/b/heatHalfLifeMs，decay 走默认 7d 语义不变）。
- **硬约束映射**：工具 schema 不变（工厂加可选尾参兼容既有 5 参调用）；config 新增键向后兼容；渲染/错误码不变。
- **新增测试**：`decay:false` 时 60 天前记忆与 1 天前记忆同分（可召回）；`decayHalfLifeMs` 可调半衰期断言；config 默认 0 → overrides `decay:false`；G5 默认组仍不劣（回归）。

---

## P1 六项（健壮性/一致性/性能）

### C. 同批候选互不判重 → 两级去重：批内瞬时 + 库内窗口（T4）

- **设计**：ingestCaptured 循环外建 `batchSeen: Set<string>`（content.trim() 精确键）；批内重复 → `rejectedDuplicate++` 跳过；再走既有 `store.list()` 库内去重。
- **语义变更点**：同批双候选同文只入库 1 条（C1 实锤 2 条 → 1 条）；指标 rejectedDuplicate 相应 +1。
- **硬约束映射**：ingest.ts 纯函数接口不变；`ingestCaptured` 签名不变。
- **新增测试**：同 content 双候选 → entries=1、rejectedDuplicate=1；批内不同候选各自入库；批内去重与库内去重叠加（批内去重后仍与库内判重）。

### F. 多块拼接粘连 → 词边界感知分隔（T6）

- **根因**：`out += b` 无分隔，`Use pnpm`+`for installs` → `Use pnpmfor installs`。
- **设计**：数组递归拼接时，若 `out` 末字符与 `part` 首字符**均为 ASCII word 字符**（`[A-Za-z0-9_]`）则补一个空格（word-boundary-aware joining）。中文/标点边界不插分隔。
- **语义变更点**：英文单词跨块粘连被分隔；中文/标点拼接逐字节不变（既有断言 `'甲乙'`、`'结果：共 12 条'`、`'甲 乙'`、`'甲  乙'` 全部保持）。
- **硬约束映射**：text.ts 纯函数零依赖；所有既有 extractTextBlocks 断言逐字节兼容（已逐条验证）。
- **新增测试**：`Use pnpm`+`for installs` → `'Use pnpm for installs'`；中文块不插空格；末尾/开头空白块不产生双空格；tool-result 递归边界同样生效。

### D. 卸载不等待捕获队列 → 捕获栅栏（T4）

- **设计**：dispose 顺序改为：clearInterval → disposers（移除监听/注销工具）→ **`await captureChain`**（捕获栅栏：等在途捕获全部结算）→ `await store.close()` → 汇总日志。captureChain 是链尾 promise，await 即排空。
- **语义变更点**：卸载瞬间在途捕获不再撞关闭的 store（丢写竞态消除）；dispose 变慢（等待在途任务，测试中任务即时 resolve 无感知）。
- **硬约束映射**：dispose 返回 Promise 语义不变；index-lifecycle 既有卸载断言（移除监听后 emit 不入库）保持。
- **新增测试**：注入慢 store（upsert 挂起），dispose → releases 前捕获先完成；事件风暴后立即 dispose 无错误（metrics.errors 不虚增）。

### K. MinHash 空转 → 签名候选预筛（T5）

- **根因**：buildIndex 全量算签名但 queryIndex 只用精确特征集，注释承诺的「快速候选剪枝」未兑现。
- **设计**：queryIndex 语义兜底分支前置 **MinHash 预筛**：
  - 仅当 `queryFeatures.size > MINHASH_K`（大查询，精确特征比对 O(|Q|) 贵于签名 O(K)）时启用；
  - 预计算 `querySig = minhashSignature(queryFeatures)`；
  - 文档侧 `cov = minhashCoverage(querySig, docSig)`，`cov < MINHASH_PRESCREEN_THRESHOLD`（新常量 = 0.30，保守下界 = 阈值×2/3）→ 跳过精确 featureCoverage；
  - 通过预筛的文档仍走精确覆盖率 ≥ 0.45 语义评分（**评分语义不变，预筛只剪枝不相干文档**）。
- **语义变更点**：小查询路径零变化（预筛不启用 → 既有 engine/语义测试全部不受影响）；大查询的语义兜底多了签名预筛（eval G3 recall@1 ≥ 0.80 保底）。
- **硬约束映射**：engine 导出常量新增不破坏；MinHash 相关导出保留；注释更新「从预留 → 实际剪枝」。
- **新增测试**：构造大查询（≥17 特征）断言预筛收益路径（不相干文档被剪、真实语义候选保留）；预筛前后召回集在固定语料上一致性抽查；MINHASH_PRESCREEN_THRESHOLD 常量导出。

### L. autoTags 死配置 → 消费：自动标签开关（T6）

- **设计**：capture 三个提取函数追加尾参 `autoTags: boolean = true`；`false` 时候选 `tags: []`（自动标签['auto','preference','explicit','fact','summary',toolName]全部清空）。插件入口传入 `cfg.autoTags`。
- **语义变更点**：`autoTags:false` 配置从摆设变为有效（捕获内容无自动标签）；`autoTags:true`（默认）行为逐字节不变。
- **硬约束映射**：函数加**尾参默认值**向后兼容既有直调；CaptureCandidate 契约不变；四工具不变。
- **新增测试**：autoTags=false 三种提取器 tags=[]；true（默认）tags 现状不变；index 层 autoTags false 配置传递。

### N. recall 热度 fire-and-forget → 合并回写 + 错误上浮（T4）

- **根因**：`void Promise.allSettled(hits.map(upsert))` 每次命中写一次（写放大），错误被 allSettled 吞掉。
- **设计**：工具内维护 `heatDirty: Map<id, MemoryEntry>`（bumped 条目按 id 覆盖合并 = **同 id 抗刷**）与 `heatChain`（串行 flush 链）：
  - execute：`for (h of hits) heatDirty.set(h.id, bumped(h))`；`heatChain = heatChain.then(flush)`（不 await 响应）；
  - flush：取 batch → clear → `Promise.allSettled(batch.map(upsert))` → **rejected 计入 `metrics.errors` + logger**（不再吞错）。
- **语义变更点**：同一 id 在 flush 窗口内多次 recall 只写一次（accessCount 只 +1，文档注明「抗刷合并」）；错误可观测。
- **硬约束映射**：execute 返回形状不变；渲染不变；既有「等 50/80ms 后 accessCount≥1」测试兼容（heatChain 微任务即 flush）。
- **新增测试**：spy store 两次 recall 同 id → upsert 调用 1 次;flush 失败 → metrics.errors++（构造 rejecting store）;不同 id 各写一次；`score` 仍不落盘（回归）。

---

## P2 七项（维护性/一致性/性能细节）

### E. .corrupt 追加非幂等 → 幂等审计留证（T6）

- **设计**：backupCorruptLines 先读已有 `.corrupt`（ENOENT→空），按行 Set 去重，只 append 未记录行；修订注释「幂等追加」。读失败容错：仍执行追加（保留证据优先）。
- **语义变更点**：同损坏行多进程重启只留证一次；已存在的重复历史行不清理（不动既有审计面）。
- **硬约束映射**：store 文件格式/权限语义不变；诊断计数不变。
- **新增测试**：两次 open 同一含损坏行文件 → .corrupt 行数不增；不同损坏行分别留证。

### G. importer isUser 死字段 → 说话者感知分类（T6）

- **设计**：新增 `inferSpeakerKind(text, isUser)`：用户句（isUser=true）→ `inferKind(text)`（现状高置信）；助手句（isUser=false）→ 偏好信号降级 `'generic'`（助手叮嘱 ≠ 用户偏好）、指令信号保持 `'instruction'`（规则复述有价值）。planImport session 分支改用它（isUser 字段正式消费）。
- **语义变更点**：会话日志导入时助手句「记住/偏好」类文本从 preference 降为 generic；用户句推断不变。
- **硬约束映射**：`extractSessionText` 与 `inferKind` 导出不变（既有断言全绿）；planImport 的 session 测试仅断言 source/tags/数量，不断言 kind（已核）。
- **新增测试**：用户句「记住要用 pnpm」→ preference；助手句复述「记住要用 pnpm」→ generic；助手句「永远不要提交密钥」→ instruction。

### H. NOT_FOUND 错误码未用 → 可选严格遗忘（T6）

- **设计**：memory_forget 增加可选参数 `strict?: boolean`（默认 false）；`removed === false && strict` → `throw new MemoryHubError(NOT_FOUND)`；默认路径返回 `{removed:false}` 不变。
- **语义变更点**：仅显式开启 strict 时未命中抛 NOT_FOUND；渲染路径不变。
- **硬约束映射**：既有 forget 测试（`{removed:false}`）不变；schema 追加可选参数（向后兼容强制模式）。
- **新增测试**：strict=true 未命中 → NOT_FOUND 错误码；strict=false 未命中 → `{removed:false}`（回归）；strict=true 命中 → `{removed:true}`。

### M. ImportOptions.mode 死配置 → 三档推断强度落地（T1/T6）

- **设计**：新增 `inferKindWithMode(text, mode)`：`conservative` → 仅强信号（指令词/「记住/记得/以后/优先/偏好」）判 kind，其余 generic；`balanced`（默认）→ `inferKind(text)`（现状）；`aggressive` → `inferKind(text)`（现状放宽路径，语义在文档注明）。planImport 文档分支使用，默认 balanced 行为不变。
- **语义变更点**：显式传 `mode:'conservative'` 时弱信号（如「喜欢」）文档块降为 generic；默认配置零变化。
- **硬约束映射**：planImport 函数签名不变；既有 planImport 文档 kind 断言（default balanced）不变。
- **新增测试**：三档同文本 kind 断言（conservative 强词→instruction、弱「习惯」→generic；balanced → preference；aggressive → preference）；mode 默认 balanced。

### A'. 非法 kind 错误形态双轨 → schema enum 前置统一（T6）

- **设计**：memoryRecallParams.kind 增加 `enum: ['decision','fact','preference','instruction','generic']`；execute 内的手工校验分支删除（非法 kind 由 dsh-tools 框架前置抛 ToolArgsError，与 memory_store 同形态）。
- **语义变更点**：recall 非法 kind 错误从 `MemoryHubError(EMPTY_CONTENT,'invalid kind: …')` 变为框架 `ToolArgsError`（错误统一）；合法路径行为不变；渲染不变。
- **硬约束映射**：grep 确认无既有测试断言 'invalid kind' 错误形态；工具 schema 的 enum 属参数约束强化（输入面收紧为合法集，输出契约不变）。
- **新增测试**：非法 kind 抛 `ToolArgsError`（继承 Error，消息含 'must be one of'）；5 种合法 kind 正常执行。

### O. 每事件 O(N) 快照拷贝 → 共享只读快照 + 写时重建（T5）

- **设计**：store.snapshots() 不再每次 `[...snapshotCache]` 拷贝，直接返回共享缓存引用；写操作（upsert/remove/removeMany/importAll）置 dirty → 下次访问**重建新数组**（copy-on-write：外部修改旧引用不影响 store 新状态）。内部全部消费方（ingest/recall/status/prune/summarize/compact/exportAll）经核验均只读。接口注释声明「返回共享只读快照，调用方不得修改」。
- **语义变更点**：list() 返回共享数组（Zero-copy）；写后数组换代；无写期间外部修改数组会污染读视图（文档化行为约束，CHANGELOG 声明）。
- **硬约束映射**：MemoryStore 接口签名不变；既有测试全部为只读断言（已核）；compact 写盘用重建后的新数组（写必先 dirty）安全。
- **新增测试**：list() 零拷贝（返回引用 === snapshotCache 内部引用，经 `store as any` 探测或通过「多次 list 同引用」断言）；写后外部旧引用修改不影响 store 新 list；compact 行数与状态一致（回归）。

### S. significanceWeight 冗余兜底 → 类型收紧消亡兜底（T6）

- **根因**：`SIGNIFICANCE_KIND[kind] ?? 1`：「kind 为 MemoryKind 联合 + Record 全键」时索引类型经实测为 **number**（noUncheckedIndexedAccess 下对 Record 字面量联合键命中索引签名，无 undefined；已用 tsc 实测验证）。
- **设计**：删除 `?? 1`，`const kindWeight = SIGNIFICANCE_KIND[kind]`；future kind 扩展未同步表时由 Record 全键约束在**编译期**拦截（兜底从运行时移到类型层）。
- **语义变更点**：运行行为逐字节不变（kind 恒在表内）。
- **硬约束映射**：engine 导出不变；typecheck 通过（已实测）。
- **新增测试**：5 种 kind × 2 source 的 significanceWeight 数值断言（表值锚定）；类型层由 tsc 保证。

---

## 硬约束全量映射（9 项 × 16 项）

| 硬约束                | 受影响项   | 保障手段                                                               |
| --------------------- | ---------- | ---------------------------------------------------------------------- |
| 四工具签名不变        | J/A'/H/N/Q | 仅内部逻辑/追加可选参/schema enum 收窄；name/execute/render 逐字节不变 |
| MemoryEntry 契约不变  | 全部       | 不增删字段；热度 bump 仍显式重建契约字段                               |
| cordis.patch.yml 不变 | 全部       | 不触碰安装方式                                                         |
| 零新增依赖            | 全部       | 仅用 node:crypto/fs 等既有内置                                         |
| 旧测试 294 项全绿     | 全部       | 逐项语义兼容设计 + 实现后全量回归                                      |
| 覆盖率不降            | 全部       | 新逻辑全量新增测试，删除死分支减少 uncovered                           |
| 渲染/错误码不变       | J/A'/H/F   | render 函数与错误码常量零改动                                          |
| eval G1–G5            | Q/K        | G5 网格不注入 decay（默认不变）；G3 由预筛阈值保底                     |
| bench                 | K/O        | 剪枝/零拷贝为正收益，bench 复核                                        |

## 实现顺序

1. P0：capture.ts（B）→ types.ts+engine.ts+config.ts+index.ts+tools（Q）→ index.ts+status（J）
2. P1：ingest.ts（C）→ text.ts（F）→ index.ts（D）→ engine.ts（K）→ capture.ts+index.ts（L）→ memory-recall.ts（N）
3. P2：store.ts（E/O）→ importer.ts（G/M）→ forget（H）→ recall（A'）→ engine.ts（S）

每批后跑 `npm run check` 增量验证；终态全链：test:coverage / eval / bench / typecheck。
