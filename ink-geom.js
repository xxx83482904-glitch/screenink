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

  // ---------- インクジェスチャーの判定 ----------
  // px = 画面上の 1px にあたるワールド座標の長さ（1 / 表示倍率）。しきい値は画面上の大きさで決める。
  // どれも「下に消す/囲む対象があるとき」だけ発動させる前提で、形の判定は控えめにしてある。

  // 値の列が向きを変えた回数。min 以上進んでから折り返したものだけ数える
  function reversals(vals, min) {
    let dir = 0, ext = vals[0], n = 0;
    for (const v of vals) {
      if (dir === 0) {
        if (Math.abs(v - ext) >= min) { dir = v > ext ? 1 : -1; ext = v; }
      } else if ((v - ext) * dir > 0) {
        ext = v;
      } else if ((ext - v) * dir >= min) {
        n++; dir = -dir; ext = v;
      }
    }
    return n;
  }

  const range = (vals) => Math.max(...vals) - Math.min(...vals);

  // 点の広がりが一番大きい向き（主軸）
  function principalAxis(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; sxy += (p.x - mx) * (p.y - my); }
    const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { ux: Math.cos(a), uy: Math.sin(a) };
  }

  // ぐしゃぐしゃ（スクラッチアウト）の形か。
  // 主軸に沿って2往復半以上している、または主軸と直角に細かく3往復半以上しているもの
  function isScratch(pts, px) {
    if (pts.length < 8) return false;
    const { ux, uy } = principalAxis(pts);
    const major = pts.map((p) => p.x * ux + p.y * uy);
    const minor = pts.map((p) => -p.x * uy + p.y * ux);
    const eM = range(major), em = range(minor);
    if (eM < 12 * px) return false;
    if (reversals(major, Math.max(8 * px, 0.4 * eM)) >= 4) return true;
    return em >= 10 * px && reversals(minor, Math.max(6 * px, 0.5 * em)) >= 6;
  }

  function pointsBox(pts) {
    return unionBox(pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  }

  // ぐしゃぐしゃの下にあって消す対象になるもの。
  // 線: 点の6割以上がぐしゃぐしゃの範囲に入り、実際に触れている。画像: 面積の6割以上が覆われている
  function scratchTargets(items, s, px, accept) {
    const box = pointsBox(s.pts);
    return items.filter((it) => {
      if (accept && !accept(it)) return false;
      if (it.type === 'image') {
        const w = Math.min(it.x + it.w, box.x + box.w) - Math.max(it.x, box.x);
        const h = Math.min(it.y + it.h, box.y + box.h) - Math.max(it.y, box.y);
        return w > 0 && h > 0 && (w * h) / (it.w * it.h) >= 0.6;
      }
      if (!boxesOverlap(strokeBox(it), box)) return false;
      const inside = it.pts.filter((p) => inBox(box, p));
      if (inside.length / it.pts.length < 0.6) return false;
      const tol = widthOf(it, 0.5) / 2 + 4 * px;
      return inside.some((p) => distToStroke(s, p) <= tol);
    });
  }

  // 閉じた輪（投げ縄）の形か。始点と終点の近くがつながり、つぶれておらず、ぐしゃぐしゃでもないもの
  function isLoop(pts, px) {
    const n = pts.length;
    if (n < 8) return false;
    const L = pathLength(pts);
    if (L < 120 * px) return false;
    const k = Math.max(1, Math.floor(n * 0.15));
    let gap = Infinity;
    for (let i = 0; i < k; i++) {
      for (let j = n - k; j < n; j++) gap = Math.min(gap, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
    if (gap > Math.max(14 * px, 0.05 * L)) return false;
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    if (Math.abs(area) / 2 / (L * L) < 0.025) return false;
    return !isScratch(pts, px);
  }

  return {
    reversals, isScratch, scratchTargets, isLoop, pointsBox,
    widthOf, strokeBox, itemBox, unionBox, boxesOverlap, distSegPoint, densify, eraseStroke,
    distToStroke, inBox, hitItem, pointInPoly, insideFraction, lassoTargets, transformItem, pathLength,
  };
});
