/* ==========================================================================
   crt.js —— 新聊天窗的行为层

   与旧 window.js 的关系：只搛了一部分骨架（历史回填、窗口按钮、拖动缩放），
   其余（四个面板、设置表单、表情条、菜单）全部不要——新界面没有这些容身之处，
   旧页面原样留在 /window/index.html。

   协议（三页一致，改了一边就得三边一起改）：
     连   ws://…/ws/pet  —— 18800 转发到 Core 的 world:desktop-pet 对话面板
     问   {"t":"hello"}  —— 要历史；答 {"t":"init",items,…}
     发   {"t":"send","id":"…","text":"…"} —— 答 {"t":"sent"|"rejected"}
     增量 {"t":"item",item} —— kind:user 是人说的，kind:say 是她说的
   气泡框里打的字、她说出口的话都在上面；从这里发出去也按气泡口吻进时间线。
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const WS = (p) => `ws://${location.host}${p}`;

// ── 等比缩放 ────────────────────────────────────────────────────────────────
// 设计稿固定 1000×760。窗口多大，整张稿子就按同一比例缩放（等比，不变形），
// 取较大的那个比例即「铺满」，多出来的边被裁掉，不会留黑边。
const DESIGN_W = 1000;
const DESIGN_H = 760;
const MIN_W = 520;
const MIN_H = 380;

function fitStage() {
  const k = Math.max(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  const html = document.documentElement;
  html.style.setProperty('--fit', String(Math.max(0.2, k)));

  // 算完再量一次真实渲染宽度修正误差。有些情况下（父层宽度、缩放叠加）
  // 算出来的比例和实际差一截，表现就是“设计稿小一圈、四周留黑边”。
  const box = document.getElementById('win');
  if (!box) { return; }
  const got = box.getBoundingClientRect().width;
  const want = DESIGN_W * Math.max(0.2, k);
  if (got > 1 && Math.abs(got - want) > 1) {
    html.style.setProperty('--fit', String(Math.max(0.2, k * (want / got))));
  }
}
fitStage();
window.addEventListener('resize', fitStage);
// 窗口是用 Win32 SetWindowPos 改的尺寸，页面这边拿到的 innerWidth/Height 可能晚几帧才更新。
// 只算一次会停在错误的比例上（表现为设计稿小一圈、四周留黑边），所以开场补算几次。
[0, 120, 400, 900, 1800].forEach((ms) => setTimeout(fitStage, ms));

const el = {
  win: $('win'),
  stage: $('stage'),
  lines: $('lines'),
  input: $('input'),
  titlebar: $('titlebar'),
  tbText: $('tb-text'),
  tagPlate: $('tag-plate'),
  clock: $('clock'),
  replay: $('btn-replay'),
  person: [...document.querySelectorAll('.person img')],
  card: document.querySelector('.side .card'),
};

const state = {
  pet: null,            // 桌宠对话面板（气泡通道），收发都在这条上
  petOpen: false,
  backfill: false,      // 正在回填历史：不走打字机、不逐行滚到底
  said: new Set(),      // 已经上屏的文本，回显与增量去重用
  typing: false,
  queue: [],            // 正在打字时新来的话先排队，不打架
  act: 'say1',
  actTimer: 0,
  idleTimer: 0,
};

/* ── 本地窗口控制 ────────────────────────────────────────────────────────────
   三个贴图按钮不是装饰：请求打到 18800 的 /elymes-api/win，由服务端用 Win32
   去真的最小化 / 最大化 / 关闭。这一步不能用 window.close()——那只能关掉
   脚本自己开的窗，这里是浏览器开的，关不掉。                              */
function winCtl(action, query = '') {
  return fetch(`/elymes-api/win?action=${action}${query}`)
    .then((r) => r.json())
    .catch(() => ({ ok: false }));
}

/* ── 立绘状态机 ──────────────────────────────────────────────────────────────
   同一时刻只让一张立绘 opacity:1。说话时在 say1/say2 之间切（嘴张/嘴闭），
   指导时在 teach1/teach2 之间切，同时给舞台加 .guide 把兔头和星芒亮起来。
   切帧间隔带随机拖尾，跟旧版 FACES 里的 “ms + random*220” 一个思路，
   避免看起来像机械钟。                                                     */
function paintAct(act) {
  for (const img of el.person) img.classList.toggle('on', img.dataset.act === act);
  state.act = act;
}

function loopActs(frames, ms) {
  clearInterval(state.actTimer);
  let i = 0;
  paintAct(frames[0]);
  state.actTimer = setInterval(() => {
    i = (i + 1) % frames.length;
    paintAct(frames[i]);
  }, ms + Math.random() * 220);
}

function setAct(name) {
  clearTimeout(state.idleTimer);
  el.stage.classList.toggle('guide', name === 'guide');
  if (name === 'talk') loopActs(['say1', 'say2'], 300);
  else if (name === 'guide') loopActs(['teach1', 'teach2'], 520);
  else if (name === 'sad') loopActs(['sad1', 'sad2'], 480);
  else if (name === 'cross') { clearInterval(state.actTimer); paintAct('cross'); }
  else if (name === 'pull') { clearInterval(state.actTimer); paintAct('pull'); }
  else { clearInterval(state.actTimer); paintAct('say1'); }
}

/** 说完一段时间后回到常态。拖太久会一直张着嘴，看着像卡住。 */
function restAfter(ms = 4200) {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => setAct('idle'), ms);
}

