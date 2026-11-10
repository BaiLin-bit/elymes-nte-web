/**
 * 直接连 world:console 的 chat 面板，走一遍 hello + msg，把回帧全打出来。
 * 用来确认「发消息没人回」是协议问题还是面板拒收。
 */
import { WebSocket } from 'ws';

const url = process.env.ENW_URL || 'ws://127.0.0.1:17788/ws/providers/world:console/panels/chat';
const text = process.env.ENW_TEXT || '（窗口测试）在吗，随便回一句就行';
const ws = new WebSocket(url);
const t0 = Date.now();

const log = (s) => console.log(`+${String(Date.now() - t0).padStart(5)}ms ${s}`);

ws.on('open', () => {
  log('open');
  ws.send(JSON.stringify({ type: 'hello', name: '控制台' }));
  log('sent hello');
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'msg', text }));
    log('sent msg');
  }, 900);
});
ws.on('message', (data) => {
  const raw = data.toString();
  let f = null;
  try { f = JSON.parse(raw); } catch { log('raw ' + raw.slice(0, 120)); return; }
  const head = [f.t, f.type, f.kind].filter(Boolean).join('/');
  const body = typeof f.text === 'string' ? f.text.slice(0, 160) : '';
  log(`${head || '?'} ${body}`);
  if (f.type === 'done' || f.type === 'end') {
    setTimeout(() => process.exit(0), 300);
  }
});
ws.on('error', (err) => log('ERR ' + err.message));
ws.on('close', (code) => log('close ' + code));
setTimeout(() => {
  log('timeout, exiting');
  process.exit(0);
}, 25000);
