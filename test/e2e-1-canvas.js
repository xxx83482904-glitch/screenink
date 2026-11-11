const t = require('./e2e');
const { ok, near, W, H, SCALE } = t;

t.suite('1. ワールド座標・ピンチ・無限キャンバス', async () => {
  await t.freeze();
  let st = await t.state();
  ok(t.images(st).length === 1 && t.images(st)[0].base && t.images(st)[0].w === W && t.images(st)[0].h === H,
    'キャプチャが1枚の画像オブジェクトとして原点に置かれる');
  ok((await t.pixel('bg', 5, H - 5))[3] === 255, '静止モードの背景は不透明');

  // ペンで書く（等倍）
  await t.pen(t.line([200, 200], [400, 300]));
  st = await t.state();
  let s = t.strokes(st);
  ok(s.length === 1 && near(s[0].first.x, 200, 1) && near(s[0].last.x, 400, 1) && near(s[0].last.y, 300, 1), 'ペンで書いた線が画面と同じ座標に入る');
  ok(near(s[0].maxP, 0.6, 0.05), '筆圧が記録される', 'maxP=' + s[0].maxP);
  const px = await t.pixel('ink', 300, 250);
  ok(px[0] > 200 && px[3] > 200, '線が描画されている', String(px));

  // 指1本では書かない
  await t.sleep(1600); // ペン直後の手のひら無視が切れるのを待つ
  await t.touch('touchStart', [[300, 450]]);
  for (let i = 1; i <= 8; i++) await t.touch('touchMove', [[300 + i * 15, 450]]);
  await t.touch('touchEnd', []);
  st = await t.state();
  ok(t.strokes(st).length === 1 && near(st.view.tx, 0) && near(st.view.s, 1), '指1本のドラッグでは線が増えず、表示も動かない');

  // ペン直後の指は無視（手のひら）
  await t.pen(t.line([150, 600], [160, 610], 3));
  await t.twoFinger([[400, 400], [600, 400]], [[300, 400], [700, 400]]);
  st = await t.state();
  ok(near(st.view.s, 1), 'ペン直後の指は無視される（手のひら対策）');
  await t.key('z', t.CTRL);

  // 2本指ピンチで2倍。指の中点の下にあるワールド座標は動かない
  await t.sleep(1600);
  await t.twoFinger([[400, 400], [600, 400]], [[300, 400], [700, 400]]);
  st = await t.state();
  ok(near(st.view.s, 2, 0.02) && near(st.view.tx, -500, 3) && near(st.view.ty, -400, 3), 'ピンチで2倍、中点が固定される', JSON.stringify(st.view));
  await t.shot('1-zoom-in');

  // 拡大中に書いた線はワールド座標に変換され、太さは画面上で一定
  await t.pen(t.line([500, 400], [600, 400]));
  st = await t.state();
  s = t.strokes(st);
  ok(s.length === 2 && near(s[1].first.x, 500, 1) && near(s[1].last.x, 550, 1) && near(s[1].size, 2, 0.05), '拡大中の線がワールド座標で保存される', JSON.stringify(s[1]));

  // 2本指ドラッグで移動
  await t.sleep(1600);
  await t.twoFinger([[400, 400], [600, 400]], [[500, 450], [700, 450]]);
  st = await t.state();
  ok(near(st.view.s, 2, 0.02) && near(st.view.tx, -400, 3) && near(st.view.ty, -350, 3), '2本指ドラッグで移動する', JSON.stringify(st.view));

  // 縮小すると外側は白紙で、そこにも書ける
  await t.twoFinger([[300, 400], [700, 400]], [[450, 400], [550, 400]]);
  st = await t.state();
  ok(near(st.view.s, 0.5, 0.02), 'ピンチで縮小できる', JSON.stringify(st.view));
  const capRight = st.view.tx + W * st.view.s;
  const outside = capRight < W - 80 ? [capRight + 40, st.view.ty + 120] : [st.view.tx - 40, st.view.ty + 120];
  const white = await t.pixel('bg', outside[0], outside[1]);
  ok(white[0] === 255 && white[1] === 255 && white[2] === 255 && white[3] === 255, 'キャプチャの外側は白紙', String(white));
  await t.pen(t.line(outside, [outside[0] + 20, outside[1] + 60]));
  st = await t.state();
  s = t.strokes(st);
  ok(s.length === 3 && (s[2].first.x > W || s[2].first.x < 0), '白紙の部分にも書ける', JSON.stringify(s[2].first));
  await t.shot('1-zoom-out');

  // 全体を表示 / 100% に戻す
  await t.click('fit');
  await t.sleep(80);
  st = await t.state();
  const far = s[2].last;
  const sx = far.x * st.view.s + st.view.tx, sy = far.y * st.view.s + st.view.ty;
  ok(st.view.s <= 1 && sx >= 0 && sx <= W && sy >= 0 && sy <= H && st.view.tx >= 0, '「全体」ですべてが画面内に収まる', JSON.stringify(st.view));
  await t.shot('1-fit');
  await t.click('zoom');
  await t.sleep(80);
  st = await t.state();
  ok(near(st.view.s, 1) && near(st.view.tx, 0) && near(st.view.ty, 0), '「100%」で等倍に戻る');

  // 消しゴムは線をベクターのまま分割する。戻す/進むが効く
  await t.js(`document.querySelector('[data-tool="eraser"]').click()`);
  await t.drag(t.line([300, 200], [300, 300]));
  st = await t.state();
  ok(t.strokes(st).length === 4, '消しゴムで線が2本に分かれる', 'strokes=' + t.strokes(st).length);
  ok((await t.pixel('ink', 300, 250))[3] === 0, '消した部分は透明');
  await t.key('z', t.CTRL);
  st = await t.state();
  ok(t.strokes(st).length === 3 && (await t.pixel('ink', 300, 250))[3] > 200, '「戻す」で消しゴムを取り消せる');
  await t.key('y', t.CTRL);
  ok(t.strokes(await t.state()).length === 4, '「進む」でやり直せる');
  await t.key('z', t.CTRL);

  // マーカー：1本の中で重なっても濃くならない
  await t.js(`document.querySelector('[data-tool="hl"]').click()`);
  await t.drag(t.path2([[600, 500], [700, 600], [700, 500], [600, 600]]));
  const cross = await t.pixel('ink', 650, 550), single = await t.pixel('ink', 625, 525);
  ok(near(cross[3], 102, 4) && near(single[3], 102, 4), 'マーカーの重なりが濃くならない', `cross=${cross[3]} single=${single[3]}`);
  await t.js(`document.querySelector('[data-tool="pen"]').click()`);

  // 保存：見えている範囲 / 全体
  const cw = await t.js(`document.getElementById('ink').width`), ch = await t.js(`document.getElementById('ink').height`);
  await t.click('saveView');
  await t.sleep(400);
  let last = t.saved[t.saved.length - 1];
  ok(last && last.width === cw && last.height === ch, '「今見えている範囲」は画面と同じ画素数', JSON.stringify(last));
  await t.click('saveAll');
  await t.sleep(600);
  last = t.saved[t.saved.length - 1];
  ok(last && last.width > cw, '「全体」は白紙に書いた分まで含む', JSON.stringify(last));

  // ライブ：等倍のまま。ピンチは案内だけ
  await t.setMode({ mode: 'live', image: null, keepInk: true });
  st = await t.state();
  ok(st.mode === 'live' && t.strokes(st).length === 4 && (await t.pixel('bg', 5, H - 5))[3] === 0, 'ライブでは背景が透明で書き込みは残る');
  await t.sleep(1600);
  await t.twoFinger([[400, 400], [600, 400]], [[300, 400], [700, 400]]);
  st = await t.state();
  ok(near(st.view.s, 1) && st.toast.includes('静止'), 'ライブ中のピンチは拡大せず案内を出す', st.toast);
  await t.pen(t.line([200, 500], [300, 520]));
  ok(t.strokes(await t.state()).length === 5, 'ライブでも従来どおり書ける');
  await t.click('save');
  await t.sleep(500);
  last = t.saved[t.saved.length - 1];
  ok(last && last.width === cw && last.height === ch, 'ライブの保存は画面と同じ画素数');

  // 静止へ戻すと書き込みは残り、キャプチャは1枚に差し替わる
  await t.freeze(true);
  st = await t.state();
  ok(t.images(st).length === 1 && t.strokes(st).length === 5, '静止に切り替えても書き込みが残り、キャプチャは1枚');
  await t.key('z', t.CTRL);
  st = await t.state();
  ok(t.images(st).length === 1 && t.strokes(st).length === 4, 'モード切り替えをまたいで「戻す」が効く');
});
