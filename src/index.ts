// @ts-nocheck
/**
 * 千禧年复古外壳 · Coopanion World
 * ================================
 * 这个世界的本体很薄，两件事：
 *   1. 提供一个面板（`dist/webui.js` 的 `panels.skin`），里面是「启动窗口」按钮；
 *   2. 点按钮时把本地服务拉起来，再用 Edge 的 `--app` 模式开一个无地址栏的窗口。
 *
 * 为什么窗口要自己拉：宿主的 WebUI 是全 DOM 由 JS 生成 + Tailwind 原子类，
 * 在它上面盖皮只能「盖」不能「替」。独立窗口里 DOM 由我们自己写，才能真正
 * 做出图一那个 QQ2007 窗口。
 *
 * 为什么要有本地服务（`tools/window-server.mjs`）：Core 的 WS 握手会拒跨站
 * Origin（server.ts:812 的 isForeignOrigin），浏览器的 WS 一定带 Origin；
 * 本地服务在 Node 侧转发就不带 Origin，能过。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS_KEY_HINT = 'millennium.skin.v1';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIN_PORT = Number(process.env.MLN_PORT || 18800);
const WIN_URL = `http://127.0.0.1:${WIN_PORT}/`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 本地窗口服务活着吗。 */
function pingServer(timeoutMs = 1200): Promise<boolean> {
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
function findBrowser(): string | null {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env['ProgramFiles'],
    process.env['LOCALAPPDATA'],
  ].filter(Boolean);
  const rel = [
    '\\Microsoft\\Edge\\Application\\msedge.exe',
    '\\Google\\Chrome\\Application\\chrome.exe',
    '\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const candidates: string[] = [];
  for (const r of roots) {
    candidates.push(String(r) + rel[0]);
    candidates.push(String(r) + rel[1]);
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
 * 宿主在 `resources/app/app/main.cjs:77` 认 `--pet-host`，随后调
 * `cortico-world-desktop-pet/host/electron-main.cjs` 的 `runPetHost()` 开一个
 * `transparent: true / frame: false / alwaysOnTop` 的全屏覆盖层，并把
 * `CORTICO_DESKTOP_PET_HOST` 作为一条 JSON 数组命令交给 Core（main.cjs:283）。
 * 照着这条命令起进程、再补一个 `--pet-url=<页面地址>`，就能把千禧年的页面
 * 放进真正透明的窗口里 —— 不再是 Edge `--app` 那个带白底的方块窗。
 */
function findPetHost(): { command: string; args: string[]; source: string } | null {
  const env = process.env.CORTICO_DESKTOP_PET_HOST;
  if (env) {
    try {
      const argv = JSON.parse(env) as unknown;
      if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')) {
        return { command: argv[0] as string, args: (argv as string[]).slice(1), source: 'CORTICO_DESKTOP_PET_HOST' };
      }
    } catch {
      /* 解析不了就继续往下找 */
    }
  }
  // 兜底：自己本来就跑在 Coopanion 里
  const exe = process.execPath;
  if (exe && /coopanion/i.test(path.basename(exe))) {
    return { command: exe, args: ['--pet-host'], source: 'execPath' };
  }
  return null;
}

/** 端口没通就把本地服务拉起来（detached，主进程关了它还在）。 */
async function ensureServer(): Promise<boolean> {
  if (await pingServer()) return false;
  const script = path.join(PKG_DIR, 'tools', 'window-server.mjs');
  if (!existsSync(script)) throw new Error('找不到 tools/window-server.mjs');
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: PKG_DIR,
    env: { ...process.env, MLN_PORT: String(WIN_PORT) },
  });
  child.unref();
  for (let i = 0; i < 32; i++) {
    await sleep(250);
    if (await pingServer()) return true;
  }
  throw new Error('窗口服务起来了但端口 ' + WIN_PORT + ' 连不上');
}

class MillenniumWorld {
  readonly id = 'millennium';

  private readonly ctx: any;

  private browser: any = null;
  private petWindow: any = null;
  /** 桌宠是不是跑在宿主的透明浮层里（false 表示退回了 Edge 的不透明小窗）。 */
  private petTransparent = false;

  constructor(ctx) {
    this.ctx = ctx;
  }

  private log(msg: string): void {
    this.ctx?.log?.(msg);
  }

  /**
   * 宿主在装配期会无判空地调用 `mod.tools()`（见 world.ts:505、bot.ts:892），
   * 少一个就抛 `mod.tools is not a function`，世界开关会失败。
   * 这个壳不提供任何模型工具，返回空数组即可。
   */
  tools(): any[] {
    return [];
  }

  /** 同上，bot.ts:380 会 `await m.envPromptVars()` 并按对象合并。 */
  envPromptVars(): Record<string, unknown> {
    return {};
  }

