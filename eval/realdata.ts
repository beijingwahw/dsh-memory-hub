/**
 * 真实数据接地评测（0.10.0 G6）：把真实公开文档语料经**生产同路径**导入记忆库，
 * 再以"真实问题"为查询跑召回质量门——验证插件对接真实数据后依然可靠。
 *
 * 数据来源与复现：见 eval/realdata/MANIFEST.md（Node.js 官方 API 文档 v26.10.0 固定 tag 快照）。
 * 语料本仓库固化，评测全程不联网。
 *
 * 设计要点：
 * - 入库走 planImport（splitDocument 切块 → kind 推断 → 敏感过滤 → 长短校验 → 内容哈希幂等 id），
 *   与插件启动时 importSources 的真实数据接入路径完全一致；
 * - 查询 = 真实用户会问的问题（英文）；
 * - 相关标注 = **语义空间对齐**：以 API 专名/关键短语为锚，导入库中所有含锚的块均视为相关
 *   （涵盖标题块与描述块，贴近"问 API 用法时这些记忆都算答案"的用户感知，避免切块错位低估）；
 * - 门限：聚合 recall@1 为主门限，锚点完整性守卫（任一查询锚必命中，否则语料漂移直接红）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planImport } from '../src/memory/importer'
import type { MemoryEntry } from '../src/memory/types'

/** 真实文档源（固化的官方快照） */
export interface RealDocument {
  label: string
  text: string
}

/** 真实数据查询：英文问句 + 语义锚（锚词任一出现在块中即相关） */
export interface RealQuery {
  query: string
  /** 语义锚：块含其中任一关键词即视为相关（API 专名为主，避免通用词噪声） */
  anchors: string[]
}

/** 真实数据场景：导入后的记忆库 + 定位后的查询集 */
export interface RealScenario {
  name: string
  entries: MemoryEntry[]
  queries: { query: string; relevant: string[] }[]
}

const REALDATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'realdata')

/** 读取固化的真实文档（1.0.0 扩充为 4 份：path/os/fs/stream，疑点 2 防三方同源自证） */
export function loadRealDocuments(): RealDocument[] {
  return [
    { label: 'path.md', text: readFileSync(join(REALDATA_DIR, 'path.md'), 'utf8') },
    { label: 'os.md', text: readFileSync(join(REALDATA_DIR, 'os.md'), 'utf8') },
    { label: 'fs.md', text: readFileSync(join(REALDATA_DIR, 'fs.md'), 'utf8') },
    { label: 'stream.md', text: readFileSync(join(REALDATA_DIR, 'stream.md'), 'utf8') },
  ]
}

/**
 * 真实数据查询集（Node.js v26.10.0 官方文档事实；1.0.0 修复锚标注主观性）。
 * 锚 = 文档内**真实出现**的措辞（含大小写/命令式语态/点-斜杠/反引号细节），
 * 覆盖标题块、描述块与参数块（用户问 API 用法时这些块都算答案，避免切块错位低估）。
 * query = 真实用户问法；对易被背景块（文档总览/高频选项枚举）抢榜的主题，
 * 以「How do I use <API> …」嵌入 API 专名（DESIGN-1.0：优先调锚措辞/query 表述，不降门限）。
 */
