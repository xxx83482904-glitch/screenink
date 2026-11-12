/* global api, Geom */
const $ = (id) => document.getElementById(id);
const bg = $('bg'), ink = $('ink'), drag = $('drag'), live = $('live'), ui = $('ui');
const bctx = bg.getContext('2d');
const ictx = ink.getContext('2d');
const dctx = drag.getContext('2d'); // 選択して動かしている最中のものだけを描く層
const lctx = live.getContext('2d');
const uctx = ui.getContext('2d');
const G = Geom;

const HL_ALPHA = 0.4;          // マーカーの濃さ（#live の CSS opacity と同じ値）
const PALM_REJECT_MS = 1500;   // ペン使用中〜直後は指のタッチを無視
const PALM_SIZE = 48;          // これより大きい接触（CSS px）はタップ選択に使わない
const MIN_SCALE = 0.1, MAX_SCALE = 8;
const MAX_EXPORT_PIXELS = 40e6;

// ---------- model ----------
// すべて「ワールド座標」で持つ。100% 表示のとき 1 ワールド単位 = 1 CSS px。
// items は下から順に並んだ配列で、要素は書き換えない（変更は新しい配列・新しい要素で置き換える）。
//   画像:       {id, type:'image', img, x, y, w, h, base?}   base = 静止モードで撮った画面
//   ストローク: {id, type:'stroke', tool:'pen'|'hl', color, size, pts:[{x,y,p}]}
let items = [];
let history = [items];  // items のスナップショット列。戻す/進むはこの上を行き来する
let hi = 0;
let nextId = 1;

// 表示: screen = world * s + (tx, ty)
const view = { s: 1, tx: 0, ty: 0 };

let dpr = 1;
let mode = 'hidden';
let cur = null;        // 書いている途中のストローク
let erasing = null;    // 消しゴム操作中 {last, r, screen}
let activeId = null;   // 書く/消すに使っているポインター
let lastPen = -1e9;
const state = { tool: 'pen', color: '#ff3b30', size: 4 };

let sel = new Set();   // 選択中のものの id
let xform = null;      // 選択したものを移動/拡大縮小している最中
let lasso = null;      // 選択ツールで囲んでいる最中 {pts}（ワールド座標）
let pendingLasso = null; // ペンで囲んで選択したときの輪。「線として残す」で普通の線に戻せる
let clip = null;       // コピーしたもの {items, box, w, h}

const toWorld = (cx, cy) => ({ x: (cx - view.tx) / view.s, y: (cy - view.ty) / view.s });
const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
const strokesOf = (list) => list.filter((it) => it.type === 'stroke');
const imagesVisible = () => mode === 'freeze';

function commit() {
  if (items === history[hi]) return;
  history.length = hi + 1;
  history.push(items);
  hi++;
  updateButtons();
}

function resetHistory() {
  items = [];
  history = [items];
  hi = 0;
}

// 静止モードで撮った画面を差し替える（取り消しの対象にはしない）
function setBase(base) {
  history = history.map((st) => [base, ...st.filter((it) => !it.base)]);
  items = history[hi];
}

// ---------- render ----------

// ワールド → デバイスピクセルの変換
const devT = () => ({ k: dpr * view.s, ox: dpr * view.tx, oy: dpr * view.ty });
const setT = (ctx, t) => ctx.setTransform(t.k, 0, 0, t.k, t.ox, t.oy);

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  for (const c of [bg, ink, drag, live, ui]) { c.width = w; c.height = h; }
  drawAll();
}

function clearCtx(ctx) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

function paintImages(ctx, t, outline, list = items) {
  setT(ctx, t);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingQuality = 'high';
  for (const it of list) {
    if (it.type !== 'image') continue;
    ctx.drawImage(it.img, it.x, it.y, it.w, it.h);
    if (outline) { // 白紙の上で画像の端が分かるように細い線
      ctx.lineWidth = 1 / t.k;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.strokeRect(it.x, it.y, it.w, it.h);
    }
  }
}

function prep(ctx, s, t) {
  setT(ctx, t);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = ctx.fillStyle = s.color;
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// 太さは 0.5 デバイス px 刻みに丸める（同じ太さが続く区間を1本のパスにまとめて速く描くため）
const qWidth = (w, k) => Math.max(0.5, Math.round(w * k * 2) / 2) / k;

// i-1 番目の点を制御点にした2次曲線で、中点から中点までをつなぐ（書いている最中の1区間）
function drawSeg(ctx, s, i, k) {
  const a = s.pts[i - 1], b = s.pts[i];
  const m1 = i > 1 ? mid(s.pts[i - 2], a) : a;
  const m2 = mid(a, b);
  ctx.beginPath();
  ctx.moveTo(m1.x, m1.y);
  ctx.quadraticCurveTo(a.x, a.y, m2.x, m2.y);
  ctx.lineWidth = qWidth(G.widthOf(s, (a.p + b.p) / 2), k);
  ctx.stroke();
}

function drawTail(ctx, s, k) {
  const n = s.pts.length;
  const b = s.pts[n - 1];
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, G.widthOf(s, b.p) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const m = mid(s.pts[n - 2], b);
  ctx.beginPath();
  ctx.moveTo(m.x, m.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineWidth = qWidth(G.widthOf(s, b.p), k);
  ctx.stroke();
}

// 1本の線をまとめて描く。alpha はマーカーの濃さ
function drawStroke(ctx, s, t, alpha = 1) {
  prep(ctx, s, t);
  ctx.globalAlpha = alpha;
  const pts = s.pts, n = pts.length;
  if (n === 1) { drawTail(ctx, s, t.k); return; }
  if (s.tool === 'hl') {
    // マーカーは太さが一定なので全体を1本のパスにする。1回で塗るので、自分自身との重なりは濃くならない
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) { const a = pts[i - 1], m = mid(a, pts[i]); ctx.quadraticCurveTo(a.x, a.y, m.x, m.y); }
    ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
    ctx.lineWidth = G.widthOf(s, 0.5);
    ctx.stroke();
    return;
  }
  let w0 = 0;
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i];
    const w = qWidth(G.widthOf(s, (a.p + b.p) / 2), t.k);
    if (w !== w0) {
      if (w0) ctx.stroke();
      const m1 = i > 1 ? mid(pts[i - 2], a) : a;
      ctx.beginPath();
      ctx.moveTo(m1.x, m1.y);
      ctx.lineWidth = w;
      w0 = w;
    }
    const m2 = mid(a, b);
    ctx.quadraticCurveTo(a.x, a.y, m2.x, m2.y);
  }
  ctx.stroke();
  drawTail(ctx, s, t.k);
}

// ストロークをベクターから描く。画面の外にあるものは飛ばす
function paintStrokes(ctx, list, t) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  for (const s of list) {
    const b = G.strokeBox(s);
    const x0 = Math.max(0, Math.floor(b.x * t.k + t.ox) - 2);
    const y0 = Math.max(0, Math.floor(b.y * t.k + t.oy) - 2);
    const x1 = Math.min(W, Math.ceil((b.x + b.w) * t.k + t.ox) + 2);
    const y1 = Math.min(H, Math.ceil((b.y + b.h) * t.k + t.oy) + 2);
    if (x1 <= x0 || y1 <= y0) continue; // 画面外
    drawStroke(ctx, s, t, s.tool === 'hl' ? HL_ALPHA : 1);
  }
  ctx.globalAlpha = 1;
}

