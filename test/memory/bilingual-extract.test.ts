/**
 * 双语实体抽取（1.5.0，DESIGN-1.5 模块 N）行为锁定。
 *
 * 1.2.0/1.3.0 声明的边界「英文语料仅产出片段型实体、跨语言词表扩展属后续独立课题」
 * 自此收敛：英文技术文档高频关系面（written in / supports / returns / throws /
 * emits / based on / part of / belongs to / migrated to …）与中文对应面
 * （基于/支持/提供/返回/抛出/发出/继承/实现/改为/换成）入表；宾语连词拆分
 * （and/or/与/和/、）让「A uses B and C」「A 使用 B、C」逐并列产出；
 * 宾语前导冠词剥除（returns a promise → promise）。
 *
 * 锁定不变式（1.1.1 既有语义保持）：裸 'the app' 主语保留（只剥指示词前缀）、
 * 词边界匹配（use ≠ because）、置信度下限、同三元组去重。
 */
import { describe, expect, it } from 'vitest'
import { buildGraph, queryEntities, ruleExtractTriples } from '../../src/memory/graph'
import { freshEntry } from './utils'

const T0 = 1_700_000_000_000

function tripleOf(text: string): Array<[string, string, string]> {
  return ruleExtractTriples(text).map((t) => [t.subject, t.relation, t.object])
}

describe('ruleExtractTriples 双语扩展（1.5.0 模块 N）', () => {
  it('英文技术关系面：written in / supports / returns / emits / based on / part of 各归其位', () => {
    expect(tripleOf('the engine written in rust, fast and safe')).toContainEqual(['the engine', 'written in', 'rust'])
    expect(tripleOf('node.js supports es modules')).toContainEqual(['node.js', 'supports', 'es modules'])
    expect(tripleOf('fs.readfile returns a promise, always async')).toContainEqual([
      'fs.readfile',
      'returns',
      'promise',
    ])
    expect(tripleOf('the stream emits close, then flush')).toContainEqual(['the stream', 'emits', 'close'])
    expect(tripleOf('the platform based on k8s, serving traffic')).toContainEqual(['the platform', 'based on', 'k8s'])
    expect(tripleOf('fs is part of the node core, since v0.1')).toContainEqual(['fs', 'part of', 'node core'])
  })

  it('英文演进关系面：migrated to / upgraded to / replaced by / belongs to', () => {
    expect(tripleOf('the cluster migrated to k8s, last week')).toContainEqual(['the cluster', 'migrated to', 'k8s'])
    expect(tripleOf('the runtime upgraded to node 22, lts')).toContainEqual(['the runtime', 'upgraded to', 'node 22'])
    expect(tripleOf('the cache belongs to the web tier, shared')).toContainEqual([
      'the cache',
      'belongs to',
      'web tier',
    ])
  })

  it('中文对应面：基于 / 支持 / 返回 / 抛出 / 改为 / 换成', () => {
    expect(tripleOf('运行时 基于 V8，执行代码')).toContainEqual(['运行时', '基于', 'v8'])
    expect(tripleOf('网关 支持 HTTP2')).toContainEqual(['网关', '支持', 'http2'])
    expect(tripleOf('接口 返回 JSON')).toContainEqual(['接口', '返回', 'json'])
    expect(tripleOf('解析器 抛出 SyntaxError')).toContainEqual(['解析器', '抛出', 'syntaxerror'])
    expect(tripleOf('序列化 改为 JSON')).toContainEqual(['序列化', '改为', 'json'])
    expect(tripleOf('面板 换成 Grafana')).toContainEqual(['面板', '换成', 'grafana'])
  })

  it('宾语连词拆分：en and / zh 、 与 —— 逐并列产出（A uses B and C → 两条）', () => {
    expect(tripleOf('the gateway uses nginx and envoy')).toEqual(
      expect.arrayContaining([
        ['the gateway', 'uses', 'nginx'],
        ['the gateway', 'uses', 'envoy'],
      ]),
    )
    expect(tripleOf('网关 使用 Nginx、Envoy')).toEqual(
      expect.arrayContaining([
        ['网关', '使用', 'nginx'],
        ['网关', '使用', 'envoy'],
      ]),
    )
    expect(tripleOf('网关 使用 Nginx 与 Envoy')).toEqual(
      expect.arrayContaining([
        ['网关', '使用', 'nginx'],
        ['网关', '使用', 'envoy'],
      ]),
    )
    // 拆出的并列臂仍受有效性约束：过短/虚词臂不产出（'的' 剥除后为空）
    const t = ruleExtractTriples('服务 依赖 Aaa、的')
    expect(t.filter((x) => x.relation === '依赖').length).toBe(1) // 只有 'aaa' 有效
  })

  it('宾语前导冠词剥除：returns a promise → promise（不定冠词不进实体）', () => {
    const t = ruleExtractTriples('readdir throws an error, on invalid path')
    expect(t.some((x) => x.relation === 'throws' && x.object === 'error')).toBe(true)
  })

  it('无裸 is 关系：存现句不产出 is 三元组（there is a bug 不进图）', () => {
    const t = ruleExtractTriples('there is a bug in the parser')
    expect(t.some((x) => x.relation === 'is')).toBe(false)
    expect(t.length).toBe(0)
  })

  it('同三元组去重 + 置信度下限保持（新词表不破坏既有纪律）', () => {
    const t = ruleExtractTriples('网关 使用 Nginx。网关 使用 Nginx')
    const used = t.filter((x) => x.relation === '使用')
    expect(used.length).toBe(1)
    expect(t.every((x) => x.confidence > 0.8 && x.confidence <= 1)).toBe(true)
  })

  it('标识符内部的点不是句分隔：node.js / fs.readfile 主宾语保持完整（1.5.0 修复）', () => {
    expect(tripleOf('node.js supports es modules')).toContainEqual(['node.js', 'supports', 'es modules'])
    expect(tripleOf('fs.readfile returns a promise, always async')).toContainEqual([
      'fs.readfile',
      'returns',
      'promise',
    ])
    // 真正的句末点号（后随空白）仍分隔：宾语在句点处截断
    expect(tripleOf('the engine written in rust. v2 is faster')).toContainEqual(['the engine', 'written in', 'rust'])
  })

  it('1.1.1 锁定语义保持：裸 the app 主语保留、词边界不误匹配', () => {
    const t3 = ruleExtractTriples('the app uses caching')
    expect(t3.some((x) => x.subject === 'the app' && x.relation === 'uses' && x.object === 'caching')).toBe(true)
    const t2 = ruleExtractTriples('the system because of cache')
    expect(t2.some((x) => x.relation === 'use')).toBe(false)
  })

  it('queryEntities 识别英文关系词前主语（新词表自动生效）', () => {
    const q = queryEntities('the stream emits')
    expect(q).toContain('the stream')
  })

  it('图谱接线：双语条目建图后可经英文关系面邻域扩展（跨语言实体入图）', () => {
    const g = buildGraph([
      freshEntry({ id: 'e1', content: 'the engine written in rust, fast', createdAt: T0, updatedAt: T0 }),
      freshEntry({ id: 'e2', content: 'the cli written in rust, small', createdAt: T0, updatedAt: T0 }),
    ])
    const scores = g.neighborEntityScores(['rust'], T0 + 1000, 1)
    expect(scores.size).toBeGreaterThan(0) // rust → the engine / the cli 邻域可达
    expect(g.stats(T0 + 1000).activeEdges).toBeGreaterThanOrEqual(4)
  })
})
