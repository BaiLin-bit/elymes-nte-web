/**
 * 网页端曳尔沐对话插件（elymes-nte-web）
 * ====================================
 * 这个插件本体很薄，两件事：
 *   1. 提供一个面板（`dist/webui.js` 的 `panels.skin`），里面是「启动窗口」按钮；
 *   2. 点按钮时把本地服务拉起来，再用 Edge / Chrome 的 `--app` 模式开一个无地址栏的窗口。
 *
 * 为什么窗口要自己拉：宿主 WebUI 的 DOM 全由 JS 生成 + Tailwind 原子类，
 * 在它上面盖皮肤只能「盖」不能「替」。独立窗口里 DOM 由我们自己写，才能真正
 * 做出 QQ2007 那种窗口。
 *
 * 为什么要有本地服务（`tools/window-server.mjs`）：Core 的 WebSocket 握手会拒
 * 跨站 Origin，而浏览器发起的 WS 一定带 Origin；本地服务在 Node 侧转发就不带
 * Origin，能通过校验。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 面板设置存在浏览器 localStorage 的这个键下。 */
const SETTINGS_KEY = 'elymes-nte-web.settings.v1';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIN_PORT = Number(process.env.ENW_PORT || 18800);
const WIN_URL = `http://127.0.0.1:${WIN_PORT}/`;
/* 对话窗现在用新界面 window/crt.html（旧 index.html 留着当备份，随时改回去）。
   注意 WIN_URL 本身不能动：桌宠的 pet.html 和一堆 /api 都是拼在它后面的。 */