function drawBg() {
  clearCtx(bctx);
  if (!imagesVisible()) return;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.fillStyle = '#fff'; // キャプチャの外側は白紙
  bctx.fillRect(0, 0, bg.width, bg.height);
  paintImages(bctx, devT(), true);
}

const inkView = { s: 1, tx: 0, ty: 0 }; // 線を最後に描いたときの表示

function drawInk() {
  ink.style.transform = '';
  inkView.s = view.s; inkView.tx = view.tx; inkView.ty = view.ty;
  clearCtx(dctx);
  clearCtx(lctx);
  const t = devT();
  if (xform && xform.moved) {
    // 選択したものを動かしている間は、動かない線を1回だけ描いておき、動くものだけ別の層に毎コマ描く
    const key = view.s + ',' + view.tx + ',' + view.ty + ',' + ink.width + ',' + ink.height;
    if (xform.staticKey !== key) {
      xform.staticKey = key;
      clearCtx(ictx);
      paintStrokes(ictx, strokesOf(xform.base).filter((it) => !xform.ids.has(it.id)), t);
    }
    paintStrokes(dctx, strokesOf(items).filter((it) => xform.ids.has(it.id)), t);
  } else {
    clearCtx(ictx);
    paintStrokes(ictx, strokesOf(items), t);
  }
  if (cur) drawStroke(cur.tool === 'hl' ? lctx : ictx, cur, t);
}

// ワールド座標の範囲 b に掛かる線だけを描き直す（消しゴム用）
function drawInkRegion(b) {
  if (ink.style.transform) { drawAll(); return; }
  const t = devT(), pad = 3;
  const x0 = Math.floor(b.x * t.k + t.ox) - pad, y0 = Math.floor(b.y * t.k + t.oy) - pad;
  const x1 = Math.ceil((b.x + b.w) * t.k + t.ox) + pad, y1 = Math.ceil((b.y + b.h) * t.k + t.oy) + pad;
  const box = { x: b.x - pad / t.k, y: b.y - pad / t.k, w: b.w + pad * 2 / t.k, h: b.h + pad * 2 / t.k };
  ictx.save();
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.beginPath();
  ictx.rect(x0, y0, x1 - x0, y1 - y0);
  ictx.clip();
  ictx.clearRect(x0, y0, x1 - x0, y1 - y0);
  paintStrokes(ictx, strokesOf(items).filter((s) => G.boxesOverlap(G.strokeBox(s), box)), t);
  ictx.restore();
}

const SEL_COLOR = '#0a84ff';

function drawUi() {
  clearCtx(uctx);
  uctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGuides();
  drawRuler();
  if (erasing && erasing.screen) {
    uctx.beginPath();
    uctx.arc(erasing.screen.x, erasing.screen.y, state.size * 3, 0, Math.PI * 2);
    uctx.lineWidth = 1;
    uctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    uctx.stroke();
  }
  if (lasso && lasso.pts.length > 1) {
    uctx.beginPath();
    lasso.pts.forEach((p, i) => {
      const x = p.x * view.s + view.tx, y = p.y * view.s + view.ty;
      if (i) uctx.lineTo(x, y); else uctx.moveTo(x, y);
    });
    uctx.setLineDash([6, 4]);
    uctx.lineWidth = 1.5;
    uctx.strokeStyle = SEL_COLOR;
    uctx.stroke();
    uctx.setLineDash([]);
  }
  const r = selRect();
  if (r) {
    uctx.setLineDash([6, 4]);
    uctx.lineWidth = 1.5;
    uctx.strokeStyle = SEL_COLOR;
    uctx.strokeRect(r.x, r.y, r.w, r.h);
    uctx.setLineDash([]);
    uctx.fillStyle = '#fff';
    for (const c of selCorners(r)) {
      uctx.beginPath();
      uctx.rect(c.x - 6, c.y - 6, 12, 12);
      uctx.fill();
      uctx.stroke();
    }
  }
  placeSelMenu(r);
}

function drawAll() {
  clearTimeout(settleTimer);
  drawBg();
  drawInk();
  drawUi();
  $('zoom').textContent = Math.round(view.s * 100) + '%';
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawAll(); });
}

// 選択枠や囲み線だけを描き直す
let uiQueued = false;
function requestUi() {
  if (uiQueued || drawQueued) return;
  uiQueued = true;
  requestAnimationFrame(() => { uiQueued = false; if (!drawQueued) drawUi(); });
}

// 消しゴム：消えた線のまわりだけを描き直す
let eraseQueued = false;
function requestErase() {
  if (eraseQueued || drawQueued) return;
  eraseQueued = true;
  requestAnimationFrame(() => {
    eraseQueued = false;
    if (drawQueued) return;
    if (erasing && erasing.dirty) { const b = erasing.dirty; erasing.dirty = null; drawInkRegion(b); }
    drawUi();
  });
}

// 拡大縮小・移動：線が多いときは、描いてある線の絵をそのまま伸縮・移動させ、止まってから描き直す
const HEAVY_POINTS = 3000;
let settleTimer = 0;
let viewQueued = false;
function inkPoints() {
  let n = 0;
  for (const it of items) if (it.type === 'stroke') n += it.pts.length;
  return n;
}
function requestViewDraw() {
  if (xform || inkPoints() < HEAVY_POINTS) { requestDraw(); return; }
  if (viewQueued || drawQueued) return;
  viewQueued = true;
  requestAnimationFrame(() => {
    viewQueued = false;
    if (drawQueued) return;
    drawBg();
    const r = view.s / inkView.s;
    ink.style.transform = `translate(${view.tx - inkView.tx * r}px, ${view.ty - inkView.ty * r}px) scale(${r})`;
    drawUi();
    $('zoom').textContent = Math.round(view.s * 100) + '%';
    clearTimeout(settleTimer);
    settleTimer = setTimeout(requestDraw, 120);
  });
}

// ---------- view ----------

function zoomAt(cx, cy, factor) {
  const w = toWorld(cx, cy);
  view.s = clampScale(view.s * factor);
  view.tx = cx - w.x * view.s;
  view.ty = cy - w.y * view.s;
  requestViewDraw();
}

function resetView() {
  view.s = 1; view.tx = 0; view.ty = 0;
  requestDraw();
}

function visibleItems() {
  return imagesVisible() ? items : strokesOf(items);
}

// 書き込みと画像のすべてが収まるように表示する（100% より大きくはしない）
function fitAll() {
  const b = G.unionBox(visibleItems().map(G.itemBox));
  if (!b || !b.w || !b.h) { resetView(); return; }
  const W = window.innerWidth, H = window.innerHeight, m = 24;
  view.s = clampScale(Math.min(1, (W - m * 2) / b.w, (H - m * 2) / b.h));
  view.tx = (W - b.w * view.s) / 2 - b.x * view.s;
  view.ty = (H - b.h * view.s) / 2 - b.y * view.s;
  requestDraw();
}

// ---------- selection ----------
// 選択したもの（線・画像）は、枠の中をドラッグで移動、四隅で拡大縮小、メニューかDeleteで削除できる。

