/**
 * eval 黄金语料（0.5.0 A5）：离线、固定 seed、完全可复算的检索质量评估资产。
 *
 * 场景划分：
 *   G1 精确质量：锚词 vs 长干扰（80 组，复用 0.4 bench 同款语料结构，验证 BM25 长度归一化）
 *   G2 模糊召回：编辑距离 ≤1 的错拼查询 vs 正确记忆（验证 A1 容错检索）
 *   G3 语义召回：词面零命中但词根/形态相关的查询 vs 记忆（验证 A2 近似语义兜底）
 *   G4 热度生命周期：陈旧高频 vs 新相关（验证 A4 halfLife 冷却/复活）
 *   G5 参数网格：G1 上 k1/b/heatHalfLifeMs 三参数 27 组合的敏感性对比
 */
import type { MemoryEntry } from '../src/memory/types'

export interface EvalQuery {
  /** 查询文本 */
  query: string
  /** 相关记忆 id（排名指标按此集合计算；通常 1 条，G1 固定 1 条目标） */
  relevant: string[]
  /** 场景内的显式选项（如 heatHalfLifeMs 注入），缺省用默认值 */
  options?: Record<string, unknown>
}

export interface EvalScenario {
  /** 场景名（G1..G4） */
  name: string
  /** 语料条目 */
  entries: MemoryEntry[]
  /** 查询集 */
  queries: EvalQuery[]
}

/** 固定 seed 的线性同余 PRNG（mulberry32）：保证语料可复算 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOW = Date.now()

function entry(id: string, content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    kind: 'fact',
    content,
    tags: [],
    source: 'auto',
    createdAt: NOW,
    updatedAt: NOW,
    accessCount: 0,
    ...overrides,
  }
}

/**
 * G1 精确质量：80 组，每组 1 个精炼目标（锚词）+ 5 个含锚词的长干扰。
 * 与 0.4 bench 的 makeQualityCorpus 同构，验证 BM25 长度归一化在词面精确命中下稳定。
 */
export function buildG1(): EvalScenario {
  const entries: MemoryEntry[] = []
  const queries: EvalQuery[] = []
  for (let i = 0; i < 80; i++) {
    const anchor = `q${i}anchor`
    const targetId = `g1-target-${i}`
    entries.push(entry(targetId, `${anchor} 部署方案`))
    for (let j = 0; j < 5; j++) {
      entries.push(
        entry(
          `g1-noise-${i}-${j}`,
          `${anchor} ${anchor} ${anchor} 与项目历史记录中的全部细节展开说明持续延长文档长度增加干扰`,
        ),
      )
    }
    queries.push({ query: anchor, relevant: [targetId] })
  }
  return { name: 'G1 精确质量（BM25 长度归一化）', entries, queries }
}

/** 常见英文词库（G2 错拼词与 G3 词根词使用，避免手工拼写错误） */
const WORDS = [
  'deployment',
  'configuration',
  'authentication',
  'migration',
  'monitoring',
  'integration',
  'optimization',
  'refactoring',
  'documentation',
  'infrastructure',
]

/** 从正确的词按编辑距离 ≤1 生成一个查询错拼（替换/删除/插入/交换） */
function typo(word: string, rand: () => number): string {
  const n = word.length
  const kind = Math.floor(rand() * 4)
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  if (kind === 0 && n > 2) {
    // 删除一个中间字符
    const i = 1 + Math.floor(rand() * (n - 2))
    return word.slice(0, i) + word.slice(i + 1)
  }
  if (kind === 1) {
    // 替换（随机字母）
    const i = Math.floor(rand() * n)
    const ch = letters[Math.floor(rand() * letters.length)]
    if (ch === word[i]) return word.slice(0, i) + (ch === 'a' ? 'b' : 'a') + word.slice(i + 1)
    return word.slice(0, i) + ch + word.slice(i + 1)
  }
  if (kind === 2 && n < 14) {
    // 插入
    const i = 1 + Math.floor(rand() * (n - 1))
    const ch = letters[Math.floor(rand() * letters.length)]
    return word.slice(0, i) + ch + word.slice(i)
  }
  // 相邻交换
  const i = Math.floor(rand() * (n - 1))
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2)
}