/* ── 点吐司卡：随机演一个动作，演完自己回常态 ──────────────────────────
   为什么随机：固定成同一个就变成“按钮”了，随机才像被戳到有反应。
   为什么不打断说话：正在打字时切动作会把嘴型从说话帧上拉走，看着更怪。 */
const POKE_ACTS = ['cross', 'sad', 'guide', 'talk'];
let pokeTimer = 0;

function pokeOnce() {
  if (state.typing) return;
  clearTimeout(pokeTimer);
  const name = POKE_ACTS[Math.floor(Math.random() * POKE_ACTS.length)];
  setAct(name);
  pokeTimer = setTimeout(() => setAct('idle'), 2600);
}

/* ── 打字机 ──────────────────────────────────────────────────────────────────
   为什么自己写而不是用 CSS 动画：需要把“打过字”这个事件告诉状态机（切换
   说话动作），CSS 做得到但拿不到进度。逐字 18ms 加标点停顿，接近手写节奏。
   光标是独立的 <span class="caret">，打完就抽走。                        */
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
   三条约束：
     1) 同一条话不能出现两次（chat 和 debug 会给同一句，必须去重）
     2) 角色说话走打字机，玩家自己的话直接上屏
     3) 上一条还在打的时候新话先排队                                      */
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
  // 角色台词：排队，避免两句话同时打
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
  state.pet.onclose = () => { state.petOpen = false; setTimeout(openPet, 2000); };
  state.pet.onerror = () => { try { state.pet.close(); } catch {} };
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
  const id = 'crt-' + Date.now().toString(36) + '-' + (sendSeq++);
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

  // 窗口被最小化后页面不可见；再把窗口拉回来时要取消缩放态，否则是空白
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) el.win.classList.remove('is-hidden');
  });

  /* 拖动：按住标题栏空白处移动真实窗口。
     早先的做法是每帧比 screenX 差分、再发请求挪窗；能用但跟手差——
     窗口移动本身会触发重绘，帧率一掉就拖出手感断层。现在改成让 Windows
     自己拖：发一次 WM_NCLBUTTONDOWN(HTCAPTION)，系统接管整个拖动过程，
     松手才回到页面，代价是拖动期间拿不到 pointerup（也不需要）。      */
  el.titlebar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tb-btn')) return;
    winCtl('drag');
  });
}

/* ── 缩放热区 ────────────────────────────────────────────────────────────────
   窗口去边框后没有可拖的边缘，所以页面四周铺 8 个透明热区。

   两个关键点（都是踩过的坑）：
   1. 基准尺寸必须问服务端拿（winCtl('state')），不能用 window.innerWidth。
      innerWidth 是“网页内容区”，比窗口少一条 Edge 标题栏；拿它当目标尺寸
      发回去，等于每按一下就把窗口砍掉一条标题栏。
   2. 只按被拖的那条边算。拖东边时只有宽度变，若还去夹“右边界不越出屏幕”，
      会把窗口整体挪走，看起来就是“左右同时拉伸”。

   坐标换算：页面拿到的 screenX/screenY 是 CSS 像素，Win32 要物理像素，
   本机 devicePixelRatio≈1.476、系统 DPI 1.5，不换算会越拖越小。         */
const RZ_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function setupResize() {
  for (const dir of RZ_DIRS) {
    const grip = document.createElement('div');
    grip.className = `rz rz-${dir}`;
    // 挂到 html 而不是 body：body 带 translate(-50%,-50%) scale(--fit)，
    // position:fixed 的定位基准会变成被缩放的 body，热区整体错位。
    document.documentElement.appendChild(grip);
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

  // 左右拉的时候切到「推/拉窗口」立绘，让手朝向被拖的那侧（CSS 里再镜像）
  const playPull = dir.includes('e') || dir.includes('w');
  if (playPull) {
    setAct('pull');
    el.stage.classList.toggle('flip', dir.includes('w'));
  }

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
    if (playPull) {
      setAct('idle');
      el.stage.classList.remove('flip');
    }
  };

  grip.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('blur', onUp);
}

/* ── 启动 ────────────────────────────────────────────────────────────────── */
function tickClock() {
  const d = new Date();
  el.clock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function boot() {
  mountWindowChrome();
  setupResize();
  // 10 张立绘都是 100~130KB 的 PNG，浏览器默认是「显示时才解码」。
  // 切帧那一刻才去解码，就会出现一帧空白 —— 看着就是人物闪一下。
  // 所以在开场把它们全部 decode 进缓存，之后切帧只是改 opacity，不再等解码。
  for (const img of el.person) {
    if (img.decode) { img.decode().catch(() => {}); }
    else { const pre = new Image(); pre.src = img.getAttribute('src') || img.src; }
  }
  tickClock();
  setInterval(tickClock, 30000);

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('send').addEventListener('click', send);

  // 吐司卡（右上角那张像素头像）：点一下随机演一个动作，2.6 秒后自己回常态。
  if (el.card) { el.card.addEventListener('click', pokeOnce); }

  // 喇叭：把最后一句角色台词再说一遍（重播用，与上游无关）
  el.replay.addEventListener('click', () => {
    const all = [...el.lines.querySelectorAll('.line:not(.me):not(.sys)')];
    const last = all[all.length - 1];
    if (!last) return;
    const t = last.textContent.trim();
    if (!t) return;
    last.remove();
    state.said.delete(t);
    addLine('assistant', t);
  });

  openPet();
  setAct('idle');
}

boot();
