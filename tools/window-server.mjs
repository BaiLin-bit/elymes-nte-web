/**
 * 窗口的本地服务。
 *
 * 为什么需要它：Core 的 WebSocket 握手会拒跨站 Origin（server.ts:812 的
 * isForeignOrigin），而浏览器开的 WS 一定带 Origin。Node 侧的 ws 客户端默认
 * 不带 Origin，所以这里做一层转发：窗口页面连本机（同源），本机再去连 Core。
 *
 * 端口固定 18800，只监听 127.0.0.1。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ws 是 CJS 包，用 createRequire 才拿得到真正的构造函数。
const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket: WsClient } = require('ws');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const WINDOW_DIR = path.join(HERE, 'window');
const ASSETS_DIR = path.join(PKG, 'assets');

const PORT = Number(process.env.ENW_PORT || 18800);
const CORE = process.env.ENW_CORE || 'http://127.0.0.1:17788';
const CORE_WS = CORE.replace(/^http/, 'ws');

/**
 * 宿主给的环境变量；没有就按扩展的标准位置往上推两级。
 * 这几个路径是「后端 UI」要碰的全部文件，都写死在这里，不做任意路径的服务端读写。
 */
/**
 * 宿主给的环境变量优先；没有就按扩展的标准位置往上推两级——Coopanion 下
 * 正好是 data/home 与 data/extensions。npm 单独安装时这两条兜底落空，
 * 对应面板显示「未配置」，其余功能照常。ENW_HOME 可以手工指路。
 */
const HOME_DIR = process.env.ENW_HOME || process.env.CORTICO_HOME || path.resolve(PKG, '../../home');
const EXT_DIR_RAW = process.env.CORTICO_EXTENSIONS_DIR || path.resolve(PKG, '..');
/** 被 npm 装进 node_modules 时，上一级不是扩展目录而是一堆包，宁可当没有。 */
const EXT_DIR = path.basename(EXT_DIR_RAW) === 'node_modules' ? '' : EXT_DIR_RAW;
const HOME_READY = fs.existsSync(HOME_DIR);
/** 桌宠设置存在扩展自己目录里，跟宿主配置分开，删扩展就一起清掉。 */
const STATE_DIR = path.join(PKG, 'state');
const PET_CONFIG_FILE = path.join(STATE_DIR, 'pet-config.json');
/**
 * 人格 = 宪法文件；记忆 = workspace/notes 下的条目；诊断 = logs/core.log。
 * 这三样是 Coopanion 的目录约定，不是本插件的必需品：宿主没给 home 目录时
 * 对应面板显示「未配置」，其余功能照常。非 Coopanion 环境可用 ENW_HOME 指路。
 */
const PERSONA_FILE = HOME_READY ? path.join(HOME_DIR, 'companion', 'workspace', 'CONSTITUTION.md') : '';
const NOTES_DIR = HOME_DIR ? path.join(HOME_DIR, 'companion', 'workspace', 'notes') : '';
const CORE_LOG = HOME_DIR ? path.resolve(HOME_DIR, '..', 'logs', 'core.log') : '';

/** 排障用：把 WS 转发事件写进 tools/ws.log，出问题看这个文件。 */
const WSLOG = path.join(HERE, 'ws.log');
function logWs(line) {
  try {
    fs.appendFileSync(WSLOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* 日志写不进去不影响主流程 */ }
}
try { fs.writeFileSync(WSLOG, `${new Date().toISOString()} ---- server start ----\n`); } catch { /* ignore */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};

/** 找得到哪个 Chromium 浏览器就用哪个，Edge 优先。 */
function findBrowser() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* 下一条 */ }
  }
  return null;
}

