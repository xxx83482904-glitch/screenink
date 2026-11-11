// ScreenInk — 描画に依存しない幾何計算（ブラウザでは window.Geom、Node では require で使う）
(function (root, factory) {
  const g = factory();
  if (typeof module === 'object' && module.exports) module.exports = g;
  else root.Geom = g;
})(this, function () {
  'use strict';

  // 線の太さ（ワールド座標）。筆圧 0.5 でちょうど指定の太さ
  function widthOf(s, p) {
    if (s.tool === 'hl') return s.size * 5;
    return s.size * (0.4 + 1.2 * p);
  }

  const boxCache = new WeakMap();

  // ストロークの外接矩形（太さ込み）。ストロークは作成後に書き換えない前提でキャッシュする
  function strokeBox(s) {
    let b = boxCache.get(s);
    if (b) return b;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    const pad = widthOf(s, 1) / 2;
    b = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
    boxCache.set(s, b);
    return b;
  }

  function itemBox(it) {
    return it.type === 'image' ? { x: it.x, y: it.y, w: it.w, h: it.h } : strokeBox(it);
  }

  function unionBox(boxes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of boxes) {
      if (b.x < x0) x0 = b.x;
      if (b.y < y0) y0 = b.y;
      if (b.x + b.w > x1) x1 = b.x + b.w;
      if (b.y + b.h > y1) y1 = b.y + b.h;
    }
    if (x0 === Infinity) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function boxesOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  // 線分 ab と点 p の距離
  function distSegPoint(a, b, p) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }

  // 点の間隔が step を超えないように補間する
  function densify(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t });
      }
      out.push(b);
    }
    return out;
  }

  // 消しゴム（線分 ab・半径 r）でストロークを削る。
  // 触れていなければ null、触れていれば残った断片の配列（全部消えたら空配列）を返す
  function eraseStroke(s, a, b, r) {
    const box = strokeBox(s);
    if (Math.max(a.x, b.x) < box.x - r || Math.min(a.x, b.x) > box.x + box.w + r ||
        Math.max(a.y, b.y) < box.y - r || Math.min(a.y, b.y) > box.y + box.h + r) return null;
    const pts = densify(s.pts, Math.max(r / 2, 0.25));
    let hit = false;
    const keep = pts.map((p) => {
      const k = distSegPoint(a, b, p) > r + widthOf(s, p.p) / 2;
      if (!k) hit = true;
      return k;
    });
    if (!hit) return null;
    const pieces = [];
    let run = [];
    const flush = () => {
      if (run.length >= 2) pieces.push(Object.assign({}, s, { pts: run }));
      run = [];
    };
    for (let i = 0; i < pts.length; i++) {
      if (keep[i]) run.push(pts[i]); else flush();
    }
    flush();
    return pieces;
  }

  function distToStroke(s, p) {
    const pts = s.pts;
    if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, distSegPoint(pts[i - 1], pts[i], p));
    return d;
  }

  const inBox = (b, p, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

  // 点 p の下にある一番上のもの。線を画像より優先する。accept で対象を絞れる
  function hitItem(items, p, tol, accept) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type !== 'stroke' || (accept && !accept(it))) continue;
      if (!inBox(strokeBox(it), p, tol)) continue;
      if (distToStroke(it, p) <= widthOf(it, 0.5) / 2 + tol) return it;
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type !== 'image' || (accept && !accept(it))) continue;
      if (inBox(it, p)) return it;
    }
    return null;
  }

  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // そのものの何割が多角形の内側にあるか（0〜1）
  function insideFraction(it, poly) {
    const pts = it.type === 'image'
      ? [{ x: it.x, y: it.y }, { x: it.x + it.w, y: it.y }, { x: it.x, y: it.y + it.h }, { x: it.x + it.w, y: it.y + it.h },
        { x: it.x + it.w / 2, y: it.y + it.h / 2 }]
      : it.pts;
    let n = 0;
    for (const p of pts) if (pointInPoly(p, poly)) n++;
    return n / pts.length;
  }

  // 多角形でおおむね囲まれたもの
  function lassoTargets(items, poly, minFrac, accept) {
    return items.filter((it) => (!accept || accept(it)) && insideFraction(it, poly) >= minFrac);
  }

  // 移動・拡大縮小: p' = (p - a) * s + a + d。元の要素は書き換えず新しい要素を返す
  function transformItem(it, f) {
    const tx = (x) => (x - f.ax) * f.s + f.ax + f.dx;
    const ty = (y) => (y - f.ay) * f.s + f.ay + f.dy;
    if (it.type === 'image') return Object.assign({}, it, { x: tx(it.x), y: ty(it.y), w: it.w * f.s, h: it.h * f.s });
    return Object.assign({}, it, { size: it.size * f.s, pts: it.pts.map((p) => ({ x: tx(p.x), y: ty(p.y), p: p.p })) });
  }

  function pathLength(pts) {
    let n = 0;
    for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return n;
  }

  return {
    widthOf, strokeBox, itemBox, unionBox, boxesOverlap, distSegPoint, densify, eraseStroke,
    distToStroke, inBox, hitItem, pointInPoly, insideFraction, lassoTargets, transformItem, pathLength,
  };
});
