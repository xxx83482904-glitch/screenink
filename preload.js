const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // overlay
  onMode: (cb) => ipcRenderer.on('set-mode', (_e, payload) => cb(payload)),
  onPass: (cb) => ipcRenderer.on('pass', (_e, on) => cb(on)),
  ready: () => ipcRenderer.send('overlay-ready'),
  grabScreen: () => ipcRenderer.invoke('grab-screen'),
  save: (dataUrl) => ipcRenderer.invoke('save-png', dataUrl),
  switchMode: (mode) => ipcRenderer.send('switch-mode', mode),
  setPass: (on) => ipcRenderer.send('set-pass', on),
  close: () => ipcRenderer.send('close-overlay'),
  copyPng: (dataUrl) => ipcRenderer.invoke('copy-png', dataUrl),
  readClipboardImage: () => ipcRenderer.invoke('read-clipboard-image'),
  addCapture: () => ipcRenderer.send('add-capture'),
  onAddImage: (cb) => ipcRenderer.on('add-image', (_e, payload) => cb(payload)),
  // launcher
  onLauncherState: (cb) => ipcRenderer.on('launcher-state', (_e, s) => cb(s)),
  startFreeze: () => ipcRenderer.send('start-freeze'),
  startLive: () => ipcRenderer.send('start-live'),
  openFolder: () => ipcRenderer.send('open-folder'),
  quit: () => ipcRenderer.send('quit-app'),
  addShoot: () => ipcRenderer.send('add-shoot'),
  addCancel: () => ipcRenderer.send('add-cancel'),
  onLauncherUpdate: (cb) => ipcRenderer.on('launcher-update', (_e, on) => cb(on)),
  // update
  updateOpen: () => ipcRenderer.send('update-open'),
  updateCheck: () => ipcRenderer.send('update-check'),
  updateDownload: () => ipcRenderer.send('update-download'),
  updateInstall: () => ipcRenderer.send('update-install'),
  updateGet: () => ipcRenderer.invoke('update-get'),
  onUpdateState: (cb) => ipcRenderer.on('update-state', (_e, s) => cb(s)),
});
