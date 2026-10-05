/**
 * 运行指标（可观测性）：计数插件生命周期内的关键事件。
 *
 * 零依赖计数聚合器，可注入到入口与工具层；`dispose` 时输出汇总日志，
 * `memory_status` 工具可返回快照，供上层监控与诊断。默认全 0、可增量累计。
 */

/** 指标快照（幂等序列化：纯数字字段，无函数、无方法） */
export interface HubMetricsSnapshot {
  /** 自动捕获入库成功条目数 */
  capturedTotal: number
  /** 显式 memory_store 入库条目数 */
  explicitStored: number
  /** memory_recall 调用次数 */
  recallCalls: number
  /** 召回命中条目总数（可大于调用次数） */
  recallHits: number
  /** memory_forget 成功删除数 */
  forgotten: number
  /** 因敏感信息被拒绝的条目数 */
  rejectedSensitive: number
  /** 因去重被拒绝的条目数 */
  rejectedDuplicate: number
  /** TTL 清理删除数 */
  pruned: number
  /** 捕获背压丢弃的任务数 */
  dropped: number
  /** 记录到的错误次数（捕获/工具/存储/清理） */
  errors: number
  /**
   * 1.0.0（DESIGN-1.0 模块 D，可选，向后兼容）：建立取代关系的条目数
   * （supersede 协议命中；仅自动捕获/显式写入触发，缺省 undefined = 未观测）
   */
  superseded?: number
  /** 1.0.0（模块 D，可选）：跨写入路径内容指纹去重拒绝数（UF-1.0 库内去重） */
  rejectedDuplicateCrossPath?: number
  /** 1.0.0（模块 D，可选）：RRF/语义叠加融合模式下的召回命中数（模块 B 生效度量） */
  fusionHits?: number
  /** 1.0.0（模块 D，可选）：主题聚类构建次数（模块 A2 运行时视图） */
  themeBuilds?: number
  /** 1.1.0（模块 A，可选）：蒸馏产出的总量（abstract + procedural；缺省 undefined = 未开启蒸馏） */
  distilled?: number
  /** 1.1.0（模块 A，可选）：蒸馏产出的抽象层条目数 */
  distilledAbstract?: number
  /** 1.1.0（模块 A，可选）：蒸馏产出的程序性层条目数 */
  distilledProcedural?: number
  /** 1.1.0（模块 A，可选）：蒸馏跳过的簇数（too-small/conflict/no-resonance） */
  distillSkips?: number
  /** 1.1.0（模块 B，可选）：巩固复习执行的条目数（consolidation 写入成功计数） */
  consolidated?: number
  /** 1.1.0（模块 B，可选）：最近一次巩固扫描的到期条目数（可观测 due 压力） */
  consolidationDue?: number
  /** 1.1.0（模块 C，可选）：知识图谱活跃边数（最近一次图统计快照） */
  graphEdges?: number
  /** 1.1.0（模块 C，可选）：图谱线召回命中条目数（graphEnabled=true 时图线贡献计数） */
  graphHits?: number
  /** 1.1.0（模块 D，可选）：矛盾共存对计数（双向标注完备的唯一对） */
  conflictPairs?: number
}

export type HubMetrics = HubMetricsSnapshot

/** 创建零值指标对象（可变；工具层与入口层直接累加） */
export function createMetrics(): HubMetrics {
  return {
    capturedTotal: 0,
    explicitStored: 0,
    recallCalls: 0,
    recallHits: 0,
    forgotten: 0,
    rejectedSensitive: 0,
    rejectedDuplicate: 0,
    pruned: 0,
    dropped: 0,
    errors: 0,
  }
}

/** 汇总一行结构化摘要（供 dispose / 就绪日志；旧字段顺序不变，1.0.0 追加的计数在尾部） */
export function formatMetrics(m: HubMetrics): string {
  const extras: string[] = []
  if (m.superseded !== undefined) extras.push(`superseded=${m.superseded}`)
  if (m.rejectedDuplicateCrossPath !== undefined) extras.push(`dupCrossPath=${m.rejectedDuplicateCrossPath}`)
  if (m.fusionHits !== undefined) extras.push(`fusionHits=${m.fusionHits}`)
  if (m.themeBuilds !== undefined) extras.push(`themeBuilds=${m.themeBuilds}`)
  if (m.distilled !== undefined) extras.push(`distilled=${m.distilled}`)
  if (m.distilledAbstract !== undefined) extras.push(`distilledAbstract=${m.distilledAbstract}`)
  if (m.distilledProcedural !== undefined) extras.push(`distilledProcedural=${m.distilledProcedural}`)
  if (m.distillSkips !== undefined) extras.push(`distillSkips=${m.distillSkips}`)
  if (m.consolidated !== undefined) extras.push(`consolidated=${m.consolidated}`)
  if (m.consolidationDue !== undefined) extras.push(`consolidationDue=${m.consolidationDue}`)
  if (m.graphEdges !== undefined) extras.push(`graphEdges=${m.graphEdges}`)
  if (m.graphHits !== undefined) extras.push(`graphHits=${m.graphHits}`)
  if (m.conflictPairs !== undefined) extras.push(`conflictPairs=${m.conflictPairs}`)
  const tail = extras.length > 0 ? ', ' + extras.join(', ') : ''
  return (
    `metrics: captured=${m.capturedTotal}, explicit=${m.explicitStored}, ` +
    `recalls=${m.recallCalls} (hits=${m.recallHits}), forgotten=${m.forgotten}, ` +
    `rejected(sensitive=${m.rejectedSensitive}, duplicate=${m.rejectedDuplicate}), ` +
    `pruned=${m.pruned}, dropped=${m.dropped}, errors=${m.errors}` +
    tail
  )
}
