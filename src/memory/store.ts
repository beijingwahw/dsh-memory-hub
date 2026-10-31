/**
 * MemoryStore 的 JSONL 实现（append-only + tombstone + compact）。
 *
 * 0.3.0 设计要点（世界级存储语义）：
 * - 写一致性：**先落盘（append 成功）后变更内存**，读者永远只能看到已确认落盘的状态；
 *   写失败天然无内存残留，无需回滚（0.2.0 的回滚逻辑由此弱化为无需保留）。
 * - 读性能：维护排序快照缓存（dirty 标记），`list()` 热路径 O(N) 拷贝而非每次 O(N log N) 排序；
 * - 索引失效：暴露 `revision` 版本号（任何结构性写入 +1），供上层倒排索引缓存按需重建；
 * - 批量删除：`removeMany(ids)` 单次落盘多行 tombstone + 单次 compact 判定，TTL 清理不再逐条写；
 * - compact 容错：重建失败仅告警，绝不把"已成功写入"的调用变成失败；
 * - 错误分级：closed / 写失败 / 读失败统一为 MemoryHubError 稳定错误码；
 * - 隐私：目录 0700、记忆文件 0600；
 * - 兼容 0.1.0 旧文件（逐行加载天然兼容），损坏行跳过并计数上报，非 ENOENT 错误不再吞没。
 *
 * 0.4.0 世纪升级（CENTURY-0.4）：
 * - 损坏行隔离留证：加载发现损坏行时，原文追加写入 `<file>.corrupt` 审计文件（0600、仅告警），
 *   不再静默丢弃数据证据，可为人工修复与数据恢复提供依据；
 * - compact 自检：重建后重读新文件核对行数，不一致仅告警（延续「成功写入不因优化失败」哲学）；
 * - `exportAll`：全量导出为 JSON 数组字符串，与 `importAll` 组成跨设备迁移闭环。
 *
 * 1.4.0（DESIGN-1.4 模块 I/J）：
 * - 可选 passphrase 加密：逐行 AES-256-GCM 信封（crypto.ts 编解码器收口全部落盘路径），
 *   错口令加载期快速失败、明文库原位加密迁移（append-only 历史逐行保留）、compact 与加密共存；
 * - diffReplay：T1↔T2 回放快照差异纯函数（新增/消失/内容变更/取代矛盾/纯热度），
 *   memory_status 的 diff 视图数据源。
 *
 * 1.5.0（DESIGN-1.5 模块 K/O）：
 * - changePassphrase：口令轮换 / 解密回退——逐行原序重写（深回放历史完整保留，仅换密钥外衣），
 *   由 DSH_MEMORY_NEW_PASSPHRASE 环境变量在启动期触发（插件入口接线）；
 * - timelineFromRaw：append-only 日志的记忆时间轴纯函数（按天分桶的新增/删除/更新/热度事件流），
 *   memory_status timeline 视图数据源。
 */
import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ErrorCodes, MemoryHubError } from '../errors'
import {
  createEncryptedCodec,
  deriveKey,
  isEncryptedEnvelope,
  makeKeyRecord,
  parseKeyRecord,
  plainCodec,
  randomSalt,
  type LineCodec,
} from './crypto'
import { parseMemoryEntry, type MemoryEntry, type MemoryStore, type MemoryTimeline, type TimelineBucket } from './types'

/** pid 存活性探测（跨平台）：ESRCH = 已退出；EPERM = 存活但权限受限（仍视为存活） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// 1.1.1：contentHash 下沉到独立的 hash.ts（纯函数不该挂在存储实现上）；
// 此处 re-export 保持既有 `from './store'` 导入路径兼容
export { contentHash } from './hash'

/** tombstone 行标记：删除不再重写历史行，由 compact 清除 */
const TOMBSTONE_KEY = '__tombstone__'
/** 1.3.0：tombstone 行的删除时刻字段（缺省无 = 1.2.0 及以前的旧格式，读取侧兼容） */
const TOMBSTONE_AT_KEY = 'at'

/** compact 阈值：文件行数超过「条目数 ×2 且 ≥64」时重建，避免频繁重写 */
export const COMPACT_FACTOR = 2
export const COMPACT_MIN_LINES = 64

/**
 * 1.3.0（DESIGN-1.3 模块 G）：时序回放结果。
 * entries = asOf 时刻的存活条目（按 createdAt 升序，与 list() 排序约定一致）；
 * skippedCorrupt = 回放中跳过的损坏行数（与加载语义同源，可观测）。
 */
export interface AsOfReplayResult {
  entries: MemoryEntry[]
  skippedCorrupt: number
}

/**
 * 1.3.0（DESIGN-1.3 模块 G）：情景回放（episodic replay）——把 append-only JSONL 日志
 * 回放到时刻 asOf，得到该时刻的**精确知识状态**（哪些条目存在 / 内容是哪一版 /
 * 取代与矛盾标注 / 访问热度），纯函数、确定性（单遍文件序回放，可复算）。
 *
 * 行的「写入时刻」由写入协议锚定（makeEntry / supersede 回写 / bumped 热度回写）：
 * - 内容/标注写入：updatedAt = 写入时刻，access 字段原样保留；
 * - 热度回写：updatedAt 原样保留，lastAccessAt = 写入时刻；
 * 故 写入时刻 ≡ max(updatedAt, lastAccessAt ?? -∞)。
 * 回放规则（对每行按文件序）：
 * - 条目行：updatedAt ≤ asOf 且（无 lastAccessAt 或 lastAccessAt ≤ asOf）→ 该行是
 *   id 在 asOf 时刻的状态（后行覆盖前行 = 后写覆盖）；否则整行跳过——包括
 *   「asOf 之后才创建/改写的条目」与「asOf 之后的热度回写」（其 access 状态属于未来）。
 * - tombstone 行（带 at）：at ≤ asOf → 删除该 id（asOf 时刻已删除）；at > asOf →
 *   忽略（尚未发生）；之后的条目行可复活（文件序天然支持 remove→re-add）。
 * - tombstone 行（无 at，1.2.0 及以前旧格式）：删除时刻未知 → 保守视为任何时刻都已删除。
 * - 损坏行：跳过并计数（与加载语义一致）。
 *
 * 边界（DESIGN-1.3 已声明）：compact 会清除历史行（tombstone 与被覆盖旧版本），
 * 回放退化为「最新快照的存在性判定」——深回放精度以未 compact 的日志为前提。
 */
