import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { TeamStore } from "./store.js";

const page = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cogerentor Team</title>
<style>body{font:16px system-ui;margin:0 auto;padding:24px;max-width:1100px;background:#111827;color:#e5e7eb}header{display:flex;justify-content:space-between;gap:16px}nav{display:flex;gap:8px;margin:20px 0;flex-wrap:wrap}button,input{font:inherit;padding:8px 12px;border:1px solid #64748b;border-radius:6px;color:inherit;background:#1f2937}article{padding:16px;margin:12px 0;border:1px solid #374151;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px ui-monospace}small{color:#94a3b8}.urgent{border-color:#f59e0b}.stale{border-color:#f87171}h2,h3{margin:0 0 12px}p{white-space:pre-wrap}#status{color:#94a3b8}</style>
<header><h2>Команда ворктри</h2><span id="status">Подключение</span></header><nav id="nav"><button data-view="now">Сейчас</button><button data-view="board">Общая доска</button><button data-view="history">История</button><button data-view="delivery">Доставка</button></nav><input id="search" placeholder="Поиск по сообщениям"><main id="content"></main>
<script>
const token=location.hash.slice(1);let view='now';const content=document.getElementById('content');
function el(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e}
function card(title,body,kind=''){const e=el('article');e.className=kind;e.append(el('h3',title),el('pre',typeof body==='string'?body:JSON.stringify(body,null,2)));content.append(e)}
function task(n,depth=0){card('  '.repeat(depth)+(n.name||n.id)+' ['+n.status+']',{next_action:n.next_action,blocking_reason:n.blocking_reason,readiness:n.readiness,stale:n.stale},n.stale.length?'stale':'');for(const c of n.children)task(c,depth+1)}
async function refresh(){try{const r=await fetch('/api/state?view='+view+'&q='+encodeURIComponent(document.getElementById('search').value),{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();document.getElementById('status').textContent='Ревизия '+d.snapshot.revision+' · событие '+d.snapshot.lastEventSeq;content.replaceChildren();if(view==='now'){for(const [id,s]of Object.entries(d.snapshot.sections))card(id,s.data,s.stale.length?'stale':'');for(const n of d.snapshot.plan)task(n);card('Участники',d.snapshot.observations);card('Нужен пересмотр',d.snapshot.needs_reconsideration)}if(view==='board'){for(const m of d.board.messages)card(m.id+' · '+m.author+' · '+m.data.priority,m.data.text,m.data.priority==='urgent'?'urgent':'');if(d.board.next!==null)card('Есть более ранние сообщения','Используйте team_read с курсором для полной истории.')}if(view==='history')for(const e of d.history.events)card('#'+e.seq+' '+e.type+' · '+e.actor,e.payload);if(view==='delivery')for(const e of d.snapshot.deliveries)card('#'+e.id+' '+e.recipient+' · '+e.status,e)}catch(e){document.getElementById('status').textContent='Данные не обновлены: '+e.message}}
document.getElementById('nav').onclick=e=>{if(e.target.dataset.view){view=e.target.dataset.view;refresh()}};document.getElementById('search').onchange=refresh;refresh();setInterval(refresh,3000);
</script></html>`;
export interface TeamPanel { url: string; close: () => Promise<void> }
export async function startPanel(store: TeamStore): Promise<TeamPanel> {
  const token = randomBytes(32).toString("hex"); let port = 0;
  const server: Server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.headers.host !== `127.0.0.1:${port}` || req.method !== "GET") { res.writeHead(403).end(); return; }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(page); return; }
    const authorization = Buffer.from(req.headers.authorization ?? ""); const expected = Buffer.from(`Bearer ${token}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { res.writeHead(401).end(); return; }
    if (url.pathname !== "/api/state") { res.writeHead(404).end(); return; }
    try {
      const bundle = store.bundle("human", url.searchParams.get("q") ?? undefined);
      res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(bundle));
    } catch { res.writeHead(500).end(JSON.stringify({ error: "Unable to read a consistent team snapshot" })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Team panel did not bind TCP");
  port = address.port; server.unref();
  return { url: `http://127.0.0.1:${port}/#${token}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
