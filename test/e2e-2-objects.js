const t = require('./e2e');
const { ok, near, W, H, SCALE } = t;

const center = () => t.js('[innerWidth / 2, innerHeight / 2]');
const selRectOf = (it) => ({ x: it.x - 6, y: it.y - 6, w: it.w + 12, h: it.h + 12 }); // 等倍表示のときの選択枠

t.suite('2. 貼り付け・画像オブジェクト・選択', async () => {
  await t.freeze();
  await t.sleep(1600);

  // Ctrl+V: 見えている範囲の中央に、元の大きさで貼り付けて選択状態にする
  t.clipboardImage = t.fakeCapture(Math.round(300 * SCALE), Math.round(200 * SCALE)).toDataURL();
  await t.key('v', t.CTRL);
  await t.sleep(200);
  let st = await t.state();
  let img = t.images(st)[1];
  ok(t.images(st).length === 2 && near(img.w, 300, 1) && near(img.h, 200, 1), '貼り付けた画像は元の大きさ', JSON.stringify(img));
  const [cx, cy] = await center();
  ok(near(img.x + img.w / 2, cx, 1) && near(img.y + img.h / 2, cy, 1), '貼り付け位置は見えている範囲の中央');
  ok(st.sel.length === 1 && st.sel[0] === img.id, '貼り付けた画像が選択されている');
  await t.shot('2-pasted');

  // 指でドラッグして移動
  const c = [img.x + img.w / 2, img.y + img.h / 2];
  await t.touch('touchStart', [c]);
  for (let i = 1; i <= 10; i++) await t.touch('touchMove', [[c[0] + i * 10, c[1] + i * 5]]);
  await t.touch('touchEnd', []);
  st = await t.state();
  let moved = t.images(st)[1];
  ok(near(moved.x, img.x + 100, 1) && near(moved.y, img.y + 50, 1) && st.sel.length === 1, '指のドラッグで移動できる', JSON.stringify(moved));
  await t.key('z', t.CTRL);
  ok(near(t.images(await t.state())[1].x, img.x, 1), '移動を「戻す」で取り消せる');
  await t.key('y', t.CTRL);

  // ペンで角を掴んで拡大（縦横比は保つ）
  st = await t.state();
  img = t.images(st)[1];
  let r = selRectOf(img);
  await t.pen(t.line([r.x + r.w, r.y + r.h], [r.x + r.w + 90, r.y + r.h + 60]));
  st = await t.state();
  const big = t.images(st)[1];
  ok(big.w > img.w * 1.2 && near(big.w / big.h, 1.5, 0.01) && near(big.x, img.x, 4) && near(big.y, img.y, 4), '角のハンドルで拡大縮小できる', JSON.stringify(big));
  ok(t.strokes(st).length === 0, '選択を操作している間は線が書かれない');

  // 削除と取り消し
  await t.key('Delete', 0, 'Delete');
  st = await t.state();
  ok(t.images(st).length === 1 && st.sel.length === 0, 'Delete で削除できる');
  await t.key('z', t.CTRL);
  st = await t.state();
  ok(t.images(st).length === 2, '削除を「戻す」で取り消せる');

  // 指のタップで選択 / 何もない所で解除 / 撮った画面そのものは選ばない
  await t.sleep(1600);
  img = t.images(st)[1];
  await t.tap(img.x + 20, img.y + 20);
  ok((await t.state()).sel[0] === img.id, '指のタップで貼り付けた画像を選択できる');
  await t.tap(60, H - 40);
  ok((await t.state()).sel.length === 0, '何もない所をタップすると選択が外れ、撮った画面は選ばれない');

  // メニューの「削除」
  await t.tap(img.x + 20, img.y + 20);
  ok(await t.js(`document.getElementById('selMenu').classList.contains('show')`), '選択するとメニューが出る');
  await t.click('selDelete');
  ok(t.images(await t.state()).length === 1, 'メニューの「削除」で消せる');

  // 移動してから貼り付けても「今見えている範囲」の中央
  await t.wheel(500, 400, 0, 100);
  await t.click('paste');
  await t.sleep(200);
  st = await t.state();
  img = t.images(st)[1];
  ok(near(st.view.ty, -100, 1) && near(img.y + img.h / 2, cy + 100, 1), '表示を動かした後も見えている範囲の中央に貼り付く', JSON.stringify(img));
  await t.key('Delete', 0, 'Delete');
  await t.click('zoom');

  // Ctrl+ホイールで拡大縮小（カーソル位置が中心）
  await t.wheel(500, 400, 0, -50, t.CTRL);
  st = await t.state();
  ok(st.view.s > 1.2 && near((500 - st.view.tx) / st.view.s, 500, 1), 'Ctrl+ホイールでカーソル位置を中心に拡大', JSON.stringify(st.view));
  await t.click('zoom');

  // 選択ツール: クリックで線を選択して移動、囲んで複数選択
  await t.pen(t.line([200, 250], [300, 250]));
  await t.pen(t.line([200, 300], [300, 300]));
  await t.js(`document.querySelector('[data-tool="select"]').click()`);
  await t.drag([[250, 250], [250, 250]]);
  st = await t.state();
  const s0 = t.strokes(st)[0];
  ok(st.sel.length === 1 && st.sel[0] === s0.id, '選択ツールのクリックで線を選択できる');
  await t.drag(t.line([250, 250], [290, 270]));
  st = await t.state();
  ok(near(t.strokes(st)[0].first.x, 240, 1.5) && near(t.strokes(st)[0].first.y, 270, 1.5) && t.strokes(st).length === 2, '選択した線をドラッグで移動できる', JSON.stringify(t.strokes(st)[0].first));
  // 撮った画面は、選択ツールで動かさずにクリックしたときだけ選択される
  await t.drag([[60, H - 40], [60, H - 40]]);
  st = await t.state();
  ok(st.sel.length === 1 && st.sel[0] === t.images(st)[0].id, '選択ツールのクリックで撮った画面も選択できる');
  await t.key('Escape', 0, 'Escape');
  await t.drag(t.path2([[170, 220], [380, 220], [380, 330], [170, 330], [170, 222]]));
  st = await t.state();
  ok(st.sel.length === 2, '選択ツールで囲むと中の線がまとめて選択される', JSON.stringify(st.sel));
  await t.shot('2-lasso');
  // まとめて拡大（線の太さも一緒に変わる）
  const sizeBefore = t.strokes(st)[0].size;
  const box = await t.js(`(() => { const k = window.__ink, b = Geom.unionBox(k.items.filter((i) => k.selection.has(i.id)).map(Geom.itemBox)); return b; })()`);
  await t.drag(t.line([box.x + box.w + 6, box.y + box.h + 6], [box.x + box.w + 106, box.y + box.h + 66]));
  st = await t.state();
  ok(t.strokes(st)[0].size > sizeBefore * 1.2 && st.sel.length === 2, '複数の線をまとめて拡大できる');
  await t.key('Escape', 0, 'Escape');
  ok((await t.state()).sel.length === 0 && (await t.state()).mode === 'freeze', 'Esc はまず選択を外す（閉じない）');
  await t.js(`document.querySelector('[data-tool="pen"]').click()`);

  // 選択を外すためのペンのタップは点を残さない
  await t.pen(t.line([600, 620], [700, 620]));
  await t.sleep(1600);
  await t.tap(650, 620);
  const n = t.strokes(await t.state()).length;
  ok((await t.state()).sel.length === 1, '指のタップで線を選択できる');
  await t.pen([[300, 520], [300, 520]]);
  st = await t.state();
  ok(st.sel.length === 0 && t.strokes(st).length === n, '選択を外すタップは点として残らない');

  // 追加キャプチャ: 右隣に並べて全体を表示
  t.send('add-image', { image: t.fakeCapture(Math.round(W * SCALE), Math.round(H * SCALE)).toDataURL(), size: { w: W, h: H } });
  await t.sleep(400);
  st = await t.state();
  const imgs = t.images(st);
  ok(imgs.length === 2 && near(imgs[1].x, W + 40, 1) && near(imgs[1].y, 0, 1) && st.view.s < 0.55, '追加キャプチャが右隣に並び、全体が表示される', JSON.stringify(st.view));
  await t.shot('2-two-captures');
  await t.key('z', t.CTRL);
  ok(t.images(await t.state()).length === 1, '追加キャプチャも「戻す」で取り消せる');

  // ライブでは貼り付けない
  await t.setMode({ mode: 'live', image: null, keepInk: true });
  await t.key('v', t.CTRL);
  await t.sleep(150);
  st = await t.state();
  ok(t.images(st).length === 1 && st.toast.includes('静止'), 'ライブ中の貼り付けは案内を出す', st.toast);
});