const CHAT_URL = `${WIN_URL}window/crt.html`;
/* 第三套：ui_2 素材版 2D 聊天界面。与上面两套并存，入口各管各的。 */
const UI2_URL = `${WIN_URL}window/ui2.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 窗刚开出来时标题/样式还没定，隔 0.7 秒连试几回，成功一次就收手。 */
async function attachFrameLater() {
  for (let i = 0; i < 12; i++) {
    await sleep(700);
    try {
      const r = await fetch(`${WIN_URL}elymes-api/win?action=attach`);
      const j = await r.json();
      if (j && j.ok && j.hwnd) return;
    } catch {
      /* 服务还没起好或外挂进程还没听上，下一轮再试 */
    }
  }
}

/** 聊天窗口现在真的在吗。问本地外挂，别信子进程对象。 */
async function chatWindowAlive() {
  try {
    const r = await fetch(`${WIN_URL}elymes-api/win?action=state`);
    const j = await r.json();
    return Boolean(j && j.ok);
  } catch {
    return false;
  }
}

/** 本地窗口服务活着吗。 */
function pingServer(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: WIN_PORT, path: '/api/auth/status', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** 找得到哪个 Chromium 浏览器就用哪个，Edge 优先（Windows 一定有）。 */
function findBrowser() {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env['ProgramFiles'],
    process.env['LOCALAPPDATA'],
  ].filter(Boolean);
  const candidates = [];
  for (const r of roots) {
    candidates.push(String(r) + '\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push(String(r) + '\\Google\\Chrome\\Application\\chrome.exe');
  }
  // 带上明确的绝对路径兜底
  candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  candidates.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/**
 * 宿主 Electron 的透明桌宠浮层命令。
 *
 * 宿主启动时会导出 `CORTICO_DESKTOP_PET_HOST`（一条 JSON 数组命令），照着它起
 * 进程、再补一个 `--pet-url=<页面地址>`，就能把插件页面放进真正透明的窗口里，
 * 而不是 Edge `--app` 那个带白底的方块窗。
 *
 * 拿不到这条环境变量时，也接受 `ENW_PET_HOST` 手动指定；再不行就看自己是不是
 * 正跑在 Coopanion 里（`--pet-host` 是宿主认的开关）。
 */
function findPetHost() {
  for (const key of ['CORTICO_DESKTOP_PET_HOST', 'ENW_PET_HOST']) {
    const env = process.env[key];
    if (!env) continue;
    try {
      const argv = JSON.parse(env);
      if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')) {
        return { command: argv[0], args: argv.slice(1), source: key };
      }
    } catch {
      /* 解析不了就继续往下找 */
    }
  }
  const exe = process.execPath;
  if (exe && /coopanion/i.test(path.basename(exe))) {
    return { command: exe, args: ['--pet-host'], source: 'execPath' };
  }
  return null;
}

/** 端口没通就把本地服务拉起来（detached，主进程关了它还在）。 */
async function ensureServer() {
  if (await pingServer()) return false;
  const script = path.join(PKG_DIR, 'tools', 'window-server.mjs');
  if (!existsSync(script)) throw new Error('找不到 tools/window-server.mjs');
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: PKG_DIR,
    env: { ...process.env, ENW_PORT: String(WIN_PORT) },
  });
  child.unref();
  for (let i = 0; i < 32; i++) {
    await sleep(250);
    if (await pingServer()) return true;
  }
  throw new Error('窗口服务启动了但端口 ' + WIN_PORT + ' 连不上');
}

class ElymesNteWeb {
  id = 'elymes-nte-web';

  ctx = null;

  browser = null;

  petWindow = null;

  /** 桌宠是不是跑在宿主的透明浮层里（false 表示退回了 Edge 的不透明小窗）。 */
  petTransparent = false;

  constructor(ctx) {
    this.ctx = ctx;
  }

  log(msg) {
    this.ctx?.log?.(msg);
  }

  /**
   * 宿主在装配期会无判空地调用 `mod.tools()`，少一个就抛
   * `mod.tools is not a function`，世界开关会失败。
   * 这个壳不提供任何模型工具，返回空数组即可。
   */
  tools() {
    return [];
  }

  /** 同上，宿主会 `await m.envPromptVars()` 并按对象合并。 */
  envPromptVars() {
    return {};
  }

  /**
   * 在宿主 WebUI 里的页面声明。`panels` 不能省：宿主按它生成页面里的页签，
   * 省略就会显示「没有声明任何面板」。`id` 必须与 `dist/webui.js` 里
   * `PANELS` 的键一致（即 skin）。
   */
  webUi() {
    return {
      label: '和Y？聊天',
      lamps: [],
      panels: [
        {
          id: 'skin',
          title: '对话窗口',
          description: '启动聊天窗口、表情关键词、帧间隔与颜文字',
        },
      ],
      invoke: async (panel, method, args) => {
        const list = Array.isArray(args) ? args : [];
        if (method === 'windowState') {
          return { port: WIN_PORT, url: WIN_URL, running: await pingServer(), browser: findBrowser() };
        }
        if (method === 'openWindow') {
          return await this.openWindow(Boolean(list[0]));
        }
        if (method === 'openCrtWindow') {
          // 两个入口共用同一套开窗逻辑，只是 page / 去边框不同：
          // 按钮上有两个，一个开旧界面（系统标题栏），一个开千禧风新界面（去边框）。
          return await this.openWindow(true, 'window/crt.html', true);
        }
        if (method === 'openUi2Window') {
          // 第三套界面：ui_2 素材版。同样是去边框的独立窗口，只是页不同。
          return await this.openWindow(true, 'window/ui2.html', true);
        }
        if (method === 'importPortrait') {
          return await this.importPortrait(list[0]);
        }
        if (method === 'closeWindow') {
          return await this.closeWindow();
        }
        if (method === 'previewFace') {
          // 面板上的「试播」：让正开着的聊天窗口切一下动作。
          // 窗口没开时不算错，返回 ok:false 让面板提示一句就行。
          const face = String(list[0] || 'look');
          const running = await pingServer();
          if (!running) return { ok: false, error: '窗口服务没起，先点「打开聊天窗口」' };
          try {
            const r = await fetch(`${WIN_URL}api/preview?face=${encodeURIComponent(face)}`);
            const data = await r.json();
            if (!data || !data.sent) return { ok: false, error: '聊天窗口没连上，先打开窗口' };
            return { ok: true, face, sent: data.sent };
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) };
          }
        }
        if (method === 'openPetWindow') {
          return await this.openPetWindow(Boolean(list[0]));
        }
        // 2D 聊天界面：走和桌宠同一条透明浮层通道，而不是 Edge --app 窗。
        // Edge 的 --app 窗会自己铺不透明底，CSS 透明也盖不过去；宿主的
        // --pet-host 浮层才是真透明。找不到宿主时 openPetWindow 会退回 Edge。
        if (method === 'openUi2Layer') {
          return await this.openPetWindow(true, 'window/ui2.html', '300,340');
        }
        if (method === 'closePetWindow') {
          return await this.closePetWindow();
        }
        throw new Error('未知操作：' + method);
      },
    };
  }

  /** 起服务 → 开 Edge --app 窗口。`force` 为真时忽略已开着的那个。 */
  async openWindow(force = false, page = 'index.html', frame = false) {
    const serverStarted = await ensureServer();
    // 回给前端的 url 只是给人看的，三页各对应自己的地址
    const target =
      page === 'window/crt.html' ? CHAT_URL : page === 'window/ui2.html' ? UI2_URL : WIN_URL;
    // 不能只看 this.browser.killed：Edge 主进程常常活得好好的，只是那个窗被
    // 我们关掉了（closeall / 点关闭），这时 killed 是 false，于是这里会直接
    // 返回 reused 而不开窗——用户看到的就是“点按钮没反应”。
    // 所以改成问本地服务：真有窗口才算复用。
    if (!force && (await chatWindowAlive())) {
      return { ok: true, url: target, reused: true, serverStarted };
    }
    if (!findBrowser()) throw new Error('没找到 Edge 或 Chrome，装一个才能开窗口');
    // 开窗统一交给本地服务：--user-data-dir、清残留实例、去边框、摆位都在
    // tools/window-server.mjs 里，这里再自己 spawn 一遍只会两头不同步。
    const qs = `?page=${encodeURIComponent(page)}&frame=${frame ? '1' : '0'}`;
    const resp = await fetch(`${WIN_URL}elymes-api/open-chat${qs}`, { method: 'POST' });
    const out = await resp.json();
    this.log('对话窗口已打开：' + target);
    return { ok: true, url: target, serverStarted, reused: !(out && out.opened) };
  }

  async closeWindow() {
    // 进程句柄已经不在插件手里（开窗交给服务端了），改让服务端关窗。
    try {
      await fetch(`${WIN_URL}elymes-api/win?action=close`);
    } catch {
      /* 服务没起就没什么可关的 */
    }
    this.browser = null;
    return { ok: true };
  }

  /**
   * 桌宠子进程统一从这里起。
   *
   * `ELECTRON_RUN_AS_NODE` 一定要摘掉：插件跑在 Core 宿主进程里，那边 env 带着
   * 这个变量时，`Coopanion.exe --pet-host` 会被 Electron 当成「按 Node 解释器跑」，
   * 我们拼的参数全变成 node 的参数，进程立刻打一行 `bad option: --pet-host` 就没了，
   * 屏幕上什么都不出现——「启动桌宠」点了没反应的第一现场就在这里。
   */
  spawnPetHost(command, args, extra = {}) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...extra, env });
    // 自己退出的进程 `killed` 永远是 false，句柄不清掉就会一直走「复用」分支假成功。
    child.on('error', (err) => {
      if (this.petWindow === child) this.petWindow = null;
      this.log('桌宠进程起不来：' + (err && err.message ? err.message : err));
    });
    child.on('exit', (code) => {
      if (this.petWindow === child) this.petWindow = null;
      this.log('桌宠进程已退出，code=' + code);
    });
    child.unref();
    return child;
  }

  /** 收掉上一个桌宠进程，并等它真退干净：同一份 userData 抢着起会互相踩缓存。 */
  async stopPetHost() {
    const child = this.petWindow;
    this.petWindow = null;
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * 打开桌宠窗口：优先走宿主的透明浮层，退路才是 Edge 的小方窗。
   *
   * 以前这里只看 `this.petWindow.killed` 就返回 reused=true，结果两种情况下按钮
   * 都是「点了没反应」：页面右键菜单里的「隐藏」走 `HOST.hide()`，进程活着但
   * 窗口没了；进程自己退了 `killed` 也还是 false。插件侧没有把窗口重新 show 出来
   * 的通道，所以干脆一律先收掉旧的再起新的——点一次就一定看得到桌宠。
   */
  async openPetWindow(force = false, page = 'pet.html', size = '') {
    const serverStarted = await ensureServer();
    await this.stopPetHost();
    const host = findPetHost();
    if (host) {
      const child = this.spawnPetHost(host.command, [
        ...host.args,
        `--pet-url=${WIN_URL}${page}`,
        `--parent-pid=${process.pid}`,
        ...(size ? [`--width=${size.split(',')[0]}`, `--height=${size.split(',')[1]}`] : []),
      ]);
      this.petWindow = child;
      this.petTransparent = true;
      // 起完盯一眼：真起不来就报错，不能再给面板一个假的 ok。
      await sleep(1200);
      if (child.exitCode !== null) {
        throw new Error('窗口进程起来就退了（code=' + child.exitCode + '），详见 data/logs/core.log');
      }
      this.log(`透明浮层（来自 ${host.source}）已启动：${WIN_URL}${page}`);
      return { ok: true, url: WIN_URL + page, transparent: true, source: host.source, serverStarted, reused: false };
    }
    const browser = findBrowser();
    if (!browser) throw new Error('没找到 Edge 或 Chrome，装一个才能开窗口');
    const [ew, eh] = (size || '360,360').split(',');
    const child = this.spawnPetHost(
      browser,
      [
        `--app=${WIN_URL}${page}`,
        `--window-size=${ew},${eh}`,
        '--window-position=100,100',
        // 和聊天窗一样给一份独立 profile：复用用户默认 profile 会撞上
        // 「另一个实例正在使用」，开出来是白底窗甚至开不出来。
        `--user-data-dir=${path.join(PKG_DIR, 'state', 'pet-profile')}`,
        '--no-first-run',
        '--disable-features=Translate,MediaRouter',
        '--disable-background-mode',
        '--disable-backgrounding-occluded-windows',
      ],
      { windowsHide: false },
    );
    this.petWindow = child;
    this.petTransparent = false;
    this.log('Edge 小窗（不透明）已启动：' + WIN_URL + page);
    return { ok: true, url: WIN_URL + page, transparent: false, source: 'edge', browser, serverStarted, reused: false };
  }

  async closePetWindow() {
    await this.stopPetHost();
    return { ok: true };
  }

  /**
   * 面板上「导入立绘」的落盘端。
   *
   * 浏览器里选中的图只能以 base64 过来（面板没有文件系统），所以这里解码后
   * 写进 `assets/portrait/`，文件名按 `<动作>_<序号>` 接续，再把分组结果写进
   * `assets/portrait/manifest.json`；窗口启动时读这份 manifest 覆盖/追加动作。
   *
   * 只写 `assets/portrait/` 一个目录，不碰别的东西。
   */
  async importPortrait(items) {
    const dir = path.join(PKG_DIR, 'assets', 'portrait');
    const manifestPath = path.join(dir, 'manifest.json');
    await mkdir(dir, { recursive: true });

    let manifest = { faces: {} };
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      manifest = { faces: {} };
    }
    if (!manifest || typeof manifest !== 'object') manifest = { faces: {} };
    if (!manifest.faces || typeof manifest.faces !== 'object') manifest.faces = {};

    const written = [];
    const rejected = [];
    const list = Array.isArray(items) ? items : [];

    for (const item of list) {
      const face = String(item?.face || '').trim();
      const raw = String(item?.base64 || '');
      if (!face || !/^[a-z0-9_-]{1,24}$/i.test(face)) {
        rejected.push(`${item?.name || '?'}：动作名不合法`);
        continue;
      }
      const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i.exec(raw);
      if (!m) {
        rejected.push(`${item?.name || '?'}：不是 png/jpeg/webp 图片`);
        continue;
      }
      const ext = m[1].toLowerCase() === 'image/png' ? 'png'
        : m[1].toLowerCase() === 'image/webp' ? 'webp' : 'jpg';
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) {
        rejected.push(`${item?.name || '?'}：超过 8MB`);
        continue;
      }

      const group = Array.isArray(manifest.faces[face]) ? manifest.faces[face] : [];
      let n = group.length + 1;
      let file = `${face}_${n}.${ext}`;
      while (existsSync(path.join(dir, file))) {
        n += 1;
        file = `${face}_${n}.${ext}`;
      }
      await writeFile(path.join(dir, file), buf);
      // 内置的 13 张是 jpg 且不带序号后缀例外，这里一律「文件名带扩展名」入表，
      // 窗口侧直接拼 `${name}` 就行，不用再猜后缀。
      group.push(file);
      manifest.faces[face] = group;
      written.push(file);
    }

    if (written.length) manifest.updatedAt = new Date().toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return {
      ok: written.length > 0,
      written,
      rejected,
      faces: manifest.faces,
      dir,
      note: written.length ? '重开聊天窗口后生效' : '没有写入任何文件',
    };
  }

  async start() {
    this.log('网页端曳尔沐对话插件就绪（设置存于浏览器 ' + SETTINGS_KEY + '）');
  }

  async stop() {
    await this.closeWindow();
    await this.closePetWindow();
  }

  /** 面板只读这个，用来在「世界与插件」里显示一行状态。 */
  describe() {
    return {
      displayName: '和Y？聊天',
      summary: 'QQ2007 聊天窗口（独立 Edge 窗口）+ 像素立绘 + 关键词表情 + 透明桌宠',
      settingsKey: SETTINGS_KEY,
      window: WIN_URL,
    };
  }
}

export default {
  id: 'elymes-nte-web',
  label: '和Y？聊天',
  defaults: () => ({
    enabled: false,
  }),
  create: (ctx) => new ElymesNteWeb(ctx),
};
