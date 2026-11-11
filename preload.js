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
  // launcher
  onLauncherState: (cb) => ipcRenderer.on('launcher-state', (_e, s) => cb(s)),
  startFreeze: () => ipcRenderer.send('start-freeze'),
  startLive: () => ipcRenderer.send('start-live'),
  openFolder: () => ipcRenderer.send('open-folder'),
  quit: () => ipcRenderer.send('quit-app'),
});
