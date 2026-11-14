/* 全屏彩蛋页逻辑（三幕版）
   目标：底图 + 随机透明窗 + 粉色半调/深蓝渐变 + X / +Y= / 世界 / 10KB 渐变像素字
        + 3 个斜列错误弹窗 + 灰框逐字浮动窗 + 图片窗，5 秒内走完三幕。
   触发：聊天窗发送 316651 后 POST /elymes-api/nt，由 window-server 拉起本页。
   收尾：默认 10 秒自动关；auto=0 时一直停留，直到 Esc / 确定 / 点空白关闭。 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('t') || '';
  const AUTO = params.get('auto') !== '0';
  const DURATION = 10000;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const layer = $('windows');
  const base = $('base');
  const dialog = $('dialog');
  const clock = $('tb-clock');
  const rgb1 = $('rgb1');
  const rgb2 = $('rgb2');

  const vw = () => window.innerWidth;
  const vh = () => window.innerHeight;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[(Math.random() * list.length) | 0];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = (Math.random() * (i + 1)) | 0;
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const BASES = [
    './nt/base1.webp', './nt/base2.webp', './nt/confident.webp',
    './nt/request1.webp', './nt/request2.webp', './nt/request3.webp',
  ];

  const ART = [
    { src: './nt/paint.webp',    title: '未命名 - 画图' },
    { src: './nt/base2.webp',    title: 'YMB' },
    { src: './nt/eye.webp',      title: 'virus.exe' },
    { src: './nt/door.webp',     title: '新建文件夹' },
    { src: './nt/victory.webp',  title: '世界' },
    { src: './nt/dance.webp',    title: '跳舞' },
    { src: './nt/confident.webp', title: '我的电脑' },
  ];

  const TITLES = [
    '未命名 - 画图', '无标题 - 记事本', 'YMB', 'virus.exe', '新建文件夹',
    'C:\\WINDOWS\\system32', '10KB', '回收站', '我的电脑', '世界',
  ];

  const ERR_AT = [
    { x: 0.25, y: 0.06 },
    { x: 0.30, y: 0.085 },
    { x: 0.35, y: 0.11 },
  ];

  let closed = false;
  let autoTimer = 0;
  let flickerTimer = 0;
  const timers = [];
  const driftIntervals = [];

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      if (closed) return;
      fn();
    }, ms);
    timers.push(id);
    return id;
  };

  /* 每个窗口自己的漂浮节拍：周期与幅度都随机；报错窗用更长的周期 */
  function drift(el, period, amp) {
    const bx = parseFloat(el.style.left) || 0;
    const by = parseFloat(el.style.top) || 0;
    const ease = Math.round(period * 0.65);
    el.style.transition = `left ${ease}ms ease-in-out, top ${ease}ms ease-in-out`;
    const id = setInterval(() => {
      if (closed) return;
      const w = el.offsetWidth || 220;
      const h = el.offsetHeight || 140;
      el.style.left = `${clamp(bx + rnd(-amp, amp), 4, vw() - w - 4)}px`;
      el.style.top = `${clamp(by + rnd(-amp, amp), 4, vh() - h - 4)}px`;
    }, period);
    driftIntervals.push(id);
  }

  /* 粉色半调噪点：canvas 生成一张透明底贴图，所有窗共用，靠 background-size 随机化 */
  function makeNoise() {
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const g = c.getContext('2d');
    if (!g) return '';
    g.clearRect(0, 0, 96, 96);
    for (let i = 0; i < 110; i += 1) {
      const x = Math.random() * 96;
      const y = Math.random() * 96;
      const r = rnd(0.8, 2.6);
      g.beginPath();
      g.fillStyle = Math.random() < 0.18
        ? `rgba(255,255,255,${rnd(0.18, 0.55).toFixed(2)})`
        : `rgba(255,${Math.round(rnd(95, 160))},${Math.round(rnd(185, 235))},${rnd(0.16, 0.62).toFixed(2)})`;
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    return c.toDataURL('image/png');
  }

  const NOISE = makeNoise();
  if (NOISE) document.documentElement.style.setProperty('--noise', `url("${NOISE}")`);

  /* 底图随机 + 错误兜底 */
  function setBase(src) {
    base.src = src;
    rgb1.style.backgroundImage = `url("${src}")`;
    rgb2.style.backgroundImage = `url("${src}")`;
  }

  base.addEventListener('error', () => {
    const tries = Number(base.dataset.tries || '0');
    if (tries >= 2) return;
    base.dataset.tries = String(tries + 1);
    const next = pick(BASES.filter((x) => x !== base.src));
    if (next) setBase(next);
  });

  function makeWindow({ x, y, w, h, kind = 'glass', title, src, flip, glyph, tint, delay = 0 }) {
    const nw = document.createElement('section');
    nw.className = `nw ${kind}`;
    nw.style.cssText = [
      `left:${Math.round(x)}px`,
      `top:${Math.round(y)}px`,
      `width:${Math.round(w)}px`,
      `height:${Math.round(h)}px`,
      `z-index:${kind === 'glyph' ? 60 : kind === 'stone' ? 46 : kind === 'art' ? 40 : kind === 'glass' ? 22 : 24}`,
    ].join(';');
    nw.style.setProperty('--ns', `${Math.round(rnd(22, 44))}px`);
    nw.style.setProperty('--np', `${Math.round(rnd(0, 100))}% ${Math.round(rnd(0, 100))}%`);

    const bar = document.createElement('header');
    bar.className = 'nw-bar';
    const t = document.createElement('span');
    t.className = 'nw-title';
    t.textContent = title || pick(TITLES);
    const btns = document.createElement('span');
    btns.className = 'nw-btns';
    btns.innerHTML = '<i>_</i><i>□</i><i class="x">✕</i>';
    bar.append(t, btns);

    const body = document.createElement('div');
    body.className = 'nw-body';

    if (kind === 'glyph') {
      const span = document.createElement('span');
      span.className = 'glyph-text ' + (tint || '');
      span.textContent = glyph;
      const len = Math.max(1, [...glyph].length);
      const size = Math.min((w - 16) / (len * 0.78), (h - 30) * 0.92);
      span.style.fontSize = `${Math.max(34, size)}px`;
      body.appendChild(span);
    } else if (kind === 'art') {
      const img = document.createElement('img');
      img.className = 'crop';
      img.src = src;
      img.alt = '';
      img.draggable = false;
      img.style.objectPosition = `${Math.round(rnd(18, 82))}% ${Math.round(rnd(18, 82))}%`;
      img.style.transform = flip ? 'scaleX(-1)' : '';
      img.addEventListener('error', () => nw.remove(), { once: true });
      body.appendChild(img);
    } else if (kind === 'texture') {
      body.className = 'nw-body texture-body';
    } else if (kind === 'stone') {
      body.className = 'nw-body stone-body';
      const text = document.createElement('div');
      text.className = 'stone-text';
      [...'我们做朋友吧'].forEach((ch) => {
        const s = document.createElement('span');
        s.className = 'stone-char';
        s.textContent = ch;
        const horizontal = Math.random() < 0.5;
        const amp = rnd(2.5, 4.5);
        s.style.setProperty('--dx', horizontal ? `${amp.toFixed(1)}px` : '0px');
        s.style.setProperty('--dy', horizontal ? '0px' : `${amp.toFixed(1)}px`);
        s.style.setProperty('--dur', `${rnd(1.1, 2.6).toFixed(2)}s`);
        s.style.setProperty('--del', `${rnd(0, 0.8).toFixed(2)}s`);
        text.appendChild(s);
      });
      body.appendChild(text);
    } else {
      for (let i = 0; i < 7; i += 1) {
        const line = document.createElement('div');
        line.className = 'note-line';
        body.appendChild(line);
      }
      const grip = document.createElement('span');
      grip.className = 'note-grip';
      body.appendChild(grip);
    }

    nw.append(bar, body);
    nw.style.setProperty('--d', `${Math.round(delay)}ms`);
    layer.appendChild(nw);
    drift(
      nw,
      kind === 'glyph' ? rnd(1600, 3000) : rnd(2200, 4600),
      kind === 'art' ? rnd(3, 6) : rnd(2, 4),
    );
    return nw;
  }

  function glitch(kind, ms = 360) {
    if (closed) return;
    stage.classList.add(kind);
    later(() => stage.classList.remove(kind), ms);
  }

  function flash() {
    if (closed) return;
    stage.classList.add('flash');
    setTimeout(() => stage.classList.remove('flash'), 150);
  }

  function buildErrors(W, H) {
    ERR_AT.forEach((pos, i) => {
      const box = document.createElement('div');
      box.className = 'errbox';
      box.style.left = `${clamp(pos.x * W, 10, W - 300)}px`;
      box.style.top = `${clamp(pos.y * H, 8, H - 190)}px`;
      box.style.zIndex = String(9000 + i);
      box.style.animationDelay = `${i * 180}ms`;
      box.innerHTML = `
        <div class="errtitle"><span>错误</span><span class="errx">✕</span></div>
        <div class="errbody">
          <span class="erricon">✕</span>
          <p>我们一起做朋友吧！！！</p>
        </div>
        <div class="errbtns"><button type="button">确定</button></div>`;
      box.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        close('dialog');
      });
      dialog.appendChild(box);
      drift(box, rnd(5200, 8800), rnd(1.5, 3));
    });
  }

  function build() {
    const W = vw();
    const H = vh();
    const bottom = 48;

    setBase(pick(BASES));
    buildErrors(W, H);

    const glyphs = [
      { text: 'X',    ax: 0.055, ay: 0.29, aw: 0.165, ah: 0.215, tint: 'warm' },
      { text: '+Y=',  ax: 0.255, ay: 0.40, aw: 0.240, ah: 0.190, tint: '' },
      { text: '世界', ax: 0.590, ay: 0.43, aw: 0.230, ah: 0.215, tint: 'ice' },
      { text: '10KB', ax: 0.660, ay: 0.66, aw: 0.270, ah: 0.170, tint: '' },
    ];

    const artSlots = [
      { ax: 0.015, ay: 0.045, aw: 0.200, ah: 0.235 },
      { ax: 0.790, ay: 0.050, aw: 0.190, ah: 0.240 },
      { ax: 0.020, ay: 0.600, aw: 0.150, ah: 0.210 },
      { ax: 0.810, ay: 0.590, aw: 0.160, ah: 0.220 },
    ];

    const textureSlots = [
      { ax: 0.185, ay: 0.060, aw: 0.160, ah: 0.125 },
      { ax: 0.470, ay: 0.760, aw: 0.210, ah: 0.130 },
      { ax: 0.790, ay: 0.340, aw: 0.150, ah: 0.140 },
      { ax: 0.870, ay: 0.220, aw: 0.120, ah: 0.130 },
    ];

    // 纯透明窗：只有 Win98 外框和标题栏，内容区透出底图
    const glassSlots = [
      { ax: 0.365, ay: 0.075, aw: 0.165, ah: 0.205 },
      { ax: 0.545, ay: 0.255, aw: 0.150, ah: 0.180 },
      { ax: 0.315, ay: 0.615, aw: 0.145, ah: 0.165 },
    ];

    const arts = shuffle(ART).slice(0, 4);
    const artItems = arts.map((a, i) => ({
      kind: 'art', src: a.src, title: a.title,
      ...artSlots[i],
    }));

    const textures = textureSlots.map((slot) => ({
      kind: 'texture', title: pick(TITLES), ...slot,
    }));

    const glasses = glassSlots.map((slot) => ({
      kind: 'glass', title: pick(TITLES), ...slot,
    }));

    const stone = {
      kind: 'stone', title: '无标题 - 记事本',
      ax: 0.04, ay: 0.70, aw: 0.18, ah: 0.13,
    };

    const glyphItems = glyphs.map((g) => ({
      kind: 'glyph', glyph: g.text, tint: g.tint,
      ax: g.ax, ay: g.ay, aw: g.aw, ah: g.ah,
      title: pick(TITLES),
    }));

    const place = (item) => {
      let w = clamp(item.aw * W * rnd(0.9, 1.08), 120, W * 0.38);
      let h = clamp(item.ah * H * rnd(0.9, 1.08), 86, H * 0.34);
      if (item.kind === 'stone') {
        w = clamp(w, 260, 400);
        h = clamp(h, 120, 170);
      }
      const x = clamp(item.ax * W + rnd(-0.012, 0.012) * W, 8, W - w - 8);
      const y = clamp(item.ay * H + rnd(-0.012, 0.012) * H, 8, H - h - bottom);
      return { ...item, x, y, w, h };
    };

    const add = (item, delay) => {
      const p = place(item);
      later(() => {
        makeWindow({ ...p, delay });
      }, delay);
    };

    // 第一幕：底图 + 四个字 + 两枚纹理窗 + 两张图片 + 两枚透明窗
    glyphItems.forEach((g, i) => add(g, 120 + i * 80));
    add(textures[0], 260);
    add(textures[1], 380);
    add(artItems[0], 520);
    add(glasses[0], 300);
    add(glasses[1], 900);

    // 第二幕：故障 + 两张图片 + 第三枚纹理 + 灰框浮字 + 三个报错窗 + 第三枚透明窗
    later(() => glitch('g1', 420), 1180);
    add(artItems[1], 1260);
    add(artItems[2], 1420);
    add(textures[2], 1500);
    add(glasses[2], 1550);
    add(stone, 1580);
    later(() => {
      dialog.hidden = false;
    }, 1400);

    // 第三幕：最后一张图片 + 第四枚纹理 + 二次故障
    later(() => glitch('g2', 300), 2600);
    add(artItems[3], 2660);
    add(textures[3], 2840);
    later(() => glitch('g1', 260), 4700);

    // 5 秒后进入保持段：偶发闪切
    later(() => {
      flickerTimer = setInterval(() => {
        if (closed) return;
        if (Math.random() < 0.55) flash();
      }, 1500);
    }, 3200);

    // 任务栏时钟
    const tick = () => {
      const d = new Date();
      clock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    tick();
    setInterval(tick, 5000);
  }

  function sendClose(reason) {
    const done = () => { try { window.close(); } catch { /* 关不掉就交给服务端 */ } };
    try {
      fetch('/elymes-api/nt-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: TOKEN, reason }),
        keepalive: true,
      }).catch(() => {}).finally(() => setTimeout(done, 120));
    } catch {
      setTimeout(done, 120);
    }
    setTimeout(done, 800);
  }

  function close(reason = 'manual') {
    if (closed) return;
    closed = true;
    clearTimeout(autoTimer);
    clearInterval(flickerTimer);
    timers.forEach((id) => clearTimeout(id));
    driftIntervals.forEach((id) => clearInterval(id));
    document.body.classList.add('nt-out');
    sendClose(reason);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close('esc');
    }
  });

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.errbox')) return;
    close('click');
  });

  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  build();

  if (AUTO) {
    // 先淡出，再交给服务端收尾
    later(() => document.body.classList.add('nt-out'), 9400);
    autoTimer = setTimeout(() => close('auto'), DURATION);
  }
})();