const SEL_PAD = 6; // 枠と中身のすき間（画面 px）

function setSel(ids) {
  sel = new Set(ids);
  pendingLasso = null;
  $('selKeep').hidden = true;
  requestDraw();
}

function clearSel() {
  if (sel.size) setSel([]);
}

function pruneSel() {
  const alive = new Set(visibleItems().map((it) => it.id));
  setSel([...sel].filter((id) => alive.has(id)));
}

// 選択枠（画面座標）
function selRect() {
  if (!sel.size) return null;
  const b = G.unionBox(items.filter((it) => sel.has(it.id)).map(G.itemBox));
  if (!b) return null;
  return { x: b.x * view.s + view.tx - SEL_PAD, y: b.y * view.s + view.ty - SEL_PAD, w: b.w * view.s + SEL_PAD * 2, h: b.h * view.s + SEL_PAD * 2 };
}

function selCorners(r) {
  return [
    { x: r.x, y: r.y, ox: r.x + r.w, oy: r.y + r.h },
    { x: r.x + r.w, y: r.y, ox: r.x, oy: r.y + r.h },
    { x: r.x, y: r.y + r.h, ox: r.x + r.w, oy: r.y },
    { x: r.x + r.w, y: r.y + r.h, ox: r.x, oy: r.y },
  ];
}

// 画面上の点が選択枠のどこに当たるか: 四隅 → {kind:'scale', anchor}、枠の中 → {kind:'move'}
function selHit(cx, cy, tol) {
  const r = selRect();
  if (!r) return null;
  for (const c of selCorners(r)) {
    if (Math.hypot(cx - c.x, cy - c.y) <= tol) return { kind: 'scale', anchor: toWorld(c.ox, c.oy) };
  }
  if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return { kind: 'move' };
  return null;
}

function startXform(id, hit, wp) {
  xform = { id, kind: hit.kind, anchor: hit.anchor, start: wp, base: items, ids: new Set(sel), moved: false };
  capture(id);
}

function updateXform(e) {
  const wp = toWorld(e.clientX, e.clientY);
  let f;
  if (xform.kind === 'move') {
    f = { s: 1, ax: 0, ay: 0, dx: wp.x - xform.start.x, dy: wp.y - xform.start.y };
    if (!xform.moved && Math.hypot(f.dx, f.dy) * view.s < 3) return;
  } else {
    const a = xform.anchor;
    const d0 = Math.hypot(xform.start.x - a.x, xform.start.y - a.y) || 1;
    f = { s: Math.max(0.05, Math.hypot(wp.x - a.x, wp.y - a.y) / d0), ax: a.x, ay: a.y, dx: 0, dy: 0 };
  }
  xform.moved = true;
  items = xform.base.map((it) => (xform.ids.has(it.id) ? G.transformItem(it, f) : it));
  requestDraw();
}

// 戻り値: 実際に動かしたかどうか
function endXform(cancel) {
  const x = xform;
  xform = null;
  if (!x) return false;
  if (cancel || !x.moved) items = x.base; else commit();
  requestDraw();
  return x.moved && !cancel;
}

function deleteSel() {
  if (!sel.size || xform) return;
  items = items.filter((it) => !sel.has(it.id));
  setSel([]);
  commit();
}

// 選択したものを、少しずらした位置に複製する。複製したほうが選択されるので、そのまま動かせる
function duplicateSel() {
  if (!sel.size || busy()) return;
  const d = 24 / view.s, now = performance.now();
  const added = items.filter((it) => sel.has(it.id)).map((it) => {
    const n = G.transformItem(it, { s: 1, ax: 0, ay: 0, dx: d, dy: d });
    n.id = nextId++;
    n.t = now;
    delete n.base;
    return n;
  });
  if (!added.length) return;
  items = [...items, ...added];
  commit();
  setSel(added.map((it) => it.id));
}

// 囲んで選択したときの輪を、普通の線として残す（丸を書きたかった場合）
function keepLasso() {
  const s = pendingLasso;
  if (!s) return;
  setSel([]);
  s.t = performance.now();
  items = [...items, s];
  commit();
}