export function replayAsOf(raw: string, asOf: number): AsOfReplayResult {
  const state = new Map<string, MemoryEntry>()
  let skippedCorrupt = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      skippedCorrupt++
      continue
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>
      // tombstone 行：删除事件（1.3.0 起带删除时刻 at；旧格式无 at = 任意时刻已删除）
      if (typeof obj[TOMBSTONE_KEY] === 'string') {
        const at = obj[TOMBSTONE_AT_KEY]
        if (at === undefined || (typeof at === 'number' && Number.isFinite(at) && at <= asOf)) {
          state.delete(obj[TOMBSTONE_KEY])
        }
        continue
      }
    }
    const entry = parseMemoryEntry(trimmed)
    if (entry === undefined) {
      skippedCorrupt++
      continue
    }
    // 写入时刻 ≤ asOf 的行才参与该时刻的状态（热度回写的 lastAccessAt 在未来 → 跳过）
    if (entry.updatedAt <= asOf && (entry.lastAccessAt === undefined || entry.lastAccessAt <= asOf)) {
      state.set(entry.id, entry)
    }
  }
  return { entries: [...state.values()].sort((a, b) => a.createdAt - b.createdAt), skippedCorrupt }
}

/**
 * 1.4.0（DESIGN-1.4 模块 J）：T1↔T2 回放差异条目（diff 视图数据源）。
 */
export interface ReplayDiffItem {
  id: string
  kind: string
  /** 内容首行摘要（≤24 字符，供模型/人类快速识别条目） */
  title: string
}

/** diff 中「更新」类目的变更归因 */
export type ReplayDiffChange = 'content' | 'tags' | 'supersede' | 'conflict'

export interface ReplayDiffUpdatedItem extends ReplayDiffItem {
  change: ReplayDiffChange
}

export interface ReplayDiff {
  since: number
  until: number
  addedCount: number
  removedCount: number
  updatedCount: number
  /** 仅有访问热度变化（accessCount/lastAccessAt）的条目数——认知维护的日常噪音，计数不列明细 */
  heatOnly: number
  added: ReplayDiffItem[]
  removed: ReplayDiffItem[]
  updated: ReplayDiffUpdatedItem[]
}

/** 取代/矛盾协议标记前缀（supersede / superseded-by / conflicts-with / conflict-of） */
const SUPERSEDE_TAG_PREFIXES = ['supersede:', 'superseded-by:', 'conflicts-with:', 'conflict-of:'] as const

/** diff 条目标题：正文首行裁剪到 24 字符（空白折叠，供人/模型快速识别） */
function diffTitle(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim()) ?? ''
  const collapsed = firstLine.trim().replace(/\s+/g, ' ')
  return collapsed.length <= 24 ? collapsed : `${collapsed.slice(0, 24)}…`
}

/**
 * 1.4.0（DESIGN-1.4 模块 J）：两个回放快照的差异分析（纯函数、确定性）。
 *
 * 输入为 replayAsOf(T1)/replayAsOf(T2) 的条目集（T1 < T2），输出 T1→T2 期间
 * 「记忆库发生了什么」的结构化答案：
 * - added：T2 存在、T1 不存在（新写入或删除后复活）；
 * - removed：T1 存在、T2 不存在（tombstone 删除或……被 compact 吞掉的历史，见边界）；
 * - updated：两边都在但状态推进，按归因分级——content（正文/类型/工作区变更）、
 *   supersede/conflict（取代与矛盾协议标记变化）、tags（其他标签变化）；
 * - heatOnly：仅访问热度变化（召回巩固的日常足迹）——只计数不列明细。
 *
 * 边界：compact 清除历史行后，removed 退化为「最新快照存在性判定」口径
 * （与 replayAsOf 的 compact 降级一致）；降级 store（无 listAsOf，按 createdAt
 * 过滤的当前快照）下 removed 恒为空集（看不见 tombstone）——工具层已声明。
 */
export function diffReplay(before: MemoryEntry[], after: MemoryEntry[], since: number, until: number): ReplayDiff {
  const beforeMap = new Map(before.map((e) => [e.id, e]))
  const afterMap = new Map(after.map((e) => [e.id, e]))
  const added: ReplayDiffItem[] = []
  const removed: ReplayDiffItem[] = []
  const updated: ReplayDiffUpdatedItem[] = []
  let heatOnly = 0
  for (const e of after) {
    const prev = beforeMap.get(e.id)
    if (prev === undefined) {
      added.push({ id: e.id, kind: e.kind, title: diffTitle(e.content) })
      continue
    }
    const contentChanged = prev.content !== e.content || prev.kind !== e.kind || prev.workspace !== e.workspace
    const prevTags = new Set(prev.tags)
    const currTags = new Set(e.tags)
    const tagDiff: string[] = []
    for (const t of currTags) if (!prevTags.has(t)) tagDiff.push(t)
    for (const t of prevTags) if (!currTags.has(t)) tagDiff.push(t)
    if (contentChanged) {
      updated.push({ id: e.id, kind: e.kind, title: diffTitle(e.content), change: 'content' })
    } else if (tagDiff.length > 0) {
      const marker = tagDiff.find((t) => SUPERSEDE_TAG_PREFIXES.some((p) => t.startsWith(p)))
      const isConflict =
        marker !== undefined && (marker.startsWith('conflicts-with:') || marker.startsWith('conflict-of:'))
      updated.push({
        id: e.id,
        kind: e.kind,
        title: diffTitle(e.content),
        change: marker === undefined ? 'tags' : isConflict ? 'conflict' : 'supersede',
      })
    } else if (
      prev.accessCount !== e.accessCount ||
      prev.lastAccessAt !== e.lastAccessAt ||
      prev.updatedAt !== e.updatedAt
    ) {
      // 内容与标签全同、仅访问/回写时间戳推进 = 纯热度足迹
      heatOnly++
    }
  }
  for (const e of before) {
    if (!afterMap.has(e.id)) removed.push({ id: e.id, kind: e.kind, title: diffTitle(e.content) })
  }
  added.sort((a, b) => a.id.localeCompare(b.id))
  removed.sort((a, b) => a.id.localeCompare(b.id))
  updated.sort((a, b) => a.id.localeCompare(b.id))
  return {
    since,
    until,
    addedCount: added.length,
    removedCount: removed.length,
    updatedCount: updated.length,
    heatOnly,
    added,
    removed,
    updated,
  }
}

