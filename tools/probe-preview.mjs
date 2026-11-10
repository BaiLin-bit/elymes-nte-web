// 验证「试播」通路：连上 /ws/ctl，再让服务端推一个动作，看窗口侧能不能收到。
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:18800';
const ws = new WebSocket('ws://127.0.0.1:18800/ws/ctl');
const done = (code) => { try { ws.close(); } catch { /* ignore */ } process.exit(code); };

ws.on('open', async () => {
  await new Promise((r) => setTimeout(r, 250));
  const res = await fetch(`${BASE}/api/preview?face=laugh`);
  console.log('端点返回:', await res.text());
});
ws.on('message', (d) => {
  console.log('窗口侧收到:', d.toString());
  done(0);
});
ws.on('error', (e) => { console.log('ERR', e.message); done(1); });
setTimeout(() => { console.log('超时：没收到指令'); done(1); }, 6000);
