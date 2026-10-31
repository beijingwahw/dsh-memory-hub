/**
 * 自包含 HTML 可视化导出（1.5.1，DESIGN-1.5 模块 P「可视化检索页」）。
 *
 * 目标：把「记忆时间轴 / 可视化检索页」以**仓库内可交付形态**关闭——单个静态 HTML
 * 文件（零外部依赖、零网络引用、可离线打开）：
 * - 时间轴柱状视图：按天分桶的新增/更新/纯热度/删除事件柱（服务端确定性渲染，
 *   纯 HTML/CSS，禁 JS 也可读）；
 * - 检索页：全量语料以安全 JSON 内嵌，浏览器内即时评分排序（词面 idf 加权，
 *   拉丁词 + CJK 2-gram，与服务端 token 化同精神）浏览记忆。
 *
 * 工程纪律：
 * - **确定性**：同输入（含注入的 generatedAt）逐字节可复算——条目按 (createdAt, id)
 *   排序、固定键序序列化、模板无随机/时钟引用；
 * - **注入安全**：内嵌 JSON 经 `\u003c` 转义（杜绝 `</script>` 逃逸），页面 DOM 一律
 *   textContent 构建（内容含 HTML 也不被执行）；服务端模板文本全部经 escapeHtml；
 * - **自包含断言锚**：输出不含任何 `http(s)://` 资源引用（G26 门禁锚点）；
 * - 隐私边界：导出为**明文观看工件**（与加密存储正交——文件落存储目录 0600，
 *   与记忆库同权限保护；不介意者不应开启导出）。
 */
import type { MemoryEntry, MemoryTimeline } from './types'

/** HTML 文本转义（属性与文本通用：& < > " '） */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 内嵌 <script> 的 JSON 安全序列化（`<` → \u003c，杜绝 </script> 逃逸） */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** 导出载荷（generatedAt 由调用方注入——确定性渲染的关键） */
export interface MemoryHtmlPayload {
  entries: readonly MemoryEntry[]
  timeline: MemoryTimeline
  generatedAt: number
}

/** 时间轴柱状视图的单桶行（确定性 HTML/CSS，无 JS 依赖） */
function timelineBars(timeline: MemoryTimeline): string {
  const buckets = timeline.buckets
  if (buckets.length === 0) return '<p class="empty">（无时间锚事件——空库或全部历史已被 compact 重建）</p>'
  const maxEvents = Math.max(1, ...buckets.map((b) => b.added + b.removed + b.updated + b.heat))
  const cols = buckets.map((b, i) => {
    const total = b.added + b.removed + b.updated + b.heat
    const h = Math.round((100 * total) / maxEvents)
    const seg = (n: number, cls: string): string => (n > 0 ? `<i class="${cls}" style="flex:${n}"></i>` : '')
    const label =
      i === 0 || i === buckets.length - 1 || i % 10 === 9
        ? `<span class="day">${escapeHtml(b.day)}</span>`
        : '<span class="day"></span>'
    const title = `${b.day}：+${b.added} −${b.removed} ~${b.updated} (h${b.heat}) → 存活 ${b.total}`
    return `<div class="col" title="${escapeHtml(title)}"><div class="bar" style="height:${h}%">${seg(
      b.added,
      'a',
    )}${seg(b.updated, 'u')}${seg(b.heat, 'h')}${seg(b.removed, 'r')}</div>${label}</div>`
  })
  return (
    `<p class="meta">${buckets.length} 天 · 事件 ${timeline.events} · ${
      timeline.truncated ? '仅保留最近 ' + buckets.length + ' 天' : '完整跨度'
    } · ${escapeHtml(new Date(timeline.firstAt).toISOString().slice(0, 10))} → ${escapeHtml(
      new Date(timeline.lastAt).toISOString().slice(0, 10),
    )}</p><div class="chart">${cols.join('')}</div>` +
    '<p class="legend"><i class="a"></i>新增 <i class="u"></i>更新 <i class="h"></i>热度 <i class="r"></i>删除</p>'
  )
}

/** 条目 → 页面语料投影（固定键序，确定性序列化；剔除运行时专有字段） */
function pageEntry(e: MemoryEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: e.id,
    kind: e.kind,
    content: e.content,
    tags: e.tags,
    source: e.source,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    accessCount: e.accessCount,
  }
  if (e.workspace !== undefined) out['workspace'] = e.workspace
  if (e.lastAccessAt !== undefined) out['lastAccessAt'] = e.lastAccessAt
  return out
}

