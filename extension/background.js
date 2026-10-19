'use strict';
// SDM eklentisi — arka plan (service worker)
//  * Chrome'un başlattığı indirmeleri yakalar, iptal eder ve SDM'ye çerez/referer ile yollar.
//    SDM kapalıysa hiçbir şeye dokunmaz; Chrome normal indirir.
//  * Sekmelerdeki video/ses akışlarını (mp4, webm, m3u8, mpd) ağ trafiğinden algılar.
//  * İçerik betiğinden gelen "bu videoyu indir" isteklerini SDM'ye iletir.

const API = 'http://127.0.0.1:47321';
const DEFAULTS = {
  enabled: true,
  minSizeMB: 5,
  exts: 'zip rar 7z tar gz bz2 xz iso img exe msi dmg pkg deb rpm apk appimage mp4 mkv webm avi mov wmv flv m4v mp3 m4a flac wav aac ogg opus pdf epub docx xlsx pptx torrent bin',
  excluded: 'mail.google.com drive.google.com docs.google.com',
  overlay: true, // videoların üstündeki "SDM ile indir" düğmesi
  overlayOff: '', // düğmenin gösterilmeyeceği siteler
};
const skipOnce = new Set();

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

async function ping() {
  let ok = false;
  try {
    const r = await fetch(`${API}/ping`, { signal: AbortSignal.timeout(1500) });
    ok = r.ok;
  } catch { /* SDM kapalı */ }
  const { lastFailure } = await chrome.storage.session.get('lastFailure');
  chrome.action.setBadgeText({ text: !ok ? 'OFF' : lastFailure ? '!' : '' });
  chrome.action.setBadgeBackgroundColor({ color: !ok ? '#5d665d' : lastFailure ? '#b3261e' : '#1a7f3c' });
  return ok;
}

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { error: data.error || `SDM yanıtı: ${r.status}`, fallback: !!data.fallback };
  return data;
}

async function cookiesFor(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return {
      cookieHeader: list.map((c) => `${c.name}=${c.value}`).join('; '),
      cookies: list.map(({ domain, hostOnly, path, secure, httpOnly, sameSite, expirationDate, name, value }) => ({ domain, hostOnly, path, secure, httpOnly, sameSite, expirationDate, name, value })),
    };
  } catch {
    return { cookieHeader: '', cookies: [] };
  }
}

const basename = (p) => (p || '').split(/[\\/]/).pop();
const extOf = (name) => ((name || '').match(/\.([a-z0-9]{1,8})$/i) || [, ''])[1].toLowerCase();
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function isExcluded(url, s) {
  const h = hostOf(url);
  return !!h && s.excluded.split(/[\s,]+/).filter(Boolean).some((x) => h === x || h.endsWith('.' + x));
}

async function sendDownload({ url, referrer, filename, fileSize, mime, verify = false }) {
  const c = await cookiesFor(url);
  return post('/download', {
    url, referrer, filename, fileSize, mime, verify, userAgent: navigator.userAgent,
    cookies: c.cookies, cookieHeader: c.cookieHeader,
  });
}

// SDM'nin indiremediği son dosya: açılır pencerede gösterilir.
async function noteFailure(name, error) {
  await chrome.storage.session.set({ lastFailure: { name, error, ts: Date.now() } });
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
}

async function sendVideo({ pageUrl, candidates = [], title, referrer, quality }) {
  const c = await cookiesFor(pageUrl);
  return post('/video', {
    pageUrl, candidates, title, quality, referrer, userAgent: navigator.userAgent,
    cookies: c.cookies, cookieHeader: c.cookieHeader,
  });
}

// ---------------------------------------------------------------- indirme yakalama
// onDeterminingFilename sunucu yanıt başlıkları geldikten sonra çalışır: gerçek dosya adı,
// MIME türü ve boyut bu noktada bellidir (onCreated'da çoğu zaman boştur).
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  suggest(); // Chrome'un önerdiği adı değiştirmiyoruz
  maybeCapture(item);
});

