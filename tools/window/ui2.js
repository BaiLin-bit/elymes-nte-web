/* ==========================================================================
   ui2.js —— 第二套 2D 聊天界面的行为层

   素材换成 ui_2 那 15 张（静候4 / 说话5 / 叹气6），骨架沿用千禧风 crt.js：
   一条 WebSocket、上行结构、历史回填、窗口按钮、去边框后的拖动与缩放。

   协议（三页一致，改了一边就得三边一起改）：
     连   ws://…/ws/pet  —— 18800 转发到 Core 的 world:desktop-pet 对话面板
     问   {"t":"hello"}  —— 要历史；答 {"t":"init",items,…}
     发   {"t":"send","id":"…","text":"…"} —— 答 {"t":"sent"|"rejected"}
     增量 {"t":"item",item} —— kind:user 是人说的，kind:say 是她说的

   这就是桌宠气泡框用的那条通道：气泡里打的字、她说出口的话都在上面，
   从这里发出去也按气泡口吻进时间线（模型看到的是 [typed] 名字: 内容）。
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const WS = (p) => `ws://${location.host}${p}`;
// 直接双击（file://）或手动加 ?demo=1 时走离线演示，不打 WebSocket。
const FILE_MODE = location.protocol === 'file:' || /[?&]demo=1/.test(location.search);

// ── 设计稿尺寸与等比缩放 ────────────────────────────────────────────────────
// 跟 crt 不同：那里是 cover（铺满裁边），这里是 contain（整张画都露出来）。
// 因为素材是完整的方形画，裁掉边就等于把人脸切了。
const DESIGN_W = 300;
const DESIGN_H = 340;
const MIN_W = 240;
const MIN_H = 280;

// 缩放档位：右键面板里选，乘在 contain 系数上。窗口本身不动，只改内容大小。
const FIT_SCALES = { small: 0.78, normal: 1, large: 1.28 };
let fitScale = FIT_SCALES.normal;

function fitStage() {
  const raw = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  // 封顶 1.0：设计稿 300×340 是上限，窗口给得再大也只保持原尺寸，不跟着放大。
  // 之前不封顶，宿主给了 1042×587 的内容区，算出来 1.726，聊天框被撑到 463 宽。
  const k = Math.min(1, raw) * fitScale;
  const html = document.documentElement;
  html.style.setProperty('--fit', String(Math.max(0.2, k)));

  // 算完再量一次真实渲染宽度修正误差（父层宽度、DPI 缩放都会影响）
  const box = document.getElementById('win');
  if (!box) return;
  const got = box.getBoundingClientRect().width;
  const want = DESIGN_W * Math.max(0.2, k);
  if (got > 1 && Math.abs(got - want) > 1) {
    html.style.setProperty('--fit', String(Math.max(0.2, k * (want / got))));
  }

  // 尺寸变了，贴边位置也得跟着重算，否则换档位后窗口会离边越来越远。
  // 延迟一拍：等 --fit 真正生效，同时避开 placeMode 的暂时性死区（fitStage 在它声明前就被调用了）。
  setTimeout(() => { try { applyPlace(placeMode); } catch { /* 还没初始化就跳过 */ } }, 0);
}
fitStage();
window.addEventListener('resize', fitStage);
[0, 120, 400, 900, 1800].forEach((ms) => setTimeout(fitStage, ms));

// Esc 关窗：18801 外挂起不来时标题栏的 ─ □ ✕ 是死的，留一个键盘兜底
// 自己关自己：宿主是 --pet-host 进程，window.close() 常被忽略，所以先让宿主隐藏窗口，
// 隐藏是宿主自己实现的，一定会生效；随后再试一次 close，能把进程一起收走就收走。
function closeSelf() {
  try { window.petHost?.hide?.(); } catch { /* 不当网页打开时没有宿主 */ }
  setTimeout(() => { try { window.close(); } catch { /* 拦了就静默 */ } }, 60);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSelf();
  }
});

