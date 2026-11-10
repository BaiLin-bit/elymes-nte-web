/**
 * 单独验一下 world:desktop-pet 的 chat 面板：连上发 hello，看它回什么。
 * 只发 hello，不发对话内容。
 */
import { WebSocket } from 'ws';

const url = process.env.ENW_URL || 'ws://127.0.0.1:17788/ws/providers/world:desktop-pet/panels/chat';
const ws = new WebSocket(url);
const seen = [];

ws.on('open', () => {
  console.log('open');
  ws.send(JSON.stringify({ type: 'hello', name: '曳尔沐' }));
});
ws.on('message', (data) => {
  const raw = data.toString();
  let f = null;
  try { f = JSON.parse(raw); } catch { /* ignore */ }
  seen.push(f ? String(f.type || f.t || '?') + ':' + String(f.kind || '') : '(bad)');
  console.log('frame', seen.length, seen.at(-1));
  if (f && typeof f.text === 'string' && f.type === 'sys') console.log('  text:', f.text.slice(0, 120));
});
ws.on('error', (err) => console.log('err', err.message));
setTimeout(() => {
  console.log('total frames:', seen.length, seen.join(' | '));
  process.exit(0);
}, 6000);
