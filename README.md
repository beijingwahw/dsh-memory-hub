# dsh-memory-hub

**DeepSeek Harness 本地优先智能会话记忆插件** —— v0.9.0（2026-10-05）

后台自动捕获会话中的事实 / 偏好 / 指令 / 决策，append-only JSONL 落盘，支持语义召回、热度生命周期、多工作区隔离、敏感过滤与隐私守护。

## 仓库内容

| 路径 | 说明 |
| --- | --- |
| `dist/dsh-memory-hub-0.9.0.tgz` | 插件安装包（npm pack 产物） |
| `dist/dsh-memory-hub-0.9.0.zip` | 交付归档（tgz + 双报告 + eval 报告） |
| `docs/LIFT-0.9.md` | 0.8.0 → 0.9.0 十六项薄弱项深度闭环报告 |
| `docs/QUALITY-0.9.md` | 0.9.0 全链质量门实测记录 |
| `quality-report-0.9.0.md` | 黄金语料检索质量评估报告（可复算） |
| `CHANGELOG.md` / `LICENSE` | 变更记录（Keep a Changelog）/ MIT |

## 安装

```bash
dsh plugin --profile web add ./dist/dsh-memory-hub-0.9.0.tgz
```

安装后插件以 `memory-hub` id 并入 profile 配置树（`cordis.patch.yml` 声明），重载即生效。卸载即恢复原状，记忆文件保留在磁盘上。

## 0.9.0 亮点（16 项薄弱项闭环）

- **漂移免疫词法**：强度词单一事实源编译派生，裸「务必/一定」conservative 漏记修复
- **共享默认隔离**：未标注 workspace = 全局共享，tools/result 捕获按 Agent 会话 cwd 溯源
- **双尺度时间语义**：评分衰减可关闭、半衰期可注入，ttlDays=0「永不过期」真正可检索
- **写入路径工程化**：批内瞬时去重 + dispose 捕获栅栏 + recall 热度合并回写抗刷
- **签名候选预筛**：MinHash 从预留落地为真实剪枝；快照零拷贝 + 写时重建
- **契约显式化**：autoTags / importer isUser / mode 三档 / strict 遗忘（NOT_FOUND）全部落地

## 质量门（0.9.0 实测）

324 项测试全绿（32 文件）· 覆盖率 lines 100 / branches 97.87 / functions 100 / statements 100 ·
eval G1–G5 六门限全绿（recall@1 = 1.0）· bench 通过（BM25 top@1 命中率 100%）·
渲染文本与错误码逐字节不变 · 零新增依赖。