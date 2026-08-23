// oxlint-disable import/exports-last
import type { EdgeDef, ObserveDef } from 'server:core'
import { Observe } from 'server:core'
import type { Flow, Operation } from 'std:effect'
import { race, sleep, toReadable } from 'std:effect'

/**
 * The dev console at `/_ozaco`: one self-contained page (no CDN, no build step) over the
 * plugin's JSON endpoints — live request list (SSE), request detail (span waterfall + logs +
 * failures + events). Served by the edge through `Edge.actions.raw` once the server listens.
 */
const CONSOLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ozaco · observe</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262a33;--fg:#e6e8ee;--dim:#8b93a7;--ok:#3ddc84;--bad:#ff5d5d;--warn:#ffb454;--acc:#7aa2f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;gap:16px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header b{color:var(--acc)}header input{background:var(--bg);border:1px solid var(--line);color:var(--fg);padding:4px 8px;border-radius:4px;width:280px}
main{display:grid;grid-template-columns:minmax(320px,1fr) 2fr;height:calc(100vh - 45px)}
section{overflow:auto}#list{border-right:1px solid var(--line)}
.row{display:grid;grid-template-columns:72px 1fr 60px 64px;gap:8px;padding:6px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover,.row.sel{background:#1d2230}.row .st{text-align:right}.ok{color:var(--ok)}.bad{color:var(--bad)}.dim{color:var(--dim)}
#detail{padding:12px 16px}h2{margin:0 0 8px;font-size:14px}h3{margin:16px 0 6px;font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.span{display:grid;grid-template-columns:220px 1fr 70px;gap:8px;align-items:center;padding:3px 0}
.bar{position:relative;height:10px;background:#222735;border-radius:3px}.bar i{position:absolute;top:0;height:10px;border-radius:3px;background:var(--acc)}
.bar i.failed{background:var(--bad)}.bar i.cancelled{background:var(--warn)}
pre{background:var(--panel);border:1px solid var(--line);padding:8px;border-radius:4px;overflow:auto;margin:4px 0}
.tag{display:inline-block;padding:0 6px;border-radius:3px;background:#2a2f3d;color:var(--dim);margin-right:6px}
.empty{color:var(--dim);padding:24px}
</style></head><body>
<header><b>ozaco</b> observe <span class="dim" id="stats"></span><input id="q" placeholder="filter: service, action, tag…"><a href="#" id="cluster" class="dim">cluster</a><span class="dim" id="live">● live</span></header>
<main><section id="list"></section><section id="detail"><div class="empty">pick a request</div></section></main>
<script>
const base=location.pathname.replace(/\\/$/,'');const list=document.getElementById('list');const detail=document.getElementById('detail');const q=document.getElementById('q');
let rows=[];let selected=null;
const fmt=ms=>ms==null?'':ms+'ms';const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function render(){const f=q.value.trim();list.innerHTML='';for(const r of rows){if(f&&!(r.service||'').includes(f)&&!(r.action||'').includes(f)&&!(r.error||'').includes(f)&&!(r.path||'').includes(f))continue;
const d=document.createElement('div');d.className='row'+(selected===r.requestId?' sel':'');d.innerHTML='<span class="dim">'+new Date(r.startedAt).toLocaleTimeString()+'</span><span>'+esc(r.method?r.method+' '+r.path:(r.service+'.'+r.action))+' <span class="dim">'+esc(r.lane)+'</span></span><span class="st '+(r.error?'bad':'ok')+'">'+(r.status??'')+'</span><span class="st dim">'+fmt(r.durationMs)+'</span>';
d.onclick=()=>open(r.requestId);list.appendChild(d)}}

async function open(id){selected=id;render();const res=await fetch(base+'/api/request/'+id);if(!res.ok){detail.innerHTML='<div class=empty>not found</div>';return}const v=await res.json();
const start=v.request.startedAt,total=Math.max(1,(v.request.endedAt||Date.now())-start);
let html='<h2>'+esc(v.request.method?v.request.method+' '+v.request.path:v.request.service+'.'+v.request.action)+' <span class="'+(v.request.error?'bad':'ok')+'">'+(v.request.status??'')+'</span> <span class=dim>'+fmt(v.request.durationMs)+'</span></h2>';
html+='<div class=dim>request '+esc(id)+' · lane '+esc(v.request.lane)+' · '+esc(v.request.serviceId)+(v.request.error?' · <span class=bad>'+esc(v.request.error)+'</span>':'')+'</div>';

html+='<h3>spans</h3>';for(const s of v.spans){const l=((s.startedAt-start)/total*100).toFixed(1),w=Math.max(0.5,(s.endedAt-s.startedAt)/total*100).toFixed(1);
html+='<div class=span><span><span class=tag>'+esc(s.kind)+'</span>'+esc(s.name)+'</span><div class=bar><i class="'+s.status+'" style="left:'+l+'%;width:'+w+'%"></i></div><span class="dim st">'+fmt(s.endedAt-s.startedAt)+'</span></div>'}

if(v.failures.length){html+='<h3>failures</h3>';for(const f of v.failures)html+='<pre><b class=bad>'+esc(f.tag)+'</b> '+esc(f.message)+'\\n<span class=dim>at '+esc(f.where)+'</span>\\n'+esc((f.causes||[]).join('\\n'))+'</pre>'}

if(v.logs.length){html+='<h3>logs</h3>';for(const g of v.logs)html+='<pre><span class=tag>'+esc(g.level)+'</span>'+esc(g.msg)+(g.data?'  '+esc(JSON.stringify(g.data)):'')+'</pre>'}

if(v.events.length){html+='<h3>events</h3>';for(const e of v.events)html+='<div><span class=tag>'+esc(e.kind)+'</span>'+esc(e.name)+'</div>'}
detail.innerHTML=html}
async function load(){const res=await fetch(base+'/api/requests?limit=200');const page=await res.json();rows=page.requests;render();const st=await fetch(base+'/api/stats');document.getElementById('stats').textContent=JSON.stringify(await st.json())}
q.oninput=render;load();

document.getElementById('cluster').onclick=async e=>{e.preventDefault();selected=null;render();const res=await fetch(base+'/api/cluster');const c=await res.json();
let html='<h2>cluster</h2><div class=dim>since '+new Date(c.since).toLocaleTimeString()+'</div><h3>members</h3>';

for(const [svc,ms] of Object.entries(c.members)){html+='<div><span class=tag>'+esc(svc)+'</span>'+(ms.length?ms.map(m=>'<span class="'+(m.draining?'bad':'ok')+'">'+esc(m.instance)+'</span> <span class=dim>'+esc(m.version)+(m.draining?' draining':'')+'</span>').join(' · '):'<span class=bad>nobody</span>')+'</div>'}
html+='<h3>instances</h3><div class=span><span class=dim>instance</span><span class=dim>spans · failed</span><span class="dim st">p95</span></div>';

for(const i of c.instances){html+='<div class=span><span>'+esc(i.instance)+' <span class=dim>'+esc(i.serviceId)+'</span></span><span>'+i.spans+' · <span class="'+(i.failed?'bad':'ok')+'">'+i.failed+'</span></span><span class="dim st">'+fmt(i.p95Ms)+'</span></div>'}
detail.innerHTML=html};
const es=new EventSource(base+'/api/live');es.onmessage=e=>{const batch=JSON.parse(e.data);for(const r of batch){rows=[r,...rows.filter(x=>x.requestId!==r.requestId)].slice(0,500)}render()};
es.onerror=()=>{document.getElementById('live').textContent='○ offline'};
</script></body></html>`

const json = (value: unknown, status = 200): Response => Response.json(value, { status })

/** Mount the console + its JSON endpoints on the edge (once the server listens). */
export function* mountConsole(edge: EdgeDef.Handle): Operation<void> {
  const get = (path: string, handler: EdgeDef.RawRoute['handler']) =>
    edge.actions.raw({ method: 'GET', path, handler })

  yield* get('/_ozaco', function* () {
    return new Response(CONSOLE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })

  yield* get('/_ozaco/api/stats', function* () {
    return json(yield* Observe.actions.stats())
  })

  yield* get('/_ozaco/api/cluster', function* (request) {
    const window = Number(new URL(request.url).searchParams.get('windowMs') ?? 0) || undefined
    return json(yield* Observe.actions.cluster(window))
  })

  yield* get('/_ozaco/api/requests', function* (request) {
    const url = new URL(request.url)
    const query: ObserveDef.Query = {
      service: url.searchParams.get('service') ?? undefined,
      action: url.searchParams.get('action') ?? undefined,
      tag: url.searchParams.get('tag') ?? undefined,
      status: (url.searchParams.get('status') as ObserveDef.Query['status']) ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 50),
      cursor: url.searchParams.get('cursor') ?? undefined,
    }
    return json(yield* Observe.actions.query(query))
  })

  yield* get('/_ozaco/api/request/:id', function* (_request, params) {
    const view = yield* Observe.actions.request(params.id!)
    return view ? json(view) : json({ error: 'not found' }, 404)
  })

  yield* get('/_ozaco/api/live', function* () {
    // SSE: every batch of newly finished requests as one `data:` line, a comment every 15s
    const encoder = new TextEncoder()
    const frames: Flow<Uint8Array, void> = {
      *[Symbol.iterator]() {
        const watch = yield* Observe.actions.watch()
        return {
          *next() {
            const step = yield* race([
              (function* () {
                return { batch: (yield* watch.next()).value }
              })(),
              (function* () {
                yield* sleep(15_000)
                return { keepalive: true as const }
              })(),
            ])
            const text =
              'batch' in step ? `data: ${JSON.stringify(step.batch)}\n\n` : ': keepalive\n\n'
            return { done: false as const, value: encoder.encode(text) }
          },
        }
      },
    }
    const body = yield* toReadable(frames)
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  })
}
