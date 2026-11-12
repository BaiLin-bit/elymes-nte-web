/**
 * 千禧年复古外壳 · WebUI 面板 bundle 的源码
 * ==========================================
 * 这个文件不直接进 dist：`tools/build.mjs` 会把下面那行 ART 占位换成内联的 base64 图片
 * （立绘 + 桌宠），产出 `dist/webui.js`。图片必须内联——宿主的扩展资产表只认
 * `webUiClient` 与 `webUiStyle` 两个文件，同目录的散图取不到。
 *
 * 模块被 import 的那一刻就把皮肤装上（不再等谁点面板），之后整页会话内一直生效。
 * 刷新页面后需要重新载入一次本模块（打开一次本面板即可），这是纯扩展包的边界。
 */

const ART = __ART__;

const KEY = 'millennium.skin.v1';

/** 默认设置。面板改的就是这份结构。 */
const DEFAULTS = {
  enabled: true,
  glitch: true,
  closeSendsX: true,
  portraitWidth: 320,
  idleFace: 'talk',
  faces: [
    {
      id: 'talk', label: '说话', frames: ['talk_1', 'talk_2', 'talk_3'], ms: 260,
      keys: ['嗯', '呢', '吧', '啊', '对', '好'],
    },
    {
      id: 'intro', label: '介绍', frames: ['intro_1', 'intro_2', 'intro_3'], ms: 460,
      keys: ['介绍', '我叫', '我是', '自我', '名字'],
    },
    {
      id: 'laugh', label: '捧腹大笑', frames: ['laugh_1', 'laugh_2'], ms: 220,
      keys: ['哈哈', '笑', '233', '嘿嘿', '呜呼', 'XD'],
    },
    {
      id: 'angry', label: '生气', frames: ['angry_1', 'angry_2', 'angry_3'], ms: 200,
      keys: ['生气', '哼', '讨厌', '可恶', '气死', '不许', '烦'],
    },
    {
      id: 'look', label: '张望', frames: ['look_1', 'look_2'], ms: 620,
      keys: ['看看', '在哪', '咦', '什么', '？'],
    },
  ],
  kaomoji: [
    '(｡･ω･｡)', '(๑•̀ㅂ•́)و✧', '( ˘ω˘ )', '(´；ω；`)', '(￣▽￣)',
    '(・∀・)', '(╯°□°）╯', '(づ｡◕‿‿◕｡)づ', '(๑´ω`๑)', '(⌐■_■)',
    '(=^･ω･^=)', 'ヽ(°〇°)ﾉ',
  ],
};

// ---------------------------------------------------------------- 设置读写

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readSettings() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch { /* 隐私模式 */ }
  if (!raw) return clone(DEFAULTS);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return clone(DEFAULTS);
    const out = clone(DEFAULTS);
    if (typeof parsed.enabled === 'boolean') out.enabled = parsed.enabled;
    if (typeof parsed.glitch === 'boolean') out.glitch = parsed.glitch;
    if (typeof parsed.closeSendsX === 'boolean') out.closeSendsX = parsed.closeSendsX;
    if (Number.isFinite(parsed.portraitWidth)) out.portraitWidth = Math.min(560, Math.max(180, parsed.portraitWidth));
    if (typeof parsed.idleFace === 'string') out.idleFace = parsed.idleFace;
    if (Array.isArray(parsed.faces) && parsed.faces.length > 0) {
      out.faces = parsed.faces.map((f) => ({
        id: String(f && f.id ? f.id : 'talk'),
        label: String(f && f.label ? f.label : '动作'),
        frames: Array.isArray(f && f.frames) ? f.frames.map(String) : [],
        ms: Number.isFinite(f && f.ms) ? Math.min(2000, Math.max(80, f.ms)) : 260,
        keys: Array.isArray(f && f.keys) ? f.keys.map(String) : [],
      }));
    }
    if (Array.isArray(parsed.kaomoji)) out.kaomoji = parsed.kaomoji.map(String);
    return out;
  } catch {
    return clone(DEFAULTS);
  }
}

function writeSettings(next) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* 写不进去就算了 */ }
}

// ------------------------------------------------------------------ 小工具

function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(inner) {
  const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrap.setAttribute('viewBox', '0 0 16 16');
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = inner;
  return wrap;
}

