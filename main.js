// ScreenInk — 画面をキャプチャして、そのままペンで書き込むアプリ
const {
  app, BrowserWindow, globalShortcut, desktopCapturer, screen, ipcMain,
  Tray, Menu, nativeImage, clipboard, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ショートカット（変えたい場合はここを書き換える）
const KEYS = {
  freeze: 'Control+Alt+S', // 画面を静止画にして書く
  live: 'Control+Alt+D',   // 動いている画面に重ねて書く
  pass: 'Control+Alt+A',   // 書く ⇔ 下のアプリを操作 の切り替え
  close: 'Control+Alt+X',  // 閉じる
};
const HIDE_WAIT_MS = 220; // 自分のウィンドウが画面から消えるのを待つ時間

let overlay = null;
let launcher = null;
let tray = null;
let mode = 'hidden'; // 'hidden' | 'freeze' | 'live'
let passthrough = false;
let display = null;  // いま書き込み中のディスプレイ
let busy = false;
let quitting = false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const saveDir = () => path.join(app.getPath('pictures'), 'ScreenInk');
const preload = path.join(__dirname, 'preload.js');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 2回目の起動（例：Surfaceペンのボタンにこのアプリを割り当てた場合）は即キャプチャ
  app.on('second-instance', () => startFreeze());
  app.whenReady().then(init);
}

function init() {
  app.setAppUserModelId('jp.the-triangle.screenink');
  createOverlay();
  createLauncher();
  createTray();
  globalShortcut.register(KEYS.freeze, () => startFreeze());
  globalShortcut.register(KEYS.live, () => startLive());
  globalShortcut.register(KEYS.pass, () => { if (mode === 'live') setPass(!passthrough); });
  globalShortcut.register(KEYS.close, () => closeOverlay());
  showLauncher('idle');
}

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* トレイ常駐 */ });

// ---------- windows ----------

function createOverlay() {
  overlay = new BrowserWindow({
    show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload, contextIsolation: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.on('close', (e) => { if (!quitting) { e.preventDefault(); closeOverlay(); } });
}

function createLauncher() {
  launcher = new BrowserWindow({
    width: 64, height: 252, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, focusable: false,
    webPreferences: { preload, contextIsolation: true },
  });
  launcher.setAlwaysOnTop(true, 'screen-saver');
  launcher.loadFile(path.join(__dirname, 'launcher.html'));
  launcher.on('close', (e) => { if (!quitting) e.preventDefault(); });
}

function showLauncher(state) {
  const d = (state === 'pass' && display) || screen.getPrimaryDisplay();
  const wa = d.workArea;
  const [w, h] = launcher.getSize();
  // 初回と、表示先ディスプレイが変わったときだけ右端中央へ。あとはユーザーが動かした位置のまま
  if (launcher._displayId !== d.id) {
    launcher.setPosition(wa.x + wa.width - w - 12, Math.round(wa.y + (wa.height - h) / 2));
    launcher._displayId = d.id;
  }
  launcher.webContents.send('launcher-state', state);
  launcher.showInactive();
  launcher.moveTop();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('ScreenInk');
  const menu = Menu.buildFromTemplate([
    { label: `キャプチャして書く (${KEYS.freeze.replace('Control', 'Ctrl')})`, click: () => startFreeze() },
    { label: `画面に重ねて書く (${KEYS.live.replace('Control', 'Ctrl')})`, click: () => startLive() },
    { type: 'separator' },
    { label: '保存フォルダを開く', click: openFolder },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => tray.popUpContextMenu());
}

// ---------- capture ----------

function targetDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function captureDisplay(d) {
  const size = {
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src) throw new Error('画面を取得できませんでした');
  return src.thumbnail;
}

// 自分のウィンドウを隠してから画面を撮る
async function captureClean(d) {
  const overlayWasVisible = overlay.isVisible();
  overlay.hide();
  launcher.hide();
  await delay(HIDE_WAIT_MS);
  try {
    return await captureDisplay(d);
  } finally {
    if (overlayWasVisible) { overlay.show(); overlay.focus(); }
  }
}

// ---------- modes ----------

function sendMode(payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    ipcMain.once('overlay-ready', () => { clearTimeout(timer); resolve(); });
    overlay.webContents.send('set-mode', payload);
  });
}

async function presentOverlay(payload) {
  overlay.setBounds(display.bounds);
  await sendMode(payload);
  setPass(false, true);
  launcher.hide();
  overlay.show();
  overlay.setBounds(display.bounds); // 倍率の違うモニター間の移動でずれることがあるため再設定
  overlay.moveTop();
  overlay.focus();
}

async function startFreeze(keepInk = false) {
  if (busy) return;
  busy = true;
  try {
    if (mode === 'hidden') display = targetDisplay();
    const wasVisible = overlay.isVisible();
    if (wasVisible) overlay.hide();
    launcher.hide();
    await delay(HIDE_WAIT_MS);
    const img = await captureDisplay(display);
    mode = 'freeze';
    await presentOverlay({ mode, image: img.toDataURL(), keepInk });
  } catch (err) {
    console.error(err);
    if (mode === 'hidden') showLauncher('idle'); else overlay.show();
  } finally {
    busy = false;
  }
}

async function startLive(keepInk = false) {
  if (busy) return;
  busy = true;
  try {
    if (mode === 'hidden') display = targetDisplay();
    mode = 'live';
    await presentOverlay({ mode, image: null, keepInk });
  } finally {
    busy = false;
  }
}

// 書く ⇔ 下のアプリを操作（ライブ時のみ）。操作中は書き込みを表示したままクリックを素通しする
function setPass(on, silent = false) {
  passthrough = on;
  overlay.setIgnoreMouseEvents(on);
  overlay.webContents.send('pass', on);
  if (on) {
    showLauncher('pass');
  } else if (!silent) {
    launcher.hide();
    overlay.focus();
  }
}

function closeOverlay() {
  if (mode === 'hidden') return;
  mode = 'hidden';
  passthrough = false;
  overlay.setIgnoreMouseEvents(false);
  overlay.hide();
  overlay.webContents.send('set-mode', { mode: 'hidden', image: null, keepInk: false });
  showLauncher('idle');
}

function openFolder() {
  fs.mkdirSync(saveDir(), { recursive: true });
  shell.openPath(saveDir());
}

// ---------- ipc ----------

ipcMain.on('start-freeze', () => startFreeze());
ipcMain.on('start-live', () => {
  if (mode === 'live' && passthrough) setPass(false); // ランチャーの「書く」に戻る
  else startLive();
});
ipcMain.on('switch-mode', (_e, m) => (m === 'freeze' ? startFreeze(true) : startLive(true)));
ipcMain.on('set-pass', (_e, on) => { if (mode === 'live') setPass(!!on); });
ipcMain.on('close-overlay', () => closeOverlay());
ipcMain.on('open-folder', openFolder);
ipcMain.on('quit-app', () => app.quit());

ipcMain.handle('grab-screen', async () => (await captureClean(display)).toDataURL());

ipcMain.handle('save-png', async (_e, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(img);
  const t = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `ScreenInk_${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}_` +
    `${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}.png`;
  fs.mkdirSync(saveDir(), { recursive: true });
  const file = path.join(saveDir(), name);
  await fs.promises.writeFile(file, img.toPNG());
  return file;
});