// ── 右键快捷面板 ────────────────────────────────────────────────
// 只改本页的缩放档位，不开新窗、不请求服务端：窗口尺寸由宿主定，内容自己缩。
const ctxMenu = document.getElementById('ctx-menu');

// body 身上有 transform（居中 + scale --fit）。带 transform 的元素会成为 position: fixed 的
// 包含块，面板就改成相对 body 定位、跟着一起缩放 —— 表现就是「右键弹了个东西但看不全」。
// 挂到 <html> 下就没这回事，fixed 恢复成相对视口。
if (ctxMenu && ctxMenu.parentNode !== document.documentElement) {
  document.documentElement.appendChild(ctxMenu);
}

// 宿主光标最近一次的位置与「该不该拿鼠标」的判定函数，由 attachHostMouse 装上。
// 面板一关就得按当前位置重判，否则光标停在面板上时窗口会一直捉着鼠标。
let ui2Cursor = null;
let ui2Verdict = null;

function hideCtxMenu() {
  if (ctxMenu) ctxMenu.classList.remove('show');
  if (ui2Verdict) ui2Verdict(ui2Cursor);
}

window.addEventListener('contextmenu', (e) => {
  if (!ctxMenu) return;
  e.preventDefault();
  ctxMenu.classList.add('show');
  // 摆进窗口内：右下角点右键时不要飘到窗外
  const w = ctxMenu.offsetWidth || 100;
  const h = ctxMenu.offsetHeight || 120;
  const x = Math.min(e.clientX, window.innerWidth - w - 2);
  const y = Math.min(e.clientY, window.innerHeight - h - 2);
  ctxMenu.style.left = Math.max(2, x) + 'px';
  ctxMenu.style.top = Math.max(2, y) + 'px';
});

window.addEventListener('mousedown', (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) hideCtxMenu();
});

if (ctxMenu) {
  ctxMenu.querySelectorAll('.menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      const act = item.dataset.act;
      hideCtxMenu();
      if (act === 'size') {
        const arg = item.dataset.arg;
        fitScale = FIT_SCALES[arg] || FIT_SCALES.normal;
        fitStage();
      } else if (act === 'history') {
        // 已经把对话贴在聊天框里了，这里只是把滚动条拉到底重看一遍
        const lines = document.getElementById('lines');
        if (lines) lines.scrollTop = lines.scrollHeight;
      } else if (act === 'hide') {
        // 这一项才是真的关窗，跟九宫格挪位置分开放，免得误点就把自己关掉。
        // 宿主是 --pet-host 进程，window.close() 常被忽略，先让宿主把窗藏了再关。
        closeSelf();
      }
    });
  });
}

// ── 桌面九宫格定位 ────────────────────────────────────────────────
// petHost 没有移动窗口的方法，宿主窗口本身 movable:false 且铺满整个工作区。
// 所以这里挪的不是系统窗口，而是内容在页面里的落点——对宿主窗口来说页面就是整个屏幕，
// translate 到哪个象限，视觉上就等于把聊天界面放到了哪个位置。
const PLACE_KEY = 'ui2.place';
let placeMode = 'mc';