const ICONS = {
  smile: '<circle cx="8" cy="8" r="7" fill="#ffd93b" stroke="#8a6a12" stroke-width="1"/><rect x="5" y="5" width="1.6" height="2.2" fill="#4a3a08"/><rect x="9.4" y="5" width="1.6" height="2.2" fill="#4a3a08"/><path d="M4.6 9.2h6.8c-.4 2-1.8 3.2-3.4 3.2S5 11.2 4.6 9.2z" fill="#4a3a08"/>',
  photo: '<rect x="2" y="3" width="12" height="10" fill="#e9f2ff" stroke="#2a3f78" stroke-width="1"/><path d="M3 12l3.2-4 2.4 3 2-2.4 2.4 3.4z" fill="#3f7a4a"/><rect x="10.2" y="4.6" width="2" height="2" fill="#ffd93b"/>',
  letterA: '<rect x="2" y="1.5" width="12" height="13" fill="#fff" stroke="#2a3f78" stroke-width="1"/><path d="M5 11.5L8 4l3 7.5h-1.7l-.6-1.7H7.3l-.6 1.7z" fill="#1d2f6b"/>',
  letterX: '<rect x="2" y="1.5" width="12" height="13" fill="#fff" stroke="#8a2a3a" stroke-width="1"/><path d="M5 4.5l3 3 3-3 1.4 1.4-3 3 3 3L11 13.3l-3-3-3 3L3.6 11.9l3-3-3-3z" fill="#a32638"/>',
  gem: '<path d="M8 1.5l4.6 4.6L8 14.5 3.4 6.1z" fill="#9ee7ff" stroke="#2a6f9a" stroke-width="1"/><path d="M8 1.5v13M3.4 6.1h9.2" stroke="#2a6f9a" stroke-width=".7" opacity=".7"/>',
  image: '<rect x="2" y="3" width="12" height="10" fill="#f4f2ff" stroke="#2a3f78" stroke-width="1"/><circle cx="6" cy="6.4" r="1.2" fill="#ffb03b"/><path d="M3 12l3.4-3.6 2.2 2.2 1.8-1.8L13 12z" fill="#4a7f4a"/>',
};

function pickInput() {
  const areas = Array.from(document.querySelectorAll('textarea'));
  const visible = areas.filter((a) => a.offsetParent !== null && !a.disabled && !a.readOnly);
  if (visible.length) return visible[visible.length - 1];
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
  const vis = editables.filter((e) => e.offsetParent !== null);
  return vis.length ? vis[vis.length - 1] : null;
}

/** 往聊天输入框里塞文字。受控组件要靠原生 setter 才会认这次改动。 */
function insertText(text) {
  const input = pickInput();
  if (!input) return false;
  input.focus();
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    const next = input.value + text;
    if (setter && setter.set) setter.set.call(input, next);
    else input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.selectionStart = input.selectionEnd = next.length;
  } else {
    document.execCommand('insertText', false, text);
  }
  return true;
}

// ------------------------------------------------------------------ 状态

const state = {
  settings: readSettings(),
  chrome: null,
  emobar: null,
  portrait: null,
  portraitImg: null,
  portraitTag: null,
  currentFace: null,
  timers: [],
  observers: [],
  clockTimer: null,
  taskbar: null,
  installed: false,
};

// ---------------------------------------------------------------- 字体

const FONT_FAMILY = 'Poxiao Pixel CN 12';
let fontInjected = false;

/**
 * 字体数据只能内联在 JS 里：webui.css 是宿主从 /assets/<version>/ 发出来的，
 * 写在 CSS 里的 ../assets/fonts/xxx.woff2 会 404。
 */
function injectFont() {
  if (fontInjected) return;
  const url = (ART.font && ART.font.poxiao) || (ART.font && ART.font.fusion) || '';
  if (!url) return;
  const style = document.createElement('style');
  style.id = 'mln-font';
  style.textContent = "@font-face{font-family:'" + FONT_FAMILY + "';"
    + 'src:url(' + url + ") format('woff2');"
    + 'font-weight:400;font-style:normal;font-display:block;}';
  document.head.appendChild(style);
  fontInjected = true;
}

function later(fn, ms) {
  const id = window.setTimeout(fn, ms);
  state.timers.push(id);
  return id;
}

function clearTimers() {
  for (const id of state.timers) window.clearTimeout(id);
  state.timers.length = 0;
}

function disposeAll() {
  clearTimers();
  if (state.clockTimer) window.clearInterval(state.clockTimer);
  state.clockTimer = null;
  for (const ob of state.observers) ob.disconnect();
  state.observers.length = 0;
  state.chrome?.remove();
  state.emobar?.remove();
  state.taskbar?.remove();
  state.portrait?.remove();
  state.chrome = null;
  state.emobar = null;
  state.taskbar = null;
  state.portrait = null;
  state.portraitImg = null;
  state.portraitTag = null;
  state.currentFace = null;
  state.chatObserver = false;
  document.documentElement.classList.remove('mln-on', 'mln-min', 'mln-max');
  state.installed = false;
}

// ---------------------------------------------------------------- 立绘动画

function faceById(id) {
  const list = state.settings.faces;
  return list.find((f) => f.id === id) || list.find((f) => f.id === state.settings.idleFace) || list[0] || null;
}

function frameUrl(name) {
  const art = ART.portrait || {};
  return art[name] || '';
}

function playGlitch() {
  if (!state.settings.glitch || !state.portrait) return;
  const layer = state.portrait.querySelector('.mln-portrait-glitch');
  if (!layer) return;
  layer.removeAttribute('data-fire');
  void layer.offsetWidth;
  layer.setAttribute('data-fire', '1');
}

/** 切一个动作：换首帧 → 抖一下 → 依次补帧（伪插帧）。 */
function setFace(id, force) {
  if (!state.portraitImg) return;
  const face = faceById(id);
  if (!face) return;
  if (!force && state.currentFace === face.id) return;
  const frames = face.frames.filter((f) => frameUrl(f));
  if (!frames.length) return;

  state.currentFace = face.id;
  clearTimers();
  state.portraitImg.src = frameUrl(frames[0]);
  if (state.portraitTag) state.portraitTag.textContent = face.label;
  playGlitch();

  if (frames.length < 2) return;
  let i = 1;
  const tick = () => {
    const name = frames[i % frames.length];
    state.portraitImg.src = frameUrl(name);
    i += 1;
    later(tick, face.ms);
  };
  later(tick, face.ms);
}