/** 聊天窗口：桌宠左键点一下开一个，短时间内的连点不重复开。 */
let chatChild = null;
let chatAt = 0;
function openChatWindow() {
  const now = Date.now();
  if (chatChild && !chatChild.killed && now - chatAt < 8000) return { reused: true };
  const browser = findBrowser();
  if (!browser) return { error: '没找到 Edge 或 Chrome' };
  try {
    chatChild = spawn(
      browser,
      [
        `--app=http://127.0.0.1:${PORT}/`,
        '--window-size=1120,740',
        '--no-first-run',
        '--disable-features=Translate,MediaRouter',
        '--autoplay-policy=no-user-gesture-required',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    chatChild.unref();
    chatAt = now;
    return { opened: true };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + path.basename(file));
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/** 只允许落在白名单目录里的相对路径，挡住 `../`。 */
function safeJoin(root, rel) {
  const target = path.resolve(root, '.' + path.posix.resolve('/', rel));
  return target.startsWith(root + path.sep) ? target : null;
}

// ── 后端 UI 用的小工具 ──────────────────────────────────
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 读 JSON 文件，坏了就当没有，不给页面抛异常。 */
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 先写临时文件再改名，半路挂掉不会留下半个 JSON。 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 换行都归一成 \n，避免 Windows 上的 CRLF 把 textarea 弄出多余空行。 */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 桌宠设置的默认值，和 pet.html 里的常量保持一致。 */
const PET_DEFAULTS = {
  size: 60,
  avoidIn: 130,
  avoidOut: 200,
  speed: 1,
  rest: true,
  restMsMin: 3500,
  restMsMax: 7000,
  restGapMin: 6000,
  restGapMax: 14000,
};

/** 存盘的设置可能是老版本、也可能被手工改坏，这里只认认识的字段并夹到合理区间。 */
function normalizePetConfig(raw) {
  const cfg = { ...PET_DEFAULTS };
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  if (raw && typeof raw === 'object') {
    cfg.size = Math.round(num(raw.size, 24, 200, PET_DEFAULTS.size));
    cfg.avoidIn = Math.round(num(raw.avoidIn, 20, 600, PET_DEFAULTS.avoidIn));
    cfg.avoidOut = Math.round(num(raw.avoidOut, cfg.avoidIn + 10, 900, Math.max(PET_DEFAULTS.avoidOut, cfg.avoidIn + 70)));
    cfg.speed = Math.round(num(raw.speed, 0.3, 3, PET_DEFAULTS.speed) * 100) / 100;
    cfg.rest = raw.rest !== false;
    cfg.restMsMin = Math.round(num(raw.restMsMin, 800, 60000, PET_DEFAULTS.restMsMin));
    cfg.restMsMax = Math.round(num(raw.restMsMax, cfg.restMsMin + 500, 120000, Math.max(PET_DEFAULTS.restMsMax, cfg.restMsMin + 500)));
    cfg.restGapMin = Math.round(num(raw.restGapMin, 1000, 600000, PET_DEFAULTS.restGapMin));
    cfg.restGapMax = Math.round(num(raw.restGapMax, cfg.restGapMin + 1000, 1200000, Math.max(PET_DEFAULTS.restGapMax, cfg.restGapMin + 1000)));
  }
  return cfg;
}

/** 读扩展清单：只挑出能认出来的名字与版本，页面拿到的就是一张表。 */
function listExtensions() {
  const out = [];
  if (!EXT_DIR) return out;
  let names = [];
  try {
    names = fs.readdirSync(EXT_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return out;
  }
  for (const name of names) {
    // _patches / _rescued / node_modules 这些是干活留下的目录，不是插件。
    if (name.startsWith('_') || name.startsWith('.') || name === 'node_modules') continue;
    const dir = path.join(EXT_DIR, name);
    let pkg = readJsonFile(path.join(dir, 'package.json'), null);
    if (!pkg) pkg = readJsonFile(path.join(dir, 'cortico.json'), null);
    if (!pkg) pkg = readJsonFile(path.join(dir, 'manifest.json'), null);
    // 认不出清单的目录也不是插件，直接跳过，别在列表里堆名字。
    if (!pkg) continue;
    out.push({
      id: name,
      name: pkg.displayName || pkg.name || name,
      version: pkg.version || '',
      about: pkg.description || pkg.about || '',
    });
  }
  return out;
}

/** 记忆条目：notes 目录下的 md，按修改时间倒序，只给摘要。 */
function listNotes(limit = 40) {
  const out = [];
  if (!NOTES_DIR) return out;
  let files = [];
  try {
    files = fs.readdirSync(NOTES_DIR, { withFileTypes: true }).filter((d) => d.isFile());
  } catch {
    return out;
  }
  for (const f of files) {
    const full = path.join(NOTES_DIR, f.name);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    out.push({ name: f.name, size: st.size, at: st.mtimeMs });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit).map((n) => ({
    name: n.name,
    size: n.size,
    at: new Date(n.at).toISOString(),
  }));
}

/** 诊断：日志尾巴 + 各端口状态，够判断「哪一环没起来」。 */
function diagnostics() {
  let logTail = [];
  try {
    const buf = fs.readFileSync(CORE_LOG, 'utf8').replace(/\r\n/g, '\n');
    logTail = buf.split('\n').filter(Boolean).slice(-60);
  } catch {
    logTail = [HOME_READY ? '（读不到 core.log）' : '（未配置宿主 home 目录，没有日志可读）'];
  }
  return {
    pid: process.pid,
    port: PORT,
    core: CORE,
    home: HOME_DIR || null,
    extensionsDir: EXT_DIR,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    logTail,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/index.html') {
    serveFile(res, path.join(WINDOW_DIR, 'index.html'));
    return;
  }
  if (pathname.startsWith('/window/')) {
    const f = safeJoin(WINDOW_DIR, pathname.slice('/window/'.length));
    if (f) serveFile(res, f);
    else res.writeHead(403).end();
    return;
  }
  if (pathname.startsWith('/assets/')) {
    const f = safeJoin(ASSETS_DIR, pathname.slice('/assets/'.length));
    if (f) serveFile(res, f);
    else res.writeHead(403).end();
    return;
  }
  // 桌宠专用路由
  if (pathname === '/pet.html' || pathname === '/pet') {
    serveFile(res, path.join(WINDOW_DIR, 'pet.html'));
    return;
  }
  if (pathname === '/elymes-api/open-chat' && req.method === 'POST') {
    // 桌宠左键召唤聊天窗口
    const result = openChatWindow();
    res.writeHead(result.error ? 500 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: !result.error, ...result }));
    return;
  }
  if (pathname === '/api/preview') {
    // 插件面板上的「试播」走这里：让正在开着的聊天窗口切一下动作。
    const face = url.searchParams.get('face') || 'look';
    let sent = 0;
    for (const c of HUBS.ctl.clients) {
      sendToClient(c, JSON.stringify({ face }));
      sent += 1;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, face, sent }));
    return;
  }
  // ── 后端 UI 的接口 ──────────────────────────────────
  if (pathname === '/elymes-api/pet-config') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, config: normalizePetConfig(readJsonFile(PET_CONFIG_FILE, null)) });
      return;
    }
    if (req.method === 'POST') {
      try {
        const raw = JSON.parse((await readBody(req)) || '{}');
        const config = normalizePetConfig(raw);
        writeFileAtomic(PET_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
        // 桌宠那边开着的话立刻收一遍，不用等它自己轮询。
        for (const c of HUBS.ctl.clients) sendToClient(c, JSON.stringify({ petConfig: config }));
        sendJson(res, 200, { ok: true, config });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      }
      return;
    }
    res.writeHead(405).end();
    return;
  }
  if (pathname === '/elymes-api/extensions' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, dir: EXT_DIR, extensions: listExtensions() });
    return;
  }
  if (pathname === '/elymes-api/notes' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, dir: NOTES_DIR, notes: listNotes() });
    return;
  }
  if (pathname === '/elymes-api/diagnostics' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, ...diagnostics() });
    return;
  }
  if (pathname === '/elymes-api/persona') {
    if (!PERSONA_FILE) {
      sendJson(res, 503, {
        ok: false,
        path: '',
        text: '',
        error: '没检测到宿主 home 目录，人格文件不可用（可用 ENW_HOME 指定）',
      });
      return;
    }
    if (req.method === 'GET') {
      const text = readText(PERSONA_FILE);
      sendJson(res, 200, { ok: text !== null, path: PERSONA_FILE, text: text || '' });
      return;
    }
    if (req.method === 'POST') {
      try {
        const data = JSON.parse((await readBody(req)) || '{}');
        const text = typeof data.text === 'string' ? data.text : '';
        if (!text.trim()) {
          sendJson(res, 400, { ok: false, error: '内容是空的，没有保存' });
          return;
        }
        const old = readText(PERSONA_FILE);
        let backup = '';
        if (old !== null) {
          // 人格文件是核心资产，动之前先留一份带时间戳的副本。
          backup = `${PERSONA_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          fs.writeFileSync(backup, old, 'utf8');
        }
        writeFileAtomic(PERSONA_FILE, text.replace(/\r\n/g, '\n'));
        sendJson(res, 200, { ok: true, backup, bytes: Buffer.byteLength(text, 'utf8') });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
      }
      return;
    }
    res.writeHead(405).end();
    return;
  }
  // `/api/*` 直接转给 Core，省得页面自己处理跨站。
  if (pathname.startsWith('/api/')) {
    try {
      const upstream = await fetch(CORE + pathname + url.search, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// ── WebSocket 反代 ──────────────────────────────────────────────
// 页面连 ws://127.0.0.1:18800/ws/{chat|debug}，这里替它连 Core。
const wss = new WebSocketServer({ noServer: true });

const UPSTREAM = {
  chat: `${CORE_WS}/ws/providers/world:console/panels/chat`,
  debug: `${CORE_WS}/ws/debug`,
};

/**
 * 每条流只维护一条上游连接，浏览器页面随便重连。
 *
 * 之前是一对一转发：页面 WS 一断就跟上游断，于是 TA 的回话经常落在
 * 已经关掉的旧连接上——表现就是「发了消息，没人应」。改成共享上游后，
 * 页面重连只是换个收件人，上游一直挂着。
 */
const HUBS = {
  chat: { key: 'chat', url: UPSTREAM.chat, ws: null, clients: new Set(), queue: [], retry: 0 },
  debug: { key: 'debug', url: UPSTREAM.debug, ws: null, clients: new Set(), queue: [], retry: 0 },
  // 本地指令流：不连 Core，只用来把「试播」这类面板动作推给窗口。
  ctl: { key: 'ctl', url: null, ws: null, clients: new Set(), queue: [], retry: 0 },
};

/**
 * 时间线里混着大量系统注入：`[console] PIN: 530630 [19:47] 控制台：xxx`、
 * 记忆快照、生态箱自检、信箱事件、重启提示……它们都挂在 user 角色下，
 * 但不是人说的话。前端那道过滤没能全部拦住（同一条文本在不同位置判断结果不一致），
 * 索性在服务端把 hello 里的这些条目剔掉，页面拿到的就是干净的。
 */
const NOISE_WORDS = [
  '[console', '[system]', '[turn', '记忆快照', '记忆域', '生态箱', '信箱',
  '邮件', '封信', '回信', '还能寄', '排行榜', '名次', 'terrarium.', 'mem_',
  'returnReport', 'end_turn',
];

function itemText(item) {
  const parts = item && item.content;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const part of parts) if (part && typeof part.text === 'string') out += part.text;
  return out;
}

function dropNoise(session) {
  return session.filter((entry) => {
    const item = entry && entry.item ? entry.item : entry;
    if (!item || item.type !== 'message' || item.role !== 'user') return true;
    const text = itemText(item);
    if (!text) return true;
    if (/^\[console\]/.test(text) || /^#\s/.test(text)) return false;
    for (const w of NOISE_WORDS) if (text.includes(w)) return false;
    return text.length <= 1200;
  });
}

function sendToClient(client, text) {  if (client.readyState !== 1) return;
  try { client.send(text); } catch { /* 单个客户端失败不影响别的 */ }
}

function ensureHub(hub) {
  const cur = hub.ws;
  if (cur && (cur.readyState === 0 || cur.readyState === 1)) return cur;
  const ws = new WsClient(hub.url);
  hub.ws = ws;
  ws.on('open', () => {
    hub.retry = 0;
    logWs(`[${hub.key}] upstream open`);
    while (hub.queue.length) {
      const text = hub.queue.shift();
      try { ws.send(text); } catch { break; }
    }
  });
  ws.on('message', (data) => {
    let text = data.toString();
    // 上游的 hello 只发一次（debug 那帧是整份 session，349KB）。页面要是比上游晚连上，
    // 就再也等不到它了——所以存一份，谁后来谁补发。
    try {
      const f = JSON.parse(text);
      if (f && f.t === 'hello') {
        const before = Array.isArray(f.session) ? f.session.length : -1;
        if (before >= 0) f.session = dropNoise(f.session);
        if (Array.isArray(f.session) && f.session.length !== before) {
          text = JSON.stringify(f);
          logWs(`[${hub.key}] hello 清洗 ${before} -> ${f.session.length} 条`);
        }
        hub.snapshot = text;
      }
    } catch { /* 不是 JSON 就当普通帧 */ }
    logWs(`[${hub.key}] upstream frame ${text.length}B clients=${hub.clients.size}`);
    for (const client of hub.clients) sendToClient(client, text);
  });
  ws.on('close', (code, reason) => {
    logWs(`[${hub.key}] upstream close ${code} ${String(reason).slice(0, 80)}`);
    hub.ws = null;
    const delay = Math.min(8000, 800 * 2 ** hub.retry);
    hub.retry += 1;
    setTimeout(() => ensureHub(hub), delay);
  });
  ws.on('error', (err) => {
    logWs(`[${hub.key}] upstream error ${String((err && err.message) || err)}`);
    try { ws.close(); } catch { /* ignore */ }
  });
  return ws;
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const key = url.pathname.replace(/^\/ws\//, '');
  const hub = HUBS[key];
  if (!hub) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    logWs(`[${key}] client upgrade, readyState=${client.readyState}`);
    hub.clients.add(client);
    if (hub.snapshot) sendToClient(client, hub.snapshot);

    // 页面这一侧随时可能重连（刷新、切窗口）。上游保持一条不动，
    // 回复就不会落在"已经关掉的旧连接"上——之前正是这样丢掉 TA 的回话。
    // ctl 是本地指令流，没有上游，页面发来的东西直接忽略。
    const up = hub.url ? ensureHub(hub) : null;
    const sendUp = (text) => {
      if (!up) return;
      if (up.readyState === 1) up.send(text);
      else hub.queue.push(text);
    };

    client.on('message', (data) => sendUp(data.toString()));
    client.on('close', () => {
      hub.clients.delete(client);
    });
    client.on('error', () => {
      hub.clients.delete(client);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[elymes] window server on http://127.0.0.1:${PORT} -> ${CORE}`);
  ensureHub(HUBS.debug);
});
