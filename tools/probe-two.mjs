/**
 * 同时开两条 /ws/debug，看是不是只有第一条能拿到 hello 帧。
 * 只统计帧数与首帧类型，不打印对话内容。
 */
import { WebSocket } from 'ws';

const URL = process.env.ENW_URL || 'ws://127.0.0.1:18800/ws/debug';

/** 开一条，收到首帧就算成功；3.5 秒还没动静就算失败。连接保持打开。 */
function open(tag, keepMs = 6000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let frames = 0;
    let first = '';
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      resolve({ tag, frames, first: first || reason, ws });
    };
    const timer = setTimeout(() => finish('(timeout)'), 3500);
    ws.on('message', (data) => {
      frames++;
      if (!first) {
        try { first = String(JSON.parse(data.toString()).t || '?'); } catch { first = '(bad json)'; }
        clearTimeout(timer);
        finish('');
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); finish('ERR ' + err.message); });
    ws.on('close', () => { clearTimeout(timer); finish('(closed)'); });
    setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, keepMs);
  });
}

const a = await open('A');
const b = await open('B');
console.log('A:', JSON.stringify({ frames: a.frames, first: a.first }));
console.log('B:', JSON.stringify({ frames: b.frames, first: b.first }));
setTimeout(() => process.exit(0), 5500);