/** 盯着聊天记录，命中关键词就换动作。 */
function watchChat(root) {
  const scan = () => {
    const text = (root.textContent || '').slice(-1400);
    if (!text) return;
    let best = null;
    for (const face of state.settings.faces) {
      for (const key of face.keys) {
        if (!key) continue;
        const at = text.lastIndexOf(key);
        if (at < 0) continue;
        if (!best || at > best.at) best = { at, face };
      }
    }
    if (best) setFace(best.face.id);
  };

  let pending = 0;
  const ob = new MutationObserver(() => {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      scan();
    }, 180);
  });
  ob.observe(root, { childList: true, subtree: true, characterData: true });
  state.observers.push(ob);
  scan();
}

// ------------------------------------------------------------------ 立绘层

function mountPortrait() {
  const live = document.querySelector('.liveview');
  if (!live) return null;
  if (state.portrait && state.portrait.isConnected) return state.portrait;

  const box = h('div', 'mln-portrait');
  const img = h('img', 'mln-portrait-img');
  img.alt = '';
  img.draggable = false;
  const glitch = h('div', 'mln-portrait-glitch');
  const tag = h('div', 'mln-portrait-tag', '待机');
  box.append(img, glitch, tag);
  live.appendChild(box);

  state.portrait = box;
  state.portraitImg = img;
  state.portraitTag = tag;
  state.currentFace = null;

  const idle = faceById(state.settings.idleFace);
  if (idle) {
    const frames = idle.frames.filter((f) => frameUrl(f));
    if (frames.length) img.src = frameUrl(frames[0]);
    setFace(idle.id, true);
  }
  return box;
}

// ---------------------------------------------------------------- 标题栏

/** 从 /api/status 里读到的桌宠名字（= bot 展示名）；空串表示还没读到。 */
let petNameCache = '';

/** 同步可用的名字：先看 rail、再看缓存。 */
function botName() {
  const node = document.querySelector('#rail .rail-name-text');
  const text = node && node.textContent ? node.textContent.trim() : '';
  return petNameCache || text || 'TA';
}

/**
 * 桌宠名字 = bot 展示名：先读 `/api/status` 的 displayName（rail 上显示的就是它），
 * 取不到再退到 Core 配置里的 `worlds.desktop-pet.user` 兜底。
 */
async function resolvePetName() {
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
  // 口径已定：桌宠名字就是 bot 展示名，先读它
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin' });
    if (res.ok) {
      const st = await res.json();
      const name = pick(st && st.displayName);
      if (name) {
        petNameCache = name;
        return name;
      }
    }
  } catch { /* 落到下一个来源 */ }
  try {
    const res = await fetch('/api/config', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      const groups = Array.isArray(data && data.groups) ? data.groups : [];
      const hit = groups.find((item) => item && item.group && item.group.id === 'world:desktop-pet');
      const name = pick(hit && hit.values ? hit.values['worlds.desktop-pet.user'] : '');
      if (name) {
        petNameCache = name;
        return name;
      }
    }
  } catch { /* 用 rail 上的字 */ }
  return '';
}

/** 名字到手后把标题栏文字补上。 */
function refreshTitleText() {
  const node = document.querySelector('.mln-tb-text');
  if (node) node.textContent = '正在与 ' + botName() + ' 聊天......';
}

function dropItem(label, hint, go) {
  const btn = h('button');
  btn.type = 'button';
  btn.append(h('span', null, label));
  if (hint) btn.append(h('small', null, hint));
  btn.addEventListener('click', () => {
    closeMenus();
    go();
  });
  return btn;
}

function closeMenus() {
  if (!state.chrome) return;
  for (const menu of state.chrome.querySelectorAll('.mln-menu')) menu.classList.remove('mln-open');
}

function buildMenu(label, letter, items) {
  const menu = h('div', 'mln-menu');
  const btn = h('button');
  btn.type = 'button';
  const u = h('u', null, letter);
  btn.append(u, document.createTextNode(label.slice(1)));
  const drop = h('div', 'mln-drop');
  for (const item of items) {
    if (item === '-') {
      drop.append(h('div', 'mln-sep'));
      continue;
    }
    drop.append(dropItem(item.label, item.hint, item.go));
  }
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.classList.contains('mln-open');
    closeMenus();
    if (!open) menu.classList.add('mln-open');
  });
  btn.addEventListener('mouseenter', () => {
    if (!state.chrome) return;
    const anyOpen = state.chrome.querySelector('.mln-menu.mln-open');
    if (anyOpen && !menu.classList.contains('mln-open')) {
      closeMenus();
      menu.classList.add('mln-open');
    }
  });
  menu.append(btn, drop);
  return menu;
}

function go(hash) {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  location.hash = hash;
}

