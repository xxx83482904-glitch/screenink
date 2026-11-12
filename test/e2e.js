// 実際の overlay.html を Electron で開き、ペン・指・マウスの入力を合成して動作を確かめる。
//   npm run test:e2e            （拡大率 100%）
//   set SCALE=1.5 && npm run test:e2e   （拡大率 150% を模擬）
// 画面キャプチャとウィンドウ制御（main.js）は対象外。そこは実機で確認する。
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const SCALE = Number(process.env.SCALE || 1);
const OUT = process.env.OUT || path.join(__dirname, 'out');
const W = 1000, H = 700;
app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE));

let win, dbg;
let failed = 0, passed = 0;
const saved = [];
const copied = [];
const docs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (code) => win.webContents.executeJavaScript(code);
const cdp = (method, params) => dbg.sendCommand(method, params);

function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---- 入力の合成 ----
async function drag(pts, opt = {}) {
  const base = { button: opt.button || 'left', pointerType: opt.pointerType || 'mouse', modifiers: opt.modifiers || 0 };
  if (opt.force != null) base.force = opt.force;
  const buttons = { left: 1, right: 2, middle: 4 }[base.button];
  await cdp('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons, clickCount: 1 });
  if (opt.hold) await sleep(opt.hold);
  for (const [x, y] of pts.slice(1)) {
    await cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', x, y, buttons });
    await sleep(opt.step == null ? 4 : opt.step);
  }
  const last = pts[pts.length - 1];
  await cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', x: last[0], y: last[1], buttons: 0, clickCount: 1 });
  await sleep(40);
}
const pen = (pts, opt = {}) => drag(pts, { pointerType: 'pen', force: 0.6, ...opt });

// 点列をなめらかにつなぐ（n 分割）
function line(a, b, n = 12) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  return out;
}
function path2(points, n = 8) {
  let out = [points[0]];
  for (let i = 1; i < points.length; i++) out = out.concat(line(points[i - 1], points[i], n).slice(1));
  return out;
}

async function touch(type, pts) {
  await cdp('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
  await sleep(16);
}
// 2本指を from → to へ動かす
async function twoFinger(from, to, steps = 10) {
  await touch('touchStart', from);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', from.map((p, k) => [p[0] + (to[k][0] - p[0]) * i / steps, p[1] + (to[k][1] - p[1]) * i / steps]));
  }
  await touch('touchEnd', []);
  await sleep(60);
}
async function tap(x, y) {
  await touch('touchStart', [[x, y]]);
  await sleep(40);
  await touch('touchEnd', []);
  await sleep(60);
}
async function key(k, mods = 0, code) {
  const p = { key: k, code: code || ('Key' + k.toUpperCase()), modifiers: mods, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : undefined };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
  await sleep(60);
}
const CTRL = 2, SHIFT = 8;
async function wheel(x, y, deltaX, deltaY, modifiers = 0) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers });
  await sleep(80);
}
const send = (ch, payload) => win.webContents.send(ch, payload);

const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
const state = () => js(`(() => { const k = window.__ink; return {
  mode: k.mode, view: { ...k.view },
  items: k.items.map((it) => it.type === 'image'
    ? { id: it.id, type: 'image', base: !!it.base, x: it.x, y: it.y, w: it.w, h: it.h }
    : { id: it.id, type: 'stroke', tool: it.tool, size: it.size, n: it.pts.length, first: it.pts[0], last: it.pts[it.pts.length - 1],
        maxP: Math.max(...it.pts.map((p) => p.p)) }),
  sel: k.selection ? [...k.selection] : [],
  toast: document.getElementById('toast').classList.contains('show') ? document.getElementById('toast').textContent : '',
}; })()`);
const strokes = (st) => st.items.filter((it) => it.type === 'stroke');
const images = (st) => st.items.filter((it) => it.type === 'image');
// canvas の1画素（CSS px 指定）
const pixel = (id, x, y) => js(`(() => { const c = document.getElementById('${id}'); const d = devicePixelRatio;
  return [...c.getContext('2d').getImageData(Math.round(${x} * d), Math.round(${y} * d), 1, 1).data]; })()`);

async function shot(name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
}

// テスト用の画面キャプチャ（格子模様）
function fakeCapture(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = ((x >> 6) + (y >> 6)) % 2 ? 205 : 232;
      buf[i] = c - 20; buf[i + 1] = c; buf[i + 2] = c - 6; buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

function setMode(payload) {
  return new Promise((resolve) => {
    ipcMain.once('overlay-ready', () => setTimeout(resolve, 80));
    win.webContents.send('set-mode', payload);
  });
}
const freeze = (keepInk = false) => setMode({
  mode: 'freeze', keepInk, size: { w: W, h: H },
  image: fakeCapture(Math.round(W * SCALE), Math.round(H * SCALE)).toDataURL(),
});

const suites = [];
const suite = (name, fn) => suites.push({ name, fn });
module.exports = { wheel, send, suite, ok, near, sleep, js, state, strokes, images, pixel, shot, pen, drag, line, path2, touch, twoFinger, tap, key, click, freeze, setMode, saved, copied, docs, CTRL, SHIFT, W, H, SCALE, fakeCapture,
  get win() { return win; } };

for (const f of fs.readdirSync(__dirname).filter((n) => /^e2e-.*\.js$/.test(n)).sort()) require(path.join(__dirname, f));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  ipcMain.handle('save-png', (_e, dataUrl) => {
    const img = nativeImage.createFromDataURL(dataUrl);
    const file = path.join(OUT, `saved${saved.length}.png`);
    fs.writeFileSync(file, img.toPNG());
    saved.push({ file, ...img.getSize() });
    return { file, copied: true };
  });
  ipcMain.handle('save-doc', (_e, json, dataUrl) => { docs.push({ json, png: nativeImage.createFromDataURL(dataUrl).getSize() }); return { file: 'test' + docs.length + '.screenink' }; });
  ipcMain.handle('grab-screen', () => fakeCapture(Math.round(W * SCALE), Math.round(H * SCALE)).toDataURL());
  module.exports.clipboardImage = null;
  ipcMain.handle('read-clipboard-image', () => module.exports.clipboardImage);
  ipcMain.handle('copy-png', (_e, dataUrl) => { copied.push(nativeImage.createFromDataURL(dataUrl).getSize()); return true; });
  for (const ch of ['switch-mode', 'set-pass', 'close-overlay', 'add-capture']) ipcMain.on(ch, () => {});

  win = new BrowserWindow({
    x: 40, y: 40, width: W, height: H, useContentSize: true, show: false, frame: false, backgroundColor: '#808080',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'overlay.html'));
  win.showInactive();
  dbg = win.webContents.debugger;
  dbg.attach('1.3');
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) { failed++; console.log('  PAGE ERROR ' + e.message); } });
  await sleep(300);

  const only = process.env.ONLY;
  for (const s of suites) {
    if (only && !s.name.includes(only)) continue;
    console.log('\n' + s.name);
    try { await s.fn(); } catch (err) { failed++; console.log('  FAIL (例外) ' + (err.stack || err)); }
  }
  console.log(`\n${passed} passed, ${failed} failed  (SCALE=${SCALE})`);
  app.exit(failed ? 1 : 0);
});
