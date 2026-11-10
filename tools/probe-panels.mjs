/**
 * 扫一遍：除了 world:console，还有哪些 world 暴露了可连的 chat 面板。
 * 只报告「连不连得上 + 首帧类型」，不打印任何对话内容。
 */
import { WebSocket } from 'ws';

const BASE = process.env.ENW_CORE || 'http://127.0.0.1:17788';
const WS_BASE = BASE.replace(/^http/, 'ws');

async function worldIds() {
  const res = await fetch(`${BASE}/api/config`);
  const data = await res.json();
  const ids = new Set();
  for (const g of data.groups || []) {
    const id = g?.group?.id;
    if (typeof id === 'string' && id.startsWith('world:')) ids.add(id.slice(6));
  }
  return [...ids].sort();
}

function tryStream(world, panel, waitMs = 2600) {
  const url = `${WS_BASE}/ws/providers/world:${world}/panels/${panel}`;
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(url);
    const finish = (r) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ world, panel, result: 'no-frame' }), waitMs);
    ws.on('message', (data) => {
      clearTimeout(timer);
      let t = '?';
      try {
        const f = JSON.parse(data.toString());
        t = String(f.t || f.type || '?');
      } catch { t = '(bad json)'; }
      finish({ world, panel, result: 'ok:' + t });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      finish({ world, panel, result: 'err:' + String(err.message || err).slice(0, 60) });
    });
  });
}

const ids = await worldIds();
console.log('worlds:', ids.join(', '));
const rows = [];
for (const id of ids) {
  const r = await tryStream(id, 'chat');
  rows.push(r);
  console.log(`${r.world.padEnd(18)} chat -> ${r.result}`);
}
const good = rows.filter((r) => r.result.startsWith('ok:'));
console.log('\n可用:', good.length ? good.map((r) => r.world).join(', ') : '(无)');
