const t = require('./e2e');
const { ok, near } = t;

const circle = (cx, cy, r, n = 48) => {
  const a = [];
  for (let i = 0; i <= n; i++) a.push([cx + r * Math.cos(i / n * 2 * Math.PI), cy + r * Math.sin(i / n * 2 * Math.PI)]);
  return a;
};
const ids = (st) => t.strokes(st).map((s) => s.id);
const alpha = async (id, x, y) => (await t.pixel(id, x, y))[3];
const inkTransform = () => t.js(`document.getElementById('ink').style.transform`);

t.suite('4. 複製と、線が多いときの描画', async () => {
  await t.freeze();

  // --- 囲んで選択 → 複製 ---
  await t.pen(t.line([300, 300], [380, 304]));
  await t.pen(t.line([300, 320], [380, 316]));
  let st = await t.state();
  const orig = ids(st);
  await t.sleep(1100);
  await t.pen(circle(340, 310, 75), { step: 3 });
  ok((await t.state()).sel.length === 2, '（丸で囲んで2本を選択）');
  await t.click('selDup');
  st = await t.state();
  let copies = t.strokes(st).filter((s) => !orig.includes(s.id));
  ok(ids(st).length === 4 && st.sel.length === 2 && copies.every((s) => st.sel.includes(s.id)), '「複製」で同じものが増え、複製した側が選択される', JSON.stringify(st.sel));
  ok(near(copies[0].first.x, 324, 1.5) && near(copies[0].first.y, 324, 1.5), '複製は少しずれた位置に出る', JSON.stringify(copies[0].first));
  // そのままペンで掴んで動かせる
  await t.pen(t.line([364, 334], [564, 434]), { step: 6 });
  st = await t.state();
  copies = t.strokes(st).filter((s) => !orig.includes(s.id));
  ok(near(copies[0].first.x, 524, 2) && near(copies[0].first.y, 424, 2) && st.sel.length === 2, '複製したものをそのまま動かせる', JSON.stringify(copies[0].first));
  ok((await alpha('drag', 560, 425)) === 0 && (await alpha('ink', 560, 425)) > 0, '動かし終えると、線は元の層に描き直される');
  await t.key('d', t.CTRL);
  st = await t.state();
  ok(ids(st).length === 6 && st.sel.length === 2, 'Ctrl+D でも複製できる');
  await t.key('z', t.CTRL);
  await t.key('z', t.CTRL);
  await t.key('z', t.CTRL);
  ok(ids(await t.state()).length === 2, '複製と移動は「戻す」で取り消せる');

  // --- 消しゴムは、消した線のまわりだけ描き直す（隣の線を消さない） ---
  await t.js(`document.querySelector('[data-tool="pen"]').click()`);
  await t.drag(t.line([100, 620], [300, 620]));
  await t.drag(t.line([100, 640], [300, 640]));
  await t.js(`document.querySelector('[data-tool="eraser"]').click()`);
  await t.drag(t.line([200, 596], [200, 610], 6), { step: 20 }); // 半径 12px なので y=622 まで届く
  ok((await alpha('ink', 200, 620)) === 0 && (await alpha('ink', 120, 620)) > 0, '消しゴムでなぞった所だけ消える');
  ok((await alpha("ink", 200, 640)) > 0 && (await alpha("ink", 120, 640)) > 0, 'すぐ隣の線は消えない');
  await t.js(`document.querySelector('[data-tool="pen"]').click()`);

  // --- 線が多いとき：拡大縮小・移動は、描いてある絵を動かしてから描き直す ---
  await t.wheel(500, 300, 0, 40);
  ok((await inkTransform()) === '', '線が少ないうちは毎コマ描き直す');
  await t.wheel(500, 300, 0, -40);
  await t.js(`(() => {
    const list = [];
    for (let i = 0; i < 120; i++) {
      const pts = [];
      for (let k = 0; k < 60; k++) pts.push({ x: 520 + (i % 12) * 30 + k * 2, y: 40 + Math.floor(i / 12) * 30 + Math.sin(k / 4) * 8, p: 0.3 + 0.5 * Math.abs(Math.sin(k / 9)) });
      list.push({ id: nextId++, type: 'stroke', tool: i % 10 ? 'pen' : 'hl', color: '#0a84ff', size: i % 10 ? 4 : 16, pts, t: 0 });
    }
    items = [...items, ...list]; commit(); drawAll();
  })()`);
  await t.sleep(100);
  ok((await alpha('ink', 120, 620)) > 0 && (await alpha('ink', 120, 520)) === 0, '（移動前の線の位置）');
  await t.js(`window.dispatchEvent(new WheelEvent('wheel', { clientX: 500, clientY: 300, deltaY: 100, cancelable: true }))`);
  await t.sleep(50);
  const during = await inkTransform();
  ok(/translate\(0px, -100px\) scale\(1\)/.test(during), '線が多いときは、移動中は描いてある絵をそのまま動かす', during);
  await t.sleep(400);
  st = await t.state();
  ok((await inkTransform()) === '' && near(st.view.ty, -100, 0.5), '止まると描き直して、絵のずらしを解除する');
  ok((await alpha('ink', 120, 520)) > 0 && (await alpha('ink', 120, 620)) === 0, '描き直した後の線は、移動後の正しい位置にある');
  await t.js(`resetView()`);
  await t.sleep(100);
});
