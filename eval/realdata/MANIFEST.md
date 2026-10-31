# G6 真实数据语料清单（Node.js 官方 API 文档快照）

语料为 Node.js **v26.10.0**（固定 tag，官方发布后不可变）四份 API 文档的原始 Markdown 快照，
自 `nodejs.org` 官方文档站直接下载固化，评测全程不联网。

- 下载源：`https://nodejs.org/docs/v26.10.0/api/<file>.md`
- 固化时间：2026-10-30（重建；tag 固定保证字节可复现）
- 校验方式：`npm run verify:realdata`（SHA-256 + 字节数双重比对，防语料漂移）
- 用途：`eval/realdata.ts` 的 `buildRealScenario()` 经生产同路径 `planImport` 导入后跑 G6/G7/G8 门禁

| 文件 | 来源 | 版本 | 固化字节 SHA-256 | 字节数 |
| ---- | ---- | ---- | ---- | ---- |
| `path.md` | nodejs.org 官方文档 | v26.10.0 | `f6e28a9cefcedcf35cbcf39f46c1da561e2880cfc358251632627b21c58703c6` | 16915 |
| `os.md` | nodejs.org 官方文档 | v26.10.0 | `00eafdab442c752c0edcc1375bbe226938efa5cb20670ee64591c4858573ab8d` | 37124 |
| `fs.md` | nodejs.org 官方文档 | v26.10.0 | `a388f98783c341c471cf4178a09b5e6169360f1b1d43e480cab1095d6b69fee8` | 306829 |
| `stream.md` | nodejs.org 官方文档 | v26.10.0 | `7942009743992e0a8f705f0f736cbb717f6e61ed295fd5770ea75152877200c8` | 159942 |

## 复现步骤

```bash
for f in path os fs stream; do
  curl -sSL --fail -o "eval/realdata/$f.md" "https://nodejs.org/docs/v26.10.0/api/$f.md"
done
npm run verify:realdata
```

> 注意：`.prettierignore` 已排除本目录——任何工具都不得重排/格式化语料，否则哈希失配、
> 门禁立即变红（这正是清单存在的意义）。