async function maybeCapture(item) {
  const url = item.finalUrl || item.url;
  if (skipOnce.has(url) || skipOnce.has(item.url)) { skipOnce.delete(url); skipOnce.delete(item.url); return; }
  if (!/^https?:/i.test(url) || item.byExtensionId) return;
  const s = await getSettings();
  if (!s.enabled || isExcluded(url, s) || isExcluded(item.referrer || '', s)) return;
  const name = basename(item.filename);
  const big = item.totalBytes > 0 && item.totalBytes >= s.minSizeMB * 1024 * 1024;
  if (!s.exts.split(/\s+/).includes(extOf(name)) && !big) return;
  if (!(await ping())) return; // SDM kapalı: Chrome indirsin

  // İptal etmeden önce duraklat: SDM dosyayı alamazsa (site koruması, oturum, tek
  // kullanımlık bağlantı) Chrome kaldığı yerden devam eder, dosya kaybolmaz.
  try { await chrome.downloads.pause(item.id); } catch { /* küçük dosya çoktan bitmiş olabilir */ }
  const [now] = await chrome.downloads.search({ id: item.id });
  if (!now || now.state !== 'in_progress') return; // Chrome zaten bitirdi

  let res;
  try {
    res = await sendDownload({ url, referrer: item.referrer, filename: name, fileSize: item.totalBytes, mime: item.mime, verify: true });
  } catch (e) {
    res = { error: e.message };
  }
  if (res && res.ok) {
    try { await chrome.downloads.cancel(item.id); await chrome.downloads.erase({ id: item.id }); } catch { /* yok say */ }
  } else {
    try { await chrome.downloads.resume(item.id); } catch { /* yok say */ }
    await noteFailure(name, (res && res.error) || 'SDM yanıt vermedi');
  }
}

// ---------------------------------------------------------------- akış algılama
const MEDIA_SKIP_HOSTS = /(^|\.)(googlevideo\.com|doubleclick\.net|googlesyndication\.com)$/;

function classify(url, ct, len) {
  let p = '';
  try { p = new URL(url).pathname.toLowerCase(); } catch { /* yok say */ }
  if (/mpegurl/i.test(ct) || p.endsWith('.m3u8')) return 'hls';
  if (/dash\+xml/i.test(ct) || p.endsWith('.mpd')) return 'dash';
  if (/\.(ts|m4s|aac)$/.test(p) || /mp2t|iso.segment/i.test(ct)) return null; // akış parçaları
  if (/^(video|audio)\//i.test(ct) || /\.(mp4|webm|mkv|mov|m4v|mp3|m4a|ogg|flac)$/.test(p)) {
    if (len && len < 512 * 1024) return null; // önizleme/reklam gibi küçük dosyalar
    return /^audio\//i.test(ct) || /\.(mp3|m4a|ogg|flac)$/.test(p) ? 'audio' : 'video';
  }
  return null;
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400 || !/^https?:/.test(d.url)) return;
    if (MEDIA_SKIP_HOSTS.test(hostOf(d.url))) return;
    const h = Object.fromEntries((d.responseHeaders || []).map((x) => [x.name.toLowerCase(), x.value || '']));
    const len = Number((/\/(\d+)$/.exec(h['content-range'] || '') || [])[1] || h['content-length'] || 0);
    const type = classify(d.url, h['content-type'] || '', len);
    if (type) remember(d.tabId, { url: d.url, type, size: len, mime: (h['content-type'] || '').split(';')[0] });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

// Bellek içi önbellek: her ağ isteğinde depolamayı okumamak için. Service worker uykuya
// geçerse chrome.storage.session'dan geri yüklenir.
const mediaCache = new Map();

