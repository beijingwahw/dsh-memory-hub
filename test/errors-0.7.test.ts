import { describe, expect, it } from 'vitest'
import { ErrorCodes, MemoryHubError, errorMessage, toMemoryHubError } from '../src/errors'

describe('ErrorCodes 稳定错误码契约（0.7.0, U3）', () => {
  it('全部错误码为对外稳定字符串（追加不修改）', () => {
    expect(ErrorCodes.EMPTY_CONTENT).toBe('EMPTY_CONTENT')
    expect(ErrorCodes.SENSITIVE_CONTENT).toBe('SENSITIVE_CONTENT')
    expect(ErrorCodes.STORE_CLOSED).toBe('STORE_CLOSED')
    expect(ErrorCodes.STORE_WRITE_FAILED).toBe('STORE_WRITE_FAILED')
    expect(ErrorCodes.STORE_READ_FAILED).toBe('STORE_READ_FAILED')
    expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND')
    expect(ErrorCodes.INTERNAL).toBe('INTERNAL')
  })
})

describe('MemoryHubError（0.7.0, U3）', () => {
  it('携带 code/message/cause，name 为 MemoryHubError', () => {
    const cause = new Error('磁盘满了')
    const err = new MemoryHubError(ErrorCodes.STORE_WRITE_FAILED, 'append failed', cause)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('MemoryHubError')
    expect(err.code).toBe('STORE_WRITE_FAILED')
    expect(err.message).toBe('append failed')
    expect(err.cause).toBe(cause)
  })

  it('无 cause 时 cause 为 undefined', () => {
    const err = new MemoryHubError(ErrorCodes.NOT_FOUND, 'missing')
    expect(err.cause).toBeUndefined()
  })
})

describe('toMemoryHubError（0.7.0, U3）', () => {
  it('已是 MemoryHubError 时原样返回（不重包不丢 code）', () => {
    const original = new MemoryHubError(ErrorCodes.SENSITIVE_CONTENT, '拒绝')
    expect(toMemoryHubError(original)).toBe(original)
  })

  it('普通 Error 包装为 INTERNAL 并保留 cause', () => {
    const raw = new Error('boom')
    const wrapped = toMemoryHubError(raw)
    expect(wrapped).toBeInstanceOf(MemoryHubError)
    expect(wrapped.code).toBe('INTERNAL')
    expect(wrapped.message).toBe('boom')
    expect(wrapped.cause).toBe(raw)
  })

  it('非 Error 值（原始值/对象）用 fallback 文案', () => {
    expect(toMemoryHubError(42).message).toBe('unexpected error')
    expect(toMemoryHubError({}).message).toBe('unexpected error')
    expect(toMemoryHubError(undefined).message).toBe('unexpected error')
  })

  it('显式指定 code 时采用指定错误码', () => {
    const wrapped = toMemoryHubError(new Error('read failed'), ErrorCodes.STORE_READ_FAILED, 'fallback')
    expect(wrapped.code).toBe('STORE_READ_FAILED')
    expect(wrapped.message).toBe('read failed')
    expect(wrapped.cause).toBeInstanceOf(Error)
  })

  it('非 Error 值 + 显式 code 时使用自定义 fallback', () => {
    const wrapped = toMemoryHubError('oops', ErrorCodes.INTERNAL, 'custom fallback')
    expect(wrapped.message).toBe('custom fallback')
    expect(wrapped.code).toBe('INTERNAL')
  })
})

describe('errorMessage 统一错误信息提取（0.7.0, U3）', () => {
  it('MemoryHubError → "CODE: message"（保留稳定错误码）', () => {
    const err = new MemoryHubError(ErrorCodes.EMPTY_CONTENT, '内容为空')
    expect(errorMessage(err)).toBe('EMPTY_CONTENT: 内容为空')
  })

  it('普通 Error → message', () => {
    expect(errorMessage(new Error('普通错误'))).toBe('普通错误')
  })

  it('其余值 → String 兜底（undefined/null/数字/对象）', () => {
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage({})).toBe('[object Object]')
  })
})
