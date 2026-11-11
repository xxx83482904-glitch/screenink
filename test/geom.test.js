const test = require('node:test');
const assert = require('node:assert');
const G = require('../ink-geom.js');

const stroke = (pts, extra = {}) => ({ type: 'stroke', tool: 'pen', size: 4, pts: pts.map(([x, y]) => ({ x, y, p: 0.5 })), ...extra });

test('eraseStroke: 触れていなければ null', () => {
  const s = stroke([[0, 0], [100, 0]]);
  assert.strictEqual(G.eraseStroke(s, { x: 50, y: 40 }, { x: 60, y: 40 }, 10), null);
});

test('eraseStroke: 真ん中を消すと2本に分かれる', () => {
  const s = stroke([[0, 0], [100, 0]]);
  const pieces = G.eraseStroke(s, { x: 50, y: -20 }, { x: 50, y: 20 }, 10);
  assert.strictEqual(pieces.length, 2);
  assert.ok(pieces[0].pts[pieces[0].pts.length - 1].x < 40);
  assert.ok(pieces[1].pts[0].x > 60);
});

test('eraseStroke: 全体を覆うと何も残らない', () => {
  const s = stroke([[0, 0], [10, 0]]);
  assert.deepStrictEqual(G.eraseStroke(s, { x: 5, y: 0 }, { x: 5, y: 0 }, 30), []);
});

test('strokeBox は太さを含む', () => {
  const b = G.strokeBox(stroke([[10, 10], [20, 30]]));
  assert.ok(b.x < 10 && b.y < 10 && b.x + b.w > 20 && b.y + b.h > 30);
});

// ---------- ジェスチャー判定 ----------
const P = (arr) => arr.map(([x, y]) => ({ x, y, p: 0.5 }));
// 点列を細かく補間する（実際のペン入力に近づける）
const dense = (arr) => G.densify(P(arr), 3);

const zigzagH = (x0, x1, y, passes, drift = 3) => { // 横に往復
  const a = [];
  for (let i = 0; i <= passes; i++) a.push([i % 2 ? x1 : x0, y + i * drift]);
  return dense(a);
};
const circle = (cx, cy, r, turns = 1, n = 60) => {
  const a = [];
  for (let i = 0; i <= n * turns; i++) a.push([cx + r * Math.cos(i / n * 2 * Math.PI), cy + r * Math.sin(i / n * 2 * Math.PI)]);
  return P(a);
};

test('isScratch: 横に3往復するとスクラッチ', () => {
  assert.ok(G.isScratch(zigzagH(100, 200, 100, 6), 1));
});
test('isScratch: 縦に往復しながら横へ進む（WWW 形）もスクラッチ', () => {
  const a = [];
  for (let i = 0; i <= 8; i++) a.push([100 + i * 12, i % 2 ? 130 : 100]);
  assert.ok(G.isScratch(dense(a), 1));
});
test('isScratch: 直線・1往復・丸・Z はスクラッチではない', () => {
  assert.ok(!G.isScratch(dense([[0, 0], [200, 10]]), 1));
  assert.ok(!G.isScratch(zigzagH(100, 200, 100, 2), 1));
  assert.ok(!G.isScratch(circle(100, 100, 40), 1));
  assert.ok(!G.isScratch(dense([[0, 0], [100, 0], [0, 80], [100, 80]]), 1));
});
test('isScratch: 小さな山が3つ（m や w のような字）はスクラッチではない', () => {
  assert.ok(!G.isScratch(dense([[0, 30], [10, 0], [20, 30], [30, 0], [40, 30], [50, 0], [60, 30]]), 1));
});
test('isScratch: 小さすぎる動きは無視', () => {
  assert.ok(!G.isScratch(zigzagH(100, 106, 100, 8, 0.5), 1));
});

test('scratchTargets: 覆われた線だけが対象。一部しか覆われていない長い線は残す', () => {
  const word = { id: 1, type: 'stroke', tool: 'pen', size: 4, pts: dense([[110, 108], [190, 112]]) };
  const longLine = { id: 2, type: 'stroke', tool: 'pen', size: 4, pts: dense([[0, 110], [600, 110]]) };
  const far = { id: 3, type: 'stroke', tool: 'pen', size: 4, pts: dense([[110, 300], [190, 300]]) };
  const scribble = { type: 'stroke', tool: 'pen', size: 4, pts: zigzagH(100, 200, 100, 6) };
  assert.deepStrictEqual(G.scratchTargets([word, longLine, far], scribble, 1).map((i) => i.id), [1]);
});
test('scratchTargets: 画像は6割以上覆われたときだけ', () => {
  const small = { id: 1, type: 'image', x: 110, y: 100, w: 80, h: 16 };
  const big = { id: 2, type: 'image', x: 0, y: 0, w: 1000, h: 700 };
  const scribble = { type: 'stroke', tool: 'pen', size: 4, pts: zigzagH(100, 200, 100, 6) };
  assert.deepStrictEqual(G.scratchTargets([small, big], scribble, 1).map((i) => i.id), [1]);
});

test('isLoop: 丸・少し行き過ぎた丸は輪', () => {
  assert.ok(G.isLoop(circle(100, 100, 50), 1));
  assert.ok(G.isLoop(circle(100, 100, 50, 1.08), 1));
});
test('isLoop: C の形・直線・小さな丸・つぶれた往復は輪ではない', () => {
  assert.ok(!G.isLoop(circle(100, 100, 50, 0.7), 1));
  assert.ok(!G.isLoop(dense([[0, 0], [300, 0]]), 1));
  assert.ok(!G.isLoop(circle(100, 100, 8), 1));
  assert.ok(!G.isLoop(dense([[0, 0], [200, 2], [0, 4]]), 1));
  assert.ok(!G.isLoop(zigzagH(100, 200, 100, 6), 1));
});
test('isLoop: 表示倍率が変わっても画面上の大きさで判定する', () => {
  const big = circle(100, 100, 50).map((p) => ({ x: p.x / 4, y: p.y / 4, p: 0.5 })); // 400% 表示で書いた丸
  assert.ok(G.isLoop(big, 1 / 4));
  assert.ok(!G.isLoop(big, 1)); // 等倍なら小さすぎる
});
test('lassoTargets: 輪の中にほぼ入っているものだけ', () => {
  const inside = { id: 1, type: 'stroke', tool: 'pen', size: 4, pts: dense([[80, 100], [120, 100]]) };
  const crossing = { id: 2, type: 'stroke', tool: 'pen', size: 4, pts: dense([[100, 100], [400, 100]]) };
  assert.deepStrictEqual(G.lassoTargets([inside, crossing], circle(100, 100, 50), 0.8).map((i) => i.id), [1]);
});
