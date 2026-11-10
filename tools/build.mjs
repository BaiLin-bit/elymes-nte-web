/**
 * 把 tools/webui.source.js 里的 __ART__ 换成内联 base64，产出 dist/webui.js。
 *
 * 为什么内联：宿主的扩展资产表只认 `cortico.webUiClient` 与 `cortico.webUiStyle`
 * 两个文件（见 core/bundled-panels.ts），同目录的散图 WebUI 取不到。
 * 改完源码或换图后重跑：node tools/build.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function dirToDataUris(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    const ext = extname(name).toLowerCase();
    const type = MIME[ext];
    if (!type) continue;
    out[basename(name, extname(name))] = `data:${type};base64,${readFileSync(full).toString('base64')}`;
  }
  return out;
}

const art = {
  portrait: dirToDataUris(join(root, 'assets', 'portrait')),
  pet: dirToDataUris(join(root, 'assets', 'pet')),
  font: {},
};

// 字体同样要内联：webui.css 由宿主从 /assets/<version>/webui.css 发出，
// 里面的 ../fonts/xxx.woff2 会 404，所以 base64 塞进 JS、运行时注入 @font-face。
for (const [name, file] of [
  ['poxiao', 'poxiao-pixel-cn-12.woff2'],
  ['fusion', 'FusionPixel.woff2'],
]) {
  const full = join(root, 'assets', 'fonts', file);
  if (existsSync(full)) {
    art.font[name] = `data:font/woff2;base64,${readFileSync(full).toString('base64')}`;
  }
}

const source = readFileSync(join(here, 'webui.source.js'), 'utf8');
if (!source.includes('__ART__')) {
  console.error('源码里没有 __ART__ 占位，拒绝覆盖 dist/webui.js');
  process.exit(1);
}

const json = JSON.stringify(art);
// 必须用 replaceAll 且传函数：字符串形式会把 json 里的 `$&` 之类当成替换模式，
// 而且只替换第一处会让 `const ART = __ART__;` 原样留在产物里（运行时 ReferenceError）。
const out = source.replaceAll('__ART__', () => json);
if (out.includes('__ART__')) {
  console.error('产物里还有未替换的 __ART__ 占位，构建中止');
  process.exit(1);
}
const target = join(root, 'dist', 'webui.js');
writeFileSync(target, out, 'utf8');

console.log(
  `dist/webui.js  ${(out.length / 1024 / 1024).toFixed(2)} MB`
  + `  portrait=${Object.keys(art.portrait).length}`
  + `  pet=${Object.keys(art.pet).length}`
  + `  font=${Object.keys(art.font).join('+') || '无'}`,
);
