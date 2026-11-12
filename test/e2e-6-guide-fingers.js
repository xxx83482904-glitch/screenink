const t = require('./e2e');
const { ok, near, W, H } = t;

// 実機の指に近い触り方: 接触の幅が 56px 前後（Surface の高精細画面では指先でもこのくらいになる）、ペンを使った直後
const R = 28;
async function fat(type, pts) {
  await t.win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
    type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: R, radiusY: R, force: 0.5 })),
  });
  await t.sleep(16);
}
async function fatDrag(from, to, steps = 8) {
  await fat('touchStart', from);
  for (let i = 1; i <= steps; i++) await fat('touchMove', from.map((p, k) => [p[0] + (to[k][0] - p[0]) * i / steps, p[1] + (to[k][1] - p[1]) * i / steps]));
  await fat('touchEnd', []);
  await t.sleep(60);
}
const ruler = () => t.js(`__ink.ruler && { ...__ink.ruler }`);
const vps = () => t.js(`__ink.persp && __ink.persp.vps.map((p) => ({ ...p }))`);
const penTouch = () => t.pen(t.line([120, 600], [180, 640])); // 直前にペンを使う（手のひら対策の時間内にする）
const deg = (a) => a * 180 / Math.PI;

t.suite('6. 定規と消失点を指で動かす（実機に近い大きな接触・ペンの直後）', async () => {
  await t.freeze();
  const cx = await t.js('innerWidth / 2'), cy = await t.js('innerHeight / 2');
  await t.click('rulerBtn');
  await t.sleep(50);

  await penTouch();
  await fatDrag([[cx, cy]], [[cx + 60, cy + 40]]);
  let r = await ruler();
  ok(near(r.cx, cx + 60, 1) && near(r.cy, cy + 40, 1), '大きな接触でも、ペンの直後でも、指1本で定規を動かせる', JSON.stringify(r));

  // 定規の縁から少し外れた所を触っても掴める
  await penTouch();
  await fatDrag([[r.cx, r.cy - 36 - 12]], [[r.cx - 40, r.cy - 36 - 12]]);
  const r2 = await ruler();
  ok(near(r2.cx, r.cx - 40, 1), '定規の縁の少し外側を触っても掴める');

  // 2本で回す（ペンの直後）
  r = r2;
  await penTouch();
  await fatDrag([[r.cx - 120, r.cy], [r.cx + 120, r.cy]], [[r.cx - 120 * Math.cos(0.5), r.cy - 120 * Math.sin(0.5)], [r.cx + 120 * Math.cos(0.5), r.cy + 120 * Math.sin(0.5)]]);
  r = await ruler();
  ok(near(r.a, 0.5, 0.01), 'ペンの直後でも、指2本で定規を回せる', deg(r.a));

  // 1本目が定規の外、2本目が定規の上 → 画面の拡大ではなく定規の回転
  const s0 = (await t.state()).view.s;
  await t.sleep(1600);
  const a0 = r.a;
  const off = [r.cx, r.cy + 150]; // 定規から離れた所
  const on = [r.cx + 100 * Math.cos(r.a), r.cy + 100 * Math.sin(r.a)];
  await fatDrag([off, on], [off, [on[0] + 80, on[1] + 80]]);
  r = await ruler();
  const st = await t.state();
  ok(near(st.view.s, s0, 0.001) && Math.abs(r.a - a0) > 0.05, '片方の指だけ定規に乗っていても、画面は拡大せず定規が回る', `s=${st.view.s} a=${deg(r.a)}`);
  await t.click('rulerBtn');

  // --- 消失点 ---
  await t.click('perspBtn');
  await t.js(`document.querySelector('[data-persp="2"]').click()`);
  await t.sleep(50);
  let v = await vps();
  await penTouch();
  // 指は丸の中心から少し外れて触れることが多い
  await fatDrag([[v[0].x + 22, v[0].y + 18]], [[v[0].x + 102, v[0].y - 22]]);
  const v2 = await vps();
  ok(near(v2[0].x, v[0].x + 102, 1) && near(v2[0].y, v[0].y - 22, 1), 'ペンの直後でも、大きな接触でも、消失点を指で動かせる（丸から少し外れても掴める）', JSON.stringify(v2[0]));
  ok(near((await t.state()).view.s, s0, 0.001), '消失点を動かしても画面は動かない');
  await t.js(`document.querySelector('[data-persp="0"]').click()`);
  await t.click('clear');
  await t.js(`resetView()`);
});
