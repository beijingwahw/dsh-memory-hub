# DESIGN-1.4 · 纵深防御与时间分析版

> 版本：1.4.0 ｜ 日期：2026-10-31 ｜ 前置：DESIGN-1.3（时空完备）
>
> 主题：把 roadmap 的最后一项未勾选能力（会话级加密存储）与 DESIGN-1.3
> 留下的两项未来工作（memory_status 按 asOf 历史统计 / T1↔T2 回放 diff 视图）
> 一次性落地为生产能力——**纵深防御**（静态保密 + 逐行防篡改）与
> **时间分析**（历史快照 + 变更审计）。

## 0. 动机

1.3.0 交付时空完备后，记忆库能回答「任意时刻我知道什么」；但两个维度的
问题仍然开放：

- **静态保密**：JSONL 明文落盘（0600 权限之外再无防线）。备份同步、磁盘
  镜像、误提交仓库都会让全部记忆正文直接可读——这是 roadmap 自 0.2.0 起
  唯一未勾选项「会话级加密存储（可选 passphrase）」。
- **时间分析**：asOf 只活在 `memory_recall`。管理面问题（「上周这个库有
  多少条记忆？」「周二到周四之间记忆库发生了什么？」）没有生产接口——
  DESIGN-1.3 §4 明确列为未来工作。

## 1. 模块 I：会话级加密存储（可选 passphrase）

### 1.1 威胁模型与目标

| 威胁                                 | 对策                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| 离线读取记忆文件（备份/镜像/误提交） | 静态保密：除密钥记录头（KDF 参数 + 盐，公开无敏感）外零明文     |
| 局部篡改/截断密文行                  | 逐行 AES-256-GCM AEAD：认证失败走既有损坏行隔离留证通道         |
| 错误口令静默表现为「空库」           | 加载期快速失败：首个信封行认证失败即抛 `STORE_READ_FAILED`      |
| 加密库漏配口令把密文行清空           | 首行密钥记录 + 无口令 → 显式报错指引进错误信息                  |
| 口令落入配置文件                     | 推荐 `DSH_MEMORY_PASSPHRASE` 环境变量；config 优先级 > 环境变量 |
| 迁移丢历史（深回放依赖行序日志）     | 原位加密迁移逐行原序重写（含 tombstone 与被覆盖旧版本）         |

### 1.2 文件格式（append-only 兼容，零存储语义迁移）

```
首行   {"__kdf__":"scrypt","salt":<b64 16B>,"n":16384,"r":8,"p":1}   ← 明文头
其余行 {"__enc__":1,"iv":<b64 12B>,"ct":<b64 密文+16B tag>}          ← AEAD 信封
```

- **KDF**：scrypt(N=16384, r=8, p=1) → 32B AES-256 密钥。参数随头持久化，
  读侧按文件头派生（未来调参不破坏旧库）；盐 16B CSPRNG，每库一个。
- **AEAD**：每行独立 12B 随机 IV；AAD = `dsh-memory-hub/enc/v1` 绑定格式
  版本（跨格式行拼接防御）。
- **密文字节不确定**（CSPRNG IV 的安全属性，非缺陷）；**逻辑层确定性**
  （解码后条目集/回放结果与明文库逐项一致，G21 接地）。
- **混合文件容忍**：解码器对非信封形状行明文透传——迁移中间态（历史
  明文行 + 新密文行）可正常读写，下次 compact 收敛为全密文。

### 1.3 接线与生命周期

- `JsonlMemoryStore.open(filePath, logger?, { passphrase? })`：
  - 头存在 + 口令 → 按头派生密钥，正常加载；
  - 头存在 + 无口令 → 显式抛错（绝不把密文行按损坏行静默清空）；
  - 头不存在 + 口令 → 新盐派生；**明文库（行数 > 0）加载后原位加密迁移**；
  - 错口令判定：头存在 && 全部信封行认证失败（GCM 对口令确定性——正确
    口令下不可能全军覆没）→ 加载期抛错；部分失败 = 篡改，走损坏行隔离。
- `apply` 入口：`config.passphrase || DSH_MEMORY_PASSPHRASE || ''`——空即
  明文（与 1.3.0 逐字节一致）；口令绝不写日志。
- 全部落盘路径收口于 `appendRaw`（写侧逐行编码 + 首写补头）与
  `loadLines`/`compact`/`listAsOf`/`encryptInPlace`（读侧解码）；
  `upsert/upsertMany/importAll/removeMany/tombstone` 无一绕过。
- **compact 与加密共存**：磁盘视角回放先解码为逻辑行，合并后统一编码
  重写 + 头保留；自检行数 = 条目数 + 1（头）。
