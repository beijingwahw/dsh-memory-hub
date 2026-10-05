/**
 * dsh-memory-hub 插件入口
 *
 * 加载后自动：
 * 1. 打开/创建 JSONL 记忆库（~/.dsh/memory-hub/memories.jsonl，可配置）；
 * 2. 注册 4 个工具：memory_store / memory_recall / memory_forget / memory_status；
 * 3. 基于事件溯源（session/event 火线 + tools/result 管线）做保守自动捕获；
 * 4. 按 TTL 定期清理过期记忆（可配置）。
 *
 * 全部捕获经串行队列处理（FIFO promise 链，失败不阻断后续），
 * 所有注册的监听器、定时器与存储句柄都以插件 effect 形式返回，随插件卸载自动释放。
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MemoryHubConfigSchema, normalizeConfig, type MemoryHubConfig } from './config'
import { runCognitiveMaintenance } from './memory/cognitive'
import { TemporalGraph } from './memory/graph'
import { JsonlMemoryStore } from './memory/store'
import { pruneExpired, summarize, evictLowestValue } from './memory/engine'
import { planImport } from './memory/importer'
import { ingestCaptured } from './memory/ingest'
import { extractTextBlocks } from './memory/text'
import { extractFromAssistant, extractFromToolResult, extractFromUserMessage } from './memory/capture'
import { createMetrics, formatMetrics } from './memory/metrics'
import { errorMessage } from './errors'
import { createMemoryRecallTool } from './tools/memory-recall'
import { createMemoryStoreTool } from './tools/memory-store'
import { createMemoryForgetTool } from './tools/memory-forget'
import { createMemoryStatusTool } from './tools/memory-status'

export const name = 'dsh-memory-hub'
export const inject = ['tools']
export const Config = MemoryHubConfigSchema

export function apply(ctx: Context, config: Partial<MemoryHubConfig> = {}) {
  const cfg = normalizeConfig(config)
  const log = ctx.logger('dsh-memory-hub')
  const metrics = createMetrics()
  const logger = (msg: string) => log.info(msg)

  const storageDir = cfg.storageDir || join(homedir(), '.dsh', 'memory-hub')
  const filePath = join(storageDir, 'memories.jsonl')

  const storeP = JsonlMemoryStore.open(filePath, (m) => log.info(m))

  // 1.1.0（DESIGN-1.1 模块 C）：时序知识图谱运行时——仅 graphEnabled 显式开启时构建
  // （缺省 false 不构建，四工具无图行为与 1.0.0 逐字节一致，G10/G11）
  const graph = cfg.graphEnabled ? new TemporalGraph(cfg.graphMaxEntities) : undefined

  async function fileBytes(): Promise<number> {
    try {
      const s = await stat(filePath)
      return s.size
    } catch {
      return 0
    }
  }

  // 工具注册（store 就绪后逐个独立注册，一个失败不阻断其余）
  const toolDisposers: Array<() => void> = []
  storeP
    .then((store) => {
      const registrations: Array<() => () => void> = [
        () =>
          ctx.tools.register(
            createMemoryStoreTool(store, cfg.maxEntryChars, logger, metrics, {
              dedupWindowMs: cfg.dedupWindowMs,
              supersedeMode: cfg.supersedeMode,
              // 1.1.0（模块 D1）：矛盾共存显式写入路径（默认 off，与自动捕获同一判定级联）
              conflictMode: cfg.conflictMode,
              ...(graph ? { graph } : {}),
            }),
          ),
        () =>
          ctx.tools.register(
            createMemoryRecallTool(
              store,
              cfg.defaultRecallTokens,
              cfg.defaultRecallLimit,
              logger,
              metrics,
              // 0.9.0：双尺度时间语义——recallDecayHalfLifeDays=0（默认）关闭评分衰减，
              // 长期记忆按「永不过期」真正可召回；>0 恢复按天指数冷却（半衰期可调）
              cfg.recallDecayHalfLifeDays > 0
                ? { decayHalfLifeMs: cfg.recallDecayHalfLifeDays * 24 * 60 * 60 * 1000 }
                : { decay: false },
              // 1.0.0（模块 B2）：融合模式与语义叠加由 config 注入（默认 interpolate/off = 0.10.0 语义）
              { fusionMode: cfg.fusionMode, semanticBoost: cfg.semanticBoost },
              // 1.1.0（模块 C2）：图谱第四召回线运行时注入（graphEnabled 开启时；否则不生效）
              graph,
            ),
          ),
        () => ctx.tools.register(createMemoryForgetTool(store, logger, metrics, graph ?? undefined)),
        () =>
          ctx.tools.register(
            createMemoryStatusTool(store, fileBytes, logger, metrics, {
              themesDefault: cfg.themes,
              // 1.1.0（模块 B3/C4）：巩固状态与图谱可观测（仅 auto/开启时输出，缺省零行为变化）
              ...(cfg.consolidationMode === 'auto' ? { consolidationMode: cfg.consolidationMode as 'auto' } : {}),
              ...(cfg.recallThreshold !== undefined ? { recallThreshold: cfg.recallThreshold } : {}),
              ...(graph ? { graph } : {}),
            }),
          ),
      ]
      for (const setup of registrations) {
        try {
          const disposer = setup()
          if (typeof disposer === 'function') toolDisposers.push(disposer)
        } catch (err) {
          metrics.errors++
          log.warn('tool registration failed: %s', errorMessage(err))
        }
      }
      log.info('memory tools registered (%d)', toolDisposers.length)
    })
    .catch((err: unknown) => {
      metrics.errors++
      log.warn('store open failed: %s', errorMessage(err))
    })

  // 启动清理（共用 pruneOnce）
  void pruneOnce('startup')

  // 0.6.0：真实数据启动导入（可选配置；逐个源容错，失败仅告警，绝不阻断插件启动）
  async function importSources(): Promise<void> {
    const sources = cfg.importSources
    const docs = sources?.documents ?? []
    const logs = sources?.sessionLogs ?? []
    if (docs.length === 0 && logs.length === 0) return
    // 1.0.0（UF-1.0）：导入前读当前库内容做库内去重（跨 id 前缀互认，疑点 7 闭环）
    const existing = await storeP.then((store) => store.list())
    for (const path of docs) {
      try {
        const text = await readFile(path, 'utf8')
        const plan = planImport({
          documents: [{ label: path, text }],
          options: { now: Date.now(), maxChars: cfg.maxEntryChars },
          existing,
        })
        const added = await storeP.then((store) => store.importAll(plan.entries))
        // 1.1.0（模块 C2）：importer 路径图谱同步——实际新增条目进运行时图（首启动时图为空）
        if (graph && added > 0) {
          for (const e of plan.entries) graph.add(e)
        }
        log.info(
          'imported %d memory(ies) from %s (%d planned, %d short, %d sensitive, %d duplicate dropped)',
          added,
          path,
          plan.stats.imported,
          plan.stats.droppedShort,
          plan.stats.droppedSensitive,
          plan.stats.droppedDuplicate,
        )
      } catch (err) {
        metrics.errors++
        log.warn('document import failed (%s): %s', path, errorMessage(err))
      }
    }
    for (const path of logs) {
      try {
        const raw = await readFile(path, 'utf8')
        const plan = planImport({
          sessions: [{ label: path, lines: raw.split('\n') }],
          options: { now: Date.now(), maxChars: cfg.maxEntryChars },
          existing,
        })
        const added = await storeP.then((store) => store.importAll(plan.entries))
        // 1.1.0（模块 C2）：importer 路径图谱同步
        if (graph && added > 0) {
          for (const e of plan.entries) graph.add(e)
        }
        log.info(
          'imported %d memory(ies) from session log %s (%d planned, %d corrupt, %d sensitive, %d duplicate dropped)',
          added,
          path,
          plan.stats.imported,
          plan.stats.corruptLines,
          plan.stats.droppedSensitive,
          plan.stats.droppedDuplicate,
        )
      } catch (err) {
        metrics.errors++
        log.warn('session log import failed (%s): %s', path, errorMessage(err))
      }
    }
  }
  void importSources()

  async function pruneOnce(scope: 'startup' | 'periodic'): Promise<void> {
    try {
      const store = await storeP
      const all = await store.list()
      let removed = 0
      if (cfg.ttlDays > 0) {
        const expired = pruneExpired(all, cfg.ttlDays)
        if (expired.length) {
          // 批量删除：单次落盘 tombstone 批次 + 单次 compact 判定（接口兼容回退逐个删）
          if (typeof store.removeMany === 'function') {
            removed = await store.removeMany(expired.map((e) => e.id))
          } else {
            for (const e of expired) if (await store.remove(e.id)) removed++
          }
          metrics.pruned += removed
          if (removed > 0) logger(`pruned ${removed} expired memories (${scope})`)
        }
      }
      // 1.0.0（模块 A3）：价值感知自动淘汰（仅 autoEvict 显式开启且超限时生效；instruction 永不淘汰）
      if (cfg.autoEvict && cfg.maxEntries > 0) {
        const victimIds = evictLowestValue(all, cfg.maxEntries)
        if (victimIds.length > 0) {
          let evicted = 0
          if (typeof store.removeMany === 'function') {
            evicted = await store.removeMany(victimIds)
          } else {
            for (const id of victimIds) if (await store.remove(id)) evicted++
          }
          metrics.pruned += evicted
          logger(`evicted ${evicted} lowest-value memories (${scope}, max=${cfg.maxEntries})`)
        }
      }
    } catch (err) {
      metrics.errors++
      log.warn('prune failed (%s): %s', scope, errorMessage(err))
    }
  }

  const disposers: Array<() => void> = []

  // 1.1.0（DESIGN-1.1 模块 E）：空闲认知维护批处理——蒸馏/巩固的调度入口。
  // 只在 auto 模式运行（默认 off 零行为变化 G11）；失败仅告警+计数，绝不阻断主链路；
  // 幂等可重入（蒸馏 id 确定性 + 已存在跳过；巩固仅更新访问历史）。
  async function runIdleMaintenance(scope: 'idle' | 'dispose'): Promise<void> {
    if (cfg.distillMode !== 'auto' && cfg.consolidationMode !== 'auto') return
    try {
      const store = await storeP
      const r = await runCognitiveMaintenance(
        store,
        {
          distillMode: cfg.distillMode,
          distillMinCluster: cfg.distillMinCluster,
          consolidationMode: cfg.consolidationMode,
          recallThreshold: cfg.recallThreshold,
          maxEntryChars: cfg.maxEntryChars,
        },
        metrics,
        graph,
      )
      if (r.distilled > 0 || r.consolidated > 0) {
        log.info('cognitive maintenance (%s): distilled=%d consolidated=%d', scope, r.distilled, r.consolidated)
      }
    } catch (err) {
      metrics.errors++
      log.warn('cognitive maintenance failed (%s): %s', scope, errorMessage(err))
    }
  }

  // -------------------------------------------------------------------------
  // 自动捕获：有界串行队列（FIFO promise 链 + 背压上限）
  // 密集事件不并发风暴；超过队列深度上限时丢弃最早期任务并计数（保护内存有界）。
  // -------------------------------------------------------------------------
  const MAX_PENDING_CAPTURES = 256
  let pendingCaptures = 0
  let captureChain: Promise<void> = Promise.resolve()

  /** 入队一次捕获任务；任务自身异常由链尾统一记录，失败不阻断后续任务 */
  function enqueueCapture(task: () => Promise<void>): void {
    if (pendingCaptures >= MAX_PENDING_CAPTURES) {
      metrics.dropped++
      log.warn('capture queue full (%d), dropping event', metrics.dropped)
      return
    }
    pendingCaptures++
    captureChain = captureChain
      .then(task)
      .catch((err: unknown) => {
        metrics.errors++
        log.warn('capture failed: %s', errorMessage(err))
      })
      .finally(() => {
        pendingCaptures--
      })
  }

  if (cfg.captureMode !== 'off') {
    // session/event 火线：用户消息 → 偏好/指令；激进模式 → 助手摘要
    disposers.push(
      ctx.on('session/event', (session: Session, event: SessionEvent) => {
        enqueueCapture(async () => {
          const store = await storeP
          const workspace = session.header.cwd
          if (event.type === 'user/message') {
            const src = event.data.source
            // 只捕获真实用户输入，跳过插件注入/子代理上下文等合成消息
            if (typeof src !== 'object' || src === null || src.kind !== 'user') return
            const text = extractTextBlocks(event.data.content)
            if (!text) return
            await ingestCaptured(
              store,
              extractFromUserMessage(text, cfg.captureMode, cfg.autoTags),
              {
                maxEntryChars: cfg.maxEntryChars,
                dedupWindowMs: cfg.dedupWindowMs,
                supersedeMode: cfg.supersedeMode,
                // 1.1.0（模块 D1）：矛盾共存识别（默认 off = 1.0.0 行为）
                ...(cfg.conflictMode === 'auto' ? { conflictMode: cfg.conflictMode } : {}),
              },
              metrics,
              workspace,
              graph,
            )
          } else if (event.type === 'assistant/message' && cfg.captureMode === 'aggressive') {
            const text = extractTextBlocks(event.data.message.content)
            if (!text) return
            // 助手消息用助手提取器（结论/摘要信号），与工具结果语义不同
            await ingestCaptured(
              store,
              extractFromAssistant(text, 'aggressive', cfg.autoTags),
              {
                maxEntryChars: cfg.maxEntryChars,
                dedupWindowMs: cfg.dedupWindowMs,
                supersedeMode: cfg.supersedeMode,
                // 1.1.0（模块 D1）：矛盾共存识别（默认 off = 1.0.0 行为）
                ...(cfg.conflictMode === 'auto' ? { conflictMode: cfg.conflictMode } : {}),
              },
              metrics,
              workspace,
              graph,
            )
          }
          // 'tool/result' 由 tools/result 事件统一处理，避免双写
        })
      }),
    )

    // tools/result 管线：工具成功执行 → 事实类记忆
    disposers.push(
      ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
        enqueueCapture(async () => {
          if (exec.name.startsWith('memory_')) return // 不记忆记忆工具自身的输出
          if (result.isError) return // 不把瞬时失败写成长期记忆
          const text = extractTextBlocks(result.content)
          if (!text) return
          const store = await storeP
          // 0.9.0：工具结果按 Agent 会话 cwd 溯源 workspace（exec.agent.session.header.cwd），
          // 修复「工具结果类记忆永远无 workspace」——多项目环境隔离链路完整；
          // agent 缺省（如裸工具调用）时回落 undefined = 全局共享记忆（与统一隔离语义一致）
          const workspace = exec.agent?.session?.header?.cwd
          await ingestCaptured(
            store,
            extractFromToolResult(exec.name, text, cfg.captureMode, cfg.autoTags),
            {
              maxEntryChars: cfg.maxEntryChars,
              dedupWindowMs: cfg.dedupWindowMs,
              supersedeMode: cfg.supersedeMode,
              // 1.1.0（模块 D1）：矛盾共存识别（默认 off = 1.0.0 行为）
              ...(cfg.conflictMode === 'auto' ? { conflictMode: cfg.conflictMode } : {}),
            },
            metrics,
            workspace,
            graph,
          )
        })
      }),
    )
  }

  // TTL 定期清理
  let timer: ReturnType<typeof setInterval> | undefined
  if (cfg.ttlDays > 0) {
    timer = setInterval(() => void pruneOnce('periodic'), 6 * 60 * 60 * 1000)
  }

  storeP
    .then(async (store) => {
      const stats = summarize(await store.list(), await fileBytes())
      log.info(
        'dsh-memory-hub ready (storage: %s, capture: %s, entries: %d, lines: %d, corrupt: %d)',
        storageDir,
        cfg.captureMode,
        stats.total,
        store.diagnostics.lines,
        store.diagnostics.corrupt,
      )
      // 1.1.0（模块 E）：启动空闲维护——库就绪后排队一次蒸馏/巩固批处理
      // （仅 auto 模式激活；低优先级异步执行，不阻塞就绪与后续事件处理）
      void runIdleMaintenance('idle')
    })
    .catch((err: unknown) => {
      metrics.errors++
      log.warn('store init failed: %s', errorMessage(err))
    })

  // 插件卸载：先停定时器与监听，再等待捕获队列排空（捕获栅栏），最后关闭存储句柄
  return async () => {
    if (timer) clearInterval(timer)
    for (const d of disposers) d()
    for (const d of toolDisposers) d()
    // 0.9.0：捕获栅栏（D 薄弱项）——等在途捕获全部结算后再 close，
    // 杜绝事件风暴后卸载时 in-flight 任务撞已关闭 store 的丢写竞态与 errors 虚增。
    // captureChain 链尾自带 catch（错误已计 metrics.errors + 日志），await 不 reject。
    await captureChain
    // 1.1.0（模块 E）：卸载栅栏维护——在途捕获结算后再跑一次蒸馏/巩固批处理
    // （仅 auto 模式；幂等幂等重入与自身容错，绝不阻塞 close；成功与否均继续卸载）
    await runIdleMaintenance('dispose')
    try {
      const store = await storeP
      await store.close()
    } catch (err) {
      metrics.errors++
      log.warn('store close failed: %s', errorMessage(err))
    }
    log.info('dsh-memory-hub disposed (%s)', formatMetrics(metrics))
  }
}
