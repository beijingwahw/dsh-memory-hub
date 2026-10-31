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

  // 1.4.0（DESIGN-1.4 模块 I）：会话级加密口令——config 显式传入优先，
  // 其次 DSH_MEMORY_PASSPHRASE 环境变量（推荐：口令不落配置文件）；
  // 空缺省 = 明文存储（与 1.3.0 逐字节一致）。加密库漏配口令时 open 显式失败
  //（绝不把密文行当损坏行静默清空），storeP catch 记日志、工具不注册——行为显式可诊断。
  const passphrase = cfg.passphrase || process.env['DSH_MEMORY_PASSPHRASE'] || ''
  const storeP = JsonlMemoryStore.open(
    filePath,
    (m) => log.info(m),
    passphrase !== '' ? { passphrase } : undefined,
  ).then(async (store) => {
    // 1.5.0（DESIGN-1.5 模块 K）：启动期口令轮换——DSH_MEMORY_NEW_PASSPHRASE 定义且
    // 不等于当前有效口令时触发一次 changePassphrase（非空 = 换新口令/启用加密；
    // 空串 = 解密回退为明文库）。逐行原序重写，深回放历史完整保留；失败仅告警
    // 不阻断启动（库保持原口令/原形态可用，改完口令后应移除该环境变量）。
    const nextPw = process.env['DSH_MEMORY_NEW_PASSPHRASE']
    if (nextPw !== undefined && nextPw !== passphrase) {
      try {
        await store.changePassphrase(nextPw)
        log.info(
          'memory store passphrase rotated via DSH_MEMORY_NEW_PASSPHRASE (%s)',
          nextPw !== '' ? 'new passphrase active' : 'decrypted back to plaintext',
        )
      } catch (err) {
        metrics.errors++
        log.warn('passphrase rotation failed (store keeps current form): %s', errorMessage(err))
      }
    }
    return store
  })

  // 1.1.1：dispose 竞态防护——dispose 在 store open 完成前触发（慢磁盘/启动即热重载）时，
  // storeP 的 then 回调仍会按挂载顺序执行；该标志让注册链/就绪链入口感知卸载，
  // 直接关闭 store 返回，杜绝「工具注册到已关闭的 store 且 disposer 永不执行」。
  let disposed = false

  // 1.1.0（DESIGN-1.1 模块 C）+ 1.2.0（DESIGN-1.2 模块 E）：时序知识图谱运行时——
  // graphEnabled（第四召回线）或 inferEnabled（第五推理线）任一显式开启时构建
  // （缺省均 false 不构建，四工具无图行为与 1.0.0 逐字节一致，G10/G11）
  const graph = cfg.graphEnabled || cfg.inferEnabled ? new TemporalGraph(cfg.graphMaxEntities) : undefined

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
      // 1.1.1：dispose 已先行触发 → 不再注册工具（否则注册到已关闭的 store 上，
      // 且这些工具的 disposer 因 dispose 已返回而永不执行，在宿主上泄漏）
      if (disposed) {
        void store.close().catch((err: unknown) => {
          metrics.errors++
          log.warn('store close failed (late open): %s', errorMessage(err))
        })
        return
      }
      const registrations: Array<() => () => void> = [
        () =>
          ctx.tools.register(
            createMemoryStoreTool(store, cfg.maxEntryChars, logger, metrics, {
              dedupWindowMs: cfg.dedupWindowMs,
              supersedeMode: cfg.supersedeMode,
              // 1.1.0（模块 D1）：矛盾共存显式写入路径（默认 off，与自动捕获同一判定级联）
              conflictMode: cfg.conflictMode,
              // 1.1.1：矛盾检测独立窗口（默认 30 天，跨周信念反转可检测）
              conflictWindowMs: cfg.conflictWindowMs,
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
              // 1.1.1：graphEnabled=true 时经默认值注入图线（原实现配置开关从不生效）
              // 1.2.0：inferEnabled/inferMaxHops 同形态注入推理线（默认 false/off = 1.1.1 语义）
              // 1.5.0：vectorEnabled 同形态注入向量第六线（默认 false = 1.4.0 语义）
              {
                fusionMode: cfg.fusionMode,
                semanticBoost: cfg.semanticBoost,
                ...(cfg.graphEnabled ? { graphEnabled: true } : {}),
                ...(cfg.inferEnabled ? { inferEnabled: true } : {}),
                ...(cfg.vectorEnabled ? { vectorEnabled: true } : {}),
                inferMaxHops: cfg.inferMaxHops,
              },
              // 1.1.0（模块 C2）：图谱第四召回线运行时注入（graphEnabled 开启时；否则不生效）
              graph,
              // 1.3.0（模块 G）：情景回放重建 T 时刻图视图的实体上限（与运行时图同配置）
              cfg.graphMaxEntities,
            ),
          ),
        () => ctx.tools.register(createMemoryForgetTool(store, logger, metrics, graph ?? undefined)),
        () =>
          ctx.tools.register(
            createMemoryStatusTool(store, fileBytes, logger, metrics, {
              themesDefault: cfg.themes,
              // 1.5.1（DESIGN-1.5 模块 P）：可视化页导出目录（存储目录；exportHtml 请求时写入）
              htmlDir: storageDir,
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
    // 1.1.1：此前的 await 位于所有 try/catch 之外——「配置了导入源且 store open 失败」时
    // 该 Promise 拒绝被 void 丢弃为 unhandled rejection（Node ≥15 默认崩溃宿主进程）。
    let existing: Awaited<ReturnType<JsonlMemoryStore['list']>>
    try {
      existing = await storeP.then((store) => store.list())
    } catch (err) {
      metrics.errors++
      log.warn('import skipped (store open failed): %s', errorMessage(err))
      return
    }
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
  // 密集事件不并发风暴；超过队列深度上限时丢弃**最新**事件并计数（保护内存有界，
  // 保留已在处理的早期事件；1.1.1 修正注释与实现不符——实现一直是最新的被拒之门外）。
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
          // 1.1.1：header 可选链保护（与下方工具结果路径的 exec.agent?.session?.header?.cwd
          // 同形态；header 缺失时 workspace=undefined = 全局共享记忆，而非每事件一次 TypeError）
          const workspace = session.header?.cwd
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
                ...(cfg.conflictMode === 'auto'
                  ? { conflictMode: cfg.conflictMode, conflictWindowMs: cfg.conflictWindowMs }
                  : {}),
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
                ...(cfg.conflictMode === 'auto'
                  ? { conflictMode: cfg.conflictMode, conflictWindowMs: cfg.conflictWindowMs }
                  : {}),
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
              ...(cfg.conflictMode === 'auto'
                ? { conflictMode: cfg.conflictMode, conflictWindowMs: cfg.conflictWindowMs }
                : {}),
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
    // 1.1.1：自持定时器不阻止进程退出（宿主若依赖事件循环排空而未显式 dispose 插件，
    // 该 6 小时句柄会挂住进程）；clearInterval 仍保留在 disposer 中
    timer.unref?.()
  }

  storeP
    .then(async (store) => {
      if (disposed) {
        await store.close().catch((err: unknown) => {
          metrics.errors++
          log.warn('store close failed (late open): %s', errorMessage(err))
        })
        return
      }
      const all = await store.list()
      // 1.1.1（P0 修复）：图种子加载——存量条目全量进图。图的设计注释一直声称
      // 「重启后由条目重建」（buildGraph 工厂即为此准备），但此前从未在生产路径接线：
      // 重启后图仅含本次会话新写入/导入的条目，第四召回线与 asOf 时间线回放对
      // 占记忆库绝大多数的历史条目完全失效。upsertEdge 幂等合并保证与
      // importSources 已增量加入的条目不冲突；list() 按 createdAt 升序回放，
      // 取代/复活时间线语义正确。
      if (graph) {
        for (const e of all) graph.add(e)
        log.info('graph seeded from store (%d entries)', all.length)
      }
      const stats = summarize(all, await fileBytes())
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
    // 1.1.1：先行置位，取消仍在途的 storeP then 回调（工具注册/就绪日志/导入）
    disposed = true
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