// 選択したものをコピーする。アプリ内には「もの」のまま、クリップボードには画像として入れる
async function copySel() {
  if (!sel.size || busy()) return;
  const list = items.filter((it) => sel.has(it.id));
  const b = G.unionBox(list.map(G.itemBox));
  const m = 8;
  const box = { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
  const out = renderBox(box, exportScale(box, list), list);
  clip = { items: list, box: b, w: out.width, h: out.height };
  const copied = await api.copyPng(out.toDataURL('image/png'));
  toast(copied ? 'コピーしました' : 'コピーしました（このアプリ内でのみ貼り付けできます）');
}

// コピーしたものを、今見えている範囲の中央に貼り付ける
function pasteClip() {
  const c = toWorld(window.innerWidth / 2, window.innerHeight / 2);
  let dx = c.x - (clip.box.x + clip.box.w / 2), dy = c.y - (clip.box.y + clip.box.h / 2);
  if (Math.hypot(dx, dy) * view.s < 4) { dx = 24 / view.s; dy = 24 / view.s; } // 同じ場所なら少しずらす
  const now = performance.now();
  const added = clip.items.map((it) => {
    const n = G.transformItem(it, { s: 1, ax: 0, ay: 0, dx, dy });
    n.id = nextId++;
    n.t = now;
    delete n.base;
    return n;
  });
  items = [...items, ...added];
  commit();
  setSel(added.map((it) => it.id));
}

// 指のタップやペンの長押しで選べるもの。撮った画面そのもの（base）は誤操作を避けるため選択ツールでだけ選べる
const gestureSelectable = (it) => !it.base;

function selectAt(wp, tol, accept) {
  const it = G.hitItem(visibleItems(), wp, tol, accept);
  setSel(it ? [it.id] : []);
  return it;
}

function placeSelMenu(r) {
  const m = $('selMenu');
  const show = !!r && !xform && !cur && !lasso;
  m.classList.toggle('show', show);
  if (!show) return;
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let y = r.y - mh - 10;
  if (y < 84) y = r.y + r.h + 10;
  if (y + mh > window.innerHeight - 8) y = Math.max(84, window.innerHeight - mh - 8);
  const x = Math.min(window.innerWidth - mw - 8, Math.max(8, r.x + r.w / 2 - mw / 2));
  m.style.left = x + 'px';
  m.style.top = y + 'px';
}

// ---------- ruler & perspective guides ----------
// 定規は画面に固定（拡大縮小しても大きさは変わらない）。縁の近くでペンやマウスで書くと、縁に沿ってまっすぐになる。
// 指1本で移動、指2本で移動と回転（0°/45°/90° などに吸い付く）。マウスは定規の上をドラッグで移動、ホイールで1°ずつ回転。
const RULER_HALF = 36;  // 定規の幅の半分（画面 px）
const RULER_SNAP = 28;  // 縁からこの距離までに書き始めたら、定規に沿わせる
const RULER_ANGLE_SNAP = 2.5 * Math.PI / 180;
let ruler = null;       // {cx, cy, a, len}（画面座標。a はラジアン、時計回りが正）
let rulerGrab = null;   // 指やマウスで定規を動かしている最中
let curEdge = null;     // 書いている線を沿わせている縁

function toggleRuler(on = !ruler) {
  ruler = on ? { cx: window.innerWidth / 2, cy: window.innerHeight / 2, a: 0, len: Math.min(1000, window.innerWidth * 0.7) } : null;
  rulerGrab = null;
  updateButtons();
  requestUi();
}

// 画面上の点を、定規の座標（u = 長さ方向、v = 幅方向）に直す
function rulerLocal(x, y) {
  const dx = x - ruler.cx, dy = y - ruler.cy, c = Math.cos(ruler.a), s = Math.sin(ruler.a);
  return { u: dx * c + dy * s, v: -dx * s + dy * c };
}
function rulerPoint(u, v) {
  const c = Math.cos(ruler.a), s = Math.sin(ruler.a);
  return { x: ruler.cx + u * c - v * s, y: ruler.cy + u * s + v * c };
}
function onRuler(x, y) {
  if (!ruler) return false;
  const l = rulerLocal(x, y);
  return Math.abs(l.u) <= ruler.len / 2 && Math.abs(l.v) <= RULER_HALF;
}

// 書き始めの点が定規の上か縁の近くなら、沿わせる縁を返す（線の太さの半分だけ外側に置く）
function rulerEdgeFor(x, y, tool) {
  if (!ruler) return null;
  const l = rulerLocal(x, y);
  if (Math.abs(l.u) > ruler.len / 2 + RULER_SNAP || Math.abs(l.v) > RULER_HALF + RULER_SNAP) return null;
  const side = l.v < 0 ? -1 : 1;
  return { v: side * (RULER_HALF + G.widthOf({ tool, size: state.size }, 0.5) / 2 + 1) };
}

function snapToRuler(edge, x, y) {
  const u = Math.max(-ruler.len / 2, Math.min(ruler.len / 2, rulerLocal(x, y).u));
  return rulerPoint(u, edge.v);
}

function setRulerAngle(a) {
  const step = Math.PI / 4;
  const k = Math.round(a / step);
  ruler.a = Math.abs(a - k * step) < RULER_ANGLE_SNAP ? k * step : a;
}

function startRulerTwo(id2) {
  const ids = [rulerGrab.ids[0], id2];
  const a = touches.get(ids[0]), b = touches.get(ids[1]);
  rulerGrab = { ids, r0: { ...ruler }, m0: mid(a, b), ang0: Math.atan2(b.y - a.y, b.x - a.x) };
}

function updateRulerGrab() {
  const g = rulerGrab;
  if (!ruler) { rulerGrab = null; return; }
  if (g.ids.length === 1) {
    const p = g.mouse ? g.cur : touches.get(g.ids[0]);
    if (!p) return;
    ruler.cx = g.r0.cx + p.x - g.p0.x;
    ruler.cy = g.r0.cy + p.y - g.p0.y;
  } else {
    const a = touches.get(g.ids[0]), b = touches.get(g.ids[1]);
    if (!a || !b) return;
    const m = mid(a, b);
    ruler.cx = g.r0.cx + m.x - g.m0.x;
    ruler.cy = g.r0.cy + m.y - g.m0.y;
    setRulerAngle(g.r0.a + Math.atan2(b.y - a.y, b.x - a.x) - g.ang0);
  }
  requestUi();
}

// 表示する角度（水平 = 0°、反時計回りに 0〜179°）
function rulerDeg() {
  let d = Math.round(-ruler.a * 180 / Math.PI) % 180;
  if (d < 0) d += 180;
  return d;
}

function drawRuler() {
  if (!ruler) return;
  const L = ruler.len, h = RULER_HALF;
  uctx.save();
  uctx.translate(ruler.cx, ruler.cy);
  uctx.rotate(ruler.a);
  uctx.fillStyle = 'rgba(28, 28, 30, 0.5)';
  uctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  uctx.lineWidth = 1;
  uctx.beginPath();
  uctx.rect(-L / 2, -h, L, h * 2);
  uctx.fill();
  uctx.stroke();
  uctx.beginPath();
  for (let i = 0; i * 10 <= L; i++) {
    const x = -L / 2 + i * 10, t = i % 10 === 0 ? 14 : i % 5 === 0 ? 10 : 6;
    uctx.moveTo(x, -h); uctx.lineTo(x, -h + t);
    uctx.moveTo(x, h); uctx.lineTo(x, h - t);
  }
  uctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  uctx.stroke();
  if (Math.cos(ruler.a) < -1e-6) uctx.rotate(Math.PI); // 角度の文字は逆さにしない
  uctx.fillStyle = '#fff';
  uctx.font = '600 14px "Segoe UI", "Yu Gothic UI", sans-serif';
  uctx.textAlign = 'center';
  uctx.textBaseline = 'middle';
  uctx.fillText(rulerDeg() + '°', 0, 0);
  uctx.restore();
}

// パースのガイド線: 消失点（ワールド座標。撮った画面と一緒に拡大縮小・移動する）から放射状の線を出すだけ。線の補正はしない
let persp = null;  // {n, vps: [{x, y}]}
let vpDrag = null; // 消失点を動かしている最中 {id, i, touch?}
const VP_COLORS = ['#0a84ff', '#ff9f0a', '#30d158'];
const VP_RAYS = 48;

function setPersp(n) {
  hideSaveMenu();
  vpDrag = null;
  if (!n) {
    persp = null;
  } else {
    const W = window.innerWidth, H = window.innerHeight;
    const at = [[[W / 2, H * 0.45]], [[W * 0.12, H * 0.45], [W * 0.88, H * 0.45]],
      [[W * 0.12, H * 0.4], [W * 0.88, H * 0.4], [W / 2, H * 0.94]]][n - 1];
    persp = { n, vps: at.map(([x, y]) => toWorld(x, y)) };
  }
  updateButtons();
  requestUi();
}

const vpScreen = (p) => ({ x: p.x * view.s + view.tx, y: p.y * view.s + view.ty });

function vpHit(x, y) {
  if (!persp) return -1;
  for (let i = persp.vps.length - 1; i >= 0; i--) {
    const p = vpScreen(persp.vps[i]);
    if (Math.hypot(x - p.x, y - p.y) <= 16) return i;
  }
  return -1;
}

function moveVp(e) {
  if (persp && persp.vps[vpDrag.i]) persp.vps[vpDrag.i] = toWorld(e.clientX, e.clientY);
  requestUi();
}

function drawGuides() {
  if (!persp) return;
  const W = window.innerWidth, H = window.innerHeight, R = Math.hypot(W, H) * 3;
  const sp = persp.vps.map(vpScreen);
  uctx.save();
  uctx.lineWidth = 1;
  // 地平線（1点透視は消失点を通る水平線、2点・3点は左右の消失点を結ぶ線）
  uctx.beginPath();
  if (persp.n === 1) {
    uctx.moveTo(0, sp[0].y); uctx.lineTo(W, sp[0].y);
  } else {
    const a = sp[0], b = sp[1], d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
    uctx.moveTo(a.x - ux * R, a.y - uy * R); uctx.lineTo(a.x + ux * R, a.y + uy * R);
  }
  uctx.strokeStyle = 'rgba(255, 59, 48, 0.7)';
  uctx.stroke();
  uctx.globalAlpha = 0.35;
  sp.forEach((p, i) => {
    uctx.beginPath();
    for (let k = 0; k < VP_RAYS; k++) {
      const t = k / VP_RAYS * Math.PI * 2;
      uctx.moveTo(p.x, p.y);
      uctx.lineTo(p.x + Math.cos(t) * R, p.y + Math.sin(t) * R);
    }
    uctx.strokeStyle = VP_COLORS[i];
    uctx.stroke();
  });
  uctx.globalAlpha = 1;
  sp.forEach((p, i) => {
    uctx.beginPath();
    uctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    uctx.fillStyle = '#fff';
    uctx.fill();
    uctx.lineWidth = 2;
    uctx.strokeStyle = VP_COLORS[i];
    uctx.stroke();
  });
  uctx.restore();
}

// ---------- pointer ----------
// ペン = 常に書く。指 = 常に操作（2本指でピンチ/移動、タップで選択）。
// マウス = 書く（中ボタン or Space+ドラッグで移動）。選択中は、枠の中や四隅をどの入力でも掴める。

const touches = new Map(); // pointerId -> {x, y}
let pinch = null;
let pan = null;
let spaceDown = false;

function point(e, prev, edge) {
  let p = 0.5;
  if (e.pointerType === 'pen' && e.pressure > 0) {
    p = prev ? prev.p * 0.6 + e.pressure * 0.4 : e.pressure; // 筆圧のガタつきをならす
  }
  let sx = e.clientX, sy = e.clientY;
  if (edge && ruler) { const q = snapToRuler(edge, sx, sy); sx = q.x; sy = q.y; } // 定規の縁に沿わせる
  const w = toWorld(sx, sy);
  return { x: w.x, y: w.y, p };
}

function capture(id) {
  try { live.setPointerCapture(id); } catch (_) { /* ignore */ }
}

function endTouches() {
  touches.clear();
  pinch = null;
  touchTap = null;
  if (rulerGrab && !rulerGrab.mouse) rulerGrab = null;
  if (vpDrag && vpDrag.touch) vpDrag = null;
}

function twoTouches() {
  const [a, b] = [...touches.values()];
  return { m: mid(a, b), d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}

function startPinch() {
  const { m, d } = twoTouches();
  pinch = { d0: d, m0: m, s0: view.s, w0: toWorld(m.x, m.y), hinted: false };
}

function updatePinch() {
  const { m, d } = twoTouches();
  if (mode !== 'freeze') { // ライブは等倍の重ね書きのまま。操作されたら案内だけ出す
    if (!pinch.hinted && (Math.abs(d - pinch.d0) > 24 || Math.hypot(m.x - pinch.m0.x, m.y - pinch.m0.y) > 24)) {
      pinch.hinted = true;
      toast('拡大縮小と移動は「静止」モードで使えます');
    }
    return;
  }
  view.s = clampScale(pinch.s0 * d / pinch.d0);
  view.tx = m.x - pinch.w0.x * view.s;
  view.ty = m.y - pinch.w0.y * view.s;
  requestViewDraw();
}

function eraseSeg(a, b) {
  let changed = false;
  const out = [];
  for (const it of items) {
    const pieces = it.type === 'stroke' ? G.eraseStroke(it, a, b, erasing.r) : null;
    if (!pieces) { out.push(it); continue; }
    changed = true;
    erasing.dirty = G.unionBox([erasing.dirty, G.strokeBox(it)].filter(Boolean));
    for (const p of pieces) { p.id = nextId++; out.push(p); }
  }
  if (changed) items = out;
}

const HOLD_MS = 500;        // ペンの長押しで選択するまでの時間
const LASSO_MIN_AGE = 1000; // 囲んで選択できるのは、書いてからこの時間が過ぎたものだけ
const SCRATCH_SPEED = 0.5;  // スクラッチアウトとみなす速さ（画面 px / ms）。ゆっくり書いた線は消さない
let holdTimer = 0;
let strokeT0 = 0;

// ペンを動かさずに押し続けたら、その下の線や画像を選択する。そのまま動かせば移動になる
function startHold(id, cx, cy) {
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    if (!cur || activeId !== id || !isTap(cur)) return;
    const wp = toWorld(cx, cy);
    const it = G.hitItem(visibleItems(), wp, 8 / view.s, gestureSelectable);
    if (!it) return;
    cur = null;
    drawInk();
    setSel([it.id]);
    startXform(id, { kind: 'move' }, wp);
  }, HOLD_MS);
}