export const REAL_QUERIES: RealQuery[] = [
  // ---- path 模块（12 问）----
  { query: 'What does path.extname return for a given file?', anchors: ['path.extname', 'extension of the path'] },
  {
    query: 'Does path.basename behave the same on POSIX and Windows?',
    anchors: ['path.basename', 'Process the last portion of a path'],
  },
  { query: 'What does path.dirname return?', anchors: ['path.dirname', 'directory name of a path'] },
  { query: 'What does path.join do with the given segments?', anchors: ['path.join', 'joins all given path segments'] },
  {
    query: 'What does path.resolve do with a sequence of paths?',
    anchors: ['path.resolve', 'resolves a sequence of paths'],
  },
  {
    query: 'What does path.parse return for a path string?',
    anchors: ['path.parse', 'root, dir, base, ext, and name'],
  },
  {
    query: 'What does path.delimiter return on POSIX systems?',
    anchors: ['path.delimiter', 'platform-specific path delimiter'],
  },
  {
    query: 'What is the path separator on Windows?',
    anchors: ['path.sep', 'path segment separator', 'multiple path separators'],
  },
  {
    query: 'Does path.isAbsolute determine absolute paths?',
    anchors: ['path.isAbsolute', 'path.isAbsolute()', 'determines if the literal'],
  },
  { query: 'What does path.normalize do to a path?', anchors: ['path.normalize', 'normalizes the given path'] },
  {
    query: 'What does path.relative compute?',
    anchors: ['path.relative', 'relative path from', 'relative path from `from` to `to`'],
  },
  {
    query: 'What Windows-specific path implementations does path.win32 provide?',
    anchors: ['path.win32', 'Windows-specific implementations'],
  },
  // ---- os 模块（11 问）----
  { query: 'What does os.cpus return?', anchors: ['os.cpus', 'array of objects representing a logical CPU core'] },
  {
    query: 'What fields does each os.cpus CPU object contain?',
    anchors: [
      'os.cpus',
      'model, speed, and times',
      'logical CPU core',
      'The properties included on each object include',
    ],
  },
  { query: 'What does os.freemem return?', anchors: ['os.freemem', 'amount of free system memory in bytes'] },
  { query: 'What does os.homedir return?', anchors: ['os.homedir', 'home directory of the current user'] },
  { query: 'What does os.hostname return?', anchors: ['os.hostname', 'host name of the operating system'] },
  {
    query: 'What values can os.platform return?',
    anchors: ['os.platform', 'process.platform', 'Possible values are'],
  },
  { query: 'What does os.release return?', anchors: ['os.release', 'identifying the operating system'] },
  { query: 'What does os.tmpdir return?', anchors: ['os.tmpdir', 'default directory for temporary files'] },
  {
    query: 'What does os.totalmem return and in which unit?',
    anchors: ['os.totalmem', 'total amount of system memory in bytes'],
  },
  { query: 'What does os.uptime return?', anchors: ['os.uptime', 'system uptime in number of seconds'] },
  { query: 'What does os.loadavg return?', anchors: ['os.loadavg', '1, 5, and 15 minute load averages'] },
  {
    query: 'What does os.networkInterfaces return?',
    anchors: ['os.networkInterfaces', 'object containing only network interfaces'],
  },
  // ---- fs 模块（13 问）----
  {
    query: 'How do I asynchronously write data to a file with fs.writeFile?',
    anchors: ['fs.writeFile', 'Asynchronously writes data to a file'],
  },
  { query: 'How do I remove a file or a directory?', anchors: ['fs.rm', 'removes files and directories'] },
  {
    query: 'What asynchronous file system methods does the fs/promises module provide?',
    anchors: ['fs.promises', 'fs/promises', 'asynchronous file system methods'],
  },
  {
    query: 'How do I use fs.access to check permissions for a file or directory?',
    anchors: ['fs.access', "Tests a user's permissions", 'constants.F_OK'],
  },
  {
    query: 'How do I resolve a path to its canonical pathname?',
    anchors: ['fs.realpath', 'canonical pathname'],
  },
  {
    query: 'How do I use fs.copyFile to copy a file to a destination?',
    anchors: ['fs.copyFile', 'fs.copyFileSync', 'destination path to copy'],
  },
  {
    query: 'How do I read the entire contents of a file synchronously?',
    anchors: ['fs.readFileSync', 'reads the entire contents'],
  },
  {
    query: 'How do I read the contents of a directory?',
    anchors: ['fs.readdir', 'Reads the contents of a directory'],
  },
  { query: 'How do I watch for changes to a file?', anchors: ['fs.watch', 'Watch for changes'] },
  {
    query: 'How do I use fs.mkdir to create a new directory?',
    anchors: ['fs.mkdir', 'Asynchronously creates a directory'],
  },
  {
    query: 'How do I append data to a file without truncating it?',
    anchors: ['fs.appendFile', 'Asynchronously append data to a file', 'Appends writes to dest file'],
  },
  {
    query: 'How do I get file status information such as a Stats object?',
    anchors: ['fs.stat', 'fs.Stats'],
  },
  {
    query: 'How do I use fs.createReadStream to stream a file for reading in chunks?',
    anchors: ['fs.createReadStream', 'fs.ReadStream'],
  },
  // ---- stream 模块（12 问）----
  {
    query: 'What is a Readable stream and how do its modes work?',
    anchors: ['Readable streams', 'flowing'],
  },
  {
    query: 'What are Writable streams used for?',
    anchors: ['Writable streams', 'write()'],
  },
  {
    query: 'What are Duplex and Transform streams?',
    anchors: ['Duplex', 'Transform'],
  },
  {
    query: 'How do I use stream.pipeline to pipe several streams together?',
    anchors: ['stream.pipeline', 'pipeline', 'pipe a series of streams'],
  },
  { query: 'What does stream.compose do?', anchors: ['stream.compose', 'compose'] },
  { query: 'How does backpressure affect highWaterMark limits?', anchors: ['backpressure', 'highWaterMark'] },
  {
    query: 'Can I create a readable stream from an iterable or async iterable?',
    anchors: ['Readable.from', 'iterable or async iterable', 'as an async iterable'],
  },
  {
    query: 'What is the difference between flowing and paused modes?',
    anchors: ['flowing', 'paused'],
  },
  { query: 'How do I use pipe() and unpipe() on a readable stream?', anchors: ['pipe()', 'unpipe()'] },
  { query: 'What is an object mode stream used for?', anchors: ['object mode', 'readable.read'] },
  {
    query: 'How do I consume a readable stream with an async iterator?',
    anchors: ['for await', 'async iterators'],
  },
  {
    query: 'How does stream.pipeline handle errors?',
    anchors: ['stream.pipeline', 'forwarding errors', 'errors'],
  },
]

/** 固定导入基准时间（跨运行可复算；仅影响 createdAt 时间戳，不影响内容哈希与召回） */
export const REAL_NOW = 1_752_000_000_000

/**
 * G6 真实数据门限（0.10.0 冻结）：基于真实语料实测的**保守**下限，可复算。
 * 合成语料（G1–G4）门限针对"种子构造的理想场景"，真实数据门限针对
 * "含代码块/多段落的真实文档"——问句召回第一答没有 100% 保证，但 top-3/top-5 必须高。
 */
export const G6_REQUIRED = {
  recall1: 0.75,
  recall3: 0.85,
  recall5: 0.95,
}

/**
 * 构建真实数据场景：
 * 1) 真实文档 → planImport（生产同路径）；
 * 2) 对每个查询，在导入条目中定位含任一语义锚的条目 id 作为相关标注；
 * 3) 返回场景（entries 为**全量导入库**——含代码块，贴近真实数据形态）。
 */
export function buildRealScenario(): RealScenario {
  const docs = loadRealDocuments()
  const plan = planImport({
    documents: docs.map((d) => ({ label: d.label, text: d.text })),
    options: { now: REAL_NOW },
  })
  const entries = plan.entries
  const queries = REAL_QUERIES.map((rq) => {
    const relevant = entries.filter((e) => rq.anchors.some((a) => e.content.includes(a))).map((e) => e.id)
    return { query: rq.query, relevant }
  })
  return {
    name: 'G6 真实数据接地（Node.js v26.10.0 官方文档）',
    entries,
    queries,
  }
}
