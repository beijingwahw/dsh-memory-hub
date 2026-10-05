/**
 * 统一错误分类：MemoryHubError
 *
 * 所有可预期的失败（参数校验、敏感拒绝、存储异常）都以带稳定 code 的错误抛出，
 * 便于上层按 code 分流处理（重试 / 提示 / 记录），也便于测试断言。
 */

/** 稳定错误码（对外 API 契约，新增只追加不修改） */
export const ErrorCodes = {
  /** 参数为空或非法 */
  EMPTY_CONTENT: 'EMPTY_CONTENT',
  /** 内容包含敏感信息，拒绝入库 */
  SENSITIVE_CONTENT: 'SENSITIVE_CONTENT',
  /** 存储已关闭 */
  STORE_CLOSED: 'STORE_CLOSED',
  /** 存储写入失败 */
  STORE_WRITE_FAILED: 'STORE_WRITE_FAILED',
  /** 存储读取/加载失败 */
  STORE_READ_FAILED: 'STORE_READ_FAILED',
  /** 目标不存在（如删除不存在的记忆） */
  NOT_FOUND: 'NOT_FOUND',
  /** 内部非法状态 */
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export class MemoryHubError extends Error {
  readonly code: ErrorCode
  override readonly cause?: unknown

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'MemoryHubError'
    this.code = code
    this.cause = cause
  }
}

/** 把未知错误规整为 MemoryHubError（保留原 cause），便于统一错误处理 */
export function toMemoryHubError(
  err: unknown,
  code: ErrorCode = ErrorCodes.INTERNAL,
  fallback = 'unexpected error',
): MemoryHubError {
  if (err instanceof MemoryHubError) return err
  const message = err instanceof Error ? err.message : fallback
  return new MemoryHubError(code, message, err)
}

/**
 * 统一错误信息提取（0.7.0 起为全局唯一入口）：
 * - MemoryHubError → `CODE: message`（保留稳定错误码，便于告警归类）；
 * - Error → message；
 * - 其余（undefined / 非 Error 对象 / 原始值）→ String 兜底。
 * 纯函数，供插件入口与工具层的日志/告警联用。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof MemoryHubError) return `${err.code}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}
