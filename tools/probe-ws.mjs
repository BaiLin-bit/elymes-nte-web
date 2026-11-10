// 临时探针：验证独立进程（无 Origin）能否连上 Core 的两条 WebSocket，
// 以及 /ws/debug 到底推什么帧。只读、不发送任何消息。
const CORE = 'ws://127.0.0.1:17788';
const seen = new Map();

function tap(url, label) {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => console.log(`[${label}] OPEN ${url}`));
  ws.addEventListener('error', (e) => console.log(`[${label}] ERROR ${e.message ?? e.type}`));
  ws.addEventListener('close', (e) => console.log(`[${label}] CLOSE code=${e.code} reason=${e.reason}`));
  ws.addEventListener('message', (e) => {
    let f;
    try { f = JSON.parse(e.data); } catch { return; }
    const t = f && f.t ? f.t : (f && f.type ? 'type:' + f.type : '?');
    seen.set(`${label}:${t}`, (seen.get(`${label}:${t}`) || 0) + 1);
    if (seen.get(`${label}:${t}`) <= 2) {
      console.log(`[${label}] ${t} :: ${JSON.stringify(f).slice(0, 400)}`);
    }
  });
  return ws;
}

tap(`${CORE}/ws/debug`, 'debug');
const chat = tap(`${CORE}/ws/providers/world:console/panels/chat`, 'chat');
setTimeout(() => {
  console.log('--- 帧类型统计 ---');
  for (const [k, v] of seen) console.log(k, v);
  process.exit(0);
}, 15000);