function applyPlace(name) {
  placeMode = name || 'mc';
  // 偏移必须写在 body 上：#win 的 transform 留给 .is-hidden 的收起动画，
  // 两边抢同一个属性会让收起态失效。
  const host = document.body;
  const win = document.getElementById('win');
  if (!host || !win) return;

  // 按实测矩形算，而不是拿设计稿的 300×340 拍脑袋：缩放档位变了、窗口被缩小，
  // 拍出来的偏移就会差一截——上一版「贴不到底」就是这个原因（固定 12px 边距 + 用了 360 而不是真实高）。
  const r = win.getBoundingClientRect();
  const w = r.width || DESIGN_W;
  const h = r.height || DESIGN_H;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const col = placeMode[1];
  const row = placeMode[0];
  // 贴边就是真的贴边：左/上放 0，右/下让窗口外沿落在视口边线上。
  const left = col === 'l' ? 0 : col === 'r' ? Math.max(0, vw - w) : Math.max(0, (vw - w) / 2);
  const top = row === 't' ? 0 : row === 'b' ? Math.max(0, vh - h) : Math.max(0, (vh - h) / 2);

  // body 是先 scale 再 translate，且 transform-origin 在中心，所以平移量不乘缩放，
  // 直接用「目标中心 - 视口中心」即可。
  const dx = left + w / 2 - vw / 2;
  const dy = top + h / 2 - vh / 2;
  host.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(var(--fit, 1))`;
  try { localStorage.setItem(PLACE_KEY, placeMode); } catch { /* 存不了就算 */ }
  const grid = document.getElementById('pos-grid');
  if (grid) {
    grid.querySelectorAll('.pos-cell').forEach((c) => {
      c.classList.toggle('on', c.dataset.place === placeMode);
    });
  }
}

const posGrid = document.getElementById('pos-grid');
if (posGrid) {
  posGrid.addEventListener('click', (e) => {
    const cell = e.target.closest('.pos-cell');
    if (!cell) return;
    applyPlace(cell.dataset.place);
    hideCtxMenu();
  });
}

try {
  const saved = localStorage.getItem(PLACE_KEY);
  if (saved) applyPlace(saved);
} catch { /* 读不到就默认居中 */ }

// 调试用：?place=bc 之类的参数直接指定落点，方便无头截图核对贴边（正常打开不受影响）。
try {
  const forced = new URLSearchParams(location.search).get('place');
  if (forced && /^(tl|tc|tr|ml|mc|mr|bl|bc|br)$/.test(forced)) applyPlace(forced);
} catch { /* 参数不合法就忽略 */ }
window.addEventListener('resize', () => applyPlace(placeMode));

const el = {
  win: $('win'),
  scene: $('scene'),
  lines: $('lines'),
  input: $('input'),
  titlebar: $('titlebar'),
  tbText: $('tb-text'),
  cbText: $('cb-text'),
  person: [...document.querySelectorAll('.art img')],
};

const state = {
  pet: null,            // 桌宠对话面板（气泡通道），收发都在这条上
  petOpen: false,
  backfill: false,      // 正在回填历史：不走打字机、不逐行滚到底
  said: new Set(),      // 已上屏文本，回显与增量去重
  typing: false,
  queue: [],
  act: 'idle',
  group: 'idle',        // 当前在播哪一组：idle / talk / sigh
  actTimer: 0,
  idleTimer: 0,
  ambientTimer: 0,      // 空闲随机换动作的定时器
};

/* ── 本地窗口控制 ────────────────────────────────────────────────────────────
   三个假按钮真的去动窗口：请求打到 18800 的 /elymes-api/win。
   不能用 window.close()——那只关得掉脚本自己开的窗。                     */
function winCtl(action, query = '') {
  return fetch(`/elymes-api/win?action=${action}${query}`)
    .then((r) => r.json())
    .catch(() => ({ ok: false }));
}

/* ── 立绘三态 ────────────────────────────────────────────────────────────────
   静候4 / 说话5 / 叹气6，同一时刻只有一张 opacity:1。
   节奏放慢：240ms 一轮的说话帧太快，在 300px 小窗上看着像抽抾。
   同帧不重绘：setAct 连续调两次同一种时直接返回，不重建定时器。*/
const FRAMES = {
  idle: ['idle1', 'idle2', 'idle3', 'idle4'],
  talk: ['talk1', 'talk2', 'talk3', 'talk4', 'talk5'],
  sigh: ['sigh1', 'sigh2', 'sigh3', 'sigh4', 'sigh5', 'sigh6'],
};
const SPEED = { idle: 900, talk: 320, sigh: 700 };

function paintAct(name) {
  for (const img of el.person) img.classList.toggle('on', img.dataset.act === name);
  state.act = name;
}

function loopActs(frames, ms) {
  clearInterval(state.actTimer);
  let i = 0;
  paintAct(frames[0]);
  state.actTimer = setInterval(() => {
    i = (i + 1) % frames.length;
    paintAct(frames[i]);
  }, ms + Math.random() * 120);
}

function setAct(name) {
  clearTimeout(state.idleTimer);
  if (name === 'hold') return;                  // 停帧：保持当前不动
  // 注意：state.act 存的是当前帧名（idle2 这种），拿组名去比永远不相等，
  // 所以另用 state.group 记录「现在播的是哪一组」。
  const group = name === 'talk' ? 'talk' : name === 'sigh' ? 'sigh' : 'idle';
  if (group === state.group && state.actTimer) return;  // 同一组不重排，否则每次都从第 1 帧重头
  state.group = group;
  if (group === 'talk') loopActs(FRAMES.talk, SPEED.talk);
  else if (group === 'sigh') loopActs(FRAMES.sigh, SPEED.sigh);
  else loopActs(FRAMES.idle, SPEED.idle);
}

/** 说完一段时间后回静候。拖太久会一直张着嘴，看着像卡住。 */
function restAfter(ms = 1600) {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => setAct('idle'), ms);
}

/* ── 空闲随机动作 ─────────────────────────────────────────────────────────────
   两组入口：点标题栏那个小图标（随机换一种）、放着不管时每 8~20 秒自己换一次。
   让位规则：正在打字不打断（打完照旧回静候）；右键面板开着不换（动作在面板底下乱跳很怪）。*/
const ACT_MIX = [['idle', 50], ['sigh', 35], ['talk', 15]];   // 用户定的权重：静候 50 / 叹气 35 / 说话 15
const ACT_HOLD = { idle: 3600, sigh: 4200, talk: 1900 };       // 一组帧跑完大致要这么久
const AMBIENT_MIN = 8000;
const AMBIENT_SPAN = 12000;                                     // 8~20 秒

function menuOpen() {
  return !!(ctxMenu && ctxMenu.classList.contains('show'));
}

function pickAct() {
  let r = Math.random() * 100;
  for (const [name, w] of ACT_MIX) {
    if (r < w) return name;
    r -= w;
  }
  return 'idle';
}

/** 播一种动作，播完回静候并重新起算下次间隔。返回是否真的换了。 */
function playAct(name) {
  if (state.typing || menuOpen()) return false;
  setAct(name);
  clearTimeout(state.ambientTimer);
  state.ambientTimer = setTimeout(() => {
    if (!state.typing) setAct('idle');
    scheduleAmbient();
  }, ACT_HOLD[name] + Math.random() * 800);
  return true;
}

function scheduleAmbient(wait) {
  clearTimeout(state.ambientTimer);
  const ms = wait || (AMBIENT_MIN + Math.random() * AMBIENT_SPAN);
  state.ambientTimer = setTimeout(() => {
    if (state.typing || menuOpen()) { scheduleAmbient(3000); return; }   // 让位，过会儿再看
    playAct(pickAct());
  }, ms);
}

/** 点图标：随机换一种，避开当前正在播的那组，否则点一下什么都不会发生。 */
function nextRandomAct() {
  for (let i = 0; i < 4; i += 1) {
    const name = pickAct();
    if (name !== state.group) { playAct(name); return; }
  }
  playAct(pickAct());
}

/* ── 打字机 ──────────────────────────────────────────────────────────────────
   逐字 18ms 加标点停顿，接近手写节奏；光标是独立 span，打完就抽走。
   打字期间切到说话帧，打完回静候。                                        */
const PAUSE = { '，': 120, '。': 180, '！': 200, '？': 180, '、': 90, '…': 150, '\n': 200 };

function typeLine(node, text, done) {
  let i = 0;
  state.typing = true;
  setAct('talk');
  const caret = document.createElement('span');
  caret.className = 'caret';
  node.appendChild(caret);

  const step = () => {
    if (i >= text.length) {
      caret.remove();
      state.typing = false;
      restAfter();
      done && done();
      return;
    }
    const ch = text[i++];
    caret.before(document.createTextNode(ch));
    scrollBottom();
    setTimeout(step, 18 + (PAUSE[ch] || 0));
  };
  step();
}

function scrollBottom() {
  el.lines.scrollTop = el.lines.scrollHeight;
}

/* ── 上屏 ────────────────────────────────────────────────────────────────────
   1) 同一条话不能出现两次（chat 与 debug 会给同一句）
   2) 角色说话走打字机，玩家自己的话直接上屏
   3) 上一条还在打时，新话先排队                                              */
function addLine(role, text, force) {
  const t = (text || '').trim();
  if (!t) return;
  // force 用在自己刚发出去的那句：同一句话连说两遍也要两行，回显靠 said 去重。
  if (!force && state.said.has(t)) return;
  state.said.add(t);
  if (state.said.size > 400) state.said = new Set([...state.said].slice(-200));

  const div = document.createElement('div');
  div.className = 'line' + (role === 'user' ? ' me' : role === 'sys' ? ' sys' : '');
  el.lines.appendChild(div);

  // 回填历史：直接上屏，不排队、不逐字滚。否则一开窗就是几十行打字机 + 每字 scrollBottom，
  // 正是「历史消息注入时疯狂滚聊天框」的根源。
  if (state.backfill) { div.textContent = t; return; }

  if (role === 'user' || role === 'sys') {
    div.textContent = t;
    scrollBottom();
    return;
  }
  state.queue.push({ div, text: t });
  pumpQueue();
}

function pumpQueue() {
  if (state.typing || !state.queue.length) return;
  const job = state.queue.shift();
  typeLine(job.div, job.text, pumpQueue);
}

/* ── 从气泡面板里抠人话 ────────────────────────────────────────────────────
   桌宠对话面板的条目（item）只有两种跟聊天有关：
     kind:user —— 人说的话，via 记着来源（bubble 气泡框 / chat 对话页 / voice）
     kind:say  —— 她「说出口」的话，beats 里每段算一句
   其余 ask（提问）/ touch（摸头）/ figure（换装）/ activity（工具流水）
   不是对话，不往聊天框里塞。                                              */
const NOISE = ['[system]', '[turn', '[console', '记忆快照', '生态箱', '信箱'];
const isNoise = (s) => NOISE.some((w) => s.includes(w));

function cleanText(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 1200 || isNoise(t)) return '';
  return t;
}

function rowsFromItem(item) {
  if (!item) return [];
  if (item.kind === 'user') {
    const text = cleanText(item.text);
    return text ? [{ role: 'user', text }] : [];
  }
  if (item.kind === 'say') {
    const out = [];
    for (const b of Array.isArray(item.beats) ? item.beats : []) {
      const text = cleanText(b && b.text);
      if (text) out.push({ role: 'assistant', text });
    }
    return out;
  }
  return [];
}

/* 历史只回填最近几条：面板一次给全量（实测 297 条），全画会刷屏。
   回填期间不走打字机，见 addLine 里的 state.backfill。                      */
const BACKFILL = 5;

function backfill(items) {
  el.lines.innerHTML = '';
  state.said.clear();
  state.queue.length = 0;
  const rows = [];
  for (const it of items || []) for (const r of rowsFromItem(it)) rows.push(r);
  state.backfill = true;
  for (const r of rows.slice(-BACKFILL)) addLine(r.role, r.text);
  state.backfill = false;
  scrollBottom();
  setAct('idle');
}
/* ── 气泡通道：收发都走桌宠对话面板 ─────────────────────────────────────── */
function applyPetFrame(f) {
  if (!f) return;
  if (f.t === 'init') { backfill(f.items); return; }
  if (f.t === 'item') {
    for (const r of rowsFromItem(f.item)) addLine(r.role, r.text);
    return;
  }
  if (f.t === 'rejected') {
    addLine('sys', typeof f.reason === 'string' && f.reason ? f.reason : '（这条没发出去）');
    return;
  }
  if (f.t === 'notice' && typeof f.text === 'string') { addLine('sys', f.text); return; }
  // older / sent / withdrawn / settled / phase / ask / paused / bot / activity / draft
  // 都跟这一格聊天框无关，静默跳过。
}

function openPet() {
  try { state.pet = new WebSocket(WS('/ws/pet')); } catch { setTimeout(openPet, 2000); return; }
  state.pet.onopen = () => {
    state.petOpen = true;
    state.pet.send(JSON.stringify({ t: 'hello' }));   // 要历史就必须先 hello
  };
  state.pet.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    applyPetFrame(f);
  };
  state.pet.onclose = () => { state.petOpen = false; sighOnce(); setTimeout(openPet, 2000); };
  state.pet.onerror = () => { try { state.pet.close(); } catch {} };
}
/* 断线时叹一口气。重连是每 2 秒一次的，所以做 10 秒节流，不然会一直叹气。 */
let sighAt = 0;
function sighOnce() {
  const now = Date.now();
  if (now - sighAt < 10000) return;
  sighAt = now;
  setAct('sigh');
  restAfter(1800);
}

/* ── 发消息 ────────────────────────────────────────────────────────────────
   发到面板 send 的消息会被记成 via=chat（与她在对话页里自己打的一样），
   但模型收到的文本与气泡框打字完全相同：「[typed] 名字: 内容」。
   旧版的 hello + msg 是控制台通道的口令，会被标上 [console|PIN]，已停用。 */
let sendSeq = 0;

function send() {
  const text = (el.input.value || '').trim();
  if (!text) return;
  if (!state.pet || state.pet.readyState !== 1) {
    addLine('sys', '（还没连上，稍等一下再试）');
    return;
  }
  const id = 'ui2-' + Date.now().toString(36) + '-' + (sendSeq++);
  state.pet.send(JSON.stringify({ t: 'send', id, text }));
  addLine('user', text, true);   // 自己说的话立即上屏，不等回显
  el.input.value = '';
  if (window.ntMaybeTrigger) window.ntMaybeTrigger(text);   // 关键词彩蛋（nt-trigger.js）
  setAct('idle');
}
function mountWindowChrome() {
  $('btn-min').addEventListener('click', () => { el.win.classList.add('is-hidden'); winCtl('min'); });
  $('btn-max').addEventListener('click', () => winCtl('max'));
  $('btn-close').addEventListener('click', () => winCtl('close'));

  // 最小化后页面不可见；拉回来时要取消缩放态，否则是空白
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) el.win.classList.remove('is-hidden');
  });

  /* 拖动：发一次 WM_NCLBUTTONDOWN(HTCAPTION) 让 Windows 自己拖，
     比每帧算差分跟手（旧版踩过的坑）。                                    */
  el.titlebar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tb-btn')) return;
    winCtl('drag');
  });
}

/* ── 缩放热区 ────────────────────────────────────────────────────────────────
   1. 基准尺寸必须问服务端（winCtl('state')），不能用 window.innerWidth。
   2. 只按被拖的那条边算，否则看起来就是「左右同时拉伸」。
   3. screenX 是 CSS 像素，Win32 要物理像素，乘 devicePixelRatio。        */
const RZ_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function setupResize() {
  for (const dir of RZ_DIRS) {
    const grip = document.createElement('div');
    grip.className = `rz rz-${dir}`;
    el.win.appendChild(grip);
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      void beginResize(e, dir, grip);
    });
  }
}

async function beginResize(e, dir, grip) {
  const st = await winCtl('state').catch(() => null);
  if (!st || !st.ok) return;

  const baseW = st.w;
  const baseH = st.h;
  const sx = e.screenX;
  const sy = e.screenY;
  const dpr = window.devicePixelRatio || 1;
  const minW = Math.round(MIN_W * dpr);
  const minH = Math.round(MIN_H * dpr);

  let lastW = baseW;
  let lastH = baseH;
  let pending = false;

  const onMove = (ev) => {
    const dx = (ev.screenX - sx) * dpr;
    const dy = (ev.screenY - sy) * dpr;
    let w = baseW;
    let h = baseH;
    if (dir.includes('e')) w = baseW + dx;
    if (dir.includes('w')) w = baseW - dx;
    if (dir.includes('s')) h = baseH + dy;
    if (dir.includes('n')) h = baseH - dy;
    w = Math.max(minW, Math.round(w));
    h = Math.max(minH, Math.round(h));
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      void winCtl('resize', `&w=${lastW}&h=${lastH}&edge=${dir}`);
    });
  };

  const onUp = () => {
    grip.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('blur', onUp);
  };

  grip.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('blur', onUp);
}

/* ── 离线演示 ────────────────────────────────────────────────────────────────
   直接双击 ui2.html（file://）时没有 18800，WebSocket 连不上。
   这里不打 WS，改用一段打字机演示，方便单独验收排版。                       */
function demo() {
  addLine('sys', '（离线预览：从插件里打开才会连上聊天服务）');
  addLine('assistant', '……这里是档案室。你把我叫出来，是想看看新换的窗口？');
}

/* ── 标题上的名字：服务端有显示名就用它，没有就保持默认的「伊洛伊」 ──────── */
function fetchName() {
  fetch('/api/status')
    .then((r) => r.json())
    .then((j) => {
      const n = (j && (j.displayName || j.name)) || '';
      if (!n) return;
      if (el.tbText) el.tbText.textContent = `正在与 ${n} 聊天……`;
      if (el.cbText) el.cbText.textContent = `${n} · 聊天`;
    })
    .catch(() => {});
}

/* ── 启动 ────────────────────────────────────────────────────────────────── */
window.__ui2Loaded = true;

function boot() {
  // 诊断条默认关闭：正式使用时它会在左上角压一块黑底绿字。
  // 排障时在地址后加 ?diag=1 就会重新出现（可和 ?place=bc 一起用），
  // 不用改代码——上一轮定位贴底/缩放问题全靠它，删了以后还得再写一遍。
  const wantDiag = /(^|[?&])diag=1(&|$)/.test(location.search);
  const lines = [];
  let bar = null;
  const put = (s) => {
    if (!bar) return;
    lines.push(s);
    bar.textContent = lines.join('\n');
  };

  if (wantDiag) {
    bar = document.createElement('div');
    bar.id = 'diag';
    bar.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483647;background:#000;color:#0f0;'
      + 'font:11px/1.5 Consolas,monospace;padding:2px 4px;white-space:pre;pointer-events:none;'
      + 'margin:0;border:0;-webkit-app-region:no-drag;app-region:no-drag';
    // body 上有 transform + overflow:hidden，附属在上面的定位元素会被它带着走，
    // 所以挂到 documentElement 上，光靠坐标就能把它钉在真正的左上角。
    document.documentElement.appendChild(bar);
    window.addEventListener('error', (e) => put('ERR ' + e.message + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno));
    put('script=' + (document.currentScript ? document.currentScript.src.split('/').pop() : '?'));
  }

  try {
    start(put);
  } catch (err) {
    put('BOOT FAIL ' + (err && err.message ? err.message : String(err)));
    // 没有诊断条时至少留个控制台痕迹，不至于静默白屏。
    console.error('[ui2] boot failed:', err);
  }
}

function start(put) {
  mountWindowChrome();
  setupResize();

  // 15 张都是 160~230KB 的 PNG，浏览器默认「显示时才解码」，切帧那一刻
  // 才去解码就会闪一帧空白。开场全部 decode 进缓存，之后切帧只改 opacity。
  for (const img of el.person) {
    if (img.decode) { img.decode().catch(() => {}); }
    else { const pre = new Image(); pre.src = img.getAttribute('src') || img.src; }
  }

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('send').addEventListener('click', send);

  setAct('idle');

  // 标题栏左上角那个小图标：点一下随机换一种动作
  const icon = $('tb-icon');
  if (icon) {
    icon.addEventListener('click', (e) => { e.stopPropagation(); nextRandomAct(); });
    icon.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nextRandomAct(); }
    });
  }
  scheduleAmbient();

  attachHostMouse();
  reportEnv(put);

  if (FILE_MODE) { setTimeout(demo, 500); return; }
  fetchName();
  openPet();
}

function reportEnv(put) {
  // 把关键尺寸接到诊断条上：视口、宿主、聊天框的实际矩形与计算样式。
  const host = !!window.petHost;
  const hasSet = !!(window.petHost && typeof window.petHost.setInteractive === 'function');
  const isEdge = /Edg\//.test(navigator.userAgent);
  const box = document.getElementById('chatbox');
  const scene = document.getElementById('scene');
  const cb = box ? getComputedStyle(box) : null;
  const sc = scene ? getComputedStyle(scene) : null;
  const cbRect = box ? box.getBoundingClientRect() : null;
  const scRect = scene ? scene.getBoundingClientRect() : null;
  const log = typeof put === 'function' ? put : () => {};
  log(`vp=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`);
  log(`host=${host ? 'Y' : 'N'} setInt=${hasSet ? 'Y' : 'N'} ${isEdge ? 'Edge' : 'Br'}`);
  log(`scene=${sc ? sc.position : '?'} ${scRect ? Math.round(scRect.width) + 'x' + Math.round(scRect.height) : '?'}`);
  log(`cb=${cb ? cb.position : '?'} ${cbRect ? Math.round(cbRect.width) + 'x' + Math.round(cbRect.height) : '?'}`);
  log(`cb css w=${cb ? cb.width : '?'} h=${cb ? cb.height : '?'}`);
}

function attachHostMouse() {
  // 宿主窗口铺满整个工作区，所以「谁拿鼠标」必须靠位置判定，不能常驻持有。
  // 依据（resources\app\node_modules\cortico-world-desktop-pet\host\electron-main.cjs:415-436）：
  // 光标坐标是 DIP 减去窗口左上角，宿主注释写明「页面拿它当 CSS 像素做命中判定」，
  // 所以和 getBoundingClientRect 同源，可以直接比较。之前那句「两套坐标对不上」是错的。
  const HOST = window.petHost || null;
  if (!HOST || typeof HOST.setInteractive !== 'function') return;

  const inMenu = () => !!(ctxMenu && ctxMenu.classList.contains('show'));
  const inWin = () => {
    const win = document.getElementById('win');
    return win ? win.getBoundingClientRect() : null;
  };
  const hit = (x, y) => {
    const r = inWin();
    if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    if (ctxMenu) {
      const m = ctxMenu.getBoundingClientRect();
      if (x >= m.left && x <= m.right && y >= m.top && y <= m.bottom) return true;
    }
    return false;
  };

  // 持有权是 1.5 秒租约（host\mouse-lease.cjs:28）：只在状态变化时报一次会过期，
  // 所以持有期间每次光标报告都续一次；放手时不续，租约自然到期。
  let held = false;
  const push = (want) => {
    if (!want) {
      if (!held) return;
      held = false;
      try { HOST.setInteractive(false); } catch { /* 宿主不认就作罢 */ }
      return;
    }
    held = true;
    try { HOST.setInteractive(true); } catch { /* 宿主不认就作罢 */ }
  };

  let seen = false;
  const verdict = (p) => {
    ui2Cursor = p;
    if (inMenu()) { push(true); return; }   // 面板开着就一直捉着，否则鼠标一离开面板就点不动了
    if (!p) { push(false); return; }        // 光标不在窗口上
    const over = hit(p.x, p.y);
    push(over);
    if (!seen) {
      seen = true;
      const diag = document.getElementById('diag');
      if (diag) {
        const r = inWin();
        diag.appendChild(document.createTextNode(
          `\ncur=${Math.round(p.x)},${Math.round(p.y)} over=${over ? 'Y' : 'N'}`
          + (r ? ` cbx=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : '')));
      }
    }
  };
  ui2Verdict = verdict;

  if (typeof HOST.onCursor === 'function') {
    HOST.onCursor((p) => verdict(p));
  } else {
    // 没有宿主光标通道（被当普通网页打开）时，只能靠页面自己的 mousemove。
    window.addEventListener('mousemove', (e) => {
      if (inMenu()) return;
      push(hit(e.clientX, e.clientY));
    });
  }
}

boot();
