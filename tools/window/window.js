/**
 * 窗口的页面逻辑。
 *
 * 一条 WebSocket：
 *   /ws/pet —— Core 的 world:desktop-pet 对话面板（气泡通道），历史与收发都在这里
 * 由本地 18800 服务转发，浏览器这边不碰 Core 端口。
 */
const WS = (p) => `ws://${location.host}${p}`;

const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const inputEl = $('input');
const netEl = $('net');
const tbText = $('tb-text');
const portraitImg = $('portrait-img');
const emojisEl = $('emojis');

const KAOMOJI = ['(・ω・)', '(ﾉ≧∀≦)ﾉ', '(￣▽￣)', '(´・ω・`)', '(๑•̀ㅂ•́)و', 'ヽ(°〇°)ﾉ',
  '(っ´ω`)っ', '(￣へ￣)', '(´；ω；`)', '(*´∀`*)', 'ヾ(≧▽≦*)o', '(¯﹃¯)'];

const state = {
  chat: null,
  debug: null,
  petOpen: false,
  frames: 0,
  dbgNote: '待',
  hello: null,
  lastTurnKey: null,
  selfText: new Set(),
  said: new Set(),
  seen: new Set(),
};

// ── 渲染 ────────────────────────────────────────────────
function cleanText(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 1200) return '';
  return t;
}

/**
 * 时间线里混着大量系统注入（记忆快照、生态箱自检、信箱事件、重启提示）。
 * 它们挂在 user 角色下，但不是"人说的话"，聊天窗口里照抄一遍只会糊屏。
 * 只对 user 消息过滤：assistant 说什么都留着，那才是要看的对话。
 */
const NOISE_WORDS = [
  '[system]', '[turn', '[console', 'returnReport', '无需为此主动联系', '记忆快照', '记忆域',
  '生态箱', '信箱', '邮件', '封信', '排行榜', '名次', 'terrarium.', 'mem_',
  'call_', 'end_turn', '我已收到', '系统提示',
];

