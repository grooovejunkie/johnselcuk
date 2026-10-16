'use strict';
/* global sdm, ASCII */
const $ = (s) => document.querySelector(s);
const items = new Map();
const cards = new Map();
let filter = 'all';
let query = '';
let settings = {};
let tick = 0;
const speedHistory = new Array(120).fill(0);

if (sdm.platform === 'darwin') document.body.classList.add('mac');

// ---------- biçimlendirme ----------
function bytes(n) {
  if (!(n >= 0)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${u[i]}`;
}
function clock(s) {
  if (s == null || !isFinite(s)) return '--:--';
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}
const ext = (name) => ((name || '').match(/\.([a-z0-9]{1,5})$/i) || [, ''])[1].toLowerCase();
const SPIN = ['|', '/', '-', '\\'];
const STATUS = { queued: 'SIRADA', probing: 'BAĞLANIYOR', downloading: 'İNDİRİLİYOR', paused: 'DURAKLATILDI', completed: 'TAMAM', error: 'HATA' };
const TAG = { Video: 'VİDEO', Müzik: 'MÜZİK', Arşiv: 'ARŞİV', Belgeler: 'BELGE', Programlar: 'PROGRAM', Resimler: 'RESİM', Diğer: 'DOSYA' };

function toast(msg) {
  const t = $('#toast');
  const line = '-'.repeat(msg.length + 2);
  t.textContent = `+${line}+\n| ${msg} |\n+${line}+`;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------- liste ----------
function matchesFilter(d, f) {
  if (f === 'all') return true;
  if (f === 'active') return ['downloading', 'probing', 'queued'].includes(d.status);
  if (f === 'completed') return d.status === 'completed';
  if (f === 'paused') return d.status === 'paused' || d.status === 'error';
  if (f.startsWith('cat:')) return d.category === f.slice(4);
  return true;
}
const matches = (d) => (!query || `${d.filename} ${d.url}`.toLowerCase().includes(query)) && matchesFilter(d, filter);

function buildCard(d) {
  const el = document.createElement('div');
  el.className = 'card box';
  el.innerHTML = '<div class="in"><div class="name"></div><div class="barline"></div><div class="meta"></div><div class="acts"></div></div>';
  el.addEventListener('dblclick', () => {
    const cur = items.get(d.id);
    if (cur.status === 'completed') sdm.openFile(cur.savePath);
  });
  el.querySelector('.acts').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const cur = items.get(d.id);
    const a = b.dataset.a;
    if (a === 'pause') sdm.pause(d.id);
    if (a === 'resume') sdm.resume(d.id);
    if (a === 'open') sdm.openFile(cur.savePath);
    if (a === 'folder') sdm.showInFolder(cur.savePath);
    if (a === 'copy') { navigator.clipboard.writeText(cur.pageUrl || cur.url); toast('adres kopyalandı'); }
    if (a === 'remove') {
      const del = cur.status === 'completed' && e.shiftKey;
      sdm.remove(d.id, del);
      if (del) toast('dosya diskten de silindi');
    }
  });
  ASCII.attach(el);
  return el;
}

function renderCard(d) {
  let el = cards.get(d.id);
  if (!el) { el = buildCard(d); cards.set(d.id, el); }
  el.className = `card box ${d.status}`;
  const e = ext(d.filename);
  const title = `${TAG[d.category] || 'DOSYA'}${e ? ' .' + e : ''}`;
  const active = d.status === 'downloading';
  const pct = d.size > 0 ? Math.min(100, (d.downloaded / d.size) * 100) : 0;
  let right = STATUS[d.status] || d.status;
  if (active) right = `${SPIN[tick % 4]} ${right}`;
  if (el.dataset.title !== title || el.dataset.right !== right) {
    el.dataset.title = title;
    el.dataset.right = right;
    ASCII.draw(el);
  }

  const name = el.querySelector('.name');
  if (name.textContent !== d.filename) { name.textContent = d.filename; name.title = d.filename; }

  // ilerleme satırı
  const inner = el.querySelector('.in');
  // clientWidth tam sayıya yuvarlar; yarım piksel taşma satır sonunu '…' ile keser.
  const cols = Math.max(12, Math.floor((inner.getBoundingClientRect().width - 1) / ASCII.cw));
  let barTxt;
  if (d.status === 'completed') {
    barTxt = `-> ${d.savePath || d.filename}`;
  } else {
    const unknown = (d.status === 'probing') || (active && !(d.size > 0));
    const label = unknown ? '   ...' : `${pct.toFixed(1).padStart(5)}%`;
    barTxt = ASCII.bar(cols - label.length - 1, pct, d.segments, { active, indeterminate: unknown, tick }) + ' ' + label;
  }
  const barEl = el.querySelector('.barline');
  if (barEl.textContent !== barTxt) barEl.textContent = barTxt;

  // bilgi satırı
  const sep = '  ::  ';
  const parts = [];
  if (active) {
    parts.push(`${bytes(d.downloaded)}${d.size > 0 ? ' / ' + bytes(d.size) : ''}`);
    parts.push(`${bytes(d.speed)}/s`);
    parts.push(`eta ${clock(d.eta)}`);
    if (d.connections > 1) parts.push(`${d.connections} bağlantı`);
    if (d.note) parts.push(d.note);
  } else if (d.status === 'completed') {
    parts.push(bytes(d.size));
    if (d.completedAt) parts.push(new Date(d.completedAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }));
  } else if (d.status === 'error') {
    parts.push(`! ${d.error}`);
  } else {
    if (d.downloaded > 0) parts.push(`${bytes(d.downloaded)}${d.size > 0 ? ' / ' + bytes(d.size) : ''}`);
    if (d.note) parts.push(d.note);
    if (d.status === 'paused' && d.resumable === false && d.kind === 'http' && d.downloaded > 0) parts.push('! sunucu devam etmeyi desteklemiyor');
    if (!parts.length) parts.push(d.pageUrl || d.url);
  }
  const meta = parts.join(sep);
  const metaEl = el.querySelector('.meta');
  if (metaEl.textContent !== meta) { metaEl.textContent = meta; metaEl.title = d.error || ''; }

  // düğmeler
  const acts = [];
  if (['downloading', 'probing', 'queued'].includes(d.status)) acts.push(['pause', '[ || duraklat ]']);
  if (d.status === 'paused') acts.push(['resume', '[ > sürdür ]']);
  if (d.status === 'error') acts.push(['resume', '[ @ tekrar dene ]']);
  if (d.status === 'completed') acts.push(['open', '[ aç ]']);
  acts.push(['folder', '[ klasör ]']);
  acts.push(['copy', '[ adresi kopyala ]']);
  acts.push(['remove', d.status === 'completed' ? '[ x kaldır ]' : '[ x iptal ]']);
  const key = acts.map((a) => a.join()).join();
  const actsEl = el.querySelector('.acts');
  if (actsEl.dataset.key !== key) {
    actsEl.dataset.key = key;
    actsEl.innerHTML = acts.map(([a, label]) => {
      const title = a === 'remove' && d.status === 'completed' ? ' title="shift+tık: dosyayı da sil"' : '';
      return `<button class="b ${a === 'remove' ? 'danger' : a === 'resume' || a === 'open' ? 'primary' : ''}" data-a="${a}"${title}>${label}</button>`;
    }).join('');
  }
  return el;
}

function renderList() {
  const list = $('#list');
  const visible = [...items.values()].sort((a, b) => b.createdAt - a.createdAt).filter(matches);
  $('#empty').classList.toggle('hidden', visible.length > 0);
  list.classList.toggle('hidden', visible.length === 0);
  const want = visible.map((d) => renderCard(d));
  const cur = [...list.children];
  if (cur.length !== want.length || cur.some((c, i) => c !== want[i])) {
    list.replaceChildren(...want);
    // Kartlar DOM'a girmeden genişlikleri 0'dır; yerleştikten sonra çubukları yeniden hesapla.
    visible.forEach((d) => renderCard(d));
  }
  updateCounts();
}

function updateCounts() {
  const all = [...items.values()];
  for (const b of document.querySelectorAll('[data-count]')) {
    const n = all.filter((d) => matchesFilter(d, b.dataset.count)).length;
    b.textContent = n ? String(n) : '';
  }
  const active = all.filter((d) => d.status === 'downloading').length;
  $('#stSummary').textContent = `${all.length} indirme :: ${active} etkin`;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderList(); });
}

sdm.onUpdate((d) => { items.set(d.id, d); scheduleRender(); });
sdm.onRemoved((id) => { items.delete(id); cards.delete(id); scheduleRender(); });

// Dönen çubuk ve belirsiz ilerleme animasyonu.
setInterval(() => {
  tick++;
  if ([...items.values()].some((d) => d.status === 'downloading' || d.status === 'probing')) scheduleRender();
}, 150);
window.addEventListener('resize', scheduleRender);

// ---------- hız grafiği ----------
function drawSpark() {
  const total = [...items.values()].filter((d) => d.status === 'downloading').reduce((a, d) => a + (d.speed || 0), 0);
  speedHistory.push(total);
  speedHistory.shift();
  $('#totalSpeed').textContent = `${bytes(total)}/s`;
  const pre = $('#spark');
  const cols = Math.max(8, Math.floor((pre.parentElement.getBoundingClientRect().width - 1) / ASCII.cw));
  pre.textContent = ASCII.spark(speedHistory, cols, 4);
}
setInterval(drawSpark, 1000);

// ---------- filtre / arama ----------
document.querySelector('.sidebar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  document.querySelectorAll('.f').forEach((x) => x.classList.toggle('active', x === b));
  filter = b.dataset.filter;
  $('#viewTitle').textContent = `== ${b.firstChild.textContent.trim().toLocaleUpperCase('tr-TR')} ==`;
  renderList();
});
$('#search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderList(); });

$('#btnPauseAll').onclick = () => sdm.pauseAll();
$('#btnResumeAll').onclick = () => sdm.resumeAll();
$('#btnClear').onclick = () => sdm.clearCompleted();
$('#btnFolder').onclick = () => sdm.openDownloads();

// ---------- yeni indirme penceresi ----------
const VIDEO_HOSTS = /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|reddit\.com|soundcloud\.com|bilibili\.com|ok\.ru|vk\.com|puhutv\.com|blutv\.com)/i;
let currentPrompt = null;
let promptDir = null;

function setRadio(group, q) {
  group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.q === q));
}
for (const g of document.querySelectorAll('.radio')) {
  g.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setRadio(g, b.dataset.q); });
}

async function openPrompt(p) {
  currentPrompt = p;
  promptDir = null;
  const isVideo = p.kind === 'video';
  const dlg = $('#dlgPrompt');
  dlg.dataset.title = isVideo ? 'VİDEO İNDİR' : 'YENİ İNDİRME';
  $('#pUrl').value = p.pageUrl || p.url;
  $('#pName').value = p.filename || '';
  $('#pName').placeholder = isVideo ? 'video başlığı kullanılacak' : 'sunucudan öğreniliyor...';
  $('#pNameRow').classList.toggle('hidden', isVideo);
  $('#pQualityRow').classList.toggle('hidden', !isVideo);
  $('#pDir').value = '';
  setRadio($('#pQuality'), p.quality || settings.videoQuality || 'best');
  $('#pInfo').textContent = isVideo ? (p.title ? `> "${p.title}"` : '> yt-dlp ile indirilecek') : '> dosya bilgisi alınıyor...';
  if (!dlg.open) dlg.showModal();
  ASCII.draw(dlg);
  if (!isVideo) {
    const info = await sdm.probe(p.url, p.headers);
    if (currentPrompt !== p) return;
    if (info.error) { $('#pInfo').textContent = `! ${info.error}\n  (yine de deneyebilirsin)`; return; }
    if (!$('#pName').value) $('#pName').value = info.filename || '';
    $('#pInfo').textContent = [
      `> boyut     : ${info.size > 0 ? bytes(info.size) : 'bilinmiyor'}`,
      `> bağlantı  : ${info.resumable ? `${settings.segments} paralel, duraklatılabilir` : '1 (sunucu parçalı indirmeyi desteklemiyor)'}`,
      info.mime ? `> tür       : ${info.mime}` : '',
    ].filter(Boolean).join('\n');
  }
}
$('#pDirBtn').onclick = async () => { const d = await sdm.chooseDir(); if (d) { promptDir = d; $('#pDir').value = d; } };
$('#dlgPrompt').addEventListener('close', async () => {
  const p = currentPrompt;
  currentPrompt = null;
  const v = $('#dlgPrompt').returnValue;
  if (!p) return;
  if (v !== 'start' && v !== 'later') { if (p.fromBridge) sdm.confirmPrompt(p.id, null); return; }
  const overrides = {
    filename: p.kind === 'video' ? undefined : $('#pName').value.trim() || undefined,
    quality: $('#pQuality .active')?.dataset.q,
    dir: promptDir || undefined,
    start: v === 'start',
  };
  if (p.fromBridge) await sdm.confirmPrompt(p.id, overrides);
  else await sdm.add({ ...p, ...overrides });
  toast(v === 'start' ? 'indirme başladı' : 'listeye eklendi');
});
sdm.onPrompt((p) => openPrompt({ ...p, fromBridge: true }));

function startFromUrl(url) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) { toast('geçerli bir http(s) bağlantısı değil'); return; }
  const isVideo = VIDEO_HOSTS.test(new URL(url).hostname);
  openPrompt(isVideo ? { kind: 'video', url, pageUrl: url } : { kind: 'http', url });
  $('#quickUrl').value = '';
}
$('#quickAdd').addEventListener('submit', (e) => { e.preventDefault(); startFromUrl($('#quickUrl').value); });
document.addEventListener('paste', (e) => {
  if (e.target.closest('input, dialog')) return;
  const t = e.clipboardData.getData('text');
  if (/^https?:\/\//i.test(t.trim())) startFromUrl(t);
});

// ---------- ayarlar ----------
async function openSettings() {
  settings = await sdm.getSettings();
  $('#sDir').value = settings.downloadDir;
  $('#sSegments').value = settings.segments;
  $('#sConcurrent').value = settings.maxConcurrent;
  $('#sLimit').value = settings.speedLimit;
  setRadio($('#sQuality'), settings.videoQuality);
  $('#sSort').checked = settings.sortByCategory;
  $('#sAsk').checked = settings.askBeforeDownload;
  $('#sResume').checked = settings.autoResume;
  $('#sLogin').checked = settings.startAtLogin;
  $('#sTray').checked = settings.closeToTray;
  $('#sNotify').checked = settings.notify;
  $('#sYtdlp').value = '...';
  $('#dlgSettings').showModal();
  ASCII.draw($('#dlgSettings'));
  const st = await sdm.status();
  $('#sYtdlp').value = st.ytdlp ? `yt-dlp ${st.ytdlp}` : 'henüz yok (ilk videoda otomatik iner)';
}
$('#btnSettings').onclick = openSettings;
$('#sDirBtn').onclick = async () => { const d = await sdm.chooseDir(); if (d) $('#sDir').value = d; };
$('#sYtdlpBtn').onclick = async () => {
  $('#sYtdlp').value = 'güncelleniyor...';
  const r = await sdm.updateYtdlp();
  $('#sYtdlp').value = r.error ? `! ${r.error}` : `yt-dlp ${r.version}`;
};
$('#dlgSettings').addEventListener('close', async () => {
  if ($('#dlgSettings').returnValue !== 'save') return;
  settings = await sdm.setSettings({
    downloadDir: $('#sDir').value,
    segments: +$('#sSegments').value,
    maxConcurrent: +$('#sConcurrent').value,
    speedLimit: +$('#sLimit').value,
    videoQuality: $('#sQuality .active')?.dataset.q || 'best',
    sortByCategory: $('#sSort').checked,
    askBeforeDownload: $('#sAsk').checked,
    autoResume: $('#sResume').checked,
    startAtLogin: $('#sLogin').checked,
    closeToTray: $('#sTray').checked,
    notify: $('#sNotify').checked,
  });
  toast('ayarlar kaydedildi');
});

// ---------- eklenti / durum ----------
async function refreshStatus() {
  const st = await sdm.status();
  const b = $('#stBridge');
  if (st.bridge.ok) {
    b.innerHTML = st.extensionSeen ? '<span class="ok">[*] eklenti bağlı</span>' : '[ ] eklenti bekleniyor';
  } else {
    b.innerHTML = '<span class="bad"></span>';
    b.firstChild.textContent = `[!] köprü çalışmıyor: ${st.bridge.error}`;
  }
  const led = $('#extDot');
  led.className = `led ${st.extensionSeen ? 'on' : 'off'}`;
  led.textContent = st.extensionSeen ? '*' : '-';
  $('#stYtdlp').textContent = st.ytdlp ? `yt-dlp ${st.ytdlp}` : 'yt-dlp hazırlanıyor...';
  $('#ver').textContent = st.version;
  $('#extDir').value = st.extensionDir;
  $('#extState').textContent = st.extensionSeen
    ? '[*] eklenti şu anda bağlı, tekrar kurmana gerek yok.'
    : '[ ] eklenti henüz bağlanmadı. aşağıdaki adımlar bir kerelik:';
  return st;
}
$('#btnExt').onclick = async () => { await refreshStatus(); $('#dlgExt').showModal(); ASCII.draw($('#dlgExt')); };
$('#extDirBtn').onclick = () => sdm.openExtensionDir();
sdm.onExtension(() => { const l = $('#extDot'); l.className = 'led on'; l.textContent = '*'; });
setInterval(refreshStatus, 5000);

// ---------- açılış ----------
(async () => {
  // Çerçeveler karakter genişliğine göre çizilir; ölçmeden önce gömülü font kesin yüklenmeli.
  await document.fonts.load('13px "SDM Mono"').catch(() => {});
  await document.fonts.load('700 13px "SDM Mono"').catch(() => {});
  ASCII.measure();
  for (const b of document.querySelectorAll('.f b')) {
    const lead = document.createElement('span');
    lead.className = 'lead';
    lead.textContent = '.'.repeat(40);
    b.before(lead);
  }
  ASCII.attachAll();
  settings = await sdm.getSettings();
  for (const d of await sdm.list()) items.set(d.id, d);
  renderList();
  drawSpark();
  const st = await refreshStatus();
  if (!st.extensionSeen && !localStorage.getItem('extIntroShown')) {
    localStorage.setItem('extIntroShown', '1');
    setTimeout(() => { $('#dlgExt').showModal(); ASCII.draw($('#dlgExt')); }, 600);
  }
})();
