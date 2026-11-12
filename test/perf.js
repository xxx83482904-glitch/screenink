// 描画の重さを測る。Surface 相当の画素数（既定 1920x1280 CSS px × 150% = 2880x1920）で、
// 線をたくさん書いた状態の「1コマを描き直す時間」を出す。
//   npm run test:perf
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');

const SCALE = Number(process.env.SCALE || 1.5);
const W = Number(process.env.W || 1920), H = Number(process.env.H || 1280);
const N = Number(process.env.STROKES || 300);
app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCapture(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, c = ((x >> 6) + (y >> 6)) % 2 ? 205 : 232;
    buf[i] = c - 20; buf[i + 1] = c; buf[i + 2] = c - 6; buf[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

app.whenReady().then(async () => {
  for (const ch of ['save-png', 'grab-screen', 'read-clipboard-image', 'copy-png']) ipcMain.handle(ch, () => null);
  for (const ch of ['switch-mode', 'set-pass', 'close-overlay', 'add-capture']) ipcMain.on(ch, () => {});
  const win = new BrowserWindow({
    x: 0, y: 0, width: W, height: H, useContentSize: true, show: false, frame: false, backgroundColor: '#808080', enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'overlay.html'));
  win.showInactive();
  const js = (code) => win.webContents.executeJavaScript(code);
  try {
    const t0 = Date.now();
    const url = fakeCapture(Math.round(W * SCALE), Math.round(H * SCALE)).toDataURL();
    const tEnc = Date.now() - t0;
    const ready = new Promise((r) => ipcMain.once('overlay-ready', r));
    const t1 = Date.now();
    win.webContents.send('set-mode', { mode: 'freeze', keepInk: false, size: { w: W, h: H }, image: url });
    await ready;
    console.log(`canvas ${await js('ink.width')}x${await js('ink.height')}  画像の受け渡し: 符号化 ${tEnc}ms + 表示まで ${Date.now() - t1}ms`);

    // 線を N 本（うち1割はマーカー）、1本 60 点
    await js(`(() => {
      const list = [];
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < ${N}; i++) {
        const x = rnd() * ${W - 200}, y = rnd() * ${H - 100}, pts = [];
        for (let k = 0; k < 60; k++) pts.push({ x: x + k * 3 + Math.sin(k / 4 + i) * 12, y: y + Math.cos(k / 5 + i) * 18 + k, p: 0.3 + 0.5 * Math.abs(Math.sin(k / 9)) });
        list.push({ id: nextId++, type: 'stroke', tool: i % 10 === 0 ? 'hl' : 'pen', color: '#ff3b30', size: i % 10 === 0 ? 16 : 4, pts, t: 0 });
      }
      items = [...items, ...list]; commit(); drawAll();
    })()`);
    await sleep(300);
    const time = (label, body, n = 20) => js(`(async () => {
      const ts = [];
      for (let i = 0; i < ${n}; i++) {
        const a = performance.now();
        ${body};
        ictx.getImageData(0, 0, 1, 1); // 描画を確実に終わらせてから測る
        ts.push(performance.now() - a);
        await new Promise((r) => setTimeout(r, 0));
      }
      ts.sort((a, b) => a - b);
      return ${JSON.stringify(label)} + ': 中央値 ' + ts[ts.length >> 1].toFixed(1) + 'ms / 最大 ' + ts[ts.length - 1].toFixed(1) + 'ms';
    })()`);
    console.log(`線 ${N} 本`);
    console.log(' ', await time('全体の描き直し（戻す・進む・止まった後の1回）', 'view.tx = (i % 2) * 3; drawAll()'));
    console.log(' ', await time('拡大縮小・移動の1コマ', 'view.tx = i * 3; view.s = 1 + i * 0.01; drawBg(); const r = view.s / inkView.s; ink.style.transform = `translate(${view.tx - inkView.tx * r}px, ${view.ty - inkView.ty * r}px) scale(${r})`; drawUi()'));
    await js('view.s = 1; view.tx = 0; view.ty = 0; drawAll()');
    console.log(' ', await time('消しゴムの1コマ', 'erasing = { last: { x: 500, y: 500 }, r: 12, screen: { x: 500, y: 500 } }; eraseSeg({ x: 400 + i * 20, y: 400 }, { x: 420 + i * 20, y: 420 }); if (erasing.dirty) drawInkRegion(erasing.dirty); drawUi(); erasing = null'));
    await js("setSel(items.filter((it) => it.type === 'stroke').slice(0, 20).map((it) => it.id)); xform = { id: 1, kind: 'move', start: { x: 0, y: 0 }, base: items, ids: new Set(sel), moved: true }; drawAll()");
    console.log(' ', await time('選択したものを動かす1コマ', 'items = xform.base.map((it) => (xform.ids.has(it.id) ? G.transformItem(it, { s: 1, ax: 0, ay: 0, dx: i, dy: i }) : it)); drawAll()'));
  } catch (e) { console.log('ERR', e.stack || e); }
  app.exit(0);
});
