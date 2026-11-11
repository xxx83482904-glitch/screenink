// 実際の main.js を起動し、ランチャーやツールバーのボタンと同じ IPC を呼んで、
// ウィンドウ制御・画面キャプチャ・モード切り替えを確かめる（OS へのキー/マウス入力は送らない）。
//   npm run test:main
// 数秒間、全画面の書き込み画面が実際に表示されます。保存とクリップボードには触りません。
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
require('../main.js');

const OUT = process.env.OUT || path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await sleep(1500);
  const find = (name) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith(name));
  const overlay = find('overlay.html'), launcher = find('launcher.html');
  const oj = (code) => overlay.webContents.executeJavaScript(code);
  const lj = (code) => launcher.webContents.executeJavaScript(code);
  const info = () => oj(`({ mode: __ink.mode, s: __ink.view.s, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, cw: document.getElementById('ink').width,
    images: __ink.items.filter((i) => i.type === 'image').map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h, nw: i.img.naturalWidth, nh: i.img.naturalHeight })),
    strokes: __ink.items.filter((i) => i.type === 'stroke').length })`);
  const lstate = () => lj('document.body.dataset.state');
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    console.log(`display ${d.bounds.width}x${d.bounds.height} scale ${d.scaleFactor}`);
    ok(launcher.isVisible() && !overlay.isVisible() && (await lstate()) === 'idle', '起動直後はランチャーだけが出ている');
    ok(/BT709/.test(d.colorSpace) && /SRGB/.test(d.colorSpace), '表示の色変換を止めている（撮った色がそのまま出る）', d.colorSpace);

    await lj('api.startFreeze()');
    await sleep(1800);
    let i = await info();
    const b = overlay.getBounds();
    ok(overlay.isVisible() && !launcher.isVisible() && i.mode === 'freeze', '「静止で書く」で書き込み画面が出てランチャーが隠れる');
    ok(b.x === d.bounds.x && b.y === d.bounds.y && b.width === d.bounds.width && b.height === d.bounds.height, '書き込み画面が対象の画面全体に重なる', JSON.stringify(b));
    ok(i.w === d.bounds.width && i.h === d.bounds.height && Math.abs(i.dpr - d.scaleFactor) < 0.01, '描画側の大きさと拡大率が画面と一致', JSON.stringify(i));
    const im = i.images[0];
    ok(i.images.length === 1 && im.w === d.bounds.width && im.h === d.bounds.height, 'キャプチャが画面と同じ大きさで原点に置かれる', JSON.stringify(im));
    ok(im && Math.abs(im.nw - d.bounds.width * d.scaleFactor) <= 1 && Math.abs(im.nh - d.bounds.height * d.scaleFactor) <= 1,
      'キャプチャの画素数が実画素と一致（書き込み位置がずれない）', JSON.stringify(im));
    fs.writeFileSync(path.join(OUT, 'main-freeze.png'), (await overlay.webContents.capturePage()).resize({ width: 1280 }).toPNG());

    // マウスで1本書く（この webContents にだけ届く入力）
    const send = (type, x, y) => overlay.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
    send('mouseDown', 400, 500);
    for (let k = 1; k <= 10; k++) { send('mouseMove', 400 + k * 20, 500 + k * 5); await sleep(8); }
    send('mouseUp', 600, 550);
    await sleep(150);
    ok((await info()).strokes === 1, '書き込める');

    // 追加キャプチャ: 隠す → ランチャーの「撮る」 → 右隣に並ぶ
    await oj('api.addCapture()');
    await sleep(500);
    ok(!overlay.isVisible() && launcher.isVisible() && (await lstate()) === 'add', '「＋撮影」で書き込み画面が隠れ、ランチャーに「撮る」が出る');
    await lj('api.addCancel()');
    await sleep(400);
    ok(overlay.isVisible() && !launcher.isVisible() && (await info()).images.length === 1, '「戻る」で撮らずに戻れる');
    await oj('api.addCapture()');
    await sleep(500);
    await lj('api.addShoot()');
    await sleep(1800);
    i = await info();
    ok(overlay.isVisible() && !launcher.isVisible() && i.images.length === 2 && i.images[1].x === d.bounds.width + 40 && i.s < 1 && i.strokes === 1,
      '「撮る」で2枚目が右隣に並び、全体表示になる', JSON.stringify(i));
    fs.writeFileSync(path.join(OUT, 'main-add.png'), (await overlay.webContents.capturePage()).resize({ width: 1280 }).toPNG());

    // ライブへ（書き込みは残る）→ 操作モード → 書くに戻る
    await oj(`api.switchMode('live')`);
    await sleep(700);
    i = await info();
    ok(i.mode === 'live' && i.strokes === 1 && i.s === 1 && overlay.isVisible(), 'ライブに切り替えても書き込みが残り、等倍に戻る');
    await oj('api.setPass(true)');
    await sleep(400);
    ok(launcher.isVisible() && (await lstate()) === 'pass' && (await oj('document.body.dataset.pass')) === '1', '「操作」でクリックを素通しにし、ランチャーが出る');
    await lj('api.startLive()');
    await sleep(400);
    ok(!launcher.isVisible() && (await oj('document.body.dataset.pass')) === '0', 'ランチャーの「書く」で書き込みに戻る');

    await oj('api.close()');
    await sleep(500);
    ok(!overlay.isVisible() && launcher.isVisible() && (await lstate()) === 'idle' && (await info()).strokes === 0, '閉じるとランチャーに戻り、書き込みは消える');
  } catch (err) {
    failed++;
    console.log('  FAIL (例外) ' + (err.stack || err));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
