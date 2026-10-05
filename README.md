# dsh-memory-hub

**DeepSeek Harness 本地优先智能会话记忆插件** —— v0.10.0（2026-10-05）

后台自动捕获会话中的事实 / 偏好 / 指令 / 决策，append-only JSONL 落盘，支持语义召回、热度生命周期、多工作区隔离、敏感过滤与隐私守护。

## 仓库内容

| 路径 | 说明 |
| --- | --- |
| `dist/dsh-memory-hub-0.10.0.tgz` | 插件安装包（npm pack 产物） |
| `dist/dsh-memory-hub-0.10.0.zip` | 交付归档（tgz + 报告 + eval 报告） |
| `docs/GROUND-0.10.md` | 0.9.0 → 0.10.0 真实数据接地（G6 真实数据门）报告 |
| `docs/LIFT-0.9.md` | 0.8.0 → 0.9.0 十六项薄弱项深度闭环报告 |
| `docs/QUALITY-0.9.md` | 0.9.0 全链质量门实测记录 |
| `quality-report-0.10.0.md` | 检索质量评估报告（含 G6 真实数据门，可复算） |
| `CHANGELOG.md` / `LICENSE` | 变更记录（Keep a Changelog）/ MIT |

## 安装

```bash
dsh plugin --profile web add ./dist/dsh-memory-hub-0.10.0.tgz
```

安装后插件以 `memory-hub` id 并入 profile 配置树（`cordis.patch.yml` 声明），重载即生效。卸载即恢复原状，记忆文件保留在磁盘上。

## 0.10.0 亮点（真实数据接地）

- **G6 真实数据门**：真实官方文档语料（Node.js v26.10.0 path/os 固定 tag 快照，SHA-256 固化）随仓库分发、评测不联网
- **生产同路径验证**：真实文档经 `planImport`（与 `importSources` 启动导入同管线）入库 329 条真实记忆，24 个真实 API 问句按语义锚标注
- **保守可复算门限**：recall@1 ≥ 0.75 / recall@3 ≥ 0.85 / recall@5 ≥ 0.95（实测 0.7917 / 0.8750 / 0.9583），锚点完整性守卫防语料漂移
- **双轨评估**：合成黄金语料（G1–G5）全部保留 + 真实数据门（G6）——「合成测引擎健壮性，真实测对接有效性」

## 质量门（0.10.0 实测）

325 项测试全绿（32 文件）· 覆盖率 lines 100 / branches 97.89 / functions 100 / statements 100 ·
eval G1–G6 七门限全绿（合成 recall@1=1.0，真实 0.79/0.88/0.96）· bench 通过（BM25 top@1 命中率 100%）·
渲染文本与错误码逐字节不变 · 零新增依赖。