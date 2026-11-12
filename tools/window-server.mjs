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
import net from 'node:net';
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

// 无边框外挂进程（Win32 去边框 / 拖动 / 三键）的端口与窗尺寸，见 win-frame.ps1。
// 标题用来在枚举出的窗口里认人：crt.html 的 <title> 就是这三个字。
const FRAME_PORT = Number(process.env.ENW_FRAME_PORT || 18801);
const FRAME_TITLE = '伊洛伊';
const WIN_W = 1000;
// 可见区是设计稿的 1000×760，但窗口本身要比它高：顶部 52px 是 Edge 自绘的标题栏
// （要裁掉），底部还有 7px 边框。760 + 52 + 7 = 819，这样页面拿到的视口正好 760。
// 这两行现在是「设计稿尺寸」（CSS 像素），不是窗口的真实像素：真实像素由
// win-frame.ps1 按 dpi/96 换算后再夹进工作区（屏幕放不下就等比缩小）。
// 顶部 52px 自绘标题栏 + 底边那条，也由外挂自己加，这里只给设计稿数字。
const CUT_TOP = 0; // 0 = 保留 Edge 自带标题栏；52 = 把标题栏裁掉（之前的做法）
const WIN_H = 760;

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

/* ── 无边框窗口代理 ────────────────────────────────────────────────────────
   聊天窗是 `Edge --app` 开出来的，自带一条系统标题栏和一圈边框。要变成图一那种
   「整窗就是一张画」，只能去改窗口样式；而 Node 侧没有调 user32 的现成通道，
   也不该为这件事引原生模块。所以另起一个常驻 PowerShell 进程
   tools/win-frame.ps1：它监听 127.0.0.1:18801，收一行 `action=xxx&k=v`、
   回一行 JSON；这里只做转发。

   为什么不复用 18800：那是 HTTP + WebSocket 的主干，把窗口动作塞进去会让路由
   变脏；分开后页面按钮和宿主各调各的，服务挂掉也只影响窗口样式。            */
let frameChild = null;
let frameAt = 0;

function ensureFrameService() {
  if (frameChild && !frameChild.killed) return true;
  if (Date.now() - frameAt < 3000) return false;   // 拉起失败时别每帧都重试
  frameAt = Date.now();
  const ps1 = path.join(HERE, 'win-frame.ps1');
  if (!fs.existsSync(ps1)) return false;
  try {
    // stderr 落到 state 目录：这个进程是脱离的，出问题时没地方看输出。
    let errFd = 'ignore';
    try {
      const dir = path.join(PKG, 'state');
      fs.mkdirSync(dir, { recursive: true });
      errFd = fs.openSync(path.join(dir, 'win-frame.err.log'), 'a');
    } catch { /* 开不了日志也不影响启动 */ }
    frameChild = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-Port', String(FRAME_PORT),
        '-Keyword', FRAME_TITLE,
        '-Width', String(WIN_W),
        '-Height', String(WIN_H),
        '-CutTop', String(CUT_TOP),
        '-ChatProfile', path.join(STATE_DIR, 'chat-profile'),
      ],
      // 不能加 detached：Windows 上 detached + PowerShell 会让子进程
      // 一启动就以 exit=0 静默退出（实测三种组合，只有 detached:false 能听上端口）。
      // 不用 detached 也不怕：本进程退出后子进程照样活着，只是变成孤儿。
      { stdio: ['ignore', 'ignore', errFd], windowsHide: true },
    );
    frameChild.unref();
    // killed 只表示「我们喊过停」，进程自己退掉时它还是 false，
    // 所以必须在 exit 里清空，否则会一直以为服务还活着、再也不重拉。
    frameChild.on('error', () => { frameChild = null; });
    frameChild.on('exit', () => { frameChild = null; });
    return true;
  } catch {
    frameChild = null;
    return false;
  }
}

/** 发一行命令、收一行 JSON。窗口服务是同步应答的，不用管粘包以外的事。 */
function winCmd(line, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const sock = net.connect({ host: '127.0.0.1', port: FRAME_PORT });
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* 已经关了 */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(line + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { finish(JSON.parse(buf.slice(0, i))); }
      catch { finish({ ok: false, error: 'bad json: ' + buf.slice(0, i) }); }
    });
    sock.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
  });
}

/** 外挂进程首次启动要 Add-Type 现编 C#，差不多一两秒才听上端口；
    所以「连不上」不算失败，隔一小会儿再试，直到超时。 */
async function winCmdReady(line, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, error: 'not-ready' };
  while (Date.now() < deadline) {
    last = await winCmd(line, 2500);
    const err = last && typeof last.error === 'string' ? last.error : '';
    if (!err.startsWith('connect')) return last;
    await new Promise((r) => setTimeout(r, 350));
  }
  return last;
}

/** 18801 听没听上端口。只做探测，不动任何窗口。 */
function framePing(timeoutMs = 400) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const sock = net.connect({ host: '127.0.0.1', port: FRAME_PORT });
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock.destroy(); } catch { /* 已经关了 */ }
      resolve(v);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

/** 等外挂进程起来。它每次冷启动都要 Add-Type 现编 C#，等不到就别再等——
    后面那两条指令各要 6 秒、5 秒超时，白等一次就是 11 秒。 */
async function waitFrameReady(ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await framePing(400)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 窗刚开出来时标题可能还没写上、样式也没定，隔 0.7 秒连试几回。 */
async function attachFrameWhenReady() {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const r = await winCmdReady('action=attach', 2000);
    if (r && r.ok && r.hwnd) return r;
  }
  return null;
}

/** 把“被 Edge 恢复成最小化”的窗拉回正常。标题要等页面 JS 跑完才含关键字，
 *  所以同样得轮询；只要一次恢复了就不用再跑。 */
async function unminWhenReady() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 600));
    const r = await winCmdReady('action=unmin', 2000);
    if (r && r.ok && r.unmin > 0) return r;
  }
  return null;
}

/** 旧界面的历史默认是「最大化 + 置顶」（速览 2026-11-10 第 29 条）。 */
async function fitOldWindow() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 600));
    const s = await winCmdReady('action=state', 2000);
    if (!s || !s.ok) continue;
    const r = await winCmdReady('action=fullscreen', 3000);
    if (r && r.ok) return r;
  }
  return null;
}

/** 聊天窗口：桌宠左键点一下开一个，短时间内的连点不重复开。 */
let chatChild = null;
let chatAt = 0;
let openSeq = 0;
// 上一次有页面连上 /ws/chat 的时间。窗口会留在屏幕上，但页面没加载成功时
// 一个客户端都不会连上来——这是判断「开出来的窗到底活着没有」的唯一硬指标。
let lastChatClientAt = 0;
/**
 * 起一个宿主透明浮层页（--pet-host 通道）。
 *
 * 宿主命令来源与 src/index.mjs 的 findPetHost 一致，但本服务是独立 node 进程，
 * process.execPath 指不到 Coopanion.exe，所以只认环境变量；拿不到就返回错误，
 * 让调用方决定退路，不在这里默默起一个带白底的 Edge 窗。
 */