function mountChrome() {
  const kernel = document.getElementById('kernel-root');
  if (!kernel) return null;
  if (state.chrome && state.chrome.isConnected) return state.chrome;

  const chrome = h('div', 'mln-chrome');

  // ---- 标题栏
  const bar = h('div', 'mln-titlebar');
  bar.setAttribute('data-kind', 'active');
  const icon = h('div', 'mln-tb-icon');
  const title = h('div', 'mln-tb-text', '正在与 ' + botName() + ' 聊天......');
  const btns = h('div', 'mln-tb-btns');

  const min = h('button', 'mln-tb-btn mln-tb-min');
  min.type = 'button';
  min.title = '最小化';
  min.setAttribute('aria-label', '最小化');
  min.addEventListener('click', () => {
    document.documentElement.classList.toggle('mln-min');
  });

  const max = h('button', 'mln-tb-btn mln-tb-max');
  max.type = 'button';
  max.title = '最大化';
  max.setAttribute('aria-label', '最大化');
  max.addEventListener('click', () => {
    document.documentElement.classList.toggle('mln-max');
  });

  const close = h('button', 'mln-tb-btn mln-tb-close');
  close.type = 'button';
  close.title = '关闭（往输入框发一个 X）';
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', () => {
    if (!state.settings.closeSendsX) {
      document.documentElement.classList.remove('mln-max', 'mln-min');
      return;
    }
    const ok = insertText('X');
    if (!ok) toast('找不到输入框，X 没发出去');
  });

  btns.append(min, max, close);
  bar.append(icon, title, btns);

  // ---- 菜单栏
  const menubar = h('div', 'mln-menubar');
  menubar.append(
    buildMenu('File', 'F', [
      { label: '控制台 · 对话', hint: '#/live', go: () => go('#/live') },
      { label: '使用量', hint: '#/usage', go: () => go('#/usage') },
      '-',
      { label: '刷新窗口外观', go: () => { reinstall(); } },
    ]),
    buildMenu('Edit', 'E', [
      { label: '设置', hint: '#/settings', go: () => go('#/settings') },
      { label: '外观', hint: '#/appearance', go: () => go('#/appearance') },
      '-',
      { label: '皮肤设置（本插件）', go: () => { go('#/world'); toast('在世界与插件里打开「千禧年外壳」面板'); } },
    ]),
    buildMenu('View', 'V', [
      { label: '世界与插件', hint: '#/world', go: () => go('#/world') },
      { label: '模型连接', hint: '#/providers', go: () => go('#/providers') },
      '-',
      { label: '立绘显隐', go: () => { togglePortrait(); } },
      { label: '抖动特效', go: () => { state.settings.glitch = !state.settings.glitch; writeSettings(state.settings); toast(state.settings.glitch ? '抖动：开' : '抖动：关'); } },
    ]),
    buildMenu('Help', 'H', [
      { label: '接入 · 模型连接', hint: '#/providers', go: () => go('#/providers') },
      { label: '人格与记忆', hint: '#/prompts', go: () => go('#/prompts') },
      { label: '诊断 · 使用量', hint: '#/usage', go: () => go('#/usage') },
      '-',
      { label: '本皮肤说明', go: () => { toast('纯扩展包皮肤：不改宿主，关掉扩展即恢复原样'); } },
    ]),
  );

  chrome.append(bar, menubar);
  kernel.appendChild(chrome);
  state.chrome = chrome;

  document.addEventListener('click', closeMenus);
  const ob = new MutationObserver(() => {
    const name = botName();
    if (title.textContent !== '正在与 ' + name + ' 聊天......') {
      title.textContent = '正在与 ' + name + ' 聊天......';
    }
  });
  const rail = document.querySelector('#rail');
  if (rail) ob.observe(rail, { childList: true, subtree: true, characterData: true });
  state.observers.push(ob);

  return chrome;
}

function togglePortrait() {
  if (state.portrait) {
    state.portrait.remove();
    state.portrait = null;
    state.portraitImg = null;
    state.portraitTag = null;
    state.currentFace = null;
    clearTimers();
    toast('立绘：隐藏');
    return;
  }
  const box = mountPortrait();
  if (!box) toast('当前不是聊天页，立绘只在控制台对话里出现');
  else toast('立绘：显示');
}

// ------------------------------------------------------------- 底部表情条

let letterIsX = false;

