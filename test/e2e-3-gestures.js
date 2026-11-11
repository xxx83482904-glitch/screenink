const t = require('./e2e');
const { ok, near, W, H, SCALE } = t;

// 横に往復するぐしゃぐしゃ
const zig = (x0, x1, y, passes = 6, drift = 5) => {
  const a = [];
  for (let i = 0; i <= passes; i++) a.push([i % 2 ? x1 : x0, y + i * drift]);
  return t.path2(a, 10);
};
const circle = (cx, cy, r, n = 48) => {
  const a = [];
  for (let i = 0; i <= n; i++) a.push([cx + r * Math.cos(i / n * 2 * Math.PI), cy + r * Math.sin(i / n * 2 * Math.PI)]);
  return a;
};
const ids = (st) => t.strokes(st).map((s) => s.id);
const keepShown = () => t.js(`!document.getElementById('selKeep').hidden && document.getElementById('selMenu').classList.contains('show')`);

t.suite('3. インクジェスチャー（スクラッチアウト・投げ縄・長押し）', async () => {
  await t.freeze();
  // 「単語」に見立てた2本と、離れた所の1本
  await t.pen(t.line([300, 300], [380, 304]));
  await t.pen(t.line([300, 320], [380, 316]));
  await t.pen(t.line([600, 500], [700, 500]));
  let st = await t.state();
  const [w1, w2, far] = ids(st);

  // --- スクラッチアウト ---
  await t.pen(zig(288, 392, 296), { step: 2 });
  st = await t.state();
  ok(ids(st).length === 1 && ids(st)[0] === far, 'ぐしゃぐしゃと書くと下の線が消え、ぐしゃぐしゃ自体も残らない', JSON.stringify(ids(st)));
  await t.shot('3-scratched');
  await t.key('z', t.CTRL);
  st = await t.state();
  ok(ids(st).length === 3 && ids(st).includes(w1) && ids(st).includes(w2), 'スクラッチアウトを「戻す」で取り消せる');

  await t.pen(zig(100, 200, 600), { step: 2 });
  st = await t.state();
  ok(ids(st).length === 4 && t.images(st).length === 1, '何もない所のぐしゃぐしゃは普通の線として残る（撮った画面は消えない）');
  await t.key('z', t.CTRL);

  await t.pen(zig(288, 392, 296), { step: 45 });
  st = await t.state();
  ok(ids(st).length === 4 && ids(st).includes(w1), 'ゆっくり書いた往復は消去とみなさない');
  await t.key('z', t.CTRL);

  await t.pen(t.line([280, 310], [400, 312]), { step: 2 });
  ok(ids(await t.state()).length === 4, '線の上を1回なぞっただけでは消えない');
  await t.key('z', t.CTRL);

  await t.pen(zig(320, 700, 480, 6, 8), { step: 2 }); // far(600-700) は覆うが、単語は範囲外
  st = await t.state();
  ok(ids(st).length === 2 && !ids(st).includes(far) && ids(st).includes(w1), '覆った線だけが消える');
  await t.key('z', t.CTRL);

  // 貼り付けた画像もスクラッチアウトで消せる
  t.clipboardImage = t.fakeCapture(Math.round(100 * SCALE), Math.round(50 * SCALE)).toDataURL();
  await t.key('v', t.CTRL);
  await t.sleep(200);
  st = await t.state();
  const im = t.images(st)[1];
  await t.pen([[60, H - 40], [60, H - 40]]); // 選択を外す
  await t.pen(zig(im.x - 6, im.x + im.w + 6, im.y + 4, 6, 7), { step: 2 });
  st = await t.state();
  ok(t.images(st).length === 1 && ids(st).length === 3, '貼り付けた画像もスクラッチアウトで消せる', JSON.stringify(t.images(st)));
  await t.key('z', t.CTRL);
  await t.key('z', t.CTRL); // 貼り付けも取り消す

  // --- 即時投げ縄 ---
  await t.sleep(1100);
  await t.pen(circle(340, 310, 75), { step: 3 });
  st = await t.state();
  ok(st.sel.length === 2 && st.sel.includes(w1) && st.sel.includes(w2) && ids(st).length === 3, '囲んだ瞬間に中の線が選択され、輪は残らない', JSON.stringify(st.sel));
  ok(await keepShown(), 'メニューに「線として残す」が出る');
  await t.shot('3-lasso');

  // 選択をペンで動かす
  await t.pen(t.line([340, 310], [380, 340]));
  st = await t.state();
  let a = t.strokes(st).find((s) => s.id === w1);
  ok(near(a.first.x, 340, 1.5) && near(a.first.y, 330, 1.5) && st.sel.length === 2 && ids(st).length === 3, '選択したものをペンで移動できる', JSON.stringify(a.first));

  // コピー → 貼り付け（線は線のまま）
  t.clipboardImage = null;
  await t.key('c', t.CTRL);
  await t.sleep(200);
  ok((await t.state()).toast.includes('コピー'), 'コピーできる');
  await t.key('v', t.CTRL);
  await t.sleep(200);
  st = await t.state();
  ok(ids(st).length === 5 && st.sel.length === 2 && !st.sel.includes(w1) && t.images(st).length === 1, 'コピーしたものを線のまま貼り付けられ、貼り付けた側が選択される', JSON.stringify(st.sel));
  await t.key('Delete', 0, 'Delete');
  ok(ids(await t.state()).length === 3, '貼り付けたものを削除できる');

  // 丸を書きたかった場合: 「線として残す」/「戻す」
  await t.sleep(1100);
  await t.pen(circle(380, 340, 75), { step: 3 });
  ok((await t.state()).sel.length === 2, '（もう一度囲んで選択）');
  await t.click('selKeep');
  st = await t.state();
  ok(st.sel.length === 0 && ids(st).length === 4, '「線として残す」で輪が普通の線になり、選択が外れる');
  await t.key('z', t.CTRL);
  await t.pen(circle(380, 340, 75), { step: 3 });
  await t.key('z', t.CTRL);
  st = await t.state();
  ok(st.sel.length === 0 && ids(st).length === 4, '囲んだ直後の「戻す」でも輪が線として残る');
  await t.key('z', t.CTRL);
  ok(ids(await t.state()).length === 3, 'さらに「戻す」で輪が消える');

  // 書いたばかりのものは囲んでも選択しない（丸で囲む書き込みを邪魔しない）
  await t.pen(t.line([150, 200], [200, 200]));
  await t.pen(circle(175, 200, 60), { step: 2 });
  st = await t.state();
  ok(st.sel.length === 0 && ids(st).length === 5, '書いて1秒以内のものは囲んでも選択されず、丸として残る');
  await t.key('z', t.CTRL);
  await t.key('z', t.CTRL);

  // 撮った画面の上に丸を書いても選択にならない
  await t.pen(circle(800, 250, 70), { step: 2 });
  st = await t.state();
  ok(st.sel.length === 0 && ids(st).length === 4, '画面の上にただ丸を書くと、普通の線として残る');
  await t.key('z', t.CTRL);

  // 囲んで削除 → 戻す
  await t.sleep(300);
  await t.pen(circle(380, 340, 75), { step: 3 });
  await t.click('selDelete');
  st = await t.state();
  ok(ids(st).length === 1 && ids(st)[0] === far, '囲んで「削除」で消せる');
  await t.key('z', t.CTRL);
  ok(ids(await t.state()).length === 3, '削除を「戻す」で取り消せる');

  // --- ペンの長押し ---
  await t.pen(t.line([650, 500], [690, 530], 8), { hold: 700 });
  st = await t.state();
  a = t.strokes(st).find((s) => s.id === far);
  ok(st.sel.length === 1 && st.sel[0] === far && near(a.first.x, 640, 1.5) && near(a.first.y, 530, 1.5) && ids(st).length === 3,
    '線の上でペンを長押しすると選択され、そのまま動かすと移動する', JSON.stringify(a.first));
  await t.key('Escape', 0, 'Escape');

  await t.pen([[820, 600], [820, 600]], { hold: 700 });
  st = await t.state();
  ok(st.sel.length === 0 && ids(st).length === 4, '何もない所の長押しは選択にならず、点が書ける');
  await t.key('z', t.CTRL);

  await t.pen([[660, 530], [660, 530]]);
  st = await t.state();
  ok(st.sel.length === 0 && ids(st).length === 4, '線の上の短いタップは選択にならず、点が書ける');
  await t.key('z', t.CTRL);

  // --- 拡大表示でも画面上の大きさで判定する ---
  await t.sleep(1600);
  await t.twoFinger([[540, 400], [740, 400]], [[440, 400], [840, 400]]); // (640,400) を中心に2倍
  st = await t.state();
  a = t.strokes(st).find((s) => s.id === far);
  const sx = (x) => x * st.view.s + st.view.tx, sy = (y) => y * st.view.s + st.view.ty;
  await t.pen(zig(sx(a.first.x) - 12, sx(a.last.x) + 12, sy(a.first.y) - 10, 6, 4), { step: 2 });
  st = await t.state();
  ok(near(st.view.s, 2, 0.05) && !ids(st).includes(far) && ids(st).length === 2, '拡大中でもスクラッチアウトが効く', JSON.stringify(st.view));
  await t.key('z', t.CTRL);

  // ライブでも線にはジェスチャーが効く
  await t.setMode({ mode: 'live', image: null, keepInk: true });
  st = await t.state();
  a = t.strokes(st).find((s) => s.id === far);
  await t.pen(zig(a.first.x - 12, a.last.x + 12, a.first.y - 12, 6, 5), { step: 2 });
  ok(!ids(await t.state()).includes(far), 'ライブでもスクラッチアウトが効く');
});