- **原位加密迁移与 compact 的关键差异**：不合并、不去重、不丢行——
  append-only 日志的深回放历史（行序 + 旧版本 + tombstone at）逐行完整
  保留，仅「外衣」从明文换为密文（G21 断言迁移后 v1/v2 内容版本与
  删除时刻仍可回放）。tmp + fsync + rename 原子替换；失败仅告警
  （混合态可读写，compact 收敛）。
- `exportAll` 保持明文 JSON（跨设备迁移闭环；导出是显式用户动作）。

### 1.4 明文缺省零回归

无口令时 `plainCodec` 恒等变换：读写字节路径与 1.3.0 逐位一致；
`diagnostics.encrypted` 仅加密库输出（明文库键缺席，status 输出字节不变）。

## 2. 模块 J：时间分析（status asOf 快照 + T1↔T2 diff 视图）

### 2.1 asOf 快照视图（`memory_status { asOf }`）

- 语料来源与 `memory_recall asOf` 同源：`listAsOf` 优先，降级 store 按
  `createdAt` 过滤当前快照（README 声明降级口径）。
- **只输出语料层字段**（total/byKind/bySource/oldestAt/newestAt/superseded/
  hot/cold/distilled/conflictPairs + asOf 回显）：运行时 metrics/
  diagnostics/graph/巩固属于「现在」，不掺入历史快照；冷热分层以 asOf
  为「现在」计算（7 天活跃窗口锚定回放时刻）。
- workspace 过滤语义与当前视图一致（未标注 = 全局共享一并计入）。

### 2.2 diff 视图（`memory_status { diffSince, asOf? }`）

数据源为纯函数 `diffReplay(before, after)`（store.ts，与 replayAsOf 同居）：

| 类目                          | 判定                                                 |
| ----------------------------- | ---------------------------------------------------- |
| added                         | T2 存在、T1 不存在（新写入或删除后复活）             |
| removed                       | T1 存在、T2 不存在（tombstone）                      |
| updated：content              | 正文/类型/工作区变更                                 |
| updated：supersede / conflict | 取代/矛盾协议标记变化（无内容变更）                  |
| updated：tags                 | 其他标签变化                                         |
| heatOnly                      | 仅访问热度变化——只计数不列明细（巩固复习的日常噪音） |

- `diffSince ≤ asOf` 强校验（越界拒参）；`asOf` 缺省 = 现在；
  明细数组 ≤20 样本、计数完整；渲染 `[memory status diff ISO₁ → ISO₂]
+A −R ~U (heat H)` + 每类 ≤3 样本。
- 确定性：纯函数、同输入 deep-equal（G22 断言）。
- 边界：compact 清除历史行后 removed 退化为最新快照存在性口径（与
  replayAsOf 的 compact 降级一致）；降级 store 看不见 tombstone →
  removed 恒空集。

## 3. 验收门禁

| 门               | 内容                                                                                                                  | 位置                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 单元（编解码）   | roundtrip/零明文/IV 随机/篡改/错密钥/透传/头 roundtrip 与拒收/KDF 确定性                                              | `test/memory/crypto.test.ts`（9）           |
| 单元（集成）     | 新库加密/错口令/漏口令/迁移保深回放/compact 共存/单行篡改隔离/混合文件/listAsOf/exportAll/插件 config+环境变量接线    | `test/memory/store-encrypted.test.ts`（11） |
| 单元（时间视图） | diffReplay 六类归因/标题裁剪/确定性；asOf 快照字段封闭/冷热锚定/diff 手算/≤20 截断/拒参/降级/workspace 叠加/非法 asOf | `test/memory/status-asof.test.ts`（9）      |
| G21              | 真实语料 400 条落盘零明文（多锚点抽验）、迁移保深回放（v1/v2/删除时刻）、roundtrip、错口令/漏口令显式失败             | `eval/cognitive-scale.test.ts`              |
| G22              | 真实分阶段语料（G19 同构时间线）三分区 diff 与手算一致（取代/热度/删除/新增）、确定性、工具面输出契约与渲染           | 同上                                        |
| 零回归           | 无口令/无 asOf 参数时与 1.3.0 逐字节一致（plainCodec 恒等 + 时间分支缺席）                                            | 既有 bit-exact 门 + 全量套件                |

## 4. 边界与后续

- **口令恢复**：口令丢失 = 数据不可恢复（scrypt + AEAD 无后门）——这是
  特性不是缺陷；错口令在加载期显式失败而非暴力尝试。
- **进程内明文**：条目在进程内存中仍为明文（运行时必需）；加密承诺的是
  **静态保密**（at-rest）。
- **eval/realdata 语料与 .corrupt 审计文件**不受加密影响（外部文件，
  由文件系统权限保护）；`.corrupt` 中的损坏行留证为密文原文。
- **多进程写锁**与加密正交（锁文件本身明文 pid，无敏感）。
- **未来工作**：口令轮换（re-encrypt under new key，头多记录 + 重加密
  迁移机制已具备）；diff 视图的图边变化维度（实体/关系级 T1↔T2 对账）。