/**
 * 1.5.0（DESIGN-1.5 模块 O）：记忆时间轴——append-only 日志单遍回放的按天分桶事件流
 * （纯函数、确定性，memory_status timeline 视图数据源）。
 *
 * 事件分类（对每行按文件序）：
 * - 条目行：写入时刻 = max(updatedAt, lastAccessAt ?? −∞)（与 replayAsOf 同锚）。
 *   id 不在存活集（首见或删除后复活）→ added；存活且 content/tags/kind 变化 → updated；
 *   存活且仅访问字段推进 → heat（召回巩固的日常足迹）。
 * - tombstone 行（带删除时刻 at）：at 有时间锚 → removed（仅对当时存活的 id 计数）；
 *   旧格式（无 at）无时间锚 → 不计事件，保守立即作用于存活集（影响后续桶的 total）。
 * - 损坏行：跳过（加载期已留证）。
 *
 * total = 当日终态存活数（按日序 running + added − removed，时钟偏斜下负值钳 0）；
 * 分桶超 cap 时仅保留**最近**的桶（truncated=true，近期走势对模型/人类更有价值）。
 * 观测口径：时间轴是宏观事件流视图；任意时刻的精确状态请用 replayAsOf。
 */
export function timelineFromRaw(raw: string, cap = 31): MemoryTimeline {
  const counts = new Map<string, { added: number; removed: number; updated: number; heat: number }>()
  const last = new Map<string, { content: string; tags: string; kind: string }>()
  const live = new Set<string>()
  // 旧格式 tombstone（无删除时刻锚）作用于存活集但不计事件：折算到首桶前的总量基线
  let preRemoved = 0
  let firstAt = 0
  let lastAt = 0
  const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10)
  const anchor = (t: number): void => {
    if (firstAt === 0 || t < firstAt) firstAt = t
    if (t > lastAt) lastAt = t
  }
  const bucketOf = (t: number): { added: number; removed: number; updated: number; heat: number } => {
    const key = dayOf(t)
    let b = counts.get(key)
    if (b === undefined) {
      b = { added: 0, removed: 0, updated: 0, heat: 0 }
      counts.set(key, b)
    }
    return b
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // 损坏行：时间轴跳过（加载期已留证）
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj[TOMBSTONE_KEY] === 'string') {
        const at = obj[TOMBSTONE_AT_KEY]
        const id = obj[TOMBSTONE_KEY]
        if (typeof at === 'number' && Number.isFinite(at)) {
          if (live.has(id)) {
            bucketOf(at).removed++
            anchor(at)
            live.delete(id)
            last.delete(id)
          }
        } else {
          // 旧格式 tombstone：无时间锚 → 不计事件，保守立即生效于存活集
          //（折算为首桶前的总量基线，保证后续桶 total 正确）
          if (live.has(id)) {
            preRemoved++
            live.delete(id)
            last.delete(id)
          }
        }
        continue
      }
    }
    const entry = parseMemoryEntry(trimmed)
    if (entry === undefined) continue
    const wt = entry.lastAccessAt !== undefined ? Math.max(entry.updatedAt, entry.lastAccessAt) : entry.updatedAt
    const b = bucketOf(wt)
    anchor(wt)
    const prev = last.get(entry.id)
    if (!live.has(entry.id)) {
      b.added++
    } else {
      const changed =
        prev === undefined ||
        prev.content !== entry.content ||
        prev.kind !== entry.kind ||
        prev.tags !== entry.tags.join('\u0000')
      if (changed) b.updated++
      else b.heat++
    }
    live.add(entry.id)
    last.set(entry.id, { content: entry.content, kind: entry.kind, tags: entry.tags.join('\u0000') })
  }
  const days = [...counts.keys()].sort()
  let running = -preRemoved
  let events = 0
  const all: TimelineBucket[] = days.map((day) => {
    const c = counts.get(day)!
    events += c.added + c.removed + c.updated + c.heat
    running = Math.max(0, running + c.added - c.removed)
    return { day, added: c.added, removed: c.removed, updated: c.updated, heat: c.heat, total: running }
  })
  const truncated = all.length > cap
  return { firstAt, lastAt, events, truncated, buckets: truncated ? all.slice(-cap) : all }
}

export class JsonlMemoryStore implements MemoryStore {
  private entries = new Map<string, MemoryEntry>()
  private writeChain: Promise<void> = Promise.resolve()
  private closed = false
  /** 文件中行数近似值（加载行数 + 追加行数），用于 compact 判定 */
  private lines = 0
  private skippedCorrupt = 0
  /** 0.4.0：损坏行原文待隔离列表（加载时收集，open 尾部一次性写入 .corrupt） */
  private corruptLines: string[] = []
  /** 结构性版本号：任何 upsert/remove/removeMany/importAll 递增，供索引缓存失效 */
  private version = 0
  /** 排序快照缓存（dirty 时重建） */
  private snapshotCache: MemoryEntry[] | undefined
  private snapshotDirty = true
  /** 1.0.0：最近一次结构性写入新增的条目快照（IndexCache 增量构建用，读取后失效） */
  private lastInsertedSnapshot: MemoryEntry[] = []
  /** 1.0.0：最近一次 compact 回收统计（可观测性，status/diagnostics 上报） */
  private compactStats = { reclaimed: 0, ratio: 0, atLineCount: 0, timestamp: 0 }
  /**
   * 1.1.1 单实例写锁状态：
   * - lockHeld：本进程持有 `<file>.lock`（close 时释放）；
   * - compactDenied：锁被其他存活实例持有（或锁不可写）时禁用 compact——
   *   多进程并发下 rename 原子替换会用本进程内存快照吞噬其他进程未见的追加行，
   *   这是唯一可能**永久毁数据**的路径；追加写本身保持允许（多行单次 append 交错
   *   风险远小于 compact 的整文件覆盖）。
   */
  private lockHeld = false
  private compactDenied = false
  /**
   * 1.4.0（DESIGN-1.4 模块 I）：行编解码器。缺省 plainCodec = 1.3.0 字节行为逐位不变；
   * passphrase 开启后为 AES-256-GCM 信封编解码（读侧 decode / 写侧 encode 全部落盘路径收口）。
   */
  private codec: LineCodec = plainCodec
  /** 密钥记录头是否已落盘（加密库首行；首个追加写时补写，compact 重建时保留） */
  private headerWritten = false
  /** 加载期信封行认证成功/失败计数（错口令快速失败判定：头存在 && 全部信封失败） */
  private envelopeOk = 0
  private envelopeFail = 0

