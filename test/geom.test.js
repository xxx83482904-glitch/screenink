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