const PAGE_CSS = `:root{color-scheme:light dark}
body{font:14px/1.6 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px}
header h1{font-size:18px;margin:0 0 4px}.meta,.empty{color:#888;font-size:12px}
.chart{display:flex;align-items:flex-end;gap:2px;height:160px;margin:12px 0 4px}
.col{flex:1;display:flex;flex-direction:column;align-items:center;height:100%}
.bar{width:100%;display:flex;flex-direction:column-reverse;min-height:2px;border-radius:2px 2px 0 0;overflow:hidden}
.bar i{display:block;min-height:1px}
.a{background:#22c55e}.u{background:#3b82f6}.h{background:#94a3b8}.r{background:#ef4444}
.day{font-size:9px;color:#888;height:14px;white-space:nowrap}
.legend{font-size:12px;color:#888}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 12px;vertical-align:-1px}
.box{display:flex;gap:8px;margin:16px 0}
.box input{flex:1;padding:8px;border:1px solid #ccc;border-radius:6px}
.box select{padding:8px;border:1px solid #ccc;border-radius:6px}
ol{list-style:none;padding:0;margin:0}
li{border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin-bottom:8px}
li .hd{display:flex;gap:8px;align-items:baseline;font-size:12px;color:#888}
li .k{font-weight:600;color:#2563eb}
li .score{margin-left:auto}
li p{margin:6px 0 0;white-space:pre-wrap;word-break:break-word}
li .tags{font-size:11px;color:#888}`

const PAGE_JS = `(function(){
var D=window.__MH__;var EN=D.entries;
function toks(s){var out=[];var m,re=/[a-z0-9_]{2,}|[\\u4e00-\\u9fff]/g;var t=s.toLowerCase();var runs={};while((m=re.exec(t))){var w=m[0];if(w.length===1){var i=m.index;var b=t.substr(i,2);if(b.length===2){runs[b]=1}}else{runs[w]=1}}for(var k in runs)out.push(k);return out}
var DF={};EN.forEach(function(e){toks(e.content+' '+e.tags.join(' ')).forEach(function(t){DF[t]=(DF[t]||0)+1})});
var N=Math.max(1,EN.length);
function idf(t){return Math.log(1+N/((DF[t]||0)+0.5))}
function score(q,e){var qt=toks(q);if(!qt.length)return e.accessCount*0.01;var bag={};toks(e.content+' '+e.tags.join(' ')).forEach(function(t){bag[t]=(bag[t]||0)+1});var s=0;qt.forEach(function(t){if(bag[t])s+=idf(t)*(1+Math.log(bag[t]))});return s}
var Q=document.getElementById('q'),K=document.getElementById('k'),R=document.getElementById('r'),S=document.getElementById('s');
function esc(x){return x==null?'':String(x)}
function render(){var q=Q.value.trim();var kind=K.value;var scored=EN.map(function(e){return{e:e,s:score(q,e)}});if(q)scored=scored.filter(function(x){return x.s>0});if(kind)scored=scored.filter(function(x){return x.e.kind===kind});scored.sort(function(a,b){return b.s-a.s||b.e.createdAt-a.e.createdAt});scored=scored.slice(0,50);S.textContent='命中 '+scored.length+' / '+EN.length+(q?'（按查询评分降序，前 50）':'（默认按访问热度，前 50）');R.textContent='';
scored.forEach(function(x){var li=document.createElement('li');var hd=document.createElement('div');hd.className='hd';var k=document.createElement('span');k.className='k';k.textContent=x.e.kind;var d=document.createElement('span');d.textContent=new Date(x.e.createdAt).toISOString().slice(0,10);var sc=document.createElement('span');sc.className='score';sc.textContent=q?x.s.toFixed(2):'';hd.appendChild(k);hd.appendChild(d);hd.appendChild(sc);var p=document.createElement('p');p.textContent=x.e.content;li.appendChild(hd);li.appendChild(p);if(x.e.tags.length){var tg=document.createElement('div');tg.className='tags';tg.textContent='#'+x.e.tags.join(' #');li.appendChild(tg)}R.appendChild(li)})}
Q.addEventListener('input',render);K.addEventListener('change',render);render()})()`

/**
 * 渲染自包含 HTML（纯函数、确定性：同 payload 逐字节一致）。
 * 时间轴服务端渲染（纯 HTML/CSS）；检索页内嵌语料 JSON + 浏览器端即时评分。
 */
export function renderMemoryHtml(payload: MemoryHtmlPayload): string {
  const { entries, timeline, generatedAt } = payload
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  const kinds: Record<string, number> = {}
  for (const e of sorted) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-memory-hub 记忆可视化</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<header>
<h1>dsh-memory-hub 记忆可视化</h1>
<p class="meta">${sorted.length} 条记忆 · ${escapeHtml(JSON.stringify(kinds))} · 生成于 ${escapeHtml(
    new Date(generatedAt).toISOString(),
  )}（自包含静态文件，可离线打开；检索在浏览器本地进行，不上传任何数据）</p>
</header>
<section id="timeline">
<h2>记忆时间轴</h2>
${timelineBars(timeline)}
</section>
<section id="search">
<h2>检索页</h2>
<div class="box">
<input id="q" type="search" placeholder="输入关键词即时评分排序（拉丁词 + 中文相邻字）……">
<select id="k"><option value="">全部类型</option><option>decision</option><option>fact</option><option>preference</option><option>instruction</option><option>generic</option></select>
</div>
<p class="meta" id="s"></p>
<ol id="r"></ol>
</section>
<script>window.__MH__={entries:${embedJson(sorted.map(pageEntry))}};</script>
<script>${PAGE_JS}</script>
</body>
</html>
`
}