/**
 * G2 模糊召回：10 个英文专业词 × 每条 3 个不同错拼查询 = 30 组。
 * 查询是单词拼错（编辑距离 ≤1），记忆是正确拼写的完整句子——验证 A1 容错检索。
 */
export function buildG2(seed = 42): EvalScenario {
  const rand = mulberry32(seed)
  const entries: MemoryEntry[] = []
  const queries: EvalQuery[] = []
  for (let w = 0; w < WORDS.length; w++) {
    const word = WORDS[w]!
    const targetId = `g2-target-${w}`
    entries.push(entry(targetId, `项目采用${word}方案并记录在案`))
    for (let t = 0; t < 3; t++) {
      const wrong = typo(word, rand)
      if (wrong === word) continue
      entries.push(entry(`g2-noise-${w}-${t}`, `某条无关的记忆记录长短不一${w}-${t}`))
      queries.push({ query: wrong, relevant: [targetId] })
    }
  }
  return { name: 'G2 模糊召回（A1 编辑距离 ≤1 容错）', entries, queries }
}

/**
 * G3 语义召回：10 个英文专业词的**词根变体**查询（如 query=`deploy` 记忆=`deployment`）。
 * 词面零命中（整词不同 → BM25=0；编辑距离 >1 → A1 变体不触发），
 * 仅靠 A2 字符 3-gram 特征覆盖率的语义兜底召回——验证 A2 不是死代码。
 */
export function buildG3(): EvalScenario {
  const entries: MemoryEntry[] = []
  const queries: EvalQuery[] = []
  for (let w = 0; w < WORDS.length; w++) {
    const full = WORDS[w]!
    // 词根 = 去掉常见后缀（ment/ion/ing）；保证与记忆整词不同且编辑距离 >1
    const root = full.replace(/(ment|tion|ing)$/, '')
    if (root === full || root.length < 4) continue
    const targetId = `g3-target-${w}`
    // 记忆含完整词，查询用词根 → 零词面命中但 3-gram 强重叠
    entries.push(entry(targetId, `团队讨论${full}方案的落地细节`))
    for (let n = 0; n < 2; n++) {
      entries.push(entry(`g3-noise-${w}-${n}`, `无关主题${w}-${n}：周末天气与美食记录`))
    }
    queries.push({ query: root, relevant: [targetId] })
  }
  return { name: 'G3 语义召回（A2 词根 3-gram 兜底）', entries, queries }
}

/**
 * G4 热度生命周期：同内容同词面的两条记忆，一条 90 天前高频访问（已冷却），
 * 一条今日新建零访问——验证 A4 半衰期冷却让新相关记忆胜出（修复"陈旧高频霸榜"）。
 */
export function buildG4(): EvalScenario {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const targetFresh = 'g4-fresh'
  const targetStale = 'g4-stale'
  const entries: MemoryEntry[] = [
    entry(targetStale, '数据库连接池大小配置value', {
      createdAt: now - 95 * day,
      updatedAt: now - 90 * day,
      accessCount: 200,
      lastAccessAt: now - 90 * day,
    }),
    entry(targetFresh, '数据库连接池大小配置value', { createdAt: now }),
  ]
  const queries: EvalQuery[] = [
    {
      query: '数据库连接池 配置',
      relevant: [targetFresh],
      options: { now, limit: 2 },
    },
  ]
  return { name: 'G4 热度生命周期（A4 halfLife 冷却/复活）', entries, queries }
}

/** 组装四个主场景（固定 seed，保证跨运行一致） */
export function buildCorpus(): EvalScenario[] {
  return [buildG1(), buildG2(), buildG3(), buildG4()]
}

// ---------------------------------------------------------------------------
// 1.0.0 模块 E：G5-1.0 四维参数网格（k1 × b × heatHalfLife × 语义权重 = 81 组）
// 修复疑点 1：旧网格只有 3 维 27 组、指标只取 recall@1、语料无梯度（b 对均匀语料无压力）。
// ---------------------------------------------------------------------------

