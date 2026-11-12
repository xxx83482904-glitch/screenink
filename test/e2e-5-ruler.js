const t = require('./e2e');
const { ok, near, W, H } = t;

const ruler = () => t.js(`__ink.ruler && { ...__ink.ruler }`);
const persp = () => t.js(`__ink.persp && { n: __ink.persp.n, vps: __ink.persp.vps.map((p) => ({ ...p })) }`);
const lastPts = () => t.js(`(() => { const s = __ink.items.filter((it) => it.type === 'stroke').pop(); return s ? s.pts.map((p) => ({ x: p.x, y: p.y })) : []; })()`);
const nStrokes = async () => t.strokes(await t.state()).length;
const uiAlpha = async (x, y) => (await t.pixel('ui', x, y))[3];
const deg = (a) => a * 180 / Math.PI;

t.suite('5. 定規とパースのガイド線', async () => {
  await t.freeze();
  const cx = await t.js('innerWidth / 2'), cy = await t.js('innerHeight / 2'); // 150% では窓の大きさが 1px ずれることがある

  // --- 定規を出す ---
  await t.click('rulerBtn');
  let r = await ruler();
  ok(r && near(r.cx, cx, 1) && near(r.cy, cy, 1) && r.a === 0, '「定規」で画面の中央に水平の定規が出る', JSON.stringify(r));
  ok((await uiAlpha(cx - 100, cy)) > 0 && (await t.js(`document.getElementById('rulerBtn').classList.contains('on')`)), '定規が描かれ、ボタンがオンになる');

  // 縁の少し外側を、ガタガタに書く → 縁に沿ったまっすぐな線
  const top = cy - 36;
  const wobble = [];
  for (let i = 0; i <= 30; i++) wobble.push([cx - 200 + i * 13, top - 14 + (i % 2 ? 7 : -7)]);
  await t.pen(wobble);
  let pts = await lastPts();
  const ys = pts.map((p) => p.y);
  ok(pts.length > 5 && Math.max(...ys) - Math.min(...ys) < 0.01 && near(ys[0], top - 3, 0.5), '縁の近くで書くと、縁に沿ったまっすぐな線になる', `y=${Math.min(...ys)}..${Math.max(...ys)}`);
  ok(near(pts[0].x, cx - 200, 1) && near(pts[pts.length - 1].x, cx + 190, 1), '線の長さは書いた範囲のまま', `${pts[0].x} → ${pts[pts.length - 1].x}`);

  // 定規の下側の縁にも沿う（ペンは定規の上から書き始めてもよい）
  await t.pen(t.line([cx - 50, cy + 20], [cx + 80, cy + 30]));
  pts = await lastPts();
  ok(pts.every((p) => near(p.y, cy + 36 + 3, 0.5)), '定規の上から書き始めると、近いほうの縁に沿う', JSON.stringify(pts[0]));

  // 定規から離れた所は普通の線
  await t.pen(t.line([100, 180], [200, 240])); // ツールバー（狭い画面では2段）を避ける
  pts = await lastPts();
  ok(near(pts[pts.length - 1].y, 240, 1), '定規から離れた所では普通に書ける', JSON.stringify([pts[0], pts[pts.length - 1], pts.length]));

  // 定規に沿った線はジェスチャーにならない（往復しても下の線を消さない）
  const before = await nStrokes();
  const zig = [];
  for (let i = 0; i <= 6; i++) zig.push([i % 2 ? cx + 150 : cx - 150, top - 10]);
  await t.pen(t.path2(zig, 10), { step: 2 });
  ok((await nStrokes()) === before + 1, '定規に沿って往復しても、スクラッチアウトにならない');

  // --- マウス: 定規の上をドラッグで移動、ホイールで回転 ---
  const n0 = await nStrokes();
  await t.drag(t.line([cx, cy], [cx + 50, cy + 30]));
  r = await ruler();
  ok(near(r.cx, cx + 50, 1) && near(r.cy, cy + 30, 1) && (await nStrokes()) === n0, 'マウスで定規の上をドラッグすると定規が動き、線は書かれない', JSON.stringify(r));
  await t.wheel(cx + 50, cy + 30, 0, 100);
  await t.wheel(cx + 50, cy + 30, 0, 100);
  r = await ruler();
  ok(near(deg(r.a), 2, 0.01), 'ホイールで 1° ずつ回る', deg(r.a));

  // --- 指: 2本で回す。45° の近くでは吸い付く ---
  const rot = (c, d, aDeg) => { const a = aDeg * Math.PI / 180; return [[c[0] - d * Math.cos(a), c[1] - d * Math.sin(a)], [c[0] + d * Math.cos(a), c[1] + d * Math.sin(a)]]; };
  const c1 = [cx + 50, cy + 30];
  await t.twoFinger(rot(c1, 100, 0), rot(c1, 100, 30));
  r = await ruler();
  ok(near(deg(r.a), 32, 0.5) && near(r.cx, cx + 50, 1), '指2本で回せる（ペンを使った直後でも）', deg(r.a));
  await t.twoFinger(rot(c1, 100, 32), rot(c1, 100, 43.5)); // 指は定規の上に置く
  r = await ruler();
  ok(near(deg(r.a), 45, 0.001), '45° の近くでは 45° ちょうどに吸い付く', deg(r.a));
  await t.twoFinger([[c1[0], c1[1]], [c1[0] + 60, c1[1] + 60]], [[c1[0] - 100, c1[1] - 40], [c1[0] - 40, c1[1] + 20]]);
  r = await ruler();
  ok(near(r.cx, cx - 50, 1) && near(r.cy, cy - 10, 1) && near(deg(r.a), 45, 0.001), '指2本で動かすと、角度はそのままで移動する', JSON.stringify(r));

  // 斜めの定規でも縁に沿う
  const p0 = { x: r.cx - 120 * Math.cos(r.a) + 50 * Math.sin(r.a), y: r.cy - 120 * Math.sin(r.a) - 50 * Math.cos(r.a) };
  await t.pen(t.line([p0.x, p0.y], [p0.x + 150, p0.y + 120]));
  pts = await lastPts();
  const along = pts.map((p) => -(p.x - r.cx) * Math.sin(r.a) + (p.y - r.cy) * Math.cos(r.a));
  ok(along.every((v) => near(v, -39, 0.5)), '斜めの定規でも縁に沿ってまっすぐ引ける', JSON.stringify(along.slice(0, 3)));

  // 指1本で定規を動かしても、選択や線にはならない
  const sel0 = (await t.state()).sel.length;
  await t.sleep(1600);
  await t.touch('touchStart', [[r.cx, r.cy]]);
  await t.touch('touchMove', [[r.cx + 20, r.cy]]);
  await t.touch('touchMove', [[r.cx + 40, r.cy]]);
  await t.touch('touchEnd', []);
  const r2 = await ruler();
  ok(near(r2.cx, r.cx + 40, 1) && (await t.state()).sel.length === sel0, '指1本で定規を動かせる');

  await t.key('r');
  await t.sleep(60);
  ok((await ruler()) === null && (await uiAlpha(r2.cx, r2.cy)) === 0, 'R キー（またはボタン）で定規をしまう');
  await t.click('clear');

  // --- パースのガイド線 ---
  await t.click('perspBtn');
  ok(await t.js(`document.getElementById('perspMenu').classList.contains('show')`), '「パース」でメニューが出る');
  await t.js(`document.querySelector('[data-persp="2"]').click()`);
  let p = await persp();
  await t.sleep(60);
  ok(p && p.n === 2 && p.vps.length === 2 && !(await t.js(`document.getElementById('perspMenu').classList.contains('show')`)), '「2点透視」で消失点が2つ出る', JSON.stringify(p));
  const v0 = { x: W * 0.12, y: H * 0.45 };
  ok((await uiAlpha(v0.x, v0.y)) === 255 && (await uiAlpha(W / 2, H * 0.45)) > 0, '消失点と地平線が描かれる');

  // 消失点をマウスでドラッグ（線は書かれない）
  const n1 = await nStrokes();
  await t.drag(t.line([v0.x, v0.y], [v0.x + 60, v0.y - 40]));
  p = await persp();
  ok(near(p.vps[0].x, v0.x + 60, 1) && near(p.vps[0].y, v0.y - 40, 1) && (await nStrokes()) === n1, '消失点をドラッグで動かせる', JSON.stringify(p.vps[0]));
  // ペンでも動かせる
  await t.pen(t.line([W * 0.88, H * 0.45], [W * 0.8, H * 0.5]));
  p = await persp();
  ok(near(p.vps[1].x, W * 0.8, 1) && (await nStrokes()) === n1, '消失点はペンでも動かせる');

  // 拡大すると消失点も一緒に動く（撮った画面に貼り付いている）
  const w0 = p.vps[0];
  await t.wheel(W / 2, H / 2, 0, -100, t.CTRL);
  await t.sleep(100);
  const st = await t.state();
  const sx = w0.x * st.view.s + st.view.tx, sy = w0.y * st.view.s + st.view.ty;
  ok(st.view.s > 1.1 && (await uiAlpha(sx, sy)) === 255, '拡大すると、消失点も画面と一緒に動く', `s=${st.view.s} at ${sx},${sy}`);
  await t.js(`resetView()`);
  await t.sleep(50);

  await t.click('perspBtn');
  await t.js(`document.querySelector('[data-persp="3"]').click()`);
  p = await persp();
  await t.sleep(60);
  ok(p.n === 3 && (await uiAlpha(W / 2, H * 0.94)) === 255, '「3点透視」で消失点が3つになる');

  // 見た目の確認用（test/out/ruler-persp.png）
  await t.click('rulerBtn');
  await t.pen(t.line([cx - 250, cy - 50], [cx + 250, cy - 45]));
  await t.sleep(80);
  await t.shot('ruler-persp');
  await t.click('rulerBtn');
  await t.key('z', t.CTRL);
  await t.sleep(60);

  // ガイド線は保存した画像に入らない
  await t.click('saveView');
  await t.sleep(400);
  const saved = t.saved[t.saved.length - 1];
  const px = await t.js(`new Promise((res) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = devicePixelRatio; res([...x.getImageData(Math.round(${W / 2} * d), Math.round(${H * 0.94} * d), 1, 1).data]); }; i.src = 'file:///' + ${JSON.stringify(saved.file.replace(/\\/g, '/'))}; })`);
  ok(px[0] > 150 && px[1] > 150 && px[2] > 150, '保存した画像にはガイド線や消失点が入らない', JSON.stringify(px));

  await t.click('perspBtn');
  await t.js(`document.querySelector('[data-persp="0"]').click()`);
  await t.sleep(60);
  ok((await persp()) === null && (await uiAlpha(W / 2, H * 0.94)) === 0, '「ガイドを消す」で消える');

  // --- 重ね書き（ライブ）でも使える ---
  await t.setMode({ mode: 'live' });
  await t.click('rulerBtn');
  await t.sleep(1600);
  await t.drag(t.line([cx - 100, cy + 50], [cx + 100, cy + 62]));
  pts = await lastPts();
  ok(pts.length > 3 && pts.every((p) => near(p.y, cy + 39, 0.5)), 'ライブでも定規に沿って書ける（マウス）');
  await t.click('rulerBtn');
  await t.click('clear');
});
