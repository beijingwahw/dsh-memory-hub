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
 * - compact 自检：重建后重读新文件核对行数，不一致仅告警（延续"成功写入不因优化失败"哲学）；
 * - `exportAll`：全量导出为 JSON 数组字符串，与 `importAll` 组成跨设备迁移闭环。
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ErrorCodes, MemoryHubError } from '../errors'
import { parseMemoryEntry, type MemoryEntry, type MemoryStore } from './types'

/** 生成短哈希 id：内容 + 盐 + 时间，保证幂等去重用内容哈希、唯一性用完整 id */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** tombstone 行标记：删除不再重写历史行，由 compact 清除 */
const TOMBSTONE_KEY = '__tombstone__'

/** compact 阈值：文件行数超过「条目数 ×2 且 ≥64」时重建，避免频繁重写 */
export const COMPACT_FACTOR = 2
export const COMPACT_MIN_LINES = 64

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

  constructor(
    private readonly filePath: string,
    private readonly logger: (msg: string) => void = () => {},
  ) {}

  /** 从磁盘加载（兼容 0.1.0 整条目行格式与 0.2.0 tombstone 行格式） */
  static async open(filePath: string, logger?: (msg: string) => void): Promise<JsonlMemoryStore> {
    const store = new JsonlMemoryStore(filePath, logger)
    const dir = dirname(filePath)
    let createdDir: string | undefined
    try {
      createdDir = await mkdir(dir, { recursive: true })
    } catch (err) {
      throw new MemoryHubError(ErrorCodes.STORE_WRITE_FAILED, `failed to create storage directory: ${dir}`, err)
    }
    try {
      const raw = await readFile(filePath, 'utf8')
      store.loadLines(raw)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new MemoryHubError(ErrorCodes.STORE_READ_FAILED, `failed to read memory file: ${filePath}`, err)
      }
    }
    store.logger(
      `loaded ${store.entries.size} entries (${store.lines} lines, ${store.skippedCorrupt} corrupt skipped) from ${filePath}`,
    )
    // 0.4.0：损坏行隔离留证（失败仅告警，不影响加载；计数语义不变）
    await store.backupCorruptLines()
    // 目录权限仅对本插件新建的目录收紧（recursive mkdir 返回首个创建的目录路径；
    // 目录已存在时返回 undefined），既有共享目录保持原权限，避免副效应。
    await store.secure(createdDir !== undefined)
    return store
  }

  /** 逐行解析：条目行入库、tombstone 行删除、损坏行计数跳过 */
  private loadLines(raw: string): void {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.lines++
      // tombstone 行先识别：{"__tombstone__": "id"}
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>
        if (obj && typeof obj === 'object' && typeof obj[TOMBSTONE_KEY] === 'string') {
          this.entries.delete(obj[TOMBSTONE_KEY])
          this.snapshotDirty = true
          continue
        }
      } catch {
        // fallthrough to corrupt counting
      }
      const entry = parseMemoryEntry(trimmed)
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

  /** 追加原始文本（无换行约定由调用方决定；成功后行数递增） */
  private async appendRaw(text: string): Promise<void> {
    try {
      // mode 仅在文件**首次创建**时生效（Node appendFile 语义），
      // 保证新文件从一开始就是 0600，而非依赖 umask 默认权限。
      await appendFile(this.filePath, text, { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      throw new MemoryHubError(ErrorCodes.STORE_WRITE_FAILED, `failed to append memory file: ${this.filePath}`, err)
    }
    this.lines++
  }

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
   */
  private async compact(): Promise<void> {
    try {
      const tmp = `${this.filePath}.${randomUUID()}.tmp`
      const body = this.snapshots()
        .map((e) => JSON.stringify(e))
        .join('\n')
      await writeFile(tmp, body + (body ? '\n' : ''), { mode: 0o600 })
      await rename(tmp, this.filePath)
      const reclaimed = this.lines - this.entries.size
      this.lines = this.entries.size
      this.compactStats = {
        reclaimed: Math.max(0, reclaimed),
        ratio: this.lines > 0 ? Math.min(1, reclaimed / (this.lines + Math.max(0, reclaimed))) : 0,
        atLineCount: this.entries.size,
        timestamp: Date.now(),
      }
      await this.secure(false)
      await this.verifyCompact()
    } catch (err) {
      this.logger(`compact failed (kept appended layout): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** compact 自检：重读新文件，行数必须与内存条目数一致，不一致仅告警 */
  private async verifyCompact(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const actual = raw.split('\n').filter((l) => l.trim()).length
      if (actual !== this.entries.size) {
        this.logger(`compact self-check mismatch: file has ${actual} lines, expected ${this.entries.size}`)
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

  /** compact 触发（写成功后调用；失败的 compact 只告警） */
  private async compactIfNeeded(): Promise<void> {
    if (this.shouldCompact()) await this.compact()
  }

  async remove(id: string): Promise<boolean> {
    return this.removeMany([id]).then((n) => n > 0)
  }

  async removeMany(ids: string[]): Promise<number> {
    if (this.closed) throw new MemoryHubError(ErrorCodes.STORE_CLOSED, 'store closed: cannot remove')
    let removed = 0
    await this.enqueue(async () => {
      // 先落盘：tombstone 行 append 成功后才从内存删除
      const targets = ids.filter((id) => this.entries.has(id))
      if (!targets.length) return
      await this.appendRaw(targets.map((id) => JSON.stringify({ [TOMBSTONE_KEY]: id })).join('\n') + '\n')
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
  }

  get size(): number {
    return this.entries.size
  }

  /** 诊断信息（可观测性）；1.0.0 增加 compact 回收统计 */
  get diagnostics(): { lines: number; corrupt: number; compact?: { reclaimed: number; ratio: number; at: number } } {
    const out: { lines: number; corrupt: number; compact?: { reclaimed: number; ratio: number; at: number } } = {
      lines: this.lines,
      corrupt: this.skippedCorrupt,
    }
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