  constructor(
    private readonly filePath: string,
    private readonly logger: (msg: string) => void = () => {},
  ) {}

  /** 从磁盘加载（兼容 0.1.0 整条目行格式与 0.2.0 tombstone 行格式） */
  static async open(
    filePath: string,
    logger?: (msg: string) => void,
    opts?: { passphrase?: string },
  ): Promise<JsonlMemoryStore> {
    const store = new JsonlMemoryStore(filePath, logger)
    const dir = dirname(filePath)
    let createdDir: string | undefined
    try {
      createdDir = await mkdir(dir, { recursive: true })
    } catch (err) {
      throw new MemoryHubError(ErrorCodes.STORE_WRITE_FAILED, `failed to create storage directory: ${dir}`, err)
    }
    let raw: string | undefined
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new MemoryHubError(ErrorCodes.STORE_READ_FAILED, `failed to read memory file: ${filePath}`, err)
      }
    }
    // 1.4.0（模块 I）：加密握手——首行密钥记录头判定库形态，派生/创建编解码器
    const passphrase = opts?.passphrase
    const firstLine = raw?.split('\n').find((l) => l.trim())
    const keyRecord = firstLine !== undefined ? parseKeyRecord(firstLine.trim()) : undefined
    if (passphrase !== undefined && passphrase !== '') {
      if (keyRecord !== undefined) {
        // 既有加密库：按文件头 KDF 参数派生密钥（与写入侧同参同盐）
        store.codec = createEncryptedCodec(deriveKey(passphrase, keyRecord.salt, keyRecord))
        store.headerSalt = keyRecord.salt
        store.headerWritten = true
      } else {
        // 明文库（或全新库）首次开启加密：新盐只生成一次（密钥派生与首写头共用）+ 迁移标记
        const salt = randomSalt()
        store.codec = createEncryptedCodec(deriveKey(passphrase, salt))
        store.headerSalt = salt
        store.headerWritten = false
      }
    } else if (keyRecord !== undefined) {
      // 加密库但未提供口令：绝不把密文行当损坏行静默清空——显式失败并指引配置
      throw new MemoryHubError(
        ErrorCodes.STORE_READ_FAILED,
        `encrypted memory store requires a passphrase (config passphrase or DSH_MEMORY_PASSPHRASE): ${filePath}`,
      )
    }
    if (raw !== undefined) store.loadLines(raw)
    // 错口令快速失败：密钥记录头存在 + 存在信封行 + 全部信封认证失败 → 口令错误
    // （GCM 认证对口令确定性：正确口令下不可能全军覆没；部分失败 = 篡改，走损坏行隔离）
    if (keyRecord !== undefined && store.envelopeFail > 0 && store.envelopeOk === 0) {
      throw new MemoryHubError(
        ErrorCodes.STORE_READ_FAILED,
        `wrong passphrase or tampered memory file (all ${store.envelopeFail} encrypted line(s) failed authentication): ${filePath}`,
      )
    }
    store.logger(
      `loaded ${store.entries.size} entries (${store.lines} lines, ${store.skippedCorrupt} corrupt skipped) from ${filePath}`,
    )
    // 1.4.0（模块 I）：明文库原位加密迁移——逐行原序重写为密文（含历史版本与 tombstone，
    // 深回放历史完整保留），失败仅告警（功能不受损：新写加密、旧行明文可混读，下次 compact 收敛）
    if (passphrase !== undefined && passphrase !== '' && keyRecord === undefined && store.lines > 0) {
      await store.encryptInPlace(raw!)
    }
    // 0.4.0：损坏行隔离留证（失败仅告警，不影响加载；计数语义不变）
    await store.backupCorruptLines()
    // 目录权限仅对本插件新建的目录收紧（recursive mkdir 返回首个创建的目录路径；
    // 目录已存在时返回 undefined），既有共享目录保持原权限，避免副效应。
    await store.secure(createdDir !== undefined)
    // 1.1.1：单实例写锁（默认存储路径是用户级共享的 ~/.dsh/memory-hub，两个 dsh 会话
    // = 两个进程同写一个文件；锁失败不禁用插件，仅禁用 compact 并告警）
    await store.acquireLock()
    return store
  }

  /**
   * 1.1.1：单实例写锁。独占创建 `<file>.lock`（内容 = pid）；已存在时探测持有者：
   * 存活 → 告警并禁用 compact（append 继续允许）；陈旧/自身 → 抢占重写。
   * 全程不抛出（锁是最多拥有的优化，不是硬前提）。
   */
  private async acquireLock(): Promise<void> {
    const lockPath = `${this.filePath}.lock`
    try {
      await writeFile(lockPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      this.lockHeld = true
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.compactDenied = true
        this.logger(`lock write failed, compact disabled: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    try {
      const raw = await readFile(lockPath, 'utf8')
      const pid = Number.parseInt(raw.trim(), 10)
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)) {
        this.compactDenied = true
        this.logger(
          `another memory-hub instance (pid ${pid}) holds the store; compact disabled to protect concurrent writes`,
        )
        return
      }
    } catch {
      // 锁文件不可读 → 视为陈旧锁，抢占
    }
    try {
      await writeFile(lockPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 })
      this.lockHeld = true
    } catch (err) {
      this.compactDenied = true
      this.logger(`lock steal failed, compact disabled: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 释放写锁（close 尾部调用；仅释放本进程持有的锁） */
  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) return
    this.lockHeld = false
    try {
      await unlink(`${this.filePath}.lock`)
    } catch {
      // 锁文件已不存在（被清理）——无需处理
    }
  }

  /** 逐行解析：条目行入库、tombstone 行删除、损坏行计数跳过；1.4.0：先经编解码器解码 */
  private loadLines(raw: string): void {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // 密钥记录头行（明文 KDF 参数）：非数据行，跳过不计数
      if (parseKeyRecord(trimmed) !== undefined) continue
      // 1.4.0（模块 I）：加密库先解码（认证失败 = null → 损坏行通道，证据保留）
      let json = trimmed
      if (this.codec.encrypted) {
        const decoded = this.codec.decodeLine(trimmed)
        if (decoded === null) {
          this.lines++
          this.skippedCorrupt++
          if (isEncryptedEnvelope(trimmed)) this.envelopeFail++
          this.corruptLines.push(trimmed)
          continue
        }
        if (isEncryptedEnvelope(trimmed)) this.envelopeOk++
        json = decoded
      }
      this.lines++
      // tombstone 行先识别：{"__tombstone__": "id"}
      try {
        const obj = JSON.parse(json) as Record<string, unknown>
        if (obj && typeof obj === 'object' && typeof obj[TOMBSTONE_KEY] === 'string') {
          this.entries.delete(obj[TOMBSTONE_KEY])
          this.snapshotDirty = true
          continue
        }
      } catch {
        // fallthrough to corrupt counting
      }
      const entry = parseMemoryEntry(json)
      if (entry !== undefined) {
        this.entries.set(entry.id, entry)
        this.snapshotDirty = true
        continue
      }
      this.skippedCorrupt++
      // 0.4.0：保留损坏行原文供隔离备份（审计/数据恢复依据）
      this.corruptLines.push(trimmed)
    }
  }

  /**
   * 损坏行隔离留证（0.4.0 引入，0.9.0 E 修复为**真幂等**）。
   * 读取已有 `<file>.corrupt` 审计集合并按行去重，只追加本次新发现的损坏行——
   * 同一损坏行多次重启只留证一次（此前 appendFile 无保护，行数随重启次数翻倍）。
   * 失败仅告警（保留证据优先，不影响加载）。
   */
  private async backupCorruptLines(): Promise<void> {
    if (this.corruptLines.length === 0) return
    try {
      const existing = new Set<string>()
      try {
        const raw = await readFile(`${this.filePath}.corrupt`, 'utf8')
        for (const line of raw.split('\n')) existing.add(line)
      } catch {
        // ENOENT 或审计文件读取失败 → 视为空审计（仍执行追加，证据优先）
      }
      const fresh = this.corruptLines.filter((l) => !existing.has(l))
      if (fresh.length === 0) return
      await appendFile(`${this.filePath}.corrupt`, `${fresh.join('\n')}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      this.logger(`isolated ${fresh.length} new corrupt line(s) to ${this.filePath}.corrupt`)
    } catch (err) {
      this.logger(`corrupt isolation failed (kept skipping): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 排序快照（0.9.0 O：共享只读引用 + 写时重建）。
   * `list()` 热路径**零拷贝**：直接返回缓存引用（0.8.0 每次 `[...cache]` 全量 O(N) 拷贝，
   * 每捕获/每召回事件都付全表复制成本）。任何写操作置 dirty，下次读取重建**新数组**——
   * copy-on-write 保证外部持有旧引用并修改不影响 store 后续状态；compact/export 等
   * 内部序列化一律发生在新重建数组上（写必先 dirty），不存在把外部污染写盘的可能。
   * 约定：返回的快照数组为共享只读视图，调用方不得修改；需要可变副本时自行拷贝。
   */
  private snapshots(): MemoryEntry[] {
    if (this.snapshotDirty || this.snapshotCache === undefined) {
      this.snapshotCache = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)
      this.snapshotDirty = false
    }
    return this.snapshotCache
  }

  /**
   * 追加原始文本（无换行约定由调用方决定；成功后行数递增）。
   * 1.4.0（模块 I）：加密库写侧收口——首个追加写先落密钥记录头，随后逐行编码为
   * AEAD 信封（appendRaw 收到的是**逻辑行文本**，此处统一转换后落盘）。
   */
  private async appendRaw(text: string): Promise<void> {
    let payload = text
    if (this.codec.encrypted) {
      const body = text
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => this.codec.encodeLine(l))
        .join('\n')
      // 结尾换行必须保留（与明文路径逐字一致）：否则下一次 append 的信封会粘行
      payload = (this.headerWritten ? '' : makeKeyRecord(this.headerSalt ?? randomSalt()) + '\n') + body + '\n'
      this.headerWritten = true
    }
    try {
      // mode 仅在文件**首次创建**时生效（Node appendFile 语义），
      // 保证新文件从一开始就是 0600，而非依赖 umask 默认权限。
      await appendFile(this.filePath, payload, { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      throw new MemoryHubError(ErrorCodes.STORE_WRITE_FAILED, `failed to append memory file: ${this.filePath}`, err)
    }
    this.lines++
  }

  /** 密钥记录头的盐（打开期锚定：密钥派生与首写头必须同盐，缓存免二次派生） */
  private headerSalt: Buffer | undefined

  /** 追加一行（写失败向上抛出；调用方尚未变更内存，无需回滚） */
  private async appendLine(json: string): Promise<void> {
    await this.appendRaw(json + '\n')
  }

  /** compact 判定：冗余行（tombstone/历史覆盖）占比过高时重建 */
  private shouldCompact(): boolean {
    return this.lines >= COMPACT_MIN_LINES && this.lines > this.entries.size * COMPACT_FACTOR
  }

  /**
   * 1.0.0：记录结构性写入新增条目（供 IndexCache 增量构建）——
   * 读取后即失效（返回拷贝，外部修改不影响内部）。每次结构性写入前先清零，
   * 保证快照只反映**最近一次**写入的新增；仅新增场景可增量追加索引，改动/删除走全量重建。
   */
  private trackInserted(fresh: MemoryEntry[]): void {
    this.lastInsertedSnapshot = fresh.map((e) => ({ ...e }))
  }

  /** 最近一次结构性写入新增的条目（读取后内部不清空，但下次写入覆盖） */
  lastInserted(): MemoryEntry[] {
    return this.lastInsertedSnapshot.map((e) => ({ ...e }))
  }

  /**
   * 1.0.0：重建纯条目文件（tmp + rename 原子替换）。
   * 失败仅告警：条目已在上一步落盘，重建是"锦上添花"，绝不能把已成功的写入变成失败。
   * 0.4.0：重建后重读文件自检行数（不一致仅告警，延续容错哲学）。
   * 1.0.0：自检通过后上报回收统计（reclaimed/ratio），供 status/诊断可观测。
   * 1.1.1 两项升级：
   * - **回放式合并**：重建前先重读磁盘文件按行序回放（条目 upsert / tombstone 删除）
   *   得到「磁盘视角」存活集，与本进程内存快照合并——其他进程并发追加的行（内存里没有）
   *   原样保留，其他进程的 tombstone 对本进程仍持有的条目生效（尊重并发删除）。
   *   此前的「本进程快照直接重写」在多进程场景会静默吞噬对方的全部写入。
   * - **fsync 屏障**：tmp 写入后先 `fh.sync()` 再 rename，断电不产生半写文件。
   */
  private async compact(): Promise<void> {
    try {
      // 磁盘视角回放：id → 原始行（保留最新版本）；diskSeen 记录出现过的所有 id
      // （区分「被外部 tombstone 的本地条目」（跳过回填）与「磁盘从未见过」（防御性保留））
      // 1.4.0（模块 I）：加密库读侧先解码为逻辑行再判定（merged 统一持有明文行，写侧统一编码）
      const diskLive = new Map<string, string>()
      const diskSeen = new Set<string>()
      try {
        const raw = await readFile(this.filePath, 'utf8')
        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          // 密钥记录头行：重建时由写侧统一补写，此处跳过
          if (parseKeyRecord(trimmed) !== undefined) continue
          const json = this.codec.decodeLine(trimmed)
          if (json === null) continue
          try {
            const obj = JSON.parse(json) as Record<string, unknown>
            if (typeof obj[TOMBSTONE_KEY] === 'string') {
              diskLive.delete(obj[TOMBSTONE_KEY])
              diskSeen.add(obj[TOMBSTONE_KEY])
            } else if (typeof obj['id'] === 'string') {
              diskLive.set(obj['id'], json)
              diskSeen.add(obj['id'])
            }
          } catch {
            // 损坏行在重建时丢弃（加载时已留证 .corrupt）
          }
        }
      } catch {
        // 磁盘读失败 → 退化为仅本地快照重建（单进程语义与 1.0.0 一致）
      }
      // 合并：磁盘视角为主体，本地快照回填（后写覆盖；外部 tombstone 过的 id 不回填）
      const merged = new Map(diskLive)
      for (const e of this.snapshots()) {
        if (diskSeen.has(e.id) && !diskLive.has(e.id)) continue
        merged.set(e.id, JSON.stringify(e))
      }
      // 写侧统一编码（加密库 = 逐行 AEAD 信封 + 密钥记录头首行；明文库 = 原样透传）
      const outLines = [...merged.values()].map((l) => (this.codec.encrypted ? this.codec.encodeLine(l) : l))
      if (this.codec.encrypted) outLines.unshift(makeKeyRecord(this.headerSalt ?? randomSalt()))
      const body = outLines.join('\n')
      const tmp = `${this.filePath}.${randomUUID()}.tmp`
      await writeFile(tmp, body + (body ? '\n' : ''), { encoding: 'utf8', mode: 0o600 })
      // fsync 屏障：经独立句柄强制落盘后再 rename（断电不产生半写文件）。
      // sync 失败（平台/权限）不阻断 compact——rename 原子性不受影响，仅弱化断电保障。
      try {
        const fh = await open(tmp, 'r+')
        try {
          await fh.sync()
        } finally {
          await fh.close()
        }
      } catch {
        // 保持 compact 的「优化路径失败仅告警不打断」哲学
      }
      await rename(tmp, this.filePath)
      const reclaimed = this.lines - merged.size
      this.lines = merged.size
      this.compactStats = {
        reclaimed: Math.max(0, reclaimed),
        ratio: this.lines > 0 ? Math.min(1, reclaimed / (this.lines + Math.max(0, reclaimed))) : 0,
        atLineCount: merged.size,
        timestamp: Date.now(),
      }
      await this.secure(false)
      // 加密库文件 = 密钥记录头 + N 条目行（自检行数对齐）
      await this.verifyCompact(merged.size + (this.codec.encrypted ? 1 : 0))
    } catch (err) {
      this.logger(`compact failed (kept appended layout): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** compact 自检：重读新文件，行数必须与重建预期一致，不一致仅告警 */
  private async verifyCompact(expected: number): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const actual = raw.split('\n').filter((l) => l.trim()).length
      if (actual !== expected) {
        this.logger(`compact self-check mismatch: file has ${actual} lines, expected ${expected}`)
      }
    } catch (err) {
      // 自检读取失败不抛出（compact 为优化路径；条目已在上一步成功落盘）
      this.logger(`compact self-check read failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 隐私权限：记忆文件始终 0600；目录 0700 **仅对本插件新建的目录**执行
   * （strictDir=false 时跳过，避免收紧用户既有共享目录权限造成副效应）。
   */
  private async secure(strictDir: boolean): Promise<void> {
    if (strictDir) {
      try {
        await chmod(dirname(this.filePath), 0o700)
      } catch {
        // 目录权限设置失败仅告警，不影响读写（如权限受控的场景）
      }
    }
    try {
      await chmod(this.filePath, 0o600)
    } catch {
      // 文件尚不存在时忽略
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(task, task)
    return this.writeChain
  }

  /** 结构性版本号：写链上每次真实变更递增（内容/热度更新都算，语义简单正确） */
  get revision(): number {
    return this.version
  }

  async upsert(entry: MemoryEntry): Promise<MemoryEntry> {
    if (this.closed) throw new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot upsert')
    await this.enqueue(async () => {
      // 先落盘：append 成功才变更内存，读者永远看不到未确认状态
      await this.appendLine(JSON.stringify(entry))
      this.entries.set(entry.id, entry)
      this.snapshotDirty = true
      this.version++
      this.trackInserted([entry])
      await this.compactIfNeeded()
    })
    return entry
  }

  /**
   * 1.0.0：批量写入（热度合并回写等高频小写场景）——单次 appendRaw 落盘多行，
   * 较逐条 upsert 减少 N-1 次系统调用与 N-1 次 revision 递增；语义与 upsert 一致
   * （先落盘后入内存；id 已存在时按后写覆盖）。返回成功写入数。
   */
  async upsertMany(entries: MemoryEntry[]): Promise<number> {
    if (this.closed) throw new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot upsertMany')
    if (!entries.length) return 0
    let written = 0
    await this.enqueue(async () => {
      await this.appendRaw(entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
      for (const e of entries) this.entries.set(e.id, e)
      this.snapshotDirty = true
      this.version++
      written = entries.length
      this.trackInserted(entries)
      await this.compactIfNeeded()
    })
    return written
  }

  /** compact 触发（写成功后调用；失败的 compact 只告警；1.1.1：锁被并发实例持有时禁用） */
  private async compactIfNeeded(): Promise<void> {
    if (this.compactDenied) return
    if (this.shouldCompact()) await this.compact()
  }

  async remove(id: string): Promise<boolean> {
    return this.removeMany([id]).then((n) => n > 0)
  }

  async removeMany(ids: string[], now: number = Date.now()): Promise<number> {
    if (this.closed) throw new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot remove')
    let removed = 0
    await this.enqueue(async () => {
      // 先落盘：tombstone 行 append 成功后才从内存删除。
      // 1.3.0（模块 G）：tombstone 行携带删除时刻 at——情景回放（replayAsOf）据此判定
      // 「asOf 时刻是否已删除」；旧格式（无 at）回放侧保守视为任意时刻已删除。
      const targets = ids.filter((id) => this.entries.has(id))
      if (!targets.length) return
      await this.appendRaw(
        targets.map((id) => JSON.stringify({ [TOMBSTONE_KEY]: id, [TOMBSTONE_AT_KEY]: now })).join('\n') + '\n',
      )
      for (const id of targets) this.entries.delete(id)
      this.snapshotDirty = true
      this.version++
      removed = targets.length
      await this.compactIfNeeded()
    })
    return removed
  }

  list(): Promise<MemoryEntry[]> {
    return Promise.resolve(this.snapshots())
  }

  /**
   * 1.3.0（DESIGN-1.3 模块 G）：情景回放——返回 asOf 时刻的存活条目集。
   * 每次调用重读磁盘文件按行序回放（不占用内存快照/写链，read-only）：
   * - 与 list() 的关系：asOf ≥ 全部写入时刻时二者一致（除排序外逐项相等）；
   * - 并发追加安全：readFile 是文件快照，回放期间的在途写入下次调用可见；
   * - compact 边界：compact 清除历史行后深回放精度降级（存在性仍正确——被删除条目
   *   的最新行同样被清除；但内容版本与删除时刻不可再回溯），见 replayAsOf 文档。
   */
  async listAsOf(asOf: number): Promise<MemoryEntry[]> {
    if (this.closed) throw new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot replay')
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new MemoryHubError(ErrorCodes.STORE_READ_FAILED, `failed to read memory file: ${this.filePath}`, err)
    }
    // 1.4.0（模块 I）：加密库先整文件解码为逻辑行（replayAsOf 消费明文 JSONL，
    // 深回放语义与明文库逐项一致；解码失败行直接丢弃——加载期已留证且错口令已快速失败）
    if (this.codec.encrypted) {
      const decoded: string[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (parseKeyRecord(trimmed) !== undefined) continue
        const json = this.codec.decodeLine(trimmed)
        if (json !== null) decoded.push(json)
      }
      raw = decoded.join('\n')
    }
    const { entries, skippedCorrupt } = replayAsOf(raw, asOf)
    if (skippedCorrupt > 0) {
      this.logger(`asOf replay skipped ${skippedCorrupt} corrupt line(s) from ${this.filePath}`)
    }
    return entries
  }

  /**
   * 1.5.0（DESIGN-1.5 模块 O）：记忆时间轴（只读、不占写链）。
   * 重读磁盘文件按行序回放（与 listAsOf 同解码纪律：加密库先整文件解码为逻辑行，
   * 解码失败行丢弃——加载期已留证且错口令已快速失败），交给 timelineFromRaw 分桶。
   */
  async timeline(cap = 31): Promise<MemoryTimeline> {
    if (this.closed) throw new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot build timeline')
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { firstAt: 0, lastAt: 0, events: 0, truncated: false, buckets: [] }
      }
      throw new MemoryHubError(ErrorCodes.STORE_READ_FAILED, `failed to read memory file: ${this.filePath}`, err)
    }
    if (this.codec.encrypted) {
      const decoded: string[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (parseKeyRecord(trimmed) !== undefined) continue
        const json = this.codec.decodeLine(trimmed)
        if (json !== null) decoded.push(json)
      }
      raw = decoded.join('\n')
    }
    return timelineFromRaw(raw, cap)
  }

  /**
   * 1.4.0（DESIGN-1.4 模块 I）：明文库原位加密迁移——逐行**原序**重写为密文信封。
   * 与 compact 的关键差异：不合并、不去重、不丢 tombstone/历史版本行——append-only
   * 日志的深回放历史（replayAsOf 依赖的行序与旧版本行）逐行完整保留，仅「外衣」
   * 从明文换为密文。损坏行同样原样加密（下次加载解密后再按损坏行隔离留证）。
   * tmp + fsync + rename 原子替换（与 compact 同屏障）；失败仅告警（混合态可正常
   * 读写：解码器对非信封行明文透传），下次 compact 自然收敛为全密文。
   */
  private async encryptInPlace(raw: string): Promise<void> {
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const outLines: string[] = [makeKeyRecord(this.headerSalt ?? randomSalt())]
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (parseKeyRecord(trimmed) !== undefined) continue
        const json = this.codec.decodeLine(trimmed)
        outLines.push(this.codec.encodeLine(json === null ? trimmed : json))
      }
      await writeFile(tmp, outLines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
      try {
        const fh = await open(tmp, 'r+')
        try {
          await fh.sync()
        } finally {
          await fh.close()
        }
      } catch {
        // 与 compact 同哲学：fsync 失败不阻断（rename 原子性不受影响）
      }
      await rename(tmp, this.filePath)
      this.headerWritten = true
      this.logger(`encrypted ${outLines.length - 1} line(s) in place (append-only history preserved)`)
    } catch (err) {
      try {
        await unlink(tmp)
      } catch {
        // tmp 清理失败无需处理（uuid 后缀不冲突）
      }
      this.logger(
        `in-place encryption failed (mixed plaintext/ciphertext remains readable; compact will converge): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /**
   * 1.5.0（DESIGN-1.5 模块 K）：口令轮换与解密回退。
   *
   * - 加密库 → 新口令：全文件逐行**原序**重加密（新盐 + 新派生密钥；等价于一次密钥
   *   卫生轮换——同一口令重复轮换也换新盐）；
   * - 加密库 → 空口令：解密回退为明文库（信封剥除，密钥记录头不再写出）；
   * - 明文库 → 新口令：等价原位加密迁移（与 open 期迁移同一语义，供运行期启用）；
   * - 明文库 → 空口令：no-op（目标态与现状一致，免无谓重写）。
   *
   * 与 encryptInPlace 同纪律：不合并、不去重、不丢 tombstone/历史版本/损坏行——
   * append-only 深回放历史逐行保留，仅「密钥外衣」更换；tmp + fsync + rename 原子替换，
   * 失败抛出且**文件保持原状**（编解码器状态只在 rename 成功后切换）。
   * 多进程护栏：整文件重写与 compact 同级风险，写锁被其他存活实例持有时拒绝执行。
   */
  async changePassphrase(newPassphrase: string): Promise<void> {
    if (this.closed) throw new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot change passphrase')
    if (this.compactDenied) {
      throw new MemoryHubError(
        ErrorCodes.STORE_WRITE_FAILED,
        'passphrase rotation requires the exclusive write lock (another memory-hub instance holds the store)',
      )
    }
    try {
      await this.rotatePassphraseTask(newPassphrase)
    } catch (err) {
      // 失败不毒化写链（契约：库保持原口令/原形态可用——后续写入与 close 不受影响；
      // catch 派生的新尾保持与任何并发入队任务的次序）
      this.writeChain = this.writeChain.catch(() => {})
      throw err
    }
  }

  private async rotatePassphraseTask(newPassphrase: string): Promise<void> {
    await this.enqueue(async () => {
      const nextEncrypted = newPassphrase !== ''
      if (!this.codec.encrypted && !nextEncrypted) return // 明文→明文 no-op
      const salt = nextEncrypted ? randomSalt() : undefined
      const nextCodec = nextEncrypted ? createEncryptedCodec(deriveKey(newPassphrase, salt!)) : plainCodec
      let raw: string | undefined
      try {
        raw = await readFile(this.filePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new MemoryHubError(
            ErrorCodes.STORE_READ_FAILED,
            `failed to read memory file for passphrase rotation: ${this.filePath}`,
            err,
          )
        }
      }
      if (raw !== undefined) {
        // 逐行原序重写：旧编解码器解码（含历史版本/tombstone/损坏行）→ 新编解码器编码
        const outLines: string[] = nextEncrypted ? [makeKeyRecord(salt!)] : []
        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (parseKeyRecord(trimmed) !== undefined) continue
          const json = this.codec.decodeLine(trimmed)
          outLines.push(nextCodec.encodeLine(json === null ? trimmed : json))
        }
        const tmp = `${this.filePath}.${randomUUID()}.tmp`
        try {
          await writeFile(tmp, outLines.join('\n') + (outLines.length > 0 ? '\n' : ''), {
            encoding: 'utf8',
            mode: 0o600,
          })
          try {
            const fh = await open(tmp, 'r+')
            try {
              await fh.sync()
            } finally {
              await fh.close()
            }
          } catch {
            // fsync 失败不阻断 rename 原子性（与 compact/encryptInPlace 同哲学）
          }
          await rename(tmp, this.filePath)
        } catch (err) {
          try {
            await unlink(tmp)
          } catch {
            // tmp 清理失败无需处理（uuid 后缀不冲突）
          }
          throw new MemoryHubError(
            ErrorCodes.STORE_WRITE_FAILED,
            `passphrase rotation failed (file unchanged): ${this.filePath}`,
            err,
          )
        }
        await this.secure(false)
        this.logger(
          `passphrase rotated: ${this.codec.encrypted ? 'encrypted' : 'plaintext'} → ${
            nextEncrypted ? 'encrypted' : 'plaintext'
          } (${outLines.length - (nextEncrypted ? 1 : 0)} line(s) rewritten in order)`,
        )
      } else {
        this.logger('passphrase armed on empty store (codec switched; header lands on first append)')
      }
      // rename 成功后才切换运行态（失败路径下编解码器与磁盘文件保持一致）；
      // 空库特例：头尚未落盘，headerWritten 保持 false（首个追加写时补写密钥记录头）
      this.codec = nextCodec
      this.headerSalt = salt
      this.headerWritten = nextEncrypted && raw !== undefined
    })
  }

  get(id: string): Promise<MemoryEntry | undefined> {
    const entry = this.entries.get(id)
    return Promise.resolve(entry ? { ...entry } : undefined)
  }

  async importAll(entries: MemoryEntry[]): Promise<number> {
    if (this.closed) throw new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot import')
    let added = 0
    await this.enqueue(async () => {
      const fresh = entries.filter((e) => !this.entries.has(e.id))
      if (!fresh.length) return
      // 先落盘：整批 append 成功后才合并内存
      await this.appendRaw(fresh.map((e) => JSON.stringify(e)).join('\n') + '\n')
      for (const e of fresh) this.entries.set(e.id, e)
      this.snapshotDirty = true
      this.version++
      added = fresh.length
      this.trackInserted(fresh)
      await this.compactIfNeeded()
    })
    return added
  }

  /**
   * 全量导出为 JSON 数组字符串（CM 序列化排序快照；无 IO 写入主文件）。
   * 与 `importAll` 组成迁移闭环：`JSON.parse(exportAll())` 可直接喂给新实例 importAll。
   */
  exportAll(): Promise<string> {
    if (this.closed) return Promise.reject(new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot export'))
    return Promise.resolve(JSON.stringify(this.snapshots()))
  }

  async close(): Promise<void> {
    this.closed = true
    await this.writeChain
    // 1.1.1：写链排空后释放单实例锁（陈旧锁由后来者的 pid 存活探测兜底）
    await this.releaseLock()
  }

  get size(): number {
    return this.entries.size
  }

  /** 诊断信息（可观测性）；1.0.0 增加 compact 回收统计；1.4.0 增加 encrypted 形态（仅加密库输出，缺省键缺席 = 明文库零字节变化） */
  get diagnostics(): {
    lines: number
    corrupt: number
    encrypted?: boolean
    compact?: { reclaimed: number; ratio: number; at: number }
  } {
    const out: {
      lines: number
      corrupt: number
      encrypted?: boolean
      compact?: { reclaimed: number; ratio: number; at: number }
    } = {
      lines: this.lines,
      corrupt: this.skippedCorrupt,
    }
    if (this.codec.encrypted) out.encrypted = true
    if (this.compactStats.timestamp > 0) {
      out.compact = {
        reclaimed: this.compactStats.reclaimed,
        ratio: this.compactStats.ratio,
        at: this.compactStats.atLineCount,
      }
    }
    return out
  }
}