function isNoise(text, role) {
  if (role !== 'user') return false;
  if (/^#\s/.test(text)) return true;
  for (const w of NOISE_WORDS) {
    if (text.includes(w)) return true;
  }
  // 长文 + JSON 特征：工具结果被塞进了 user 消息
  if (text.length > 600 && (/\[\{/.test(text) || /\{"metric"/.test(text))) return true;
  // 太长的 user 消息基本都不是人打的
  return text.length > 1200;
}

/**
 * 桌宠对话面板里能变成聊天行的条目只有两种：
 * 1. kind:'user' —— 人说的话（via: bubble 气泡框 / chat 对话页 / voice 语音）；
 * 2. kind:'say'  —— 她「说出口」的话，beats 里每段算一句。
 * ask（提问）/ touch（摸头）/ figure（换装）/ activity（工具流水）不是对话，跳过。
 */
function rowsFromItems(items) {
  const rows = [];
  for (const item of items || []) {
    if (!item) continue;
    const at = item.ts || item.at || '';
    if (item.kind === 'user') {
      const text = cleanText(item.text);
      if (text) rows.push({ role: 'user', text, at });
    } else if (item.kind === 'say') {
      for (const b of Array.isArray(item.beats) ? item.beats : []) {
        const text = cleanText(b && b.text);
        if (text) rows.push({ role: 'assistant', text, at });
      }
    }
  }
  return rows;
}

/* 历史回填上限：控制台风这扇窗可以多回一点，2d/复古风那两个只回 5 条。 */
const BACKFILL = 40;

function backfillRows(rows) {
  const shown = rows.slice(-BACKFILL);
  state.said.clear();
  for (const r of shown) state.said.add(r.text);
  rebuild(shown);   // rebuild 只在最后滚一次，不会逐行刷屏
}

function fmtTime(at) {
  if (at) {
    const d = new Date(at);
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }
  }
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function bubble(role, text, at) {
  const row = document.createElement('div');
  row.className = 'msg' + (role === 'user' ? ' self' : '');

  const ava = document.createElement('div');
  ava.className = 'msg-ava';
  if (role !== 'user') {
    const img = document.createElement('img');
    img.src = '/assets/face/bot.png';
    img.alt = '';
    ava.appendChild(img);
  }

  const main = document.createElement('div');
  main.className = 'msg-main';
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = `${fmtTime(at)}　${role === 'user' ? '我' : 'TA'}`;
  const body = document.createElement('div');
  body.className = 'msg-text';
  body.textContent = text;
  main.append(meta, body);
  row.append(ava, main);
  return row;
}

function appendRow(role, text, at) {
  // 兜底：不管从哪条路进来（含 chat 流的回话），系统注入的一律不上屏。
  if (isNoise(text, role)) return;
  const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
  chatEl.appendChild(bubble(role, text, at));
  if (nearBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

function rebuild(rows) {
  chatEl.replaceChildren();
  const shown = rows.filter((r) => !isNoise(r.text, r.role));
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'msg';
    empty.innerHTML = '<div class="msg-main"><div class="msg-text">还没有对话。</div></div>';
    chatEl.appendChild(empty);
    return;
  }
  for (const r of shown) chatEl.appendChild(bubble(r.role, r.text, r.at));
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ── 状态显示 ────────────────────────────────────────────
function paintNet() {
  netEl.className = 'net' + (state.petOpen ? ' on' : ' bad');
  netEl.textContent = (state.petOpen ? '●' : '○') + ' 气泡 · ' + state.frames + ' · ' + state.dbgNote;
}

// ── 页面标题的名字 ──────────────────────────────────────
async function loadName() {
  try {
    const r = await fetch('/api/status');
    const st = await r.json();
    const name = st && st.displayName ? String(st.displayName) : '';
    if (name) {
      tbText.textContent = `正在与 ${name} 聊天......`;
      document.title = `正在与 ${name} 聊天`;
      return;
    }
  } catch { /* 下面有兜底 */ }
  tbText.textContent = '正在与 TA 聊天......';
}

// ── 气泡通道：桌宠对话面板，收发都在这条上 ──────────────
function applyPetFrame(f) {
  const t = f && f.t;
  if (t === 'init') {
    state.said.clear();
    state.selfText.clear();
    backfillRows(rowsFromItems(f.items));
    clearTimeout(faceTimer);
    face = 'look';
    faceIdx = 0;
    paintFace();
    return 'init:' + (Array.isArray(f.items) ? f.items.length : '?');
  }
  if (t === 'item') return showItem(f.item);
  if (t === 'older') return 'older';
  if (t === 'rejected') {
    appendRow('assistant', String(f.reason || '（这条没发出去）'), '');
    return 'rejected';
  }
  if (t === 'notice' && typeof f.text === 'string') { appendRow('assistant', f.text, ''); return 'notice'; }
  // sent / withdrawn / settled / phase / ask / paused / bot / activity / draft：与本框无关
  return t || 'other';
}

function showItem(item) {
  const rows = rowsFromItems([item]);
  let shown = 'skip';
  for (const r of rows) {
    if (r.role === 'user') {
      // 自己刚发的会在面板回显一次，认掉它，别出现两行
      if (state.selfText.has(r.text)) { state.selfText.delete(r.text); shown = 'echo'; continue; }
      if (state.said.has(r.text)) continue;
      state.said.add(r.text);
      appendRow(r.role, r.text, r.at);
      shown = 'user';
      continue;
    }
    if (state.said.has(r.text)) continue;
    state.said.add(r.text);
    appendRow(r.role, r.text, r.at);
    clearTimeout(thinkTimer);
    setFace(faceFor(r.text) || 'talk', 3200);
    shown = 'say';
  }
  return shown;
}

function openPet() {
  const ws = new WebSocket(WS('/ws/pet'));
  state.pet = ws;
  ws.addEventListener('open', () => {
    state.petOpen = true;
    ws.send(JSON.stringify({ t: 'hello' }));   // 要历史就必须先 hello
    paintNet();
  });
  ws.addEventListener('message', (e) => {
    state.frames++;
    let f = null;
    try { f = JSON.parse(e.data); } catch { state.dbgNote = 'badjson'; paintNet(); return; }
    let kind = '?';
    try {
      kind = applyPetFrame(f);
    } catch (err) {
      kind = 'ERR:' + String((err && err.message) || err).slice(0, 40);
    }
    state.dbgNote = String(kind || '?').slice(0, 14);
    paintNet();
  });
  ws.addEventListener('close', () => {
    state.petOpen = false;
    paintNet();
    setTimeout(openPet, 2000);
  });
  ws.addEventListener('error', () => {
    state.petOpen = false;
    paintNet();
  });
}

/**
 * 指令通道：插件面板上的「试播」从 window-server 推过来一条 {face}，
 * 窗口收到就切动作。断了自己重连，不打扰别人。
 */
function openCtl() {
  const ws = new WebSocket(`ws://${location.host}/ws/ctl`);
  ws.addEventListener('message', (ev) => {
    let f = null;
    try { f = JSON.parse(ev.data); } catch { return; }
    if (f && f.face && FACES[f.face]) setFace(f.face, 4200);
  });
  ws.addEventListener('close', () => setTimeout(openCtl, 3000));
  ws.addEventListener('error', () => { /* close 里会重连 */ });
}

// ── 发送 ────────────────────────────────────────────────
function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (!state.pet || state.pet.readyState !== 1) {
    appendRow('assistant', '（还没连上，稍等一下再试）', '');
    return;
  }
  const id = 'win-' + Date.now().toString(36) + '-' + (sendSeq++);
  state.pet.send(JSON.stringify({ t: 'send', id, text }));
  appendRow('user', text, '');
  state.selfText.add(text);
  state.said.add(text);
  inputEl.value = '';
  if (window.ntMaybeTrigger) window.ntMaybeTrigger(text);   // 关键词彩蛋（nt-trigger.js）
  inputEl.focus();
  // 发出去了就先摆出「在想」的样子，等 TA 回话再切成「在说」。
  setFace('think', 0);
  clearTimeout(thinkTimer);
  thinkTimer = setTimeout(() => {
    if (face === 'think') setFace('look');
  }, 90000);
}

let sendSeq = 0;

// ── 表情栏 ──────────────────────────────────────────────
function mountEmojis() {
  emojisEl.replaceChildren();
  for (const k of KAOMOJI) {
    const s = document.createElement('span');
    s.textContent = k;
    s.addEventListener('click', () => {
      const start = inputEl.selectionStart ?? inputEl.value.length;
      const end = inputEl.selectionEnd ?? inputEl.value.length;
      inputEl.value = inputEl.value.slice(0, start) + k + inputEl.value.slice(end);
      inputEl.selectionStart = inputEl.selectionEnd = start + k.length;
      inputEl.focus();
    });
    emojisEl.appendChild(s);
  }
}

function mountBar() {
  document.querySelectorAll('.embtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.emo;
      if (kind === 'face') {
        const k = KAOMOJI[Math.floor(Math.random() * KAOMOJI.length)];
        inputEl.value += k;
        inputEl.focus();
      } else if (kind === 'img') {
        const name = prompt('要发的图片名（本地路径或说明）');
        if (name) inputEl.value += `[图片: ${name}]`;
        inputEl.focus();
      } else if (kind === 'case') {
        const on = btn.classList.toggle('on');
        btn.textContent = on ? '✕' : 'A';
      } else if (kind === 'gem') {
        // 钻石 = 手动换表情：点一下轮一个动作，4 秒后自己回到张望。
        const order = ['talk', 'laugh', 'angry', 'intro', 'think'];
        gemIdx = (gemIdx + 1) % order.length;
        setFace(order[gemIdx], 4000);
        btn.classList.toggle('on');
      }
    });
  });
}

// ── 标题栏按钮 ──────────────────────────────────────────
function mountTitlebar() {
  $('btn-close').addEventListener('click', () => {
    inputEl.value = 'X';
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = 1;
  });
  $('btn-min').addEventListener('click', () => {
    // 旧界面标题栏那个「─」：收起旧界面，切到千禧风窗口。
    // 服务端 open-chat 会先清掉同配置目录的旧 Edge，所以旧窗会被一起收掉。
    void openCrtWindow();
  });
  $('btn-max').addEventListener('click', () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  });
}

// ── 立绘：张望打底，命中关键词才换动作 ──────────────────
// 张望那两张是"待机"，没有对话时循环播它；说话/笑/生气由关键词触发。
const FACES = {
  look: { frames: ['look_1.jpg', 'look_2.jpg'], ms: 1600 },
  think: { frames: ['intro_1.jpg', 'intro_2.jpg', 'intro_3.jpg'], ms: 620 },
  talk: { frames: ['talk_1.jpg', 'talk_2.jpg', 'talk_3.jpg'], ms: 380 },
  laugh: { frames: ['laugh_1.jpg', 'laugh_2.jpg'], ms: 300 },
  angry: { frames: ['angry_1.jpg', 'angry_2.jpg', 'angry_3.jpg'], ms: 330 },
  intro: { frames: ['intro_1.jpg', 'intro_2.jpg', 'intro_3.jpg'], ms: 460 },
};
const FACE_KEYS = [
  { face: 'angry', keys: ['生气', '哼', '讨厌', '可恶', '气死', '不许', '烦'] },
  { face: 'laugh', keys: ['哈哈', '笑', '233', '嘿嘿', '呜呼', 'XD'] },
  { face: 'intro', keys: ['介绍', '我叫', '我是', '自我', '名字'] },
];
let face = 'look';
let faceIdx = 0;
let faceTimer = 0;
let tickTimer = 0;
let gemIdx = -1;
let thinkTimer = 0;

/**
 * holdMs：毫秒；传 0 表示「保持这个动作，等下一件事来换」。
 * 不论切到哪个动作都自己走帧——否则切过去就定住，看着像卡了。
 */
function setFace(next, holdMs) {
  if (!FACES[next]) return;
  if (face !== next) faceIdx = 0;
  face = next;
  clearTimeout(faceTimer);
  paintFace();
  tickPortrait();
  if (next === 'look' || holdMs === 0) return;
  faceTimer = setTimeout(() => {
    face = 'look';
    faceIdx = 0;
    paintFace();
    tickPortrait();
  }, holdMs || 3200);
}

function paintFace() {
  const conf = FACES[face];
  const name = conf.frames[faceIdx % conf.frames.length];
  portraitImg.src = `/assets/portrait/${name}`;
}

/**
 * 只负责排下一跳，不立刻跳：切动作时先稳稳定在第一帧，过 ms 再换。
 * 全局只有一条链——之前的写法每次回落都再起一条，链越积越多，
 * 几条链各推一格，看起来就是"刚慢一下又变快"。
 */
function tickPortrait() {
  clearTimeout(tickTimer);
  const conf = FACES[face];
  tickTimer = setTimeout(() => {
    const cur = FACES[face];
    faceIdx = (faceIdx + 1) % cur.frames.length;
    paintFace();
    tickPortrait();
  }, conf.ms + Math.random() * 220);
}

/** 13 张立绘一次性预热，避免第一次切动作时图还没下载、看着一顿一顿。 */
function preloadFaces() {
  const all = new Set();
  for (const conf of Object.values(FACES)) for (const f of conf.frames) all.add(f);
  for (const name of all) {
    const img = new Image();
    img.src = `/assets/portrait/${name}`;
  }
}

/**
 * 面板「导入立绘」写下的分组表。有就覆盖同名动作、没有就新增一个动作。
 * 内置那 13 张是写死在 FACES 里的兜底，manifest 缺失或坏了也不影响窗口。
 */
async function loadManifest() {
  try {
    const r = await fetch('/assets/portrait/manifest.json', { cache: 'no-store' });
    if (!r.ok) return;
    const m = await r.json();
    const faces = (m && m.faces) || {};
    let changed = 0;
    for (const [id, frames] of Object.entries(faces)) {
      if (!/^[a-z0-9_-]{1,24}$/i.test(id)) continue;
      const list = Array.isArray(frames) ? frames.filter((f) => typeof f === 'string' && f) : [];
      if (!list.length) continue;
      FACES[id] = { frames: list, ms: (FACES[id] && FACES[id].ms) || 400 };
      changed += 1;
    }
    if (changed) {
      preloadFaces();
      paintFace();
    }
  } catch { /* 没有 manifest 就用内置的 */ }
}

/** 从一句话里挑最靠右命中的关键词，决定表情。 */
function faceFor(text) {
  const s = String(text || '').slice(-200);
  let best = null;
  let bestAt = -1;
  for (const rule of FACE_KEYS) {
    for (const k of rule.keys) {
      const at = s.lastIndexOf(k);
      if (at > bestAt) {
        bestAt = at;
        best = rule.face;
      }
    }
  }
  return best;
}

// ── 四个面板：File 对话 / Edit 设置 / View 插件 / Help 接入·记忆·诊断 ──
const PANELS = ['live', 'settings', 'world', 'help'];
let panelNow = 'live';
let petCfg = {};
let helpTab = 'conn';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function showPanel(name) {
  if (!PANELS.includes(name)) return;
  panelNow = name;
  const win = $('win');
  if (win) win.classList.toggle('live', name === 'live');
  for (const p of PANELS) {
    const box = document.getElementById(`panel-${p}`);
    if (box) box.classList.toggle('on', p === name);
  }
  document.querySelectorAll('.menu').forEach((m) => {
    m.classList.toggle('on', m.dataset.go === name);
  });
  if (name === 'settings') void loadSettings();
  if (name === 'world') void loadWorld();
  if (name === 'help') void loadHelpTab(helpTab);
}

function mountMenus() {
  document.querySelectorAll('.menu').forEach((m) => {
    m.addEventListener('click', () => showPanel(m.dataset.go));
  });
}

// ── Edit：桌宠设置 ───────────────────────────────────────
async function loadSettings() {
  const hint = $('set-hint');
  if (hint) hint.textContent = '读取中…';
  try {
    const r = await fetch('/elymes-api/pet-config', { cache: 'no-store' });
    const d = await r.json();
    petCfg = (d && d.config) || {};
    if (hint) hint.textContent = '';
  } catch {
    petCfg = {};
    if (hint) hint.textContent = '读不到设置，先按默认显示';
  }
  paintSettings();
}

function paintSettings() {
  document.querySelectorAll('#panel-settings .seg').forEach((seg) => {
    const cur = Number(petCfg[seg.dataset.key]);
    seg.querySelectorAll('button').forEach((b) => {
      const hit = Number.isFinite(cur) && Math.abs(Number(b.dataset.val) - cur) < 0.001;
      b.classList.toggle('on', hit);
    });
  });
  const rest = $('set-rest');
  if (rest) rest.checked = petCfg.rest !== false;
  const follow = $('set-follow');
  if (follow) follow.checked = petCfg.follow === true;
  paintFollowState();
}

/** 跟随开着的时候，「躲避距离」和「安静时间」都不生效，置灰免得误会。 */
function paintFollowState() {
  const on = petCfg.follow === true;
  const avoidSeg = document.querySelector('#panel-settings .seg[data-key="avoidIn"]');
  if (avoidSeg) avoidSeg.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  const rest = $('set-rest');
  if (rest) rest.disabled = on;
  const hint = $('set-follow-hint');
  if (hint) hint.textContent = on ? '跟随开着：躲避距离与安静时间此时不起作用' : '';
}

function mountSettings() {
  document.querySelectorAll('#panel-settings .seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        const hint = $('set-hint');
        if (hint) hint.textContent = '改过了，按保存才生效';
      });
    });
  });
  const rest = $('set-rest');
  if (rest) {
    rest.addEventListener('change', () => {
      const hint = $('set-hint');
      if (hint) hint.textContent = '改过了，按保存才生效';
    });
  }
  const follow = $('set-follow');
  if (follow) {
    follow.addEventListener('change', () => {
      petCfg = { ...petCfg, follow: follow.checked };
      paintFollowState();
      const hint = $('set-hint');
      if (hint) hint.textContent = '改过了，按保存才生效';
    });
  }
  $('set-save').addEventListener('click', () => void saveSettings());
  $('set-reset').addEventListener('click', () => {
    petCfg = { size: 60, avoidIn: 130, avoidOut: 200, speed: 1, follow: false, followRadius: 100, rest: true, roamIn: 60, roamOut: 260 };
    paintSettings();
    const hint = $('set-hint');
    if (hint) hint.textContent = '已恢复默认，按保存写下去';
  });
}