let touchTap = null;      // 指1本のタップ判定 {id, x, y, t, moved}
let swallowTap = false;   // 選択を外すためのタップを、点として残さない

const penEraser = (e) => e.pointerType === 'pen' && (e.button === 5 || !!(e.buttons & 32) || !!(e.buttons & 2));

// ほとんど動いていないストローク（タップ）か
function isTap(s) {
  const b = G.unionBox(s.pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  return Math.max(b.w, b.h) * view.s < 6;
}

function onDown(e) {
  const now = performance.now();
  hideSaveMenu();
  const wp = toWorld(e.clientX, e.clientY);
  if (e.pointerType === 'touch') {
    // 接触面が大きいもの（手のひらや指の腹）はタップとして扱わない
    const palmLike = Math.max(e.width || 0, e.height || 0) > PALM_SIZE;
    // 定規と消失点は、ペンを使った直後でも指で動かせる（手のひらのような大きな接触は除く）
    const guideTouch = !palmLike && activeId === null && !vpDrag &&
      ((touches.size === 0 && (onRuler(e.clientX, e.clientY) || vpHit(e.clientX, e.clientY) >= 0)) || (!!rulerGrab && touches.size === 1));
    if ((now - lastPen < PALM_REJECT_MS && !guideTouch) || activeId !== null) return; // 手のひら / ペンやマウスで操作中
    e.preventDefault();
    if (vpDrag) return; // 消失点を動かしている間の別の指は使わない
    if (touches.size === 0 && !palmLike) {
      const vi = vpHit(e.clientX, e.clientY);
      if (vi >= 0) { vpDrag = { id: e.pointerId, i: vi, touch: true }; capture(e.pointerId); return; }
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capture(e.pointerId);
    if (touches.size === 1) {
      if (!palmLike && onRuler(e.clientX, e.clientY)) {
        rulerGrab = { ids: [e.pointerId], r0: { ...ruler }, p0: { x: e.clientX, y: e.clientY } };
        touchTap = null;
        return;
      }
      touchTap = palmLike ? null : { id: e.pointerId, x: e.clientX, y: e.clientY, t: now, moved: false };
      const hit = selHit(e.clientX, e.clientY, 22);
      if (hit) startXform(e.pointerId, hit, wp);
    } else {
      touchTap = null;
      if (rulerGrab && touches.size === 2) { startRulerTwo(e.pointerId); return; } // 定規を指2本で回す
      endXform(true); // 2本目の指が来たら、選択の移動はやめてピンチにする
      if (touches.size === 2) startPinch();
    }
    return;
  }
  if (e.pointerType === 'pen') {
    lastPen = now;
    if (xform && activeId === null) endXform(true); // 指で動かしている最中にペンが来た
    endTouches();
  }
  if (activeId !== null || pan) return;
  // 消失点のつまみは、ペンでもマウスでも動かせる
  if (e.pointerType !== 'mouse' || e.button === 0) {
    const vi = vpHit(e.clientX, e.clientY);
    if (vi >= 0) { e.preventDefault(); activeId = e.pointerId; vpDrag = { id: e.pointerId, i: vi }; capture(e.pointerId); return; }
  }
  // マウスは定規の上をドラッグすると定規が動く（ペンは定規の上でも書ける）
  if (e.pointerType === 'mouse' && e.button === 0 && !spaceDown && onRuler(e.clientX, e.clientY)) {
    e.preventDefault();
    activeId = e.pointerId;
    rulerGrab = { ids: [e.pointerId], mouse: true, r0: { ...ruler }, p0: { x: e.clientX, y: e.clientY }, cur: { x: e.clientX, y: e.clientY } };
    capture(e.pointerId);
    return;
  }
  if (e.pointerType === 'mouse') {
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      if (mode === 'freeze') { pan = { id: e.pointerId, x: e.clientX, y: e.clientY }; capture(e.pointerId); }
      return;
    }
    if (e.button !== 0) return;
  }
  e.preventDefault();

  // ペンの尻（消しゴム）側、またはサイドボタンを押しながら → 消しゴム
  const tool = penEraser(e) ? 'eraser' : state.tool;

  if (tool !== 'eraser') {
    const hit = selHit(e.clientX, e.clientY, 14);
    if (hit) { activeId = e.pointerId; startXform(e.pointerId, hit, wp); return; }
  }
  activeId = e.pointerId;
  capture(e.pointerId);

  if (tool === 'select') {
    const add = e.shiftKey || e.ctrlKey;
    const it = G.hitItem(visibleItems(), wp, 6 / view.s);
    if (it && !it.base) {
      setSel(add ? [...sel, it.id] : [it.id]);
      startXform(e.pointerId, { kind: 'move' }, wp);
    } else {
      // 何もない所か、撮った画面の上。ドラッグなら囲み選択、動かさずに離せば撮った画面を選択
      if (!add) clearSel();
      lasso = { pts: [wp], add, click: it };
    }
    return;
  }

  swallowTap = sel.size > 0;
  clearSel();
  if (tool === 'eraser') {
    erasing = { last: wp, r: state.size * 3 / view.s, screen: { x: e.clientX, y: e.clientY } };
    eraseSeg(wp, wp);
    requestErase();
    return;
  }
  // 太さは画面上で一定。ワールド座標では表示倍率で割った値になる
  curEdge = rulerEdgeFor(e.clientX, e.clientY, tool);
  cur = { id: nextId++, type: 'stroke', tool, color: state.color, size: state.size / view.s, pts: [point(e, null, curEdge)] };
  strokeT0 = now;
  if (tool === 'hl') clearCtx(lctx);
  if (e.pointerType === 'pen' && !curEdge) startHold(e.pointerId, e.clientX, e.clientY);
}

function onMove(e) {
  if (e.pointerType === 'touch') {
    if (vpDrag && vpDrag.id === e.pointerId) { moveVp(e); return; }
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    if (rulerGrab && rulerGrab.ids.includes(e.pointerId)) { updateRulerGrab(); return; }
    if (touchTap && touchTap.id === e.pointerId && Math.hypot(t.x - touchTap.x, t.y - touchTap.y) > 10) touchTap.moved = true;
    if (xform && xform.id === e.pointerId) updateXform(e);
    else if (pinch && touches.size >= 2) updatePinch();
    return;
  }
  if (e.pointerType === 'pen') lastPen = performance.now();
  if (pan && e.pointerId === pan.id) {
    view.tx += e.clientX - pan.x;
    view.ty += e.clientY - pan.y;
    pan.x = e.clientX; pan.y = e.clientY;
    requestViewDraw();
    return;
  }
  if (e.pointerId !== activeId) return;
  e.preventDefault();
  if (vpDrag) { moveVp(e); return; }
  if (rulerGrab) { rulerGrab.cur = { x: e.clientX, y: e.clientY }; updateRulerGrab(); return; }
  if (xform) { updateXform(e); return; }
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (!evs.length) evs = [e];
  if (lasso) {
    for (const ev of evs) lasso.pts.push(toWorld(ev.clientX, ev.clientY));
    requestUi();
    return;
  }
  if (erasing) {
    for (const ev of evs) {
      const w = toWorld(ev.clientX, ev.clientY);
      eraseSeg(erasing.last, w);
      erasing.last = w;
    }
    erasing.screen = { x: e.clientX, y: e.clientY };
    requestErase();
    return;
  }
  if (!cur) return;
  const ctx = cur.tool === 'hl' ? lctx : ictx;
  const t = devT();
  prep(ctx, cur, t);
  const minStep = 0.4 / view.s;
  for (const ev of evs) {
    const prev = cur.pts[cur.pts.length - 1];
    const pt = point(ev, prev, curEdge);
    if (Math.hypot(pt.x - prev.x, pt.y - prev.y) < minStep) { prev.p = pt.p; continue; }
    cur.pts.push(pt);
    drawSeg(ctx, cur, cur.pts.length - 1, t.k);
  }
}

function onUp(e) {
  const cancelled = e.type === 'pointercancel';
  if (e.pointerType === 'touch') {
    if (vpDrag && vpDrag.id === e.pointerId) { vpDrag = null; return; }
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (rulerGrab && rulerGrab.ids.includes(e.pointerId)) { rulerGrab = null; touchTap = null; return; }
    const tap = touchTap && touchTap.id === e.pointerId ? touchTap : null;
    if (tap) touchTap = null;
    const moved = xform && xform.id === e.pointerId ? endXform(cancelled) : false;
    // 指のタップ: 線や貼り付けた画像を選択。何もない所なら選択を外す
    if (tap && !tap.moved && !moved && !cancelled && performance.now() - tap.t < 400) {
      selectAt(toWorld(tap.x, tap.y), 14 / view.s, gestureSelectable);
    }
    return;
  }
  if (pan && e.pointerId === pan.id) { pan = null; return; }
  if (e.pointerId !== activeId) return;
  if (e.pointerType === 'pen') lastPen = performance.now();
  activeId = null;
  clearTimeout(holdTimer);
  if (vpDrag) { vpDrag = null; return; }
  if (rulerGrab) { rulerGrab = null; return; }
  if (xform) { endXform(cancelled); return; }
  if (lasso) {
    const l = lasso;
    lasso = null;
    if (!cancelled && G.pathLength(l.pts) * view.s > 12) {
      const ids = G.lassoTargets(visibleItems(), l.pts, 0.7).map((it) => it.id);
      setSel(l.add ? [...sel, ...ids] : ids);
    } else if (!cancelled && l.click) {
      setSel(l.add ? [...sel, l.click.id] : [l.click.id]);
    }
    requestDraw();
    return;
  }
  if (erasing) {
    erasing = null;
    commit();
    requestDraw();
    return;
  }
  if (!cur) return;
  const s = cur;
  const ruled = !!curEdge;
  cur = null;
  curEdge = null;
  const dropTap = swallowTap && isTap(s);
  swallowTap = false;
  const added = !cancelled && !dropTap && finishStroke(s, ruled);
  if (added && s.tool !== 'hl') {
    // 普通の線は書きながら描いてあるので、最後の端だけ足せばよい（全体は描き直さない）
    const t = devT();
    prep(ictx, s, t);
    drawTail(ictx, s, t.k);
    return;
  }
  requestDraw(); // マーカーの焼き込み、ジェスチャーで消えた/選択されたもの、取り消した線を反映
}

// 書き終えた線を確定する。ペンで書いた線は、先にインクジェスチャーかどうかを調べる
//  - ぐしゃぐしゃ（スクラッチアウト）: 下にある線や画像を消す
//  - 囲む（投げ縄）: 中にあるものを選択する
// どちらも対象が無ければ普通の線として残す。撮った画面そのものは対象にしない。
// 戻り値: 普通の線として追加したら true、ジェスチャーとして使ったら false
// 定規に沿わせた線（ruled）はジェスチャーとして扱わない
function finishStroke(s, ruled) {
  const t1 = performance.now();
  if (s.tool === 'pen' && !ruled) {
    const px = 1 / view.s;
    const speed = G.pathLength(s.pts) * view.s / Math.max(1, t1 - strokeT0);
    if (G.isScratch(s.pts, px)) {
      const hit = speed >= SCRATCH_SPEED
        ? new Set(G.scratchTargets(visibleItems(), s, px, gestureSelectable).map((it) => it.id)) : new Set();
      if (hit.size) {
        items = items.filter((it) => !hit.has(it.id));
        commit();
        return false;
      }
    } else if (G.isLoop(s.pts, px)) {
      const old = (it) => gestureSelectable(it) && it.t <= strokeT0 - LASSO_MIN_AGE;
      const ids = G.lassoTargets(visibleItems(), s.pts, 0.8, old).map((it) => it.id);
      if (ids.length) {
        setSel(ids);
        pendingLasso = s;
        $('selKeep').hidden = false;
        return false;
      }
    }
  }
  s.t = t1;
  items = [...items, s];
  commit();
  return true;
}

live.addEventListener('pointerdown', onDown);
live.addEventListener('pointermove', onMove);
live.addEventListener('pointerup', onUp);
live.addEventListener('pointercancel', onUp);
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Ctrl+ホイール（タッチパッドのピンチ）= 拡大縮小、ホイール = 移動
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (ruler && onRuler(e.clientX, e.clientY)) { // 定規の上のホイールは 1° ずつ回転
    ruler.a = (Math.round(ruler.a * 180 / Math.PI) + Math.sign(e.deltaY)) * Math.PI / 180;
    requestUi();
    return;
  }
  if (mode !== 'freeze') return;
  if (e.ctrlKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.006));
  } else {
    view.tx -= e.shiftKey ? e.deltaY : e.deltaX;
    view.ty -= e.shiftKey ? 0 : e.deltaY;
    requestViewDraw();
  }
}, { passive: false });