async function remember(tabId, m) {
  const key = `tab:${tabId}`;
  let cur = mediaCache.get(key);
  if (!cur) { cur = (await chrome.storage.session.get(key))[key] || []; mediaCache.set(key, cur); }
  const base = m.url.split('?')[0];
  if (cur.some((x) => x.url === m.url || (m.type !== 'hls' && x.url.split('?')[0] === base))) return;
  cur.push({ ...m, ts: Date.now() });
  if (cur.length > 40) cur.splice(0, cur.length - 40);
  await chrome.storage.session.set({ [key]: cur });
  chrome.action.setBadgeText({ tabId, text: String(cur.length) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a7f3c' });
}

async function mediaFor(tabId) {
  const key = `tab:${tabId}`;
  return mediaCache.get(key) || (await chrome.storage.session.get(key))[key] || [];
}

function forgetTab(tabId) {
  mediaCache.delete(`tab:${tabId}`);
  chrome.storage.session.remove(`tab:${tabId}`);
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    forgetTab(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

// HLS ana listesi önce, sonra DASH, sonra doğrudan dosyalar (büyükten küçüğe).
function rankCandidates(list) {
  const order = { hls: 0, dash: 1, video: 2, audio: 3 };
  return [...list].sort((a, b) => order[a.type] - order[b.type] || (b.size || 0) - (a.size || 0) || a.ts - b.ts).map((x) => x.url);
}

async function grabVideo({ tab, frameUrl, src, title, quality }) {
  const pageUrl = frameUrl || tab.url;
  const sniffed = rankCandidates(await mediaFor(tab.id));
  const candidates = [tab.url, ...(src && /^https?:/.test(src) ? [src] : []), ...sniffed]
    .filter((u, i, a) => u && u !== pageUrl && a.indexOf(u) === i);
  return sendVideo({ pageUrl, candidates, title: title || tab.title, referrer: tab.url, quality });
}

// ---------------------------------------------------------------- mesajlar
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      if (msg.type === 'grabVideo') {
        if (!(await ping())) return reply({ error: 'SDM çalışmıyor' });
        const tab = sender.tab || (await chrome.tabs.get(msg.tabId));
        return reply(await grabVideo({ tab, frameUrl: sender.tab && sender.frameId ? sender.url : msg.frameUrl, src: msg.src, title: msg.title, quality: msg.quality }));
      }
      if (msg.type === 'grabStream') {
        if (!(await ping())) return reply({ error: 'SDM çalışmıyor' });
        const tab = await chrome.tabs.get(msg.tabId);
        return reply(msg.direct
          ? await sendDownload({ url: msg.url, referrer: tab.url })
          : await sendVideo({ pageUrl: msg.url, title: tab.title, referrer: tab.url }));
      }
      if (msg.type === 'state') {
        const { lastFailure } = await chrome.storage.session.get('lastFailure');
        return reply({ online: await ping(), media: msg.tabId ? await mediaFor(msg.tabId) : [], settings: await getSettings(), lastFailure });
      }
      if (msg.type === 'clearFailure') {
        await chrome.storage.session.remove('lastFailure');
        await ping();
        return reply({ ok: true });
      }
      if (msg.type === 'overlayAllowed') {
        const s = await getSettings();
        const h = hostOf(msg.url || '');
        const off = s.overlayOff.split(/[\s,]+/).filter(Boolean).some((x) => h === x || h.endsWith('.' + x));
        return reply({ allowed: s.overlay && !off });
      }
      if (msg.type === 'saveSettings') {
        await chrome.storage.sync.set(msg.settings);
        return reply({ ok: true });
      }
      reply({ error: 'bilinmeyen istek' });
    } catch (e) {
      reply({ error: e.message });
    }
  })();
  return true; // yanıt asenkron
});

// ---------------------------------------------------------------- sağ tık menüsü
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sdm-link', title: 'SDM ile indir', contexts: ['link', 'image', 'audio', 'video'] });
    chrome.contextMenus.create({ id: 'sdm-page', title: 'Bu sayfadaki videoyu SDM ile indir', contexts: ['page', 'video'] });
  });
  chrome.alarms.create('ping', { periodInMinutes: 0.5 });
  ping();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'sdm-link') {
      const url = info.linkUrl || info.srcUrl;
      if (url && /^https?:/.test(url)) await sendDownload({ url, referrer: tab?.url });
      else if (tab) await grabVideo({ tab, frameUrl: info.frameUrl });
    }
    if (info.menuItemId === 'sdm-page' && tab) await grabVideo({ tab, frameUrl: info.frameUrl });
  } catch { /* SDM kapalı */ }
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ping') ping(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('ping', { periodInMinutes: 0.5 }); ping(); });