/** 默认参数组（必须不劣于任何替代组合，oracle 断言写入 eval.test.ts） */
export const GRID_DEFAULT = {
  k1: 1.2,
  b: 0.75,
  heatHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
  semanticWeight: 0.3,
}

/** 参数网格：k1 × b × 半衰期 × 语义权重 = 3×3×3×3 = 81 组合 */
export function buildGrid(): { k1: number; b: number; heatHalfLifeMs: number; semanticWeight: number }[] {
  const k1s = [1.0, 1.2, 1.5]
  const bs = [0.5, 0.75, 0.9]
  const hls = [1 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000]
  const sws = [0.1, 0.3, 0.5]
  const grid: { k1: number; b: number; heatHalfLifeMs: number; semanticWeight: number }[] = []
  for (const k1 of k1s)
    for (const b of bs)
      for (const heatHalfLifeMs of hls)
        for (const semanticWeight of sws) grid.push({ k1, b, heatHalfLifeMs, semanticWeight })
  return grid
}

/**
 * G5-1.0 梯度化语料（防塌缩回归）：干扰项锚词频率梯度 × 长填充 + 语义兜底组。
 * 设计依据（diag2 实测）：目标（锚词×1、短文本）与干扰（锚词×3、长填充）在
 * b=0.5 时干扰 tf 优势胜出（recall@1 失败），b=0.75/0.9 时长文档被归一化压制、
 * 目标胜出——即 b 三档产生可区分响应；k1 饱和截距与 padding 长度共存提供 k1 压力。
 * semanticWeight 压力由 4 组语义兜底查询提供：查询为词面零命中、编辑距离 ≥2
 * （fuzzy(≤1) 不命中）的字符变体，仅 3-gram 覆盖率可召回；
 * 目标词互不相同（photosynthesis/infrastructure/documentation/authentication），
 * 避免旧版 g5semantic0..3 前缀雷同导致 3-gram 互串、top1 恒定错位。
 */
export function buildG5Gradient(): EvalScenario {
  const entries: MemoryEntry[] = []
  const queries: EvalQuery[] = []
  // A) 词面命中组（4 组）：验证 k1/b 梯度（b=0.5 塌缩、0.75/0.9 恢复）
  for (let i = 0; i < 4; i++) {
    const anchor = `g5a${i}`
    const targetId = `g5-target-${i}`
    entries.push(entry(targetId, `${anchor} 部署方案`))
    // 干扰：锚词×3 + 长填充词（diag2: tf=3+lenNorm 足以使 b=0.5 时干扰反超）
    const pad = [
      'w0',
      'w1',
      'w2',
      'w3',
      'w4',
      'w5',
      'w6',
      'w7',
      'w8',
      'w9',
      'w10',
      'w11',
      'w12',
      'w13',
      'w14',
      'w15',
      'w16',
      'w17',
      'w18',
      'w19',
    ]
    entries.push(entry(`g5-noise-${i}-0`, `${anchor} ${anchor} ${anchor} ${pad.join(' ')}`))
    queries.push({ query: anchor, relevant: [targetId] })
  }
  // B) 语义兜底组（4 组）：验证 semanticWeight 梯度（词面/fuzzy 双零命中，仅 3-gram 可召回）
  const sem = [
    { word: 'photosynthesis', variant: 'photosyhntesis' },
    { word: 'infrastructure', variant: 'infrastrcuture' },
    { word: 'documentation', variant: 'documetnation' },
    { word: 'authentication', variant: 'authetnication' },
  ]
  for (let i = 0; i < sem.length; i++) {
    const s = sem[i]!
    entries.push(entry(`g5-semantic-target-${i}`, `${s.word} 方案落地细节`))
    // 每组的干扰：其他组目标词 + 本组词的近似干扰（验证语义线能区分正确目标）
    for (let j = 0; j < sem.length; j++) {
      if (j === i) continue
      entries.push(entry(`g5-semantic-noise-${i}-${j}`, `${sem[j]!.word} 是另一个方案主题，讨论其中各类细节`))
    }
    queries.push({ query: s.variant, relevant: [`g5-semantic-target-${i}`] })
  }
  return { name: 'G5-1.0 四维网格梯度语料（k1/b/semanticWeight 可区分压力）', entries, queries }
}