async function openPetLayer(page = 'window/ui2.html', size = '300,340') {
  let host = null;
  for (const key of ['CORTICO_DESKTOP_PET_HOST', 'ENW_PET_HOST']) {
    const env = process.env[key];
    if (!env) continue;
    try {
      const argv = JSON.parse(env);
      if (Array.isArray(argv) && argv.length > 0) {
        host = { command: argv[0], args: argv.slice(1), source: key };
        break;
      }
    } catch {
      /* 解析不了就继续往下找 */
    }
  }
  if (!host) {
    logWs('[win] open-ui2 失败：拿不到 CORTICO_DESKTOP_PET_HOST / ENW_PET_HOST');
    return { ok: false, error: '拿不到宿主浮层命令（CORTICO_DESKTOP_PET_HOST 未设置），请从插件面板打开' };
  }
  const [w, h] = String(size).split(',');
  const child = spawn(host.command, [
    ...host.args,
    `--pet-url=http://127.0.0.1:${PORT}/${page}`,
    `--width=${w}`,
    `--height=${h}`,
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  logWs(`[win] 透明浮层已起：${page} ${w}x${h}（${host.source}）`);
  return { ok: true, page, transparent: true, source: host.source };
}

async function openChatWindow(page = 'window/crt.html', stripFrame = true) {
  const now = Date.now();
  if (chatChild && !chatChild.killed && now - chatAt < 8000) return { reused: true };
  const browser = findBrowser();
  if (!browser) return { error: '没找到 Edge 或 Chrome' };
  // 只开白名单里的页，防止被拼出来的路径开出去
  const ALLOWED = ['index.html', 'window/crt.html', 'window/ui2.html'];
  const page2 = ALLOWED.includes(page) ? page : 'window/crt.html';
  ensureFrameService();
  // 18801 没就绪时，closeall/killchat 会各烧满 6 秒和 5 秒超时（点完十几秒才有动静），
  // 更糟的是请求迟到时，killchat 会把「刚开出来的那个窗」当成残留实例杀掉——
  // 实测症状：窗口留在屏幕上、页面已经没了，标题停在 URL，Ctrl+R 也没反应。
  // 所以先确认外挂起来了；起不来就整段跳过，宁可留个旧窗，也不要开出一个空壳。
  const frameUp = await waitFrameReady(4000);
  if (frameUp) {
    // 先把以前残留的同标题窗关掉。必须等它关完再开新窗——否则这条关窗请求会晚到，
    // 把刚开出来的那个窗一起关掉（实测就是这样：开完立刻变成“没窗”）。
    await winCmdReady('action=closeall', 6000);
    await new Promise((r) => setTimeout(r, 500));
    // 窗关了不等于进程死了，这里再把没窗口的旧实例清掉，否则新窗会被它吞掉。
    // 走常驻外挂进程执行：新起一个 PowerShell 要 1 秒多，每次开窗都付不起。
    await winCmdReady('action=killchat', 5000);
    await new Promise((r) => setTimeout(r, 300));
  } else {
    logWs('[win] 18801 未就绪，跳过 closeall/killchat（避免迟到杀进程）');
  }

  const token = ++openSeq;
  // 旧界面是固定 1120×740 的布局、自带一整套标题栏和菜单，不能套新界面的去边框/改尺寸。
  // ui2（2D 聊天界面）按用户要求做成 300×340 的小窗，单独给尺寸。
  const winSize =
    page2 === 'window/ui2.html' ? '300,340' : stripFrame ? `${WIN_W},${WIN_H}` : '1120,740';
  const spawnOnce = () => {
    chatChild = spawn(
      browser,
      [
        `--app=http://127.0.0.1:${PORT}/${page2}`,
        `--user-data-dir=${path.join(STATE_DIR, 'chat-profile')}`,
        `--window-size=${winSize}`,
        '--no-first-run',
        '--disable-features=Translate,MediaRouter',
        '--autoplay-policy=no-user-gesture-required',
        // 这台机器的权限环境里，Edge 建沙箱令牌会失败（Crashpad 键串
        // edge_sandbox_win.cc / SandboxLaunchFailure-TokenPackage），浏览器进程
        // 一起来就崩，页面根本没机会加载。这个窗只开 127.0.0.1 的本地页，
        // 关掉沙箱换它能起来；要恢复就删这一行。
        '--no-sandbox',
        // ui2 是透明底界面：Edge 默认会给 --app 窗铺一层不透明底，
        // 光把 CSS 背景改 transparent 不够，必须让它自己也按透明渲染。
        '--default-background-color=00000000',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    chatChild.unref();
    chatAt = Date.now();
    // Edge 会记住上次的窗口状态：上一次是最小化关的，这次就起成最小化。
    // 所以不分开那种界面，都先轮询着把它恢复出来。
    void unminWhenReady();
    // 开完再点掉标题栏（Edge 会忽略 --window-size，尺寸也由外挂进程接手）
    if (stripFrame) void attachFrameWhenReady();
    else void fitOldWindow();
    return chatChild;
  };

  try {
    const startedAt = Date.now();
    spawnOnce();

    // 页面没加载成功时，窗口会留在屏幕上，但一个客户端也不会连 /ws/chat。
    // 这种情况重开一次；只重开一次，且只在「这段时间里从来没有客户端」时才动手。
    setTimeout(() => {
      if (token !== openSeq) return;
      if (lastChatClientAt >= startedAt) return;   // 加载成功了，别多事
      logWs(`[win] ${page2} 开出 10 秒内没有客户端，重开一次`);
      try { if (chatChild && !chatChild.killed) chatChild.kill(); } catch { /* 已经退了 */ }
      setTimeout(() => {
        if (token !== openSeq) return;
        const retryAt = Date.now();
        spawnOnce();
        setTimeout(() => {
          if (token !== openSeq) return;
          if (lastChatClientAt < retryAt) logWs(`[win] ${page2} 第二次仍无客户端，放弃重开`);
        }, 12000).unref();
      }, 800);
    }, 10000).unref();

    return { opened: true, page: page2, framed: stripFrame };
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

/** 桌宠设置的默认值，和 pet.html 里的常量保持一致。 */const PET_DEFAULTS = {
  size: 60,
  avoidIn: 130,
  avoidOut: 200,
  speed: 1,
  follow: false,
  followRadius: 100,
  rest: true,
  restMsMin: 3500,
  restMsMax: 7000,
  restGapMin: 6000,
  restGapMax: 14000,
  roamIn: 60,          // 活动环带内半径（px）
  roamOut: 260,        // 活动环带外半径（px）
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
    cfg.follow = raw.follow === true;
    cfg.followRadius = Math.round(num(raw.followRadius, 80, 400, PET_DEFAULTS.followRadius));
    cfg.rest = raw.rest !== false;
    cfg.restMsMin = Math.round(num(raw.restMsMin, 800, 60000, PET_DEFAULTS.restMsMin));
    cfg.restMsMax = Math.round(num(raw.restMsMax, cfg.restMsMin + 500, 120000, Math.max(PET_DEFAULTS.restMsMax, cfg.restMsMin + 500)));
    cfg.restGapMin = Math.round(num(raw.restGapMin, 1000, 600000, PET_DEFAULTS.restGapMin));
    cfg.restGapMax = Math.round(num(raw.restGapMax, cfg.restGapMin + 1000, 1200000, Math.max(PET_DEFAULTS.restGapMax, cfg.restGapMin + 1000)));
    // 活动环带：外半径先定，内半径不能顶到外圈（至少留 40px 环宽），否则环带会退化成一圈
    cfg.roamOut = Math.round(num(raw.roamOut, 100, 900, PET_DEFAULTS.roamOut));
    cfg.roamIn = Math.round(num(raw.roamIn, 0, Math.max(0, cfg.roamOut - 40), Math.min(PET_DEFAULTS.roamIn, Math.max(0, cfg.roamOut - 40))));
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

/* ── 全屏彩蛋窗（聊天框输入触发词） ──────────────────────
   聊天窗只 POST /elymes-api/nt，这里负责起一个 Edge --app 全屏窗；
   页面 10 秒后自己 POST /nt-close，服务端再按 token 杀进程，避免留下
   一个占满屏幕、又点不掉的窗。token 同时防止别的本地页乱关。          */
const NT_PAGE = path.join(WINDOW_DIR, 'nt.html');
const NT_TOP = path.join(HERE, 'nt-top.ps1');
const NT_PROFILE = path.join(STATE_DIR, 'nt-profile');
const NT_SETTINGS = path.join(STATE_DIR, 'nt-settings.json');
let ntState = null;   // { proc, token, startedAt }

function readNtSettings() {
  try {
    const raw = fs.readFileSync(NT_SETTINGS, 'utf8');
    const obj = JSON.parse(raw);
    return { autoClose: obj.autoClose !== false };
  } catch {
    return { autoClose: true };
  }
}

function writeNtSettings(patch) {
  const next = { ...readNtSettings(), ...(patch || {}) };
  next.autoClose = next.autoClose !== false;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(NT_SETTINGS, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function ntOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;   // 本机 curl / 脚本
  return origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}

function closeEffectWindow(reason = 'manual') {
  const cur = ntState;
  ntState = null;
  const pid = cur && cur.proc && cur.proc.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
    } else {
      process.kill(pid, 'SIGTERM');
    }
    logWs(`[nt] 收尾（${reason}）pid=${pid}`);
  } catch (err) {
    logWs(`[nt] 收尾失败：${String((err && err.message) || err)}`);
  }
}

async function openEffectWindow(req) {
  if (ntState) closeEffectWindow('restart');
  const browser = findBrowser();
  if (!browser) throw new Error('没找到 Edge 或 Chrome');
  if (!fs.existsSync(NT_PAGE)) throw new Error('缺少 window/nt.html');
  fs.mkdirSync(NT_PROFILE, { recursive: true });
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ntSettings = readNtSettings();
  const autoClose = ntSettings.autoClose !== false;
  const url = `http://127.0.0.1:${PORT}/window/nt.html?t=${encodeURIComponent(token)}&auto=${autoClose ? 1 : 0}`;
  const child = spawn(browser, [
    `--app=${url}`,
    '--start-fullscreen',
    '--window-size=1920,1080',
    `--user-data-dir=${NT_PROFILE}`,
    // --test-type 压掉「不受支持的命令行标志 --no-sandbox」红色提示条；
    // --disable-sync/no-default-browser-check 防止首次启动弹出 Edge 同步登录窗。
    '--test-type',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,msEdgeSync,EdgeSyncPromo,msSyncPromo',
    '--autoplay-policy=no-user-gesture-required',
    // 和聊天窗同一个原因：这台机器上 Edge 的沙箱令牌创建失败，必须关沙箱。
    '--no-sandbox',
    '--default-background-color=00000000',
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => { if (ntState && ntState.proc === child) ntState = null; });
  child.on('exit', () => { if (ntState && ntState.proc === child) ntState = null; });
  child.unref();
  ntState = { proc: child, token, startedAt: Date.now() };
  // Edge 的 --start-fullscreen 只保证尺寸，不保证置顶：用户正停在聊天窗里时，
  // 彩蛋会被压在后面。用一个独立 PowerShell 把标题为 10KB 的窗提成 TOPMOST。
  if (process.platform === 'win32' && fs.existsSync(NT_TOP)) {
    try {
      const top = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', NT_TOP, '-Title', '10KB', '-DelayMs', '1400',
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      top.unref();
    } catch { /* 提不上来也只影响层级，彩蛋照常 */ }
  }
  logWs(`[nt] 全屏彩蛋已起 pid=${child.pid}`);
  // 页面崩溃/断网时别把屏幕永久占住：15 秒后服务端兜底收掉。
  // auto=0（用户关掉了自动退出）时跳过守卫，由用户自己 Esc / 确定 / 点空白关。
  if (autoClose) {
    const guard = setTimeout(() => {
      if (ntState && ntState.token === token) closeEffectWindow('timeout');
    }, 15000);
    guard.unref();
  }
  return { pid: child.pid, token, autoClose };
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
    // 桌宠左键召唤聊天窗口；插件面板的两个按钮也走这里。
    // page=index.html 是旧界面（系统标题栏、1120×740），默认是千禧风新界面。
    const page = url.searchParams.get('page') || 'window/crt.html';
    const frame = url.searchParams.get('frame') !== '0';
    const result = await openChatWindow(page, frame);
    res.writeHead(result.error ? 500 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: !result.error, ...result }));
    return;
  }
  if (pathname === '/elymes-api/open-ui2' && req.method === 'POST') {
    // 2D 素材版界面：不走 Edge --app（那个窗自带不透明底），改起宿主的透明浮层。
    // 宿主就是 Coopanion.exe --pet-host，跟桌宠走同一条命令、同一个 --pet-url 机制，
    // 只是把页换成 window/ui2.html、尺寸换成 300×340。
    try {
      const out = await openPetLayer('window/ui2.html', '300,340');
      res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    }
    return;
  }
  // ── 全屏彩蛋（聊天框关键词触发） ─────────────────────
  if (pathname === '/elymes-api/nt-settings') {
    if (!ntOriginOk(req)) { sendJson(res, 403, { ok: false, error: 'forbidden origin' }); return; }
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...readNtSettings() });
      return;
    }
    if (req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
      if (typeof body.autoClose !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'autoClose 必须是布尔值' });
        return;
      }
      sendJson(res, 200, { ok: true, ...writeNtSettings({ autoClose: body.autoClose }) });
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  if (pathname === '/elymes-api/nt' && req.method === 'POST') {
    if (!ntOriginOk(req)) { sendJson(res, 403, { ok: false, error: 'forbidden origin' }); return; }
    try {
      const out = await openEffectWindow(req);
      sendJson(res, 200, { ok: true, ...out });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
    return;
  }
  if (pathname === '/elymes-api/nt-close' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
    if (ntState && body.t && body.t === ntState.token) {
      closeEffectWindow('page');
      sendJson(res, 200, { ok: true, closed: true });
    } else {
      // 已经被自动收掉，或 token 对不上（旧页面晚到的关闭请求）：不动当前窗。
      sendJson(res, 200, { ok: true, closed: false });
    }
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
  // ── 无边框聊天窗的窗口控制 ──────────────────────────
  // 页面里的 ─ □ ✕ 和标题栏拖动都打这里，原样转给 win-frame.ps1。
  // 允许 GET：按钮是普通 fetch，没有请求体，少一层解析。
  if (pathname === '/elymes-api/win') {
    ensureFrameService();
    const line = (url.search || '').replace(/^\?/, '') || 'action=state';
    const out = await winCmdReady(line, 8000);
    sendJson(res, out && out.ok === false && out.error === 'timeout' ? 504 : 200, out);
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
  // 桌宠 World 自己的对话面板：气泡框里打进去的字、她说出口的话都在这里。
  pet: `${CORE_WS}/ws/providers/world:desktop-pet/panels/chat`,
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
  /* 气泡流：桌宠对话面板。它的历史是「hello -> init」一问一答给的，
     多个页面同时开着时 init 只该回给发问的那一个，否则别的页面会被动重画历史。
     awaiting 记着「谁问了、还没答」，应答就按顺序认领。                  */
  pet: { key: 'pet', url: UPSTREAM.pet, ws: null, clients: new Set(), queue: [], retry: 0, awaiting: [] },
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
    // 气泡面板的 init 是「谁问回谁」的：按 hello 的先后顺序认领，不广播给所有页面，
    // 否则三个聊天窗同时开着时，一个页面问历史会把另外两个的历史重画一遍。
    try {
      const f = JSON.parse(text);
      if (f && f.t === 'init' && Array.isArray(hub.awaiting)) {
        const target = hub.awaiting.shift();
        if (target) {
          const n = Array.isArray(f.items) ? f.items.length : -1;
          logWs(`[${hub.key}] init -> 单个页面 items=${n}`);
          sendToClient(target, text);
          return;
        }
      }
    } catch { /* 不是 JSON 就当普通帧 */ }
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
    // 开窗流程靠这个时间戳判断「页面到底加载成功没有」——窗口在屏幕上，不等于页面活着。
    if (key === 'chat') lastChatClientAt = Date.now();
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

    client.on('message', (data) => {
      const text = data.toString();
      // 气泡面板：把发 hello 的页面排进 awaiting，等 init 回来认领。
      if (Array.isArray(hub.awaiting)) {
        try {
          const f = JSON.parse(text);
          if (f && f.t === 'hello') hub.awaiting.push(client);
        } catch { /* 不是 JSON 就照常转发 */ }
      }
      sendUp(text);
    });
    client.on('close', () => {
      hub.clients.delete(client);
      if (Array.isArray(hub.awaiting)) hub.awaiting = hub.awaiting.filter((c) => c !== client);
    });
    client.on('error', () => {
      hub.clients.delete(client);
      if (Array.isArray(hub.awaiting)) hub.awaiting = hub.awaiting.filter((c) => c !== client);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[elymes] window server on http://127.0.0.1:${PORT} -> ${CORE}`);
  ensureHub(HUBS.debug);
});
