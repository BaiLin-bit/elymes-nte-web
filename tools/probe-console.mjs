// 找出时间线里带着 [console] 的那几条记录，看它们的真实结构。
// 只打印结构与长度，不dump整段对话内容。
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:18800/ws/debug';
const ws = new WebSocket(URL);
const timer = setTimeout(() => { console.log('timeout'); process.exit(1); }, 12000);

ws.on('message', (data) => {
  let f;
  try { f = JSON.parse(data.toString()); } catch { return; }
  if (f.t !== 'hello' || !Array.isArray(f.session)) return;
  clearTimeout(timer);

  const text = (item) => (item && Array.isArray(item.content)
    ? item.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('')
    : '');

  const hits = [];
  for (const entry of f.session) {
    const item = entry && entry.item ? entry.item : entry;
    if (!item) continue;
    const t = text(item);
    if (!t.includes('console')) continue;
    hits.push({
      entryKeys: Object.keys(entry || {}),
      itemKeys: Object.keys(item),
      type: item.type,
      role: item.role === undefined ? '(undefined)' : item.role,
      contentTypes: Array.isArray(item.content) ? item.content.map((c) => c && c.type) : '(not array)',
      textLen: t.length,
      head: t.slice(0, 60),
    });
  }
  console.log('session 总条数:', f.session.length, ' 含 console 的:', hits.length);
  console.log(JSON.stringify(hits.slice(0, 3), null, 2));
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => { clearTimeout(timer); console.log('ERR', e.message); process.exit(1); });
