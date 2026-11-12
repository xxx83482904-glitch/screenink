const t = require('./e2e');
const { ok, near } = t;

// 「あとで編集できる形で保存」→ 開き直すと、線が線のまま戻り、続きを書ける
const last = () => t.docs[t.docs.length - 1];
const reopen = (json, name = 'test.screenink') => t.setMode({ mode: 'freeze', image: null, keepInk: false, doc: { json, name } });

t.suite('7. あとで編集できる形で保存して開き直す', async () => {
  await t.freeze();
  await t.pen(t.line([200, 200], [400, 300]));
  await t.js(`document.querySelector('[data-tool="hl"]').click()`);
  await t.pen(t.line([200, 400], [500, 400]));
  await t.js(`document.querySelector('[data-tool="pen"]').click()`);
  // 貼り付けた画像も一緒に残る
  t.clipboardImage = t.fakeCapture(120, 80).toDataURL();
  await t.js('paste()');
  await t.sleep(150);
  await t.js('clearSel()');
  const before = await t.state();

  const n0 = t.docs.length;
  await t.click('save');
  await t.click('saveEdit');
  await t.sleep(400);
  ok(t.docs.length === n0 + 1, '「あとで編集できる形で保存」でファイルが1つ作られる');
  const d = JSON.parse(last().json);
  ok(d.format === 'screenink' && d.version === 1 && d.items.length === 4, '中身は背景・線2本・貼った画像', JSON.stringify(d.items.map((i) => i.type)));
  ok(last().png.width > 0 && last().png.height > 0, '見るための PNG も一緒に作られる', JSON.stringify(last().png));
  ok((await t.state()).toast.includes('あとで編集できる形で保存しました'), '保存したことを知らせる');
  ok(t.strokes(await t.state()).length === 2, '保存しても画面の書き込みはそのまま');

  // 一度消してから開き直す
  await t.freeze();
  ok(t.strokes(await t.state()).length === 0, '（新しくキャプチャすると書き込みは無い）');
  await reopen(last().json);
  const st = await t.state();
  ok(st.mode === 'freeze', '開くと静止モードになる');
  ok(st.items.length === 4 && t.images(st).length === 2 && t.images(st).some((i) => i.base), '背景と貼った画像が戻る', JSON.stringify(t.images(st)));
  const a = t.strokes(before), b = t.strokes(st);
  ok(b.length === 2 && b.every((s, i) => s.tool === a[i].tool && s.n === a[i].n && near(s.first.x, a[i].first.x, 0.01) && near(s.last.y, a[i].last.y, 0.01) && near(s.maxP, a[i].maxP, 0.01)),
    '線が線のまま戻る（種類・点・筆圧）', JSON.stringify(b));
  ok(st.toast.includes('開きました'), '開いたことを知らせる', st.toast);

  // 開いた状態が取り消しの起点。続きを書いて、戻すと開いた直後に戻る
  await t.key('z', t.CTRL);
  ok((await t.state()).items.length === 4, '開いた直後は「戻す」で消えない');
  await t.pen(t.line([600, 200], [700, 260]));
  ok(t.strokes(await t.state()).length === 3, '開いたあとに書き足せる');
  await t.key('z', t.CTRL);
  ok(t.strokes(await t.state()).length === 2, '書き足した分を戻せる');

  // 開いた線を選んで動かせる（線のまま＝編集できる）
  const s0 = t.strokes(await t.state())[0];
  const ids = await t.js(`__ink.items.filter((i) => i.type === 'stroke').map((i) => i.id)`);
  await t.js(`document.querySelector('[data-tool="select"]').click()`);
  await t.js(`setSel([${ids[0]}])`);
  await t.sleep(50);
  const vs = (await t.state()).view;
  const sx = (x) => x * vs.s + vs.tx, sy = (y) => y * vs.s + vs.ty;
  const mid = [(sx(s0.first.x) + sx(s0.last.x)) / 2, (sy(s0.first.y) + sy(s0.last.y)) / 2];
  await t.drag(t.line(mid, [mid[0] + 50, mid[1] + 30]));
  const moved = t.strokes(await t.state())[0];
  ok(moved.first.x > s0.first.x + 10, '開いた線を選んで動かせる', `${s0.first.x} → ${moved.first.x}`);
  await t.js('clearSel()');
  await t.js(`document.querySelector('[data-tool="pen"]').click()`);

  // 壊れたファイル・別の形式は開かず、知らせる
  await reopen('{"hello":1}');
  ok((await t.state()).toast.includes('開けませんでした'), '別の形式のファイルは開かずに知らせる');
  await reopen('not json');
  ok((await t.state()).toast.includes('開けませんでした'), '壊れたファイルは開かずに知らせる');

  // ライブ: 今の画面を下敷きにして保存する
  await t.setMode({ mode: 'live', image: null, keepInk: false });
  await t.click('save');
  await t.click('saveEdit');
  await t.sleep(300);
  ok((await t.state()).toast.includes('保存する内容がありません'), 'ライブで何も書いていなければ保存しない');
  const n1 = t.docs.length;
  await t.pen(t.line([300, 300], [450, 350]));
  await t.click('save');
  await t.click('saveEdit');
  await t.sleep(400);
  ok(t.docs.length === n1 + 1, 'ライブでも編集できる形で保存できる');
  const ld = JSON.parse(last().json);
  const iw = await t.js('innerWidth'), ih = await t.js('innerHeight'); // 150% では窓の大きさが W, H から1px ほどずれる
  const bg = ld.items.find((i) => i.type === 'image');
  ok(bg && bg.base && bg.w === iw && bg.h === ih && ld.items.filter((i) => i.type === 'stroke').length === 1, 'ライブは今の画面が背景になり、線と一緒に入る', JSON.stringify(bg && { w: bg.w, h: bg.h }));
  await reopen(last().json);
  const lst = await t.state();
  ok(lst.mode === 'freeze' && t.strokes(lst).length === 1 && t.images(lst).length === 1, 'ライブで保存したものも静止モードで開ける');

  await t.click('clear');
  await t.js('resetView()');
});