// ---------- actions ----------

const busy = () => !!(cur || erasing || xform || lasso);

function undo() {
  if (pendingLasso && !busy()) { keepLasso(); return; } // 囲んで選択した直後の「戻す」は、輪を線として残す
  if (busy() || hi === 0) return;
  items = history[--hi];
  pruneSel();
  drawAll();
  updateButtons();
}

function redo() {
  if (busy() || hi >= history.length - 1) return;
  items = history[++hi];
  pruneSel();
  drawAll();
  updateButtons();
}

function clearAll() {
  if (busy() || !items.some((it) => it.type === 'stroke')) return;
  items = items.filter((it) => it.type !== 'stroke');
  pruneSel();
  commit();
  drawAll();
}

function loadImg(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// 「全体」を保存するときの解像度。画像の元の画素を落とさない倍率にする
function exportScale(box, list = items) {
  let k = dpr;
  for (const it of list) if (it.type === 'image') k = Math.max(k, it.img.naturalWidth / it.w);
  k = Math.min(4, Math.max(1, k));
  return Math.min(k, Math.sqrt(MAX_EXPORT_PIXELS / (box.w * box.h)));
}

// ワールド座標の範囲 box を倍率 k で1枚の画像にする
function renderBox(box, k, list = items) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(box.w * k));
  out.height = Math.max(1, Math.round(box.h * k));
  const x = out.getContext('2d');
  const t = { k, ox: -box.x * k, oy: -box.y * k };
  x.fillStyle = '#fff';
  x.fillRect(0, 0, out.width, out.height);
  paintImages(x, t, false, list);
  paintStrokes(x, strokesOf(list), t);
  return out;
}