async function saveSettings() {
  const next = { ...petCfg };
  document.querySelectorAll('#panel-settings .seg').forEach((seg) => {
    const on = seg.querySelector('button.on');
    if (on) next[seg.dataset.key] = Number(on.dataset.val);
  });
  next.rest = $('set-rest').checked;
  next.follow = $('set-follow').checked;
  const hint = $('set-hint');
  const btn = $('set-save');
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = '保存中…';
  try {
    const r = await fetch('/elymes-api/pet-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    const d = await r.json();
    if (d && d.ok) {
      petCfg = d.config || next;
      paintSettings();
      if (hint) hint.textContent = '已保存';
    } else if (hint) {
      hint.textContent = `没存上：${(d && d.error) || '未知原因'}`;
    }
  } catch (err) {
    if (hint) hint.textContent = `没存上：${String((err && err.message) || err)}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── View：插件 ──────────────────────────────────────────
async function loadWorld() {
  const box = $('world-list');
  if (!box) return;
  box.replaceChildren(el('div', 'hint', '读取中…'));
  try {
    const r = await fetch('/elymes-api/extensions', { cache: 'no-store' });
    const d = await r.json();
    const list = (d && d.extensions) || [];
    box.replaceChildren();
    if (!list.length) {
      box.appendChild(el('div', 'hint', '一个都没找到'));
      return;
    }
    for (const ex of list) {
      const row = el('div', 'plug');
      row.append(el('span', 'plug-name', ex.name || ex.id), el('span', 'plug-id', ex.id));
      if (ex.version) row.appendChild(el('span', 'plug-ver', `v${ex.version}`));
      box.appendChild(row);
      if (ex.about) box.appendChild(el('div', 'plug-about', ex.about));
    }
  } catch (err) {
    box.replaceChildren(el('div', 'hint', `读不到：${String((err && err.message) || err)}`));
  }
}

// ── Help：接入 / 人格记忆 / 诊断 ────────────────────────
function mountHelp() {
  document.querySelectorAll('#help-tabs .tab').forEach((t) => {
    t.addEventListener('click', () => {
      helpTab = t.dataset.tab;
      document.querySelectorAll('#help-tabs .tab').forEach((x) => x.classList.toggle('on', x === t));
      document.querySelectorAll('#panel-help .tabbody').forEach((b) => {
        b.classList.toggle('on', b.id === `tab-${helpTab}`);
      });
      void loadHelpTab(helpTab);
    });
  });
  $('persona-reload').addEventListener('click', () => void loadPersona());
  $('persona-save').addEventListener('click', () => void savePersona());
  $('diag-refresh').addEventListener('click', () => void loadDiag());
  $('open-crt').addEventListener('click', () => void openCrtWindow());
  $('open-ui2').addEventListener('click', () => void openUi2Window());
}

// 打开千禧风窗口：走服务端 /elymes-api/open-chat。
// 服务端会先清掉同配置目录的旧 Edge 实例再拉起，所以这里不用自己关旧窗。
async function openCrtWindow() {
  const hint = $('open-crt-hint');
  if (hint) hint.textContent = '正在打开…';
  try {
    const resp = await fetch('/elymes-api/open-chat', { method: 'POST' });
    const out = await resp.json();
    if (hint) {
      hint.textContent = out && out.opened ? '已打开' : '服务端说没打开，检查端口 18800';
    }
  } catch (err) {
    if (hint) hint.textContent = `打不开：${String((err && err.message) || err)}`;
  }
}

// 打开 2D 素材版界面。这一页改走透明浮层（和桌宠同一条通道），不再开 Edge --app 窗：
// --app 窗自己铺不透明底，页面里的 CSS 透明设置盖不过去。
async function openUi2Window() {
  const hint = $('open-ui2-hint');
  if (hint) hint.textContent = '正在打开…';
  try {
    const resp = await fetch('/elymes-api/open-ui2', { method: 'POST' });
    const out = await resp.json();
    if (hint) {
      const ok = out && (out.ok || out.opened);
      const how = out && out.transparent ? '透明浮层' : '普通小窗';
      hint.textContent = ok ? `已打开（${how}）` : `没打开：${(out && out.error) || '检查 18800 端口'}`;
    }
  } catch (err) {
    if (hint) hint.textContent = `打不开：${String((err && err.message) || err)}`;
  }
}

function loadHelpTab(name) {
  if (name === 'persona') return loadPersona();
  if (name === 'diag') return loadDiag();
  if (name === 'tips') return;  // 操作技巧：纯静态说明，不拉数据
  if (name === 'crt') return;   // 这一栏没有要拉的数据，只有一个按钮
  if (name === 'ui2') return;   // 同上
  return loadConn();
}

function kv(key, val, cls) {
  const row = el('div', 'kv');
  row.append(el('span', 'kv-k', key), el('span', `kv-v${cls ? ` ${cls}` : ''}`, val));
  return row;
}

async function loadConn() {
  const box = $('tab-conn');
  if (!box) return;
  box.replaceChildren(el('div', 'hint', '检查中…'));

  let diag = null;
  try {
    const r = await fetch('/elymes-api/diagnostics', { cache: 'no-store' });
    diag = await r.json();
  } catch { /* 下面按未知处理 */ }

  const rows = [];
  rows.push(kv('气泡通道', state.petOpen ? '已连接' : '没连上', state.petOpen ? 'ok' : 'bad'));
  rows.push(kv('本地服务', diag && diag.port ? `127.0.0.1:${diag.port}` : '未知'));
  rows.push(kv('Core 地址', (diag && diag.core) || '未知'));

  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    const st = await r.json();
    const name = (st && st.displayName) || '（没拿到名字）';
    const prov = (st && (st.activeProvider || st.provider)) || '';
    rows.push(kv('伙伴', prov ? `${name}　·　${prov}` : name));
  } catch {
    rows.push(kv('伙伴', 'Core 没在跑，读不到', 'bad'));
  }

  box.replaceChildren(...rows);
  void mountNtSetting(box);
}

function mountNtSetting(box) {
  const wrap = el('div', 'nt-set');
  wrap.append(el('div', 'nt-set-title', '接入界面设置'));
  const row = el('label', 'nt-set-row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  row.append(cb, el('span', '', '全屏彩蛋 10 秒自动退出'));
  const hint = el('div', 'hint nt-set-hint', '读取中…');
  wrap.append(row, hint);
  box.append(wrap);

  fetch('/elymes-api/nt-settings', { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      if (d && typeof d.autoClose === 'boolean') cb.checked = d.autoClose;
      hint.textContent = '关掉后，彩蛋会一直停留，直到按 Esc / 确定 / 点空白。';
    })
    .catch(() => {
      hint.textContent = '读不到设置，先按默认（自动退出）。';
    });

  cb.addEventListener('change', async () => {
    cb.disabled = true;
    try {
      const r = await fetch('/elymes-api/nt-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoClose: cb.checked }),
      });
      const d = await r.json();
      if (!r.ok || (d && d.ok === false)) throw new Error((d && d.error) || '保存失败');
      hint.textContent = cb.checked
        ? '已开启：10 秒自动退出。'
        : '已关闭：彩蛋会一直停留，按 Esc / 确定 / 点空白关闭。';
    } catch (err) {
      cb.checked = !cb.checked;
      hint.textContent = `保存失败：${String((err && err.message) || err)}`;
    } finally {
      cb.disabled = false;
    }
  });
}

async function loadPersona() {
  const ta = $('persona-text');
  const pathEl = $('persona-path');
  const hint = $('persona-hint');
  if (ta) ta.value = '';
  if (hint) hint.textContent = '读取中…';
  try {
    const r = await fetch('/elymes-api/persona', { cache: 'no-store' });
    const d = await r.json();
    if (pathEl) pathEl.textContent = (d && d.path) || '';
    if (ta) ta.value = (d && d.text) || '';
    if (hint) hint.textContent = d && d.ok ? `已读 ${ta ? ta.value.length : 0} 字` : ((d && d.error) || '读不到人格文件');
  } catch (err) {
    if (hint) hint.textContent = `读不到：${String((err && err.message) || err)}`;
  }
}

async function savePersona() {
  const ta = $('persona-text');
  const hint = $('persona-hint');
  const btn = $('persona-save');
  if (!ta) return;
  if (!ta.value.trim()) {
    if (hint) hint.textContent = '内容是空的，没有保存';
    return;
  }
  if (!confirm('确定把人格文件改成现在这样？会先存一份旧的备份。')) return;
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = '保存中…';
  try {
    const r = await fetch('/elymes-api/persona', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: ta.value }),
    });
    const d = await r.json();
    if (d && d.ok) {
      if (hint) hint.textContent = `已保存（${d.bytes} 字节）${d.backup ? '，旧版已备份' : ''}`;
    } else if (hint) {
      hint.textContent = `没存上：${(d && d.error) || '未知原因'}`;
    }
  } catch (err) {
    if (hint) hint.textContent = `没存上：${String((err && err.message) || err)}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadDiag() {
  const log = $('diag-log');
  const hint = $('diag-hint');
  if (hint) hint.textContent = '检查中…';
  try {
    const r = await fetch('/elymes-api/diagnostics', { cache: 'no-store' });
    const d = await r.json();
    if (hint) {
      hint.textContent = `Node ${d.node || '?'}　·　已跑 ${d.uptimeSec || 0} 秒　·　pid ${d.pid || '?'}`;
    }
    const head = [
      `core      : ${d.core || '?'}`,
      `home      : ${d.home || '?'}`,
      `extensions: ${d.extensionsDir || '?'}`,
      '──── core.log 尾部 ────',
    ].join('\n');
    if (log) log.textContent = `${head}\n${((d && d.logTail) || []).join('\n')}`;
  } catch (err) {
    if (hint) hint.textContent = `检查失败：${String((err && err.message) || err)}`;
    if (log) log.textContent = '读不到诊断信息';
  }
}

// ── 启动 ────────────────────────────────────────────────
function boot() {
  mountEmojis();
  mountBar();
  mountTitlebar();
  mountMenus();
  mountSettings();
  mountHelp();
  $('send').addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  preloadFaces();
  void loadManifest();
  portraitImg.src = '/assets/portrait/look_1.jpg';
  paintNet();
  void loadName();
  openPet();
  openCtl();
  tickPortrait();
}

boot();
