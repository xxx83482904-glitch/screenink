/* global api */
const $ = (id) => document.getElementById(id);
const bg = $('bg'), ink = $('ink'), live = $('live');
const bctx = bg.getContext('2d');
const ictx = ink.getContext('2d');
const lctx = live.getContext('2d');

const HL_ALPHA = 0.4;          // マーカーの濃さ（#live の CSS opacity と同じ値）
const PALM_REJECT_MS = 1500;   // ペン使用中〜直後は指のタッチを無視

let dpr = 1;
let mode = 'hidden';
let bgImg = null;
let strokes = [];   // {tool:'pen'|'hl'|'eraser'|'clear', color, size, pts:[{x,y,p}]}
let redoStack = [];
let cur = null;
let activeId = null;
let lastPen = -1e9;
const state = { tool: 'pen', color: '#ff3b30', size: 4 };

// ---------- canvas ----------

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  for (const c of [bg, ink, live]) { c.width = w; c.height = h; }
  drawBg();
  redraw();
}

function drawBg() {
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.clearRect(0, 0, bg.width, bg.height);
  if (mode === 'freeze' && bgImg) bctx.drawImage(bgImg, 0, 0, bg.width, bg.height);
}

function clearCtx(ctx) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

function prep(ctx, s) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ctx.fillStyle = s.tool === 'eraser' ? '#000' : s.color;
}

function widthOf(s, p) {
  if (s.tool === 'hl') return s.size * 5;
  if (s.tool === 'eraser') return s.size * 6;
  return s.size * (0.4 + 1.2 * p); // 筆圧 0.5 でちょうど指定の太さ
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
  ctx.lineWidth = widthOf(s, (a.p + b.p) / 2);
  ctx.stroke();
}

function drawTail(ctx, s) {
  const n = s.pts.length;
  const b = s.pts[n - 1];
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, widthOf(s, b.p) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const m = mid(s.pts[n - 2], b);
  ctx.beginPath();
  ctx.moveTo(m.x, m.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineWidth = widthOf(s, b.p);
  ctx.stroke();
}

function drawStroke(ctx, s) {
  prep(ctx, s);
  for (let i = 1; i < s.pts.length; i++) drawSeg(ctx, s, i);
  drawTail(ctx, s);
}

// マーカーは #live に不透明で描き、まとめて半透明で #ink に焼き込む（重なりで濃くならない）
function bakeLive() {
  ictx.save();
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.globalCompositeOperation = 'source-over';
  ictx.globalAlpha = HL_ALPHA;
  ictx.drawImage(live, 0, 0);
  ictx.restore();
  clearCtx(lctx);
}

function renderStroke(s) {
  if (s.tool === 'clear') { clearCtx(ictx); return; }
  if (s.tool === 'hl') { clearCtx(lctx); drawStroke(lctx, s); bakeLive(); return; }
  drawStroke(ictx, s);
}

function redraw() {
  clearCtx(ictx);
  clearCtx(lctx);
  let start = 0;
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokes[i].tool === 'clear') { start = i + 1; break; }
  }
  for (let i = start; i < strokes.length; i++) renderStroke(strokes[i]);
}

// ---------- pointer ----------

function point(e, prev) {
  let p = 0.5;
  if (e.pointerType === 'pen' && e.pressure > 0) {
    p = prev ? prev.p * 0.6 + e.pressure * 0.4 : e.pressure; // 筆圧のガタつきをならす
  }
  return { x: e.clientX, y: e.clientY, p };
}

function onDown(e) {
  if (activeId !== null) return;
  const now = performance.now();
  if (e.pointerType === 'pen') lastPen = now;
  if (e.pointerType === 'touch' && now - lastPen < PALM_REJECT_MS) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();

  let tool = state.tool;
  // ペンの尻（消しゴム）側、またはサイドボタンを押しながら → 消しゴム
  if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) || (e.buttons & 2))) tool = 'eraser';

  cur = { tool, color: state.color, size: state.size, pts: [point(e)] };
  activeId = e.pointerId;
  try { live.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  redoStack = [];
  if (tool === 'hl') clearCtx(lctx);
  prep(tool === 'hl' ? lctx : ictx, cur);
}