// 画像をキャンバスに置いて選択状態にする
function addImage(img, x, y, w, h) {
  const it = { id: nextId++, type: 'image', img, x, y, w, h, t: performance.now() };
  items = [...items, it];
  commit();
  setSel([it.id]);
  return it;
}

// クリップボードの画像を、今見えている範囲の中央に貼り付ける
let pasting = false;
async function paste() {
  if (pasting || busy()) return;
  if (mode !== 'freeze') { toast('貼り付けは「静止」モードで使えます'); return; }
  pasting = true;
  try {
    const url = await api.readClipboardImage();
    const img = url ? await loadImg(url) : null;
    // クリップボードの中身がこのアプリでコピーした画像のままなら、線は線のまま貼り付ける
    if (clip && (!img || (img.naturalWidth === clip.w && img.naturalHeight === clip.h))) { pasteClip(); return; }
    if (!img) { toast('クリップボードに画像がありません'); return; }
    // 100% 表示で元の大きさ。見えている範囲の 80% を超えるなら収まるように縮める
    let w = img.naturalWidth / dpr, h = img.naturalHeight / dpr;
    const vw = window.innerWidth / view.s, vh = window.innerHeight / view.s;
    const k = Math.min(1, vw * 0.8 / w, vh * 0.8 / h);
    w *= k; h *= k;
    const c = toWorld(window.innerWidth / 2, window.innerHeight / 2);
    addImage(img, c.x - w / 2, c.y - h / 2, w, h);
  } catch (err) {
    toast('貼り付けに失敗しました: ' + err.message);
  } finally {
    pasting = false;
  }
}

// 追加で撮った画面を、今ある画像の右隣に並べて全体を表示する
api.onAddImage(async ({ image, size }) => {
  if (mode !== 'freeze') return;
  try {
    const img = await loadImg(image);
    const b = G.unionBox(items.filter((it) => it.type === 'image').map(G.itemBox));
    addImage(img, b ? b.x + b.w + 40 : 0, b ? b.y : 0, size.w, size.h);
    fitAll();
  } catch (err) {
    toast('キャプチャの追加に失敗しました: ' + err.message);
  }
});