function mountEmobar() {
  if (state.emobar && state.emobar.isConnected) return state.emobar;

  const bar = h('div', 'mln-emobar');

  const smile = h('button', 'mln-embtn');
  smile.type = 'button';
  smile.title = '颜文字';
  smile.append(svg(ICONS.smile));
  smile.addEventListener('click', () => {
    const list = state.settings.kaomoji;
    if (!list.length) return toast('颜文字表是空的');
    insertText(list[Math.floor(Math.random() * list.length)]);
  });

  const pic = h('button', 'mln-embtn');
  pic.type = 'button';
  pic.title = '发图';
  pic.append(svg(ICONS.photo));
  pic.addEventListener('click', () => {
    const file = h('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.addEventListener('change', () => {
      const name = file.files && file.files[0] ? file.files[0].name : '';
      if (!name) return;
      insertText('[图片: ' + name + ']');
      toast('图名已填进输入框；真正发图走输入框的附件按钮');
    });
    file.click();
  });

  const letter = h('button', 'mln-embtn');
  letter.type = 'button';
  letter.title = 'A / X';
  const paintLetter = () => {
    letter.replaceChildren(svg(letterIsX ? ICONS.letterX : ICONS.letterA));
  };
  paintLetter();
  letter.addEventListener('click', () => {
    letterIsX = !letterIsX;
    paintLetter();
  });

  const gem = h('button', 'mln-embtn');
  gem.type = 'button';
  gem.title = '装饰';
  gem.append(svg(ICONS.gem));
  gem.addEventListener('click', () => toast('这颗钻石只是装饰'));

  const sep = h('div', 'mln-emsep');
  const emojis = h('div', 'mln-emojis');
  const paintKaomoji = () => {
    emojis.replaceChildren();
    for (const text of state.settings.kaomoji) {
      const btn = h('button', 'mln-kaomoji', text);
      btn.type = 'button';
      btn.addEventListener('click', () => insertText(text));
      emojis.append(btn);
    }
  };
  paintKaomoji();

  bar.append(smile, pic, letter, gem, sep, emojis);

  // 图一里这条表情栏在窗口内部、输入框上方。找不到输入框就退回屏幕底部。
  const live = document.querySelector('.liveview');
  const composerEl = live
    ? (live.querySelector('.prompt-input-host') || live.querySelector('.composer') || live.querySelector('.prompt'))
    : null;
  if (composerEl && composerEl.parentElement) {
    composerEl.parentElement.insertBefore(bar, composerEl);
    bar.dataset.place = 'inline';
  } else {
    bar.dataset.place = 'fixed';
    document.body.appendChild(bar);
  }

  state.emobar = bar;
  state.paintKaomoji = paintKaomoji;
  // 桌面只留纯色底，不再挂任务栏；要恢复就把下一行解开。
  // mountTaskbar();
  return bar;
}

// 屏幕最底那条 Windows 任务栏（start + 时钟），表情栏搬到窗口内之后由它占位
function mountTaskbar() {
  if (state.taskbar && state.taskbar.isConnected) return state.taskbar;

  const tb = h('div', 'mln-taskbar');

  const start = h('button', 'mln-start');
  start.type = 'button';
  start.textContent = 'start';
  start.addEventListener('click', () => go('#/live'));

  const handle = h('div', 'mln-taskbtn');
  handle.append(svg(ICONS.smile), h('span', null, 'Coopanion'));

  const fill = h('div', 'mln-taskfill');

  const clock = h('div', 'mln-clock');
  const paintClock = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    clock.textContent = p(d.getHours()) + ':' + p(d.getMinutes());
    clock.title = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  paintClock();
  if (state.clockTimer) window.clearInterval(state.clockTimer);
  state.clockTimer = window.setInterval(paintClock, 20000);

  tb.append(start, h('div', 'mln-tasksep'), handle, fill, clock);
  document.body.appendChild(tb);
  state.taskbar = tb;
  return tb;
}

// -------------------------------------------------------------------- toast

let toastNode = null;
let toastTimer = 0;

function toast(text) {
  if (!toastNode) {
    toastNode = h('div', 'mln-toast');
    toastNode.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:64px', 'transform:translateX(-50%)',
      'z-index:9999', 'padding:5px 12px', 'max-width:70vw',
      'background:#ffe9a8', 'color:#3a2a00', 'font-size:12px',
      'border:1px solid #8a6a12',
      'box-shadow:inset 1px 1px 0 #fff, 2px 2px 0 rgba(0,0,0,.3)',
      'pointer-events:none', 'opacity:0', 'transition:opacity .15s linear',
    ].join(';');
    document.body.appendChild(toastNode);
  }
  toastNode.textContent = text;
  toastNode.style.opacity = '1';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (toastNode) toastNode.style.opacity = '0';
  }, 1800);
}

// ------------------------------------------------------------------ 装配

function applySettingsToDom() {
  const root = document.documentElement;
  root.style.setProperty('--mln-portrait-w', String(state.settings.portraitWidth) + 'px');
  state.paintKaomoji?.();
  if (state.portrait || state.settings.enabled) {
    if (state.portraitImg) setFace(state.currentFace || state.settings.idleFace, true);
  }
}

function syncRoute() {
  if (!state.settings.enabled) return;
  const hash = location.hash || '#/live';
  const isLive = hash === '' || hash === '#/' || hash.startsWith('#/live');
  if (isLive) {
    if (!state.portrait && state.settings.enabled) mountPortrait();
  } else if (state.portrait) {
    state.portrait.remove();
    state.portrait = null;
    state.portraitImg = null;
    state.portraitTag = null;
    state.currentFace = null;
    clearTimers();
  }
}

/**
 * 以前这里会把标题栏/立绘/表情栏塞进宿主页面，属于「盖一层」，做不到「换一套」，
 * 那条路已经废弃（宿主 DOM 全是 JS 生成 + Tailwind 原子类，盖上去只会叠两块）。
 * 现在真正的界面在独立窗口里（tools/window/），这份 bundle 只负责面板。
 * 这里只留字体注入，面板的像素字才有得用。
 */
function install() {
  state.settings = readSettings();
  injectFont();
  state.installed = true;
}

function reinstall() {
  install();
}

// 模块被 import 时装一次字体；不碰宿主页面的任何结构。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => install(), { once: true });
} else {
  install();
}

// ------------------------------------------------------------------- 面板

function el(tag, cls, text) {
  return h(tag, cls, text);
}

