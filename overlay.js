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

function paintImages(ctx, t, outline) {
  setT(ctx, t);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingQuality = 'high';
  for (const it of items) {
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

function drawUi() {
  clearCtx(uctx);
  if (erasing && erasing.screen) {
    uctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    uctx.beginPath();
    uctx.arc(erasing.screen.x, erasing.screen.y, state.size * 3, 0, Math.PI * 2);
    uctx.lineWidth = 1;
    uctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    uctx.stroke();
  }
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

// ---------- pointer ----------
// ペン = 常に書く。指 = 常に操作（2本指でピンチ/移動）。マウス = 書く（中ボタン or Space+ドラッグで移動）。

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

function onDown(e) {
  const now = performance.now();
  hideSaveMenu();
  if (e.pointerType === 'touch') {
    if (now - lastPen < PALM_REJECT_MS || cur || erasing) return; // 手のひら
    e.preventDefault();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capture(e.pointerId);
    if (touches.size === 2) startPinch();
    return;
  }
  if (e.pointerType === 'pen') { lastPen = now; endTouches(); }
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

  let tool = state.tool;
  // ペンの尻（消しゴム）側、またはサイドボタンを押しながら → 消しゴム
  if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) || (e.buttons & 2))) tool = 'eraser';

  activeId = e.pointerId;
  capture(e.pointerId);
  if (tool === 'eraser') {
    const w = toWorld(e.clientX, e.clientY);
    erasing = { last: w, r: state.size * 3 / view.s, screen: { x: e.clientX, y: e.clientY } };
    eraseSeg(w, w);
    requestDraw();
    return;
  }
  // 太さは画面上で一定。ワールド座標では表示倍率で割った値になる
  cur = { id: nextId++, type: 'stroke', tool, color: state.color, size: state.size / view.s, pts: [point(e)] };
  if (tool === 'hl') clearCtx(lctx);
}

function onMove(e) {
  if (e.pointerType === 'touch') {
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    if (pinch && touches.size >= 2) updatePinch();
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
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (!evs.length) evs = [e];
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
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    return;
  }
  if (pan && e.pointerId === pan.id) { pan = null; return; }
  if (e.pointerId !== activeId) return;
  if (e.pointerType === 'pen') lastPen = performance.now();
  activeId = null;
  if (erasing) {
    erasing = null;
    commit();
    requestDraw();
    return;
  }
  if (!cur) return;
  const s = cur;
  cur = null;
  items = [...items, s];
  commit();
  drawInk(); // ベクターから描き直して確定（マーカーは半透明で焼き込まれる）
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

function undo() {
  if (cur || erasing || hi === 0) return;
  items = history[--hi];
  drawAll();
  updateButtons();
}

function redo() {
  if (cur || erasing || hi >= history.length - 1) return;
  items = history[++hi];
  drawAll();
  updateButtons();
}

function clearAll() {
  if (cur || erasing || !items.some((it) => it.type === 'stroke')) return;
  items = items.filter((it) => it.type !== 'stroke');
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
function exportScale(box) {
  let k = dpr;
  for (const it of items) if (it.type === 'image') k = Math.max(k, it.img.naturalWidth / it.w);
  k = Math.min(4, Math.max(1, k));
  return Math.min(k, Math.sqrt(MAX_EXPORT_PIXELS / (box.w * box.h)));
}

// ワールド座標の範囲 box を倍率 k で1枚の画像にする
function renderBox(box, k) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(box.w * k));
  out.height = Math.max(1, Math.round(box.h * k));
  const x = out.getContext('2d');
  const t = { k, ox: -box.x * k, oy: -box.y * k };
  x.fillStyle = '#fff';
  x.fillRect(0, 0, out.width, out.height);
  paintImages(x, t, false);
  paintStrokes(x, strokesOf(items), t);
  return out;
}

let saving = false;
// kind: 'view' = 今見えている範囲、'all' = 書き込みと画像を含む全体
async function save(kind) {
  hideSaveMenu();
  if (saving || cur || erasing) return;
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

function updateButtons() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === state.tool));
  document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === state.size));
  $('undo').disabled = hi === 0;
  $('redo').disabled = hi >= history.length - 1;
}

$('bar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id !== 'save') hideSaveMenu();
  if (b.dataset.tool) state.tool = b.dataset.tool;
  else if (b.dataset.color) { state.color = b.dataset.color; if (state.tool === 'eraser') state.tool = 'pen'; }
  else if (b.dataset.size) state.size = Number(b.dataset.size);
  else if (b.id === 'undo') undo();
  else if (b.id === 'redo') redo();
  else if (b.id === 'clear') clearAll();
  else if (b.id === 'fit') fitAll();
  else if (b.id === 'zoom') resetView();
  else if (b.id === 'toFreeze') api.switchMode('freeze');
  else if (b.id === 'toLive') api.switchMode('live');
  else if (b.id === 'pass') api.setPass(true);
  else if (b.id === 'save') { if (mode === 'freeze') $('saveMenu').classList.toggle('show'); else save('view'); }
  else if (b.id === 'saveView') save('view');
  else if (b.id === 'saveAll') save('all');
  else if (b.id === 'flip') $('bar').classList.toggle('bottom');
  else if (b.id === 'close') api.close();
  updateButtons();
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.key === ' ') { spaceDown = true; return; }
  if (e.key === 'Escape') api.close();
  else if (e.ctrlKey && k === 'z' && !e.shiftKey) undo();
  else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
  else if (e.ctrlKey && k === 's') { e.preventDefault(); save(e.shiftKey && mode === 'freeze' ? 'all' : 'view'); }
  else if (e.ctrlKey && k === '0') { if (mode === 'freeze') resetView(); }
  else if (e.ctrlKey && k === '1') { if (mode === 'freeze') fitAll(); }
  else if (e.ctrlKey || e.altKey) return;
  else if (k === 'p') state.tool = 'pen';
  else if (k === 'h') state.tool = 'hl';
  else if (k === 'e') state.tool = 'eraser';
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
window.__ink = { get items() { return items; }, get mode() { return mode; }, view, state };
