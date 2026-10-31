# dsh-memory-hub 0.9.0 质量报告（全链质量门实测）

> 定位：0.9.0（16 项薄弱项深度闭环）交付前的**全部质量门实测记录**——静态链、全量测试、覆盖率、
> 离线质量评估、性能基准、渲染/错误码不变性，全部为本次构建真实执行结果，非估算。
> 运行环境：node（vitest 3.2.7，v8 coverage provider）｜时间：2026-10-05 22:38

---

## 1. 门禁总览

| #   | 质量门          | 命令                                                           | 结果                           | 要点                                                                     |
| --- | --------------- | -------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| G1  | 静态链          | `npm run check`（typecheck+lint+format:check+test 的合集底座） | ✅ 全绿                        | tsc strict 系三开关零错误；eslint 9 零告警；prettier 全库一致            |
| G2  | 全量测试        | `npm test` / `npm run check`                                   | ✅ **324 项全过（32 文件）**   | 0.8.0 的 294 项 + 升维新增 30 项，无弃用无跳过                           |
| G3  | 覆盖率          | `npm run test:coverage`                                        | ✅ **100 / 97.87 / 100 / 100** | 阈值 lines 96.5 / branches 95 / functions 97 / statements 96.5，四项均超 |
| G4  | 离线质量评估    | `npm run eval`                                                 | ✅ 六门限全绿                  | G1–G5 + 报告落盘，固定 seed 可复算                                       |
| G5  | 性能基准        | `npm run bench`                                                | ✅ 8 项全过                    | BM25 top@1 命中率 100%（80/80）                                          |
| G6  | 渲染/错误码不变 | 324 项含渲染与错误码断言                                       | ✅ 逐字节无回归                | render 函数/错误码常量零改动                                             |

---

## 2. 静态链（G1）

- **typecheck**：`tsc --noEmit` 零错误——`strict` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `noUncheckedIndexedAccess` 全开；
  S 项删兜底后由 Record 全键在类型层拦截 kind 漂移（编译期证据）。
- **lint**：eslint 9（typescript-eslint recommendedTypeChecked）**0 error / 0 warning**；
  本轮修复记录：`prefer-spread`（appendFile 包装）1 处、`no-floating-promises`（测试内 writeFileSyncSafe 未 await）2 处、`prefer-const` 等 3 处——全部收口，无遗留。
- **format**：prettier 全库（含 `eval/reports/quality-report.md`）`--check` 通过。

## 3. 全量测试（G2）

324 项 = 294（0.8.0 既有）+ 30（0.9.0 升维新增），分三类：

| 专场                                          | 覆盖内容                                                                                   | 数量       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- |
| `test/upgrade-0.9.test.ts`（新增）            | B/C/E/F/G/H/J/K/L/M/N/O/Q 探针转正 + 三档 mode + strict 遗忘 + 词法派生一致性              | 14 项      |
| `test/memory/store-fault-0.8.test.ts`（扩充） | compact 空库/写盘失败/自检读失败、corrupt 隔离 Error 与 String 双分支、closed 后三操作抛错 | +6 项      |
| `test/index-lifecycle-0.8.test.ts`（扩充）    | D 项捕获栅栏（慢 upsert 时序）、decay 开关挂载分支                                         | +3 项      |
| 既有 31 文件                                  | 0.8.0 全量回归：生命周期/容错/渲染/错误码/检索/热度/significance 等                        | 294 项全绿 |

## 4. 覆盖率（G3）

合计 **lines 100（1770/1770）/ branches 97.87（738/754）/ functions 100（107/107）/ statements 100**；
算术分支仅剩 16 个防御兜底分支未走（index 84.06、recall 92.11），经逐行核验均为「并行注册失败、render 缺省值、不可达保护」类，不作独立缺陷。

| src 文件        | Lines | Branches  | Functions | 说明                                              |
| --------------- | ----- | --------- | --------- | ------------------------------------------------- |
| config.ts       | 100   | 100       | 100       | recallDecayHalfLifeDays/autoTags 新键全测         |
| errors.ts       | 100   | 100       | 100       | NOT_FOUND 经 strict 路径真实使用                  |
| index.ts        | 100   | 84.06     | 100       | 防御兜底残余（注册/卸载极端分支）                 |
| capture.ts      | 100   | 96.72     | 100       | 三提取器 × autoTags 双态                          |
| engine.ts       | 100   | 100       | 100       | decay 双尺/签名预筛/剪裁全分支                    |
| importer.ts     | 100   | 100       | 100       | isUser/mode 全档                                  |
| ingest.ts       | 100   | 100       | 100       | 两级去重                                          |
| metrics.ts      | 100   | 100       | 100       | —                                                 |
| store.ts        | 100   | **100**   | 100       | 0.8.0 的 93.13 → 100（corrupt 幂等/容错路径补齐） |
| text.ts         | 100   | 100       | 100       | 词边界分隔                                        |
| types.ts        | 100   | 100       | 100       | —                                                 |
| memory-*.ts × 4 | 100   | 92.11–100 | 100       | recall 防御行残余；status/store/forget 100        |

## 5. 离线质量评估（G4，`npm run eval`，种子固定可复算）

| 门限 | 口径                                        | recall@1 实测            | 阈值    | 结论 |
| ---- | ------------------------------------------- | ------------------------ | ------- | ---- |
| G1   | 精确质量（BM25 长度归一化，80 queries）     | **1.0000**               | ≥ 0.95  | ✅   |
| G2   | 模糊召回（A1 编辑距离 ≤1 容错，30 queries） | **1.0000**               | ≥ 0.90  | ✅   |
| G3   | 语义召回（A2 词根 3-gram 兜底，9 queries）  | **1.0000**               | ≥ 0.80  | ✅   |
| G4   | 热度生命周期（halfLife 冷却/复活）          | **1.0000**               | 第 1 位 | ✅   |
| G5   | 参数网格（k1×b×heatHalfLifeMs = 27 组合）   | 默认组**不劣于任何组合** | 不劣    | ✅   |
| 报告 | 落盘 `eval/reports/quality-report.md`       | —                        | 可复算  | ✅   |

## 6. 性能基准（G5，`npm run bench`）

- **召回性能**（1K / 10K 条目）：buildIndex / queryIndex / token 预算裁剪 / IndexCache 热命中（revision 不变）/ 热度更新复用（revision 变指纹不变）**8 项全部通过**；
- **检索质量**：BM25 0.4 top@1 命中率 **100%（80/80）**；BM25 0.4 vs cosine 0.3 基线对比通过；
  K 项签名预筛与 O 项零拷贝为正向收益项，无回退。

## 7. 渲染/错误码逐字节不变（G6）

- `src/tools/*` 四工具 **render 函数零改动**（本轮只动 execute 内部与 schema enum），status/recall/forget/store 的渲染专场测试（0.8.0 建立）全部原样通过；
- 错误码常量零改动：`errors.ts` 仅 NOT_FOUND 从「定义未用」变为「strict 路径真实抛出」，既有错误码断言（errors-0.7 专区 11 项）全绿；
- 文本提取拼接（text-0.7 专区）中文/标点逐字节断言全绿。

## 8. 结论

0.9.0 六道质量门全部通过且**无一回退**：324 测试全绿、覆盖率四项达标（branches 97.87 超 96.1 基线并同时超 96.5 阈值）、eval 六门限全绿、bench 8 项通过、
渲染与错误码逐字节不变——16 项薄弱项闭环的同时，既有用户可见行为零破坏。
