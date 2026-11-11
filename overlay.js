/* global api, Geom */
const $ = (id) => document.getElementById(id);
const bg = $('bg'), ink = $('ink'), live = $('live'), ui = $('ui');
const bctx = bg.getContext('2d');
const ictx = ink.getContext('2d');
const lctx = live.getContext('2d');
const uctx = ui.getContext('2d');
const G = Geom;

const HL_ALPHA = 0.4;          // マーカーの濃さ（#live の CSS opacity と同じ値）
const PALM_REJECT_MS = 1500;   // ペン使用中〜直後は指のタッチを無視
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

const scratch = document.createElement('canvas'); // マーカー1本ぶんを不透明で描く作業用
let exportScratch = null;

function scratchFor(w, h) {
  if (w === scratch.width && h === scratch.height) return scratch;
  if (!exportScratch) exportScratch = document.createElement('canvas');
  if (exportScratch.width !== w || exportScratch.height !== h) { exportScratch.width = w; exportScratch.height = h; }
  return exportScratch;
}

// ワールド → デバイスピクセルの変換
const devT = () => ({ k: dpr * view.s, ox: dpr * view.tx, oy: dpr * view.ty });
const setT = (ctx, t) => ctx.setTransform(t.k, 0, 0, t.k, t.ox, t.oy);

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  for (const c of [bg, ink, live, ui, scratch]) { c.width = w; c.height = h; }
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

// i-1 番目の点を制御点にした2次曲線で、中点から中点までをつなぐ
function drawSeg(ctx, s, i) {
  const a = s.pts[i - 1], b = s.pts[i];
  const m1 = i > 1 ? mid(s.pts[i - 2], a) : a;
  const m2 = mid(a, b);
  ctx.beginPath();
  ctx.moveTo(m1.x, m1.y);
  ctx.quadraticCurveTo(a.x, a.y, m2.x, m2.y);
  ctx.lineWidth = G.widthOf(s, (a.p + b.p) / 2);
  ctx.stroke();
}

function drawTail(ctx, s) {
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
  ctx.lineWidth = G.widthOf(s, b.p);
  ctx.stroke();
}

function drawStroke(ctx, s, t) {
  prep(ctx, s, t);
  for (let i = 1; i < s.pts.length; i++) drawSeg(ctx, s, i);
  drawTail(ctx, s);
}

// ストロークをベクターから描く。マーカーは1本ずつ不透明で描いてから半透明で重ねる
// （1本の中の重なりで濃くならない）
function paintStrokes(ctx, list, t) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  for (const s of list) {
    const b = G.strokeBox(s);
    const x0 = Math.max(0, Math.floor(b.x * t.k + t.ox) - 2);
    const y0 = Math.max(0, Math.floor(b.y * t.k + t.oy) - 2);
    const x1 = Math.min(W, Math.ceil((b.x + b.w) * t.k + t.ox) + 2);
    const y1 = Math.min(H, Math.ceil((b.y + b.h) * t.k + t.oy) + 2);
    if (x1 <= x0 || y1 <= y0) continue; // 画面外
    if (s.tool !== 'hl') { drawStroke(ctx, s, t); continue; }
    const sc = scratchFor(W, H);
    const sx = sc.getContext('2d');
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.clearRect(x0, y0, x1 - x0, y1 - y0);
    drawStroke(sx, s, t);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = HL_ALPHA;
    ctx.drawImage(sc, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }
}

function drawBg() {
  clearCtx(bctx);
  if (!imagesVisible()) return;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.fillStyle = '#fff'; // キャプチャの外側は白紙
  bctx.fillRect(0, 0, bg.width, bg.height);
  paintImages(bctx, devT(), true);
}

function drawInk() {
  clearCtx(ictx);
  clearCtx(lctx);
  const t = devT();
  paintStrokes(ictx, strokesOf(items), t);
  if (cur) drawStroke(cur.tool === 'hl' ? lctx : ictx, cur, t);
}

const SEL_COLOR = '#0a84ff';

