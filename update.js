/* global api */
const $ = (id) => document.getElementById(id);

// state: 'idle' | 'dev' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
function render(s) {
  $('ver').textContent = '現在のバージョン ' + s.current;
  $('msg').textContent = {
    idle: '「アップデートを確認」を押すと、新しいバージョンがあるか調べます。',
    dev: '開発用に起動しているため確認できません。\nインストールした ScreenInk で使えます。',
    checking: '新しいバージョンを確認しています…',
    none: '最新のバージョンです。',
    available: `新しいバージョン ${s.version} があります。`,
    downloading: `バージョン ${s.version} をダウンロードしています… ${s.percent}%`,
    ready: `バージョン ${s.version} の準備ができました。\n再起動すると更新されます。`,
    error: '確認できませんでした。\n' + s.message,
  }[s.state] || '';
  $('bar').classList.toggle('show', s.state === 'downloading');
  $('fill').style.width = (s.state === 'downloading' ? s.percent : 0) + '%';
  $('check').hidden = !['idle', 'none', 'error'].includes(s.state);
  $('download').hidden = s.state !== 'available';
  $('install').hidden = s.state !== 'ready';
  $('close').textContent = s.state === 'available' || s.state === 'ready' ? 'あとで' : '閉じる';
}

$('check').addEventListener('click', () => api.updateCheck());
$('download').addEventListener('click', () => api.updateDownload());
$('install').addEventListener('click', () => api.updateInstall());
$('close').addEventListener('click', () => window.close());

api.onUpdateState(render);
api.updateGet().then(render);
