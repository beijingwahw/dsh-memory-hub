#!/usr/bin/env node
/**
 * G6 真实数据语料完整性校验（1.0.0）：
 * 解析 eval/realdata/MANIFEST.md 中登记的 SHA-256 与字节数，对 eval/realdata/*.md
 * 实算比对，防止语料漂移（误改、截断、重抓错版本）导致评测基准失真。
 *
 * 用法：npm run verify:realdata（或 node scripts/verify-realdata.mjs）
 * 退出码：0 = 全部通过；1 = 任一文件不匹配或清单缺失。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'eval', 'realdata', 'MANIFEST.md')
const manifest = readFileSync(manifestPath, 'utf8')

const rowRe = /^\| `([^`]+\.md)` \|.*\| `([0-9a-f]{64})` \| (\d+) \|$/
const expected = []
for (const line of manifest.split('\n')) {
  const m = line.match(rowRe)
  if (m) expected.push({ file: m[1], sha256: m[2], bytes: Number(m[3]) })
}

if (expected.length === 0) {
  console.error(
    '[verify-realdata] 未在 MANIFEST.md 中找到任何语料登记行（格式：| file | 来源 | 版本 | URL | 时间 | hash | 字节 |）',
  )
  process.exit(1)
}

let failed = 0
for (const exp of expected) {
  const p = join(root, 'eval', 'realdata', exp.file)
  let buf
  try {
    buf = readFileSync(p)
  } catch (err) {
    console.error(`[verify-realdata] 缺失文件 ${exp.file}: ${err.message}`)
    failed++
    continue
  }
  const sha = createHash('sha256').update(buf).digest('hex')
  const ok = sha === exp.sha256 && buf.length === exp.bytes
  if (ok) {
    console.log(`[verify-realdata] ✅ ${exp.file}  SHA-256/字节 与清单一致（${exp.bytes} B）`)
  } else {
    console.error(
      `[verify-realdata] ❌ ${exp.file}  不匹配\n  清单 SHA-256: ${exp.sha256} / ${exp.bytes} B\n  实测 SHA-256: ${sha} / ${buf.length} B`,
    )
    failed++
  }
}

if (failed > 0) {
  console.error(`[verify-realdata] ${failed} 个文件校验失败，请检查 eval/realdata/ 语料与 MANIFEST.md 登记是否漂移。`)
  process.exit(1)
}
console.log(`[verify-realdata] 全部 ${expected.length} 个语料文件校验通过。`)