function mountSkinPanel(ctx) {
  const root = ctx && ctx.root ? ctx.root : document.body;
  const wrap = el('div', 'mln-panel');

  const head = el('h3', null, '千禧年复古外壳');
  const status = el('div', 'mln-panel-hint', '');
  const paintStatus = () => {
    const on = Boolean(state.settings && state.settings.enabled);
    status.textContent = on
      ? '聊天窗口是独立的一个 Edge 窗口，点下面的按钮打开；关掉它不影响 Coopanion。'
      : '皮肤未启用，下面设置仍会保存，但窗口按默认值渲染。';
  };

  // ── 窗口控制 ──────────────────────────────────────────
  const winRow = el('div', 'mln-panel-actions');
  const openBtn = el('button', null, '打开聊天窗口');
  openBtn.type = 'button';
  // 第二个入口：千禧风新界面（去边框、1000×760、自带缩放热区）。
  // 和旧界面共用同一套开窗逻辑，只是 page / 去边框不同。
  const openCrtBtn = el('button', null, '打开千禧风窗口');
  openCrtBtn.type = 'button';
  // 第三个入口：ui_2 素材版 2D 界面（同样去边框，页是 window/ui2.html）。
  const openUi2Btn = el('button', null, '打开 2D 聊天界面');
  openUi2Btn.type = 'button';
  const stateBtn = el('button', null, '检查窗口服务');
  stateBtn.type = 'button';
  const copyPortBtn = el('button', null, '复制端口');
  copyPortBtn.type = 'button';
  const copyUrlBtn = el('button', null, '复制地址');
  copyUrlBtn.type = 'button';
  const winState = el('div', 'mln-panel-hint', '');
  winRow.append(openBtn, openCrtBtn, openUi2Btn, stateBtn, copyPortBtn, copyUrlBtn);

  // 端口/地址由 world 侧决定，这里只记住最近一次拿到的值，没拿过就用兜底。
  let lastWin = null;
  const portOf = () => (lastWin && lastWin.port ? String(lastWin.port) : '18800');
  const hostOf = () => '127.0.0.1:' + portOf();
  const urlOf = () => (lastWin && lastWin.url ? lastWin.url : 'http://' + hostOf() + '/');

  /** 复制到剪贴板：先走 Clipboard API，被权限拦了就退回 execCommand。 */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制：' + text);
      return;
    } catch {
      /* 落到下面的退路 */
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    toast(ok ? '已复制：' + text : '复制失败，请手动选中复制');
  }

  const showWinState = (r) => {
    if (!r) return;
    lastWin = r;
    const bits = [];
    if (r.url) bits.push('地址 ' + r.url);
    if (r.port) bits.push('端口 ' + r.port);
    if (typeof r.running === 'boolean') bits.push(r.running ? '服务在线' : '服务未运行');
    if (r.serverStarted) bits.push('（刚拉起来）');
    if (r.reused) bits.push('（复用已开的窗口）');
    winState.textContent = bits.join(' · ');
  };

  copyPortBtn.addEventListener('click', () => void copyText(portOf()));
  copyUrlBtn.addEventListener('click', () => void copyText(urlOf()));

  openBtn.addEventListener('click', async () => {
    if (!ctx || typeof ctx.invoke !== 'function') {
      toast('这个宿主版本没有 invoke，打不开窗口');
      return;
    }
    openBtn.disabled = true;
    try {
      showWinState(await ctx.invoke('openWindow', []));
      toast('窗口已打开');
    } catch (err) {
      toast('打开失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      openBtn.disabled = false;
    }
  });

  // 新界面入口：同一个开窗逻辑，页不同（会先把旧窗关掉再开，两个不能同时开）。
  openCrtBtn.addEventListener('click', async () => {
    if (!ctx || typeof ctx.invoke !== 'function') {
      toast('这个宿主版本没有 invoke，打不开窗口');
      return;
    }
    openCrtBtn.disabled = true;
    try {
      showWinState(await ctx.invoke('openCrtWindow', []));
      toast('千禧风窗口已打开');
    } catch (err) {
      toast('打开失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      openCrtBtn.disabled = false;
    }
  });

  // 第三套界面入口：ui_2 素材版。走和桌宠同一条透明浮层通道（openUi2Layer），
  // 不再走 Edge --app 窗：那个窗自己铺不透明底，CSS 透明盖不过去。
  openUi2Btn.addEventListener('click', async () => {
    if (!ctx || typeof ctx.invoke !== 'function') {
      toast('这个宿主版本没有 invoke，打不开窗口');
      return;
    }
    openUi2Btn.disabled = true;
    try {
      showWinState(await ctx.invoke('openUi2Layer', []));
      toast('2D 聊天界面已打开');
    } catch (err) {
      toast('打开失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      openUi2Btn.disabled = false;
    }
  });

  stateBtn.addEventListener('click', async () => {
    try {
      showWinState(await ctx.invoke('windowState', []));
    } catch (err) {
      winState.textContent = '检查失败：' + (err && err.message ? err.message : String(err));
    }
  });

  // 桌宠窗口控制
  const petRow = el('div', 'mln-panel-row');
  const openPetBtn = el('button', null, '启动桌宠');
  openPetBtn.type = 'button';
  const closePetBtn = el('button', null, '关闭桌宠');
  closePetBtn.type = 'button';
  petRow.append(el('span', null, '桌宠窗口'), openPetBtn, closePetBtn);

  openPetBtn.addEventListener('click', async () => {
    if (!ctx || typeof ctx.invoke !== 'function') {
      toast('这个宿主版本没有 invoke，打不开桌宠');
      return;
    }
    openPetBtn.disabled = true;
    try {
      const r = await ctx.invoke('openPetWindow', []);
      toast('桌宠已启动：' + (r.url || ''));
    } catch (err) {
      toast('启动失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      openPetBtn.disabled = false;
    }
  });

  closePetBtn.addEventListener('click', async () => {
    if (!ctx || typeof ctx.invoke !== 'function') {
      toast('这个宿主版本没有 invoke');
      return;
    }
    closePetBtn.disabled = true;
    try {
      await ctx.invoke('closePetWindow', []);
      toast('桌宠已关闭');
    } catch (err) {
      toast('关闭失败：' + (err && err.message ? err.message : String(err)));
    } finally {
      closePetBtn.disabled = false;
    }
  });

  const draft = readSettings();

  const rowEnabled = el('div', 'mln-panel-toggle');
  const cbEnabled = el('input');
  cbEnabled.type = 'checkbox';
  cbEnabled.checked = draft.enabled;
  const lbEnabled = el('span', null, '启用千禧年皮肤');
  rowEnabled.append(cbEnabled, lbEnabled);

  const rowGlitch = el('div', 'mln-panel-toggle');
  const cbGlitch = el('input');
  cbGlitch.type = 'checkbox';
  cbGlitch.checked = draft.glitch;
  rowGlitch.append(cbGlitch, el('span', null, '切动作时抖一下（掩盖缺帧）'));

  const rowClose = el('div', 'mln-panel-toggle');
  const cbClose = el('input');
  cbClose.type = 'checkbox';
  cbClose.checked = draft.closeSendsX;
  rowClose.append(cbClose, el('span', null, '点标题栏 ✕ 往输入框发一个 X'));

  const rowWidth = el('div', 'mln-panel-row');
  const width = el('input');
  width.type = 'number';
  width.min = '180';
  width.max = '560';
  width.step = '10';
  width.value = String(draft.portraitWidth);
  rowWidth.append(el('span', null, '立绘宽度'), width);

  const facesBox = el('div', 'mln-face-list');
  const faceInputs = [];
  for (const face of draft.faces) {
    const item = el('div', 'mln-face-item');
    const first = (face.frames || []).find((f) => frameUrl(f));
    const thumb = el('img');
    if (first) thumb.src = frameUrl(first);
    thumb.alt = face.label;

    const right = el('div');
    right.style.display = 'grid';
    right.style.gap = '4px';

    const label = el('input');
    label.type = 'text';
    label.value = face.label;
    label.title = '动作名';

    const keys = el('textarea');
    keys.value = (face.keys || []).join('、');
    keys.placeholder = '关键词，用、或 , 分隔';
    keys.rows = 2;

    const ms = el('input');
    ms.type = 'number';
    ms.min = '80';
    ms.max = '2000';
    ms.step = '20';
    ms.value = String(face.ms);
    ms.title = '每帧毫秒';

    const line = el('div', 'mln-panel-actions');
    const play = el('button', null, '试播');
    play.type = 'button';
    play.addEventListener('click', () => {
      // 直接推给开着的聊天窗口；窗口没开就说清楚，别让人以为按钮坏了。
      if (!ctx || typeof ctx.invoke !== 'function') {
        toast('这个宿主版本没有 invoke，试播不可用');
        return;
      }
      play.disabled = true;
      Promise.resolve(ctx.invoke('skin', 'previewFace', [face.id]))
        .then((r) => {
          if (r && r.ok) toast(`已让它演一遍「${face.label}」`);
          else toast('试播失败：' + ((r && r.error) || '窗口没开'));
        }, (err) => toast('试播失败：' + (err && err.message ? err.message : String(err))))
        .then(() => { play.disabled = false; });
    });
    line.append(el('span', null, '帧间隔'), ms, el('span', null, 'ms'), play);

    right.append(label, keys, line);
    item.append(thumb, right);
    facesBox.append(item);
    faceInputs.push({ id: face.id, label, keys, ms });
  }

  const rowKaomoji = el('div', 'mln-panel-row');
  const kaomoji = el('textarea');
  kaomoji.rows = 3;
  kaomoji.value = (draft.kaomoji || []).join('\n');
  rowKaomoji.append(el('span', null, '颜文字'), kaomoji);

  const actions = el('div', 'mln-panel-actions');
  const save = el('button', null, '保存并应用');
  save.type = 'button';
  const reset = el('button', null, '恢复默认');
  reset.type = 'button';
  const exportBtn = el('button', null, '导出 JSON');
  exportBtn.type = 'button';
  actions.append(save, reset, exportBtn);

  const hint = el('div', 'mln-panel-hint',
    '关键词命中聊天记录里的最后一条时会切到对应动作。动作的帧来自 assets/portrait 里的同名图片；'
    + '想加动作：在打包时往 assets/portrait 放新图，再改这里的关键词即可。');

  // ── 导入立绘 ───────────────────────────────────────────
  const importBox = el('div', 'mln-import-box');
  importBox.append(el('div', 'mln-panel-sec', '导入立绘帧'));

  const importHint = el('div', 'mln-panel-hint',
    '选几张图，挑一个动作（或新起一个），点导入就会写进 assets/portrait/ 并记账到 manifest.json。'
    + '同一动作的帧按导入顺序追加在后面循环。重开聊天窗口后生效。');

  const faceIds = faceInputs.map((f) => f.id).concat(['think']);
  const importFace = el('select', 'mln-import-face');
  for (const id of faceIds) {
    const opt = el('option', null, id);
    opt.value = id;
    importFace.append(opt);
  }
  const optNew = el('option', null, '＋ 新动作…');
  optNew.value = '__new__';
  importFace.append(optNew);

  const importNewName = el('input', 'mln-import-newname');
  importNewName.type = 'text';
  importNewName.placeholder = '新动作名（小写字母/数字/下划线，如 wink）';
  importNewName.hidden = true;

  const importFiles = el('input', 'mln-import-files');
  importFiles.type = 'file';
  importFiles.accept = 'image/png,image/jpeg,image/webp';
  importFiles.multiple = true;

  const importBtn = el('button', null, '导入');
  importBtn.type = 'button';
  const importResult = el('div', 'mln-panel-hint', '');

  importFace.addEventListener('change', () => {
    importNewName.hidden = importFace.value !== '__new__';
  });

  importBtn.addEventListener('click', () => {
    const picked = Array.from(importFiles.files || []);
    if (!picked.length) {
      importResult.textContent = '先选图片。';
      return;
    }
    if (!ctx || typeof ctx.invoke !== 'function') {
      importResult.textContent = '这个宿主版本没有 invoke，导不了。';
      return;
    }
    const faceId = importFace.value === '__new__'
      ? String(importNewName.value || '').trim().toLowerCase()
      : importFace.value;
    if (!/^[a-z0-9_-]{1,24}$/.test(faceId)) {
      importResult.textContent = '动作名只能是 1–24 位小写字母、数字、下划线或短横线。';
      return;
    }
    importBtn.disabled = true;
    importResult.textContent = `正在读 ${picked.length} 张图……`;

    const readOne = (file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ face: faceId, name: file.name, base64: String(reader.result || '') });
      reader.onerror = () => resolve({ face: faceId, name: file.name, base64: '' });
      reader.readAsDataURL(file);
    });

    Promise.all(picked.map(readOne))
      .then((items) => ctx.invoke('skin', 'importPortrait', [items]))
      .then((r) => {
        if (!r || !r.ok) {
          const why = r && r.rejected && r.rejected.length ? r.rejected.join('；') : '没有写入任何文件';
          importResult.textContent = '导入失败：' + why;
          return;
        }
        const rejected = r.rejected && r.rejected.length ? `，跳过 ${r.rejected.length} 张` : '';
        importResult.textContent = `已导入 ${r.written.length} 张到「${faceId}」${rejected}。${r.note || ''}`;
        importFiles.value = '';
        toast(`已导入 ${r.written.length} 张，重开聊天窗口生效`);
      }, (err) => {
        importResult.textContent = '导入失败：' + (err && err.message ? err.message : String(err));
      })
      .then(() => { importBtn.disabled = false; });
  });

  importBox.append(
    importHint,
    el('div', 'mln-panel-row', el('span', null, '动作'), importFace, importNewName),
    el('div', 'mln-panel-row', el('span', null, '图片'), importFiles, importBtn),
    importResult,
  );

  wrap.append(
    head, status,
    winRow, winState,
    petRow,
    rowEnabled, rowGlitch, rowClose, rowWidth, facesBox, rowKaomoji, importBox, actions, hint,
  );
  root.append(wrap);
  paintStatus();

  // 挂载时先问一次端口/地址，这样「复制端口」不用点过别的按钮也是准的。
  if (ctx && typeof ctx.invoke === 'function') {
    Promise.resolve(ctx.invoke('windowState', [])).then(showWinState, (err) => {
      winState.textContent = '服务状态读取失败：' + (err && err.message ? err.message : String(err));
    });
  }

  save.addEventListener('click', () => {
    const next = {
      enabled: cbEnabled.checked,
      glitch: cbGlitch.checked,
      closeSendsX: cbClose.checked,
      portraitWidth: Number(width.value) || 320,
      idleFace: draft.idleFace,
      faces: faceInputs.map((f) => ({
        id: f.id,
        label: f.label.value.trim() || '动作',
        frames: (draft.faces.find((d) => d.id === f.id) || {}).frames || [],
        ms: Number(f.ms.value) || 260,
        keys: f.keys.value.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean),
      })),
      kaomoji: kaomoji.value.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    writeSettings(next);
    state.settings = next;
    if (next.enabled) install();
    else disposeAll();
    applySettingsToDom();
    paintStatus();
    toast('已保存');
  });

  reset.addEventListener('click', () => {
    writeSettings(clone(DEFAULTS));
    state.settings = clone(DEFAULTS);
    reinstall();
    toast('已恢复默认，重新打开本面板可看到新值');
  });

  exportBtn.addEventListener('click', () => {
    const text = JSON.stringify(readSettings(), null, 2);
    window.navigator.clipboard?.writeText(text).then(
      () => toast('设置已复制到剪贴板'),
      () => toast('复制失败，请手动导出'),
    );
  });

  return () => {
    wrap.remove();
  };
}

const PANELS = {
  skin: { mount: mountSkinPanel },
};

export default { panels: PANELS };
