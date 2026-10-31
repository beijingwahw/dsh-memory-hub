/**
 * 逐行 AEAD 编解码器（1.4.0，DESIGN-1.4 模块 I）单元锁定。
 *
 * 覆盖面：
 * - plainCodec 恒等（缺省零行为变化）；
 * - 加密编解码 roundtrip / 落盘行不含明文 / IV 随机性（同文本两次编码不同密文）；
 * - 篡改检测（ct 翻转 → null）/ 错密钥 → null / 短 iv 与短 ct 拒收；
 * - 非信封行明文透传（迁移中间态）/ 异版本信封透传；
 * - 密钥记录头 makeKeyRecord↔parseKeyRecord roundtrip 与非法输入拒收；
 * - deriveKey 同参确定性 / 异盐分歧；saltEquals。
 */
import { describe, expect, it } from 'vitest'
import {
  createEncryptedCodec,
  deriveKey,
  isEncryptedEnvelope,
  makeKeyRecord,
  parseKeyRecord,
  plainCodec,
  randomSalt,
  saltEquals,
} from '../../src/memory/crypto'

const SECRET_JSON = JSON.stringify({ id: 'e1', content: '部署密钥 abc123 不要外泄', kind: 'fact' })

describe('逐行 AEAD 编解码器（1.4.0 模块 I）', () => {
  it('plainCodec 恒等：明文库缺省路径字节行为不变', () => {
    expect(plainCodec.encrypted).toBe(false)
    expect(plainCodec.encodeLine(SECRET_JSON)).toBe(SECRET_JSON)
    expect(plainCodec.decodeLine(SECRET_JSON)).toBe(SECRET_JSON)
  })

  it('加密 roundtrip：encode→decode 还原原文；落盘行不含明文；形状为信封', () => {
    const codec = createEncryptedCodec(deriveKey('口令-甲', randomSalt()))
    const line = codec.encodeLine(SECRET_JSON)
    expect(codec.encrypted).toBe(true)
    expect(isEncryptedEnvelope(line)).toBe(true)
    expect(line).not.toContain('部署密钥')
    expect(line).not.toContain('abc123')
    expect(codec.decodeLine(line)).toBe(SECRET_JSON)
  })

  it('IV 随机性：同文本两次编码产生不同密文（CSPRNG IV），但都可解回原文', () => {
    const codec = createEncryptedCodec(deriveKey('p', randomSalt()))
    const a = codec.encodeLine(SECRET_JSON)
    const b = codec.encodeLine(SECRET_JSON)
    expect(a).not.toBe(b)
    expect(codec.decodeLine(a)).toBe(SECRET_JSON)
    expect(codec.decodeLine(b)).toBe(SECRET_JSON)
  })

  it('篡改检测：ct 翻转一个 base64 字符 → 认证失败返回 null', () => {
    const codec = createEncryptedCodec(deriveKey('p', randomSalt()))
    const line = codec.encodeLine(SECRET_JSON)
    const obj = JSON.parse(line) as { iv: string; ct: string }
    const flipped = obj.ct.slice(0, 3) + (obj.ct[3] === 'A' ? 'B' : 'A') + obj.ct.slice(4)
    expect(codec.decodeLine(JSON.stringify({ __enc__: 1, iv: obj.iv, ct: flipped }))).toBeNull()
  })

  it('错密钥 → 认证失败 null；iv/ct 长度非法 → null', () => {
    const right = createEncryptedCodec(deriveKey('p', randomSalt()))
    const line = right.encodeLine(SECRET_JSON)
    const wrong = createEncryptedCodec(deriveKey('wrong', randomSalt()))
    expect(wrong.decodeLine(line)).toBeNull()
    // iv 空 / ct 短于 16B tag
    expect(right.decodeLine('{"__enc__":1,"iv":"","ct":""}')).toBeNull()
    expect(right.decodeLine(`{"__enc__":1,"iv":"AAAAAAAAAAAAAAAA","ct":"AAAA"}`)).toBeNull()
    // iv 长度非法但 ct 达标（iv≠12B 臂独立命中）
    expect(right.decodeLine(`{"__enc__":1,"iv":"AAAAAAAA","ct":"${'A'.repeat(44)}"}`)).toBeNull()
  })

  it('非信封行明文透传（迁移中间态可读）；异版本信封不按本版解密', () => {
    const codec = createEncryptedCodec(deriveKey('p', randomSalt()))
    expect(codec.decodeLine(SECRET_JSON)).toBe(SECRET_JSON)
    expect(codec.decodeLine('{"__enc__":2,"iv":"AAAA","ct":"BBBB"}')).toBe('{"__enc__":2,"iv":"AAAA","ct":"BBBB"}')
    expect(codec.decodeLine('not json at all')).toBeNull()
  })

  it('密钥记录头 roundtrip：makeKeyRecord → parseKeyRecord 还原盐与 KDF 参数', () => {
    const salt = randomSalt()
    const rec = makeKeyRecord(salt)
    expect(isEncryptedEnvelope(rec)).toBe(false)
    const parsed = parseKeyRecord(rec)
    expect(parsed).toBeDefined()
    expect(saltEquals(parsed!.salt, salt)).toBe(true)
    expect(parsed).toMatchObject({ n: 16384, r: 8, p: 1 })
  })

  it('parseKeyRecord 拒收：普通条目行 / 垃圾文本 / 非法参数（盐过短、n=0、非整数、类型错）', () => {
    expect(parseKeyRecord(SECRET_JSON)).toBeUndefined()
    expect(parseKeyRecord('garbage{{{')).toBeUndefined()
    expect(parseKeyRecord('')).toBeUndefined()
    expect(parseKeyRecord('{"__kdf__":"scrypt","salt":"AAAA","n":16384,"r":8,"p":1}')).toBeUndefined() // 盐 <8B
    expect(parseKeyRecord('{"__kdf__":"scrypt","salt":"AAAAAAAA","n":0,"r":8,"p":1}')).toBeUndefined()
    expect(parseKeyRecord('{"__kdf__":"scrypt","salt":"AAAAAAAA","n":1.5,"r":8,"p":1}')).toBeUndefined()
    expect(parseKeyRecord('{"__kdf__":"scrypt","salt":"AAAAAAAA","n":16384,"r":"8","p":1}')).toBeUndefined()
    expect(parseKeyRecord('{"__kdf__":"bcrypt","salt":"AAAAAAAA","n":16384,"r":8,"p":1}')).toBeUndefined()
  })

  it('deriveKey：同口令同盐同参 → 同密钥；异盐 → 不同密钥；saltEquals 长度不等 false', () => {
    const salt = randomSalt()
    const k1 = deriveKey('口令', salt)
    const k2 = deriveKey('口令', salt)
    expect(k1.equals(k2)).toBe(true)
    expect(k1.equals(deriveKey('口令', randomSalt()))).toBe(false)
    expect(saltEquals(k1, k1.subarray(0, 16))).toBe(false)
    expect(k1.length).toBe(32)
  })
})