  /**
   * 世界在 WebUI 里的页面声明。`panels` 不能省：宿主按它生成页面里的页签
   * （`bot.ts` 的 ioPageContribution 只读 `webUi().panels`），省略就会显示
   * 「没有声明任何面板」。`id` 必须与 `dist/webui.js` 里 `PANELS` 的键一致（即 skin）。
   */
  webUi(): any {
    return {
      label: '千禧年外壳',
      lamps: [],
      panels: [
        {
          id: 'skin',
          title: '皮肤设置',
          description: '启动聊天窗口、表情关键词、帧间隔与颜文字',
        },
      ],
      invoke: async (panel: string, method: string, args: unknown) => {
        const list = Array.isArray(args) ? args : [];
        if (method === 'windowState') {
          return { port: WIN_PORT, url: WIN_URL, running: await pingServer(), browser: findBrowser() };
        }
        if (method === 'openWindow') {
          return await this.openWindow(Boolean(list[0]));
        }
        if (method === 'importPortrait') {
          return await this.importPortrait(list[0] as any);
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
            const data = (await r.json()) as { sent?: number };
            if (!data || !data.sent) return { ok: false, error: '聊天窗口没连上，先打开窗口' };
            return { ok: true, face, sent: data.sent };
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) };
          }
        }
        if (method === 'openPetWindow') {
          return await this.openPetWindow(Boolean(list[0]));
        }
        if (method === 'closePetWindow') {
          return await this.closePetWindow();
        }
        throw new Error('未知操作：' + method);
      },
    };
  }

  /** 起服务 → 开 Edge --app 窗口。`force` 为真时忽略已开着的那个。 */
  async openWindow(force = false): Promise<any> {
    const serverStarted = await ensureServer();
    if (this.browser && !force && !this.browser.killed) {
      return { ok: true, url: WIN_URL, reused: true, serverStarted };
    }
    const browser = findBrowser();
    if (!browser) throw new Error('没找到 Edge 或 Chrome，装一个才能开窗口');
    const child = spawn(
      browser,
      [
        `--app=${WIN_URL}`,
        '--window-size=1120,740',
        '--no-first-run',
        '--disable-features=Translate,MediaRouter',
        '--autoplay-policy=no-user-gesture-required',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    child.unref();
    this.browser = child;
    this.log('千禧年窗口已打开：' + WIN_URL);
    return { ok: true, url: WIN_URL, browser, serverStarted, reused: false };
  }

  async closeWindow(): Promise<any> {
    try {
      this.browser?.kill?.();
    } catch {
      /* 已经退了 */
    }
    this.browser = null;
    return { ok: true };
  }

  /** 打开桌宠窗口：优先走宿主的透明浮层，退路才是 Edge 的小方窗。 */
  async openPetWindow(force = false): Promise<any> {
    const serverStarted = await ensureServer();
    if (this.petWindow && !force && !this.petWindow.killed) {
      return { ok: true, url: WIN_URL + 'pet.html', reused: true, serverStarted, transparent: this.petTransparent };
    }
    const host = findPetHost();
    if (host) {
      const child = spawn(
        host.command,
        [...host.args, `--pet-url=${WIN_URL}pet.html`, `--parent-pid=${process.pid}`],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
      this.petWindow = child;
      this.petTransparent = true;
      this.log(`千禧年桌宠（透明浮层，来自 ${host.source}）已启动：${WIN_URL}pet.html`);
      return { ok: true, url: WIN_URL + 'pet.html', transparent: true, source: host.source, serverStarted, reused: false };
    }
    const browser = findBrowser();
    if (!browser) throw new Error('没找到 Edge 或 Chrome，装一个才能开窗口');
    const child = spawn(
      browser,
      [
        `--app=${WIN_URL}pet.html`,
        '--window-size=360,360',
        '--window-position=100,100',
        '--no-first-run',
        '--disable-features=Translate,MediaRouter',
        '--disable-background-mode',
        '--disable-backgrounding-occluded-windows',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    child.unref();
    this.petWindow = child;
    this.petTransparent = false;
    this.log('千禧年桌宠（Edge 小窗，不透明）已启动：' + WIN_URL + 'pet.html');
    return { ok: true, url: WIN_URL + 'pet.html', transparent: false, source: 'edge', browser, serverStarted, reused: false };
  }

  async closePetWindow(): Promise<any> {
    try {
      this.petWindow?.kill?.();
    } catch {
      /* 已经退了 */
    }
    this.petWindow = null;
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
  async importPortrait(items: Array<{ face?: string; base64?: string; name?: string }>): Promise<any> {
    const dir = path.join(PKG_DIR, 'assets', 'portrait');
    const manifestPath = path.join(dir, 'manifest.json');
    await mkdir(dir, { recursive: true });

    let manifest: any = { faces: {} };
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      manifest = { faces: {} };
    }
    if (!manifest || typeof manifest !== 'object') manifest = { faces: {} };
    if (!manifest.faces || typeof manifest.faces !== 'object') manifest.faces = {};

    const written: string[] = [];
    const rejected: string[] = [];
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

  async start(): Promise<void> {
    this.log('千禧年外壳就绪（皮肤设置存于浏览器 ' + SETTINGS_KEY_HINT + '）');
  }

  async stop(): Promise<void> {
    await this.closeWindow();
    await this.closePetWindow();
  }

  /** 面板只读这个，用来在「世界与插件」里显示一行状态。 */
  describe(): any {
    return {
      displayName: '千禧年复古外壳',
      summary: 'QQ2007 聊天窗口（独立 Edge 窗口）+ 像素立绘 + 关键词表情',
      settingsKey: SETTINGS_KEY_HINT,
      window: WIN_URL,
    };
  }
}

export default {
  id: 'millennium',
  label: '千禧年外壳',
  defaults: () => ({
    enabled: false,
  }),
  create: (ctx) => new MillenniumWorld(ctx),
};
