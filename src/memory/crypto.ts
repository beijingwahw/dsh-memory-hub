/**
 * 1.4.0（DESIGN-1.4 模块 I）：会话级加密存储——逐行 AEAD 编解码器。
 *
 * 威胁模型与目标：记忆 JSONL 明文落盘（0600）在本机被任意读取（备份同步、
 * 磁盘镜像、误提交仓库）时正文直接可读。可选 passphrase 开启后：
 * - 静态保密：文件中除密钥记录头（KDF 参数 + 盐，公开无敏感）外不含任何明文；
 * - 逐行防篡改：每行 AES-256-GCM 认证加密（AEAD），篡改行解密失败 → 走既有
 *   「损坏行隔离留证」通道（.corrupt 审计），不静默吞数据；
 * - 错口令快速失败：KDF 盐存于文件头，错误 passphrase 派生的密钥在**首个**
 *   信封行上认证失败 → 加载期即抛 STORE_READ_FAILED（绝不表现为「空库」）。
 *
 * 格式（append-only 兼容，存储语义零迁移成本）：
 * - 密钥记录头（文件首行，明文）：`{"__kdf__":"scrypt","salt":<b64>,"n":16384,"r":8,"p":1}`
 * - 条目/tombstone 行（密文信封）：`{"__enc__":1,"iv":<b64 12B>,"ct":<b64 密文+16B tag>}`
 * - 混合文件容忍：decodeLine 对非信封形状的行走明文透传——迁移中间态
 *   （历史明文行 + 新密文行共存，下一次 compact 收敛为全密文）可正常加载。
 *
 * 密码学选型（Node 内置 node:crypto，零新依赖）：
 * - KDF：scrypt(N=16384, r=8, p=1, 32B key)——内存难解，抗 GPU 暴破的口令硬化标准；
 * - AEAD：AES-256-GCM，每行 12B CSPRNG 随机 IV，16B 认证标签；
 * - AAD：固定格式标识 `dsh-memory-hub/enc/v1`，绑定行格式版本（跨格式裁剪攻击防御）。
 *
 * 确定性边界：密文字节因随机 IV 天然不确定（这是 AEAD 的安全属性，非缺陷）；
 * 逻辑层（解码后条目集/回放结果）与明文库逐项一致（G21 接地）。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** 信封行格式版本；升格式时递增并保持读侧兼容 */
const ENVELOPE_VERSION = 1
/** 信封行标记键 */
const ENVELOPE_KEY = '__enc__'
/** 密钥记录头标记键 */
const KEY_RECORD_KEY = '__kdf__'
/** scrypt 参数（与密钥记录头同源持久化，读侧按文件头参数派生而非硬编码） */
export const KDF_PARAMS = { n: 16384, r: 8, p: 1 } as const
/** AAD：绑定格式版本，防跨格式行拼接 */
const ENVELOPE_AAD = Buffer.from('dsh-memory-hub/enc/v1', 'utf8')
/** 旧版 Node 的 scryptSync 默认 maxmem(32MB) < N=16384 所需 16MB…实际 16384*128*8=16MB 恰在界内，显式放宽到 64MB 免边缘告警 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/**
 * 行编解码器：JSONL 文件行 ↔ 序列化 JSON 文本。
 * plain（默认）：恒等变换——1.3.0 及以前的字节行为逐位不变；
 * encrypted：信封封装，decode 认证失败返回 null（交由调用方按损坏行处理）。
 */
export interface LineCodec {
  readonly encrypted: boolean
  /** 序列化 JSON 文本 → 落盘行 */
  encodeLine(json: string): string
  /** 落盘行 → 序列化 JSON 文本；非信封行明文透传（混合迁移态）；无法解码 → null */
  decodeLine(line: string): string | null
}

/** 明文编解码器（缺省，零行为变化） */
export const plainCodec: LineCodec = {
  encrypted: false,
  encodeLine: (json) => json,
  decodeLine: (line) => line,
}

/** 新盐（16B CSPRNG） */
export function randomSalt(): Buffer {
  return randomBytes(16)
}

/** 口令 + 盐 → 32B AES-256 密钥（scrypt 同参确定性派生） */
export function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { n: number; r: number; p: number } = KDF_PARAMS,
): Buffer {
  return scryptSync(passphrase, salt, 32, { N: params.n, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM })
}

/** 生成密钥记录头行（文件首行，明文；盐/KDF 参数公开无敏感） */
export function makeKeyRecord(salt: Buffer, params: { n: number; r: number; p: number } = KDF_PARAMS): string {
  return JSON.stringify({
    [KEY_RECORD_KEY]: 'scrypt',
    salt: salt.toString('base64'),
    n: params.n,
    r: params.r,
    p: params.p,
  })
}

/** 解析密钥记录头行；非密钥记录行返回 undefined */
export function parseKeyRecord(line: string): { salt: Buffer; n: number; r: number; p: number } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const obj = parsed as Record<string, unknown>
  if (obj[KEY_RECORD_KEY] !== 'scrypt') return undefined
  const salt = obj['salt']
  const n = obj['n']
  const r = obj['r']
  const p = obj['p']
  if (typeof salt !== 'string' || typeof n !== 'number' || typeof r !== 'number' || typeof p !== 'number') {
    return undefined
  }
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0 || r <= 0 || p <= 0) {
    return undefined
  }
  const saltBytes = Buffer.from(salt, 'base64')
  // base64 宽松解码可能吞非法字符后产出空 buffer——盐长度下界防退化参数
  if (saltBytes.length < 8) return undefined
  return { salt: saltBytes, n, r, p }
}

/** 行是否为密文信封形状（仅形状判断，不解密） */
export function isEncryptedEnvelope(line: string): boolean {
  return line.includes(`"${ENVELOPE_KEY}"`)
}

/** 加密编解码器（每行独立 IV 的 AES-256-GCM 信封） */
export function createEncryptedCodec(key: Buffer): LineCodec {
  return {
    encrypted: true,
    encodeLine(json) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
      cipher.setAAD(ENVELOPE_AAD)
      const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final(), cipher.getAuthTag()])
      return JSON.stringify({ [ENVELOPE_KEY]: ENVELOPE_VERSION, iv: iv.toString('base64'), ct: ct.toString('base64') })
    },
    decodeLine(line) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return null
      }
      if (typeof parsed !== 'object' || parsed === null) return null
      const obj = parsed as Record<string, unknown>
      if (obj[ENVELOPE_KEY] !== ENVELOPE_VERSION || typeof obj['iv'] !== 'string' || typeof obj['ct'] !== 'string') {
        // 非信封形状 → 明文透传（迁移中间态的历史明文行；密文库里混入的明文行同规则可读）
        return line
      }
      try {
        const iv = Buffer.from(obj['iv'], 'base64')
        const data = Buffer.from(obj['ct'], 'base64')
        if (iv.length !== 12 || data.length < 16) return null
        const tag = data.subarray(data.length - 16)
        const body = data.subarray(0, data.length - 16)
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
        decipher.setAuthTag(tag)
        decipher.setAAD(ENVELOPE_AAD)
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        // GCM 认证失败（错密钥/被篡改）→ null，调用方按损坏行隔离留证
        return null
      }
    },
  }
}

/** 常量时间口令盐比较辅助（密钥记录重写探测用；同长度才比较，避免泄漏长度信息） */
export function saltEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
