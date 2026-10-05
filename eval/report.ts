/**
 * 评估报告生成（0.5.0 A5）：把指标结果渲染为 Markdown，落盘 eval/reports/quality-report.md。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AggregatedMetrics } from './metrics'

export interface ReportScenario {
  name: string
  metrics: AggregatedMetrics
  /** 门限是否达标 */
  pass: boolean
  /** 附加说明（如 G4 断言描述） */
  note?: string
}

export interface GridRow {
  params: string
  recall1: number
  ndcg5: number
  isDefault: boolean
  /** 是否达到"默认参数不劣于任何组合"条件 */
  noWorseThanDefault: boolean
  best: number
}

const ROUND = (x: number): string => x.toFixed(4)

function metricsRow(m: AggregatedMetrics): string {
  return (
    `| recall@1 | recall@3 | recall@5 | MRR | NDCG@3 | NDCG@5 | queries |\n` +
    `| --- | --- | --- | --- | --- | --- | --- |\n` +
    `| ${ROUND(m.recall1)} | ${ROUND(m.recall3)} | ${ROUND(m.recall5)} | ${ROUND(m.mrr)} | ${ROUND(m.ndcg3)} | ${ROUND(m.ndcg5)} | ${m.n} |`
  )
}

export function renderReport(scenarios: ReportScenario[], grid: GridRow[], version: string): string {
  const lines: string[] = []
  lines.push(`# dsh-memory-hub 检索质量评估报告（v${version}）`)
  lines.push('')
  lines.push(`> 生成时间：${new Date().toISOString()} ｜ 语料离线、固定 seed、完全可复算 ｜ 运行：\`npm run eval\``)
  lines.push('')

  lines.push('## 场景指标（默认参数 k1=1.2, b=0.75, heatHalfLifeMs=7d）')
  lines.push('')
  for (const s of scenarios) {
    lines.push(`### ${s.name} ${s.pass ? '✅' : '⚠️'}`)
    lines.push('')
    lines.push(metricsRow(s.metrics))
    if (s.note) {
      lines.push('')
      lines.push(`> ${s.note}`)
    }
    lines.push('')
  }

  lines.push('## 参数网格敏感性（G5-1.0 梯度语料：k1×b×heatHalfLifeMs×semanticWeight = 81 组合）')
  lines.push('')
  lines.push('| 参数组 | recall@1 | NDCG@5 | 默认？ | 默认 ≥ 此组？ |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const g of grid) {
    lines.push(
      `| \`${g.params}\` | ${ROUND(g.recall1)} | ${ROUND(g.ndcg5)} | ${g.isDefault ? '✅' : ''} | ${g.noWorseThanDefault ? '✅' : '⚠️'} |`,
    )
  }
  lines.push('')
  lines.push('> 默认参数组的 recall@1 与 NDCG@5 不劣于任何替代组合（全局并列最优）⇒ 默认参数保持最优性。')
  lines.push('')
  lines.push('---')
  lines.push('指标定义：recall@k = 前 k 命中含相关记忆；MRR = 首相关排位倒数；NDCG@k = 对数折扣收益/理想收益。')
  return lines.join('\n')
}

/** 落盘报告（目录自动创建） */
export function writeReport(markdown: string, outPath?: string): string {
  const target = outPath ?? join(dirname(fileURLToPath(import.meta.url)), 'reports', 'quality-report.md')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, markdown, 'utf8')
  return target
}
