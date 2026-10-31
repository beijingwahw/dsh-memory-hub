# DESIGN-1.6 应用级出口版（1.6.0）

> 主题：把 roadmap 最后一项「跨平台 GUI 记忆管理（桌面级应用：编辑/导入导出 UI/多库管理）」
> 以**独立应用级交付物**关闭（DESIGN-1.5 §9.4「另案推进」的落地）。
> 本仓库侧的变更刻意最小：新增 `./core` 纯库子路径导出——GUI 不复制任何存储/检索实现，
> 领域语义单一事实源仍在 dsh-memory-hub。

## 0. 变更总览

| 变更           | 内容                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `src/core.ts`  | 纯 re-export 出口（存储/检索/条目工厂/导入/HTML 导出/加密探测/敏感过滤/矛盾标注/数据模型/错误基础设施） |
| `tsup` 双入口  | `lib/index.js`（插件主出口，字节不变）+ `lib/core.js`（GUI 消费的纯库出口，98KB ESM）                   |
| `package.json` | `exports` 新增 `"./core"` 子路径；版本 1.6.0                                                            |
| 导出面锁定     | `test/core-export-1.6.test.ts`（6 项：导出形态 + makeEntry→recall→summarize 最小闭环）                  |
| 应用交付物     | `dsh-memory-hub-gui`（同级独立仓库，见下）                                                              |

## 1. `./core` 出口设计

- **零新增逻辑、零副作用**：core.ts 只 re-export 既有模块公共面；主出口（`.`）输出与 1.5.1
  逐字节一致（tsup `splitting: false`，两入口独立打包）；
- **消费方契约**：`JsonlMemoryStore` / `recall` / `summarize` / `clusterThemes` / `makeEntry` /
  `planImport` / `renderMemoryHtml` / `parseKeyRecord` / `containsSensitive` / 取代与矛盾协议
  常量 / `MemoryEntry` 等类型 / `MemoryHubError`——GUI 的全部领域语义经此单一出口；
- **不导出**：cordis 生命周期、capture 火线、TTL 清理、工具注册——这些属于宿主插件职责，
  桌面应用有自己的会话门面（打开/锁库/口令生命周期）。

## 2. dsh-memory-hub-gui（独立应用，1.0.0）

| 维度     | 交付                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态     | Electron 桌面应用（Windows / macOS / Linux）；esbuild 三目标打包（main/preload CJS + renderer IIFE）→ **零运行时第三方依赖**                                                                                                                            |
| 多库管理 | 注册表 `userData/libraries.json`（原子写 + 损坏回退留证）；默认库 `~/.dsh/memory-hub/memories.jsonl` 与插件共享；新建/添加/重命名/移出；加密库 🔒 徽标                                                                                                  |
| 编辑     | 新建 / 编辑（同 id upsert = append-only 版本推进，深回放历史保留）/ 取代协议（supersede:/superseded-by:）/ 删除与批量删除（tombstone）                                                                                                                  |
| 检索     | `engine.recall` 六线融合 + 评分条 + **why 溯源面板**；类型/来源/标签/工作区筛选 + facets 计数                                                                                                                                                           |
| 导入导出 | Markdown / 会话 JSONL / JSON 迁移包三源（`planImport` 预览→提交，内容级幂等 + 敏感零豁免）；`exportAll` JSON + 1.5.1 `renderMemoryHtml` 双导出                                                                                                          |
| 加密     | 打开缺口令/错口令显式失败→弹窗重试；启用加密（明文库原位迁移）/ 轮换 / 解密回退（`changePassphrase`）；锁库即时清口令——口令仅存活于主进程内存                                                                                                           |
| 安全基线 | contextIsolation 开 + sandbox 开 + nodeIntegration 关 + CSP；IPC 每通道入参运行期校验；DOM 全 textContent（与 1.5.1 同一注入纪律）                                                                                                                      |
| 验证     | 37 项单元测试（真实 `JsonlMemoryStore` 闭环：注册表/编辑/检索/导入导出幂等/**加密口令全生命周期含密文落盘断言**/契约防御）+ **16 步无头 E2E 冒烟**（真实 DOM 用户旅程，逐步截图门禁，隔离 userData 不触碰真实库；连续 5 次全绿 + 打包产物内复验 16/16） |
| 分发     | electron-builder：Windows NSIS+portable / macOS dmg（x64+arm64）/ Linux AppImage+deb；CI 三 OS 矩阵跑同一套门禁与冒烟；图标纯 Node 确定性生成                                                                                                           |

## 3. 边界与后续

- **GUI 与插件并行使用同一库文件**：依赖 store 既有的单实例写锁（`.lock` 存活探测）——
  两进程同写时后启者禁用 compact（append 仍安全），与两个 dsh 会话共享库同语义；
- **导出为明文观看工件**（与加密存储正交）：GUI 导出对话框内联警示，沿用 1.5.1 隐私边界文案；
- 后续课题：跨库迁移编排 UI（exportAll→importAll 已就绪，缺向导）、库健康体检
  （corrupt 留证查看）、`asOf` 时间旅行视图（replayAsOf/diffReplay 已就绪，未上 GUI）。