function drawUi() {
  clearCtx(uctx);
  uctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

// ---------- view ----------

function zoomAt(cx, cy, factor) {
  const w = toWorld(cx, cy);
  view.s = clampScale(view.s * factor);
  view.tx = cx - w.x * view.s;
  view.ty = cy - w.y * view.s;
  requestDraw();
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

// ---------- pointer ----------
// ペン = 常に書く。指 = 常に操作（2本指でピンチ/移動、タップで選択）。
// マウス = 書く（中ボタン or Space+ドラッグで移動）。選択中は、枠の中や四隅をどの入力でも掴める。

const touches = new Map(); // pointerId -> {x, y}
let pinch = null;
let pan = null;
let spaceDown = false;

function point(e, prev) {
  let p = 0.5;
  if (e.pointerType === 'pen' && e.pressure > 0) {
    p = prev ? prev.p * 0.6 + e.pressure * 0.4 : e.pressure; // 筆圧のガタつきをならす
  }
  const w = toWorld(e.clientX, e.clientY);
  return { x: w.x, y: w.y, p };
}

function capture(id) {
  try { live.setPointerCapture(id); } catch (_) { /* ignore */ }
}

function endTouches() {
  touches.clear();
  pinch = null;
  touchTap = null;
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
  requestDraw();
}

function eraseSeg(a, b) {
  let changed = false;
  const out = [];
  for (const it of items) {
    const pieces = it.type === 'stroke' ? G.eraseStroke(it, a, b, erasing.r) : null;
    if (!pieces) { out.push(it); continue; }
    changed = true;
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
    if (now - lastPen < PALM_REJECT_MS || activeId !== null) return; // 手のひら / ペンやマウスで操作中
    e.preventDefault();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capture(e.pointerId);
    if (touches.size === 1) {
      touchTap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: now, moved: false };
      const hit = selHit(e.clientX, e.clientY, 22);
      if (hit) startXform(e.pointerId, hit, wp);
    } else {
      touchTap = null;
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
    requestDraw();
    return;
  }
  // 太さは画面上で一定。ワールド座標では表示倍率で割った値になる
  cur = { id: nextId++, type: 'stroke', tool, color: state.color, size: state.size / view.s, pts: [point(e)] };
  strokeT0 = now;
  if (tool === 'hl') clearCtx(lctx);
  if (e.pointerType === 'pen') startHold(e.pointerId, e.clientX, e.clientY);
}

function onMove(e) {
  if (e.pointerType === 'touch') {
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
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
    requestDraw();
    return;
  }
  if (e.pointerId !== activeId) return;
  e.preventDefault();
  if (xform) { updateXform(e); return; }
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (!evs.length) evs = [e];
  if (lasso) {
    for (const ev of evs) lasso.pts.push(toWorld(ev.clientX, ev.clientY));
    requestDraw();
    return;
  }
  if (erasing) {
    for (const ev of evs) {
      const w = toWorld(ev.clientX, ev.clientY);
      eraseSeg(erasing.last, w);
      erasing.last = w;
    }
    erasing.screen = { x: e.clientX, y: e.clientY };
    requestDraw();
    return;
  }
  if (!cur) return;
  const ctx = cur.tool === 'hl' ? lctx : ictx;
  prep(ctx, cur, devT());
  const minStep = 0.4 / view.s;
  for (const ev of evs) {
    const prev = cur.pts[cur.pts.length - 1];
    const pt = point(ev, prev);
    if (Math.hypot(pt.x - prev.x, pt.y - prev.y) < minStep) { prev.p = pt.p; continue; }
    cur.pts.push(pt);
    drawSeg(ctx, cur, cur.pts.length - 1);
  }
}

function onUp(e) {
  const cancelled = e.type === 'pointercancel';
  if (e.pointerType === 'touch') {
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
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
  cur = null;
  const dropTap = swallowTap && isTap(s);
  swallowTap = false;
  if (!cancelled && !dropTap) finishStroke(s);
  drawInk(); // ベクターから描き直して確定（マーカーは半透明で焼き込まれる）
  requestDraw();
}

// 書き終えた線を確定する。ペンで書いた線は、先にインクジェスチャーかどうかを調べる
//  - ぐしゃぐしゃ（スクラッチアウト）: 下にある線や画像を消す
//  - 囲む（投げ縄）: 中にあるものを選択する
// どちらも対象が無ければ普通の線として残す。撮った画面そのものは対象にしない
function finishStroke(s) {
  const t1 = performance.now();
  if (s.tool === 'pen') {
    const px = 1 / view.s;
    const speed = G.pathLength(s.pts) * view.s / Math.max(1, t1 - strokeT0);
    if (G.isScratch(s.pts, px)) {
      const hit = speed >= SCRATCH_SPEED
        ? new Set(G.scratchTargets(visibleItems(), s, px, gestureSelectable).map((it) => it.id)) : new Set();
      if (hit.size) {
        items = items.filter((it) => !hit.has(it.id));
        commit();
        return;
      }
    } else if (G.isLoop(s.pts, px)) {
      const old = (it) => gestureSelectable(it) && it.t <= strokeT0 - LASSO_MIN_AGE;
      const ids = G.lassoTargets(visibleItems(), s.pts, 0.8, old).map((it) => it.id);
      if (ids.length) {
        setSel(ids);
        pendingLasso = s;
        $('selKeep').hidden = false;
        return;
      }
    }
  }
  s.t = t1;
  items = [...items, s];
  commit();
}

live.addEventListener('pointerdown', onDown);
live.addEventListener('pointermove', onMove);
live.addEventListener('pointerup', onUp);
live.addEventListener('pointercancel', onUp);
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Ctrl+ホイール（タッチパッドのピンチ）= 拡大縮小、ホイール = 移動
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (mode !== 'freeze') return;
  if (e.ctrlKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.006));
  } else {
    view.tx -= e.shiftKey ? e.deltaY : e.deltaX;
    view.ty -= e.shiftKey ? 0 : e.deltaY;
    requestDraw();
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
async function save(kind) {
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
      if (!b) { toast('保存する内容がありません'); return; }
      const m = 16;
      const box = { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
      out = renderBox(box, exportScale(box));
    } else {
      const box = { x: -view.tx / view.s, y: -view.ty / view.s, w: window.innerWidth / view.s, h: window.innerHeight / view.s };
      out = renderBox(box, dpr * view.s);
    }
    const { file, copied } = await api.save(out.toDataURL('image/png'));
    toast((copied ? '保存してクリップボードにコピーしました　' : '保存しました（コピーは失敗）　') + file);
  } catch (err) {
    toast('保存に失敗しました: ' + err.message);
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

function hideSaveMenu() { $('saveMenu').classList.remove('show'); }

// 保存メニューを「保存」ボタンの位置に出す（ツールバーが折り返していても合うように）
function toggleSaveMenu() {
  const m = $('saveMenu'), b = $('save');
  m.style.left = b.offsetLeft + 'px';
  m.classList.toggle('show');
}

function updateButtons() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === state.tool));
  document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === state.size));
  live.style.cursor = state.tool === 'select' ? 'default' : 'crosshair';
  $('undo').disabled = hi === 0 && !pendingLasso;
  $('redo').disabled = hi >= history.length - 1;
}

$('selMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'selDelete') deleteSel();
  else if (b.id === 'selCopy') copySel();
  else if (b.id === 'selKeep') keepLasso();
  updateButtons();
});

$('bar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id !== 'save') hideSaveMenu();
  if (b.dataset.tool) { state.tool = b.dataset.tool; if (state.tool !== 'select') clearSel(); }
  else if (b.dataset.color) { state.color = b.dataset.color; if (state.tool === 'eraser') state.tool = 'pen'; }
  else if (b.dataset.size) state.size = Number(b.dataset.size);
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
  else if (b.id === 'save') { if (mode === 'freeze') toggleSaveMenu(); else save('view'); }
  else if (b.id === 'saveView') save('view');
  else if (b.id === 'saveAll') save('all');
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
  else if (e.ctrlKey && k === 'c') copySel();
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
window.__ink = { get items() { return items; }, get mode() { return mode; }, get selection() { return sel; }, view, state };