function onMove(e) {
  if (e.pointerType === 'pen') lastPen = performance.now();
  if (e.pointerId !== activeId || !cur) return;
  e.preventDefault();
  const ctx = cur.tool === 'hl' ? lctx : ictx;
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (!evs.length) evs = [e];
  for (const ev of evs) {
    const prev = cur.pts[cur.pts.length - 1];
    const pt = point(ev, prev);
    if (Math.hypot(pt.x - prev.x, pt.y - prev.y) < 0.4) { prev.p = pt.p; continue; }
    cur.pts.push(pt);
    drawSeg(ctx, cur, cur.pts.length - 1);
  }
}

function onUp(e) {
  if (e.pointerId !== activeId || !cur) return;
  if (e.pointerType === 'pen') lastPen = performance.now();
  drawTail(cur.tool === 'hl' ? lctx : ictx, cur);
  if (cur.tool === 'hl') bakeLive();
  strokes.push(cur);
  cur = null;
  activeId = null;
  updateButtons();
}

live.addEventListener('pointerdown', onDown);
live.addEventListener('pointermove', onMove);
live.addEventListener('pointerup', onUp);
live.addEventListener('pointercancel', onUp);
window.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- actions ----------

function undo() {
  if (cur || !strokes.length) return;
  redoStack.push(strokes.pop());
  redraw();
  updateButtons();
}

function redo() {
  if (cur || !redoStack.length) return;
  const s = redoStack.pop();
  strokes.push(s);
  renderStroke(s);
  updateButtons();
}

function clearAll() {
  if (cur || !strokes.length || strokes[strokes.length - 1].tool === 'clear') return;
  strokes.push({ tool: 'clear' });
  redoStack = [];
  clearCtx(ictx);
  updateButtons();
}

function loadImg(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

let saving = false;
async function save() {
  if (saving || cur) return;
  saving = true;
  try {
    // ライブ時は、今の画面を撮ってから書き込みを重ねる
    const base = mode === 'freeze' ? bg : await loadImg(await api.grabScreen());
    const out = document.createElement('canvas');
    out.width = ink.width;
    out.height = ink.height;
    const x = out.getContext('2d');
    x.drawImage(base, 0, 0, out.width, out.height);
    x.drawImage(ink, 0, 0);
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

function updateButtons() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === state.tool));
  document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === state.size));
  $('undo').disabled = !strokes.length;
  $('redo').disabled = !redoStack.length;
}

$('bar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) state.tool = b.dataset.tool;
  else if (b.dataset.color) { state.color = b.dataset.color; if (state.tool === 'eraser') state.tool = 'pen'; }
  else if (b.dataset.size) state.size = Number(b.dataset.size);
  else if (b.id === 'undo') undo();
  else if (b.id === 'redo') redo();
  else if (b.id === 'clear') clearAll();
  else if (b.id === 'toFreeze') api.switchMode('freeze');
  else if (b.id === 'toLive') api.switchMode('live');
  else if (b.id === 'pass') api.setPass(true);
  else if (b.id === 'save') save();
  else if (b.id === 'flip') $('bar').classList.toggle('bottom');
  else if (b.id === 'close') api.close();
  updateButtons();
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') api.close();
  else if (e.ctrlKey && k === 'z' && !e.shiftKey) undo();
  else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
  else if (e.ctrlKey && k === 's') { e.preventDefault(); save(); }
  else if (k === 'p') state.tool = 'pen';
  else if (k === 'h') state.tool = 'hl';
  else if (k === 'e') state.tool = 'eraser';
  updateButtons();
});

// ---------- from main ----------

api.onMode(async ({ mode: m, image, keepInk }) => {
  mode = m;
  document.body.dataset.mode = m;
  if (!keepInk) { strokes = []; redoStack = []; }
  cur = null;
  activeId = null;
  bgImg = null;
  if (image) {
    try { bgImg = await loadImg(image); } catch (_) { /* 背景なしで続行 */ }
  }
  resize();
  updateButtons();
  api.ready();
});

api.onPass((on) => { document.body.dataset.pass = on ? '1' : '0'; });

window.addEventListener('resize', resize);
resize();
updateButtons();
