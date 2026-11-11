/* global api */
const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);
on('freeze', () => api.startFreeze());
on('live', () => api.startLive());
api.onLauncherUpdate((has) => { document.body.dataset.update = has ? '1' : '0'; });
on('back', () => api.startLive());          // 操作モード中は「書く」に戻る
on('snap', () => api.switchMode('freeze')); // 書き込みを残したまま静止へ
on('close', () => api.close());
on('shoot', () => api.addShoot());
on('cancel', () => api.addCancel());
api.onLauncherState((s) => { document.body.dataset.state = s; });
