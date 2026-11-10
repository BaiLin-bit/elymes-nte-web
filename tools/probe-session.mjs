/**
 * 看一眼 /ws/debug 的 hello 帧里 session 的形状：
 * 只统计 role / content[].type / 文本长度，不打印内容，避免把隐私落到日志里。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:18800/ws/debug';
const ws = new WebSocket(url);

const timer = setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(0);
}, 15000);

ws.on('open', () => console.log('open', url));
ws.on('error', (e) => {
  console.log('ERROR', e.message);
  process.exit(1);
});

ws.on('message', (data) => {
  let f;
  try {
    f = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (f.t !== 'hello') {
    console.log('frame t=' + f.t);
    return;
  }
  clearTimeout(timer);
  const session = f.session || [];
  console.log('session entries:', session.length, 'head:', (f.head || []).length);

  const roles = {};
  const types = {};
  const emptyText = { total: 0 };
  const samples = [];

  for (const entry of session) {
    const item = entry && entry.item ? entry.item : entry;
    const role = item.role || '(none)';
    roles[role] = (roles[role] || 0) + 1;
    const kinds = [];
    let textLen = 0;
    for (const c of item.content || []) {
      const k = c && c.type ? c.type : '(none)';
      kinds.push(k);
      types[k] = (types[k] || 0) + 1;
      if (typeof c.text === 'string') textLen += c.text.length;
    }
    if (item.type === 'message' && textLen === 0) emptyText.total++;
    if (samples.length < 12) {
      samples.push(`${item.type} role=${role} keys=[${Object.keys(item).join(',')}] content=[${kinds.join(',')}] textLen=${textLen}`);
    }
  }

  console.log('roles:', JSON.stringify(roles));
  console.log('content types:', JSON.stringify(types));
  console.log('message 且 textLen=0 的条数:', emptyText.total);

  const names = {};
  let outSamples = 0;
  const sayShapes = [];
  for (const entry of session) {
    const item = entry && entry.item ? entry.item : entry;
    if (item.type === 'function_call') {
      names[item.name || '(none)'] = (names[item.name || '(none)'] || 0) + 1;
      if ((item.name === 'pet_say' || item.name === 'bottle_reply') && sayShapes.length < 4) {
        let args = item.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { /* 保��原样 */ }
        }
        const shape = args && typeof args === 'object'
          ? Object.keys(args).map((k) => k + ':' + (typeof args[k] === 'string' ? 'str(' + args[k].length + ')' : typeof args[k])).join(', ')
          : typeof args;
        sayShapes.push(item.name + ' -> {' + shape + '}');
      }
    }
    if (item.type === 'function_call_output' && outSamples < 3) {
      outSamples++;
      const o = item.output;
      console.log('output sample keys:', o && typeof o === 'object' ? Object.keys(o).join(',') : typeof o,
        '| len=', typeof o === 'string' ? o.length : JSON.stringify(o || '').length);
    }
  }
  console.log('function_call 名字分布:', JSON.stringify(names));
  for (const s of sayShapes) console.log('说话工具形状:', s);
  console.log('--- 前 12 条形状 ---');
  for (const s of samples) console.log(s);
  process.exit(0);
});