let saving = false;
// kind: 'view' = 今見えている範囲、'all' = 書き込みと画像を含む全体
// copyOnly: true ならファイルを作らず、クリップボードにだけコピーする
async function save(kind, copyOnly) {
  hideSaveMenu();
  if (saving || busy()) return;
  saving = true;
  try {
    let out;
    if (mode === 'live') {
      // ライブ時は、今の画面を撮ってから書き込みを重ねる
      const base = await loadImg(await api.grabScreen());
      out = document.createElement('canvas');
      out.width = ink.width;
      out.height = ink.height;
      const x = out.getContext('2d');
      x.drawImage(base, 0, 0, out.width, out.height);
      paintStrokes(x, strokesOf(items), { k: dpr, ox: 0, oy: 0 });
    } else if (kind === 'all') {
      const b = G.unionBox(items.map(G.itemBox));
      if (!b) { toast(copyOnly ? 'コピーする内容がありません' : '保存する内容がありません'); return; }
      const m = 16;
      const box = { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
      out = renderBox(box, exportScale(box));
    } else {
      const box = { x: -view.tx / view.s, y: -view.ty / view.s, w: window.innerWidth / view.s, h: window.innerHeight / view.s };
      out = renderBox(box, dpr * view.s);
    }
    if (copyOnly) {
      toast((await api.copyPng(out.toDataURL('image/png'))) ? 'クリップボードにコピーしました（ファイルは作っていません）' : 'コピーに失敗しました');
      return;
    }
    const { file, copied } = await api.save(out.toDataURL('image/png'));
    toast((copied ? '保存してクリップボードにコピーしました　' : '保存しました（コピーは失敗）　') + file);
  } catch (err) {
    toast((copyOnly ? 'コピー' : '保存') + 'に失敗しました: ' + err.message);
  } finally {
    saving = false;
  }
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- toolbar ----------

function hideSaveMenu() { $('saveMenu').classList.remove('show'); $('perspMenu').classList.remove('show'); }

// 保存メニューを「保存」ボタンの位置に出す（ツールバーが折り返していても合うように）
function toggleSaveMenu() {
  const m = $('saveMenu'), b = $('save');
  $('perspMenu').classList.remove('show');
  // 「全体」は静止モードだけ（ライブは画面そのものが範囲）
  $('saveAll').style.display = $('copyAll').style.display = mode === 'freeze' ? '' : 'none';
  m.style.left = b.offsetLeft + 'px';
  m.classList.toggle('show');
}

function togglePerspMenu() {
  $('saveMenu').classList.remove('show');
  const m = $('perspMenu');
  m.style.left = $('perspBtn').offsetLeft + 'px';
  m.classList.toggle('show');
}

function updateButtons() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === state.tool));
  document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === state.size));
  live.style.cursor = state.tool === 'select' ? 'default' : 'crosshair';
  $('rulerBtn').classList.toggle('on', !!ruler);
  $('perspBtn').classList.toggle('on', !!persp);
  document.querySelectorAll('[data-persp]').forEach((b) => b.classList.toggle('on', !!persp && Number(b.dataset.persp) === persp.n));
  $('undo').disabled = hi === 0 && !pendingLasso;
  $('redo').disabled = hi >= history.length - 1;
}

$('selMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'selDelete') deleteSel();
  else if (b.id === 'selCopy') copySel();
  else if (b.id === 'selDup') duplicateSel();
  else if (b.id === 'selKeep') keepLasso();
  updateButtons();
});

$('bar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id !== 'save' && b.id !== 'perspBtn') hideSaveMenu();
  if (b.dataset.tool) { state.tool = b.dataset.tool; if (state.tool !== 'select') clearSel(); }
  else if (b.dataset.color) { state.color = b.dataset.color; if (state.tool === 'eraser') state.tool = 'pen'; }
  else if (b.dataset.size) state.size = Number(b.dataset.size);
  else if (b.dataset.persp != null) setPersp(Number(b.dataset.persp));
  else if (b.id === 'rulerBtn') toggleRuler();
  else if (b.id === 'perspBtn') togglePerspMenu();
  else if (b.id === 'undo') undo();
  else if (b.id === 'redo') redo();
  else if (b.id === 'clear') clearAll();
  else if (b.id === 'paste') paste();
  else if (b.id === 'addCap') api.addCapture();
  else if (b.id === 'fit') fitAll();
  else if (b.id === 'zoom') resetView();
  else if (b.id === 'toFreeze') api.switchMode('freeze');
  else if (b.id === 'toLive') api.switchMode('live');
  else if (b.id === 'pass') api.setPass(true);
  else if (b.id === 'save') toggleSaveMenu();
  else if (b.id === 'saveView') save('view');
  else if (b.id === 'saveAll') save('all');
  else if (b.id === 'copyView') save('view', true);
  else if (b.id === 'copyAll') save('all', true);
  else if (b.id === 'flip') $('bar').classList.toggle('bottom');
  else if (b.id === 'close') api.close();
  updateButtons();
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.key === ' ') { spaceDown = true; return; }
  if (e.key === 'Escape') { if (sel.size) clearSel(); else api.close(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSel();
  else if (e.ctrlKey && k === 'v') paste();
  else if (e.ctrlKey && e.shiftKey && k === 'c') { e.preventDefault(); save('view', true); }
  else if (e.ctrlKey && k === 'c') copySel();
  else if (e.ctrlKey && k === 'd') { e.preventDefault(); duplicateSel(); }
  else if (e.ctrlKey && k === 'z' && !e.shiftKey) undo();
  else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
  else if (e.ctrlKey && k === 's') { e.preventDefault(); save(e.shiftKey && mode === 'freeze' ? 'all' : 'view'); }
  else if (e.ctrlKey && k === '0') { if (mode === 'freeze') resetView(); }
  else if (e.ctrlKey && k === '1') { if (mode === 'freeze') fitAll(); }
  else if (e.ctrlKey || e.altKey) return;
  else if (k === 'p') state.tool = 'pen';
  else if (k === 'h') state.tool = 'hl';
  else if (k === 'e') state.tool = 'eraser';
  else if (k === 'v') state.tool = 'select';
  else if (k === 'r') toggleRuler();
  if (state.tool !== 'select' && 'phe'.includes(k) && k.length === 1) clearSel();
  updateButtons();
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });
window.addEventListener('blur', () => { spaceDown = false; });

// ---------- from main ----------

api.onMode(async ({ mode: m, image, size, keepInk }) => {
  mode = m;
  document.body.dataset.mode = m;
  cur = null;
  curEdge = null;
  rulerGrab = null;
  vpDrag = null;
  erasing = null;
  activeId = null;
  pan = null;
  xform = null;
  lasso = null;
  clearTimeout(holdTimer);
  setSel([]);
  endTouches();
  hideSaveMenu();
  view.s = 1; view.tx = 0; view.ty = 0; // モードを切り替えたら等倍に戻す
  if (!keepInk) resetHistory();
  if (m === 'freeze' && image) {
    try {
      const img = await loadImg(image);
      const w = size ? size.w : window.innerWidth;
      const h = size ? size.h : window.innerHeight;
      setBase({ id: nextId++, type: 'image', base: true, img, x: 0, y: 0, w, h });
    } catch (_) { /* 背景なしで続行 */ }
  }
  resize();
  updateButtons();
  api.ready();
});

api.onPass((on) => { document.body.dataset.pass = on ? '1' : '0'; });

window.addEventListener('resize', resize);
resize();
updateButtons();

// 動作確認用（開発者ツールや自動テストから状態を見る）
window.__ink = { get ruler() { return ruler; }, get persp() { return persp; }, get items() { return items; }, get mode() { return mode; }, get selection() { return sel; }, view, state };
