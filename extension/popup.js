'use strict';
const $ = (s) => document.querySelector(s);
let tab = null;

// --- ASCII çerçeve (uygulamadaki ile aynı yöntem) ---
let cw = 7.2;
const lh = 18;
function measure() {
  const s = document.createElement('span');
  s.textContent = 'M'.repeat(50);
  s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  document.body.appendChild(s);
  cw = s.getBoundingClientRect().width / 50;
  s.remove();
}
function drawBox(box) {
  let pre = box.querySelector(':scope > .frame');
  if (!pre) { pre = document.createElement('pre'); pre.className = 'frame'; box.prepend(pre); }
  const inner = box.querySelector(':scope > .in');
  box.style.height = `${(Math.ceil((inner.offsetHeight - 0.5) / lh) + 2) * lh}px`;
  const cols = Math.floor((box.clientWidth + 0.5) / cw);
  const rows = Math.round(box.clientHeight / lh);
  const t = `[ ${box.dataset.title} ]`;
  const top = '+-' + t + '-'.repeat(Math.max(0, cols - t.length - 3)) + '+';
  const mid = '|' + ' '.repeat(cols - 2) + '|';
  pre.textContent = [top, ...Array(rows - 2).fill(mid), '+' + '-'.repeat(cols - 2) + '+'].join('\n');
}
const drawAll = () => document.querySelectorAll('.box').forEach(drawBox);
const ro = new ResizeObserver(drawAll);

const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const TYPE = { hls: 'HLS', dash: 'DASH', video: 'VID', audio: 'SES' };
function size(n) { return n > 0 ? (n / 1048576).toFixed(1) + 'M' : ''; }

function renderMedia(list) {
  const el = $('#media');
  el.replaceChildren();
  if (!list.length) {
    el.innerHTML = '<div class="empty">  (henüz yok: videoyu oynatınca görünür)</div>';
    return;
  }
  for (const m of list.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'm';
    const name = decodeURIComponent((m.url.split('?')[0].split('/').pop() || m.url)).slice(0, 60);
    row.innerHTML = '<span class="t"></span><span class="u"></span><button class="b">[ indir ]</button>';
    row.querySelector('.t').textContent = TYPE[m.type] || m.type;
    row.querySelector('.u').textContent = `${name} ${size(m.size)}`;
    row.querySelector('.u').title = m.url;
    row.querySelector('button').onclick = async (e) => {
      const b = e.target;
      b.textContent = '[ ... ]';
      // Doğrudan dosyalar (mp4/mp3) hızlı çok parçalı motorla, akışlar (m3u8/mpd) yt-dlp ile.
      const r = await send({ type: 'grabStream', tabId: tab.id, url: m.url, direct: m.type === 'video' || m.type === 'audio' });
      b.textContent = r && r.ok ? '[ ok ]' : '[ ! ]';
    };
    el.appendChild(row);
  }
}

(async () => {
  await document.fonts.load('12px "SDM Mono"').catch(() => {});
  measure();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const st = await send({ type: 'state', tabId: tab && tab.id });
  $('#conn').className = st.online ? 'ok' : 'bad';
  $('#conn').textContent = st.online ? '[*] SDM bağlı' : '[!] SDM çalışmıyor';
  $('#grabPage').disabled = !st.online || !/^https?:/.test((tab && tab.url) || '');
  renderMedia(st.media || []);
  $('#enabled').checked = st.settings.enabled;
  $('#minSize').value = st.settings.minSizeMB;
  $('#exts').value = st.settings.exts;
  $('#excluded').value = st.settings.excluded;
  drawAll();
  document.querySelectorAll('.box .in').forEach((el) => ro.observe(el));
})();

$('#grabPage').onclick = async () => {
  const b = $('#grabPage');
  b.textContent = '[ ... gönderiliyor ]';
  const r = await send({ type: 'grabVideo', tabId: tab.id, frameUrl: tab.url, title: tab.title });
  b.textContent = r && r.ok ? "[ ok SDM'ye gönderildi ]" : `[ ! ${(r && r.error) || 'hata'} ]`;
};
$('#enabled').onchange = () => send({ type: 'saveSettings', settings: { enabled: $('#enabled').checked } });
$('#save').onclick = async () => {
  await send({ type: 'saveSettings', settings: {
    enabled: $('#enabled').checked,
    minSizeMB: Math.max(0, +$('#minSize').value || 0),
    exts: $('#exts').value.toLowerCase().split(/[\s,]+/).filter(Boolean).join(' '),
    excluded: $('#excluded').value.toLowerCase().split(/[\s,]+/).filter(Boolean).join(' '),
  } });
  $('#save').textContent = '[ ok kaydedildi ]';
  setTimeout(() => { $('#save').textContent = '[ kaydet ]'; }, 1500);
};
