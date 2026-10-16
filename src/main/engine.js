'use strict';
// Çok parçalı (segmented) HTTP indirme motoru.
//
// Nasıl çalışır:
//  1. probe(): "Range: bytes=0-0" ile GET atılır. 206 + Content-Range dönerse sunucu
//     parçalı indirmeyi destekliyor demektir ve toplam boyut öğrenilir. (HEAD'e güvenilmez,
//     birçok CDN HEAD'i yanlış yanıtlar.)
//  2. Dosya N parçaya bölünür; her parça kendi bağlantısıyla, tek bir .sdmpart dosyasının
//     ilgili ofsetine yazılır.
//  3. Dinamik bölme: bir parça bittiğinde, kalanı en büyük olan parça ikiye bölünür ve
//     boşalan bağlantı o yarıyı alır. Böylece yavaş bir bağlantı tüm indirmeyi bekletmez.
//  4. Durum (parça sınırları + ilerleme) diske yazılır; uygulama kapansa bile kaldığı
//     yerden devam eder. Devamda If-Range ile dosyanın sunucuda değişmediği doğrulanır.

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { sanitizeFilename, filenameFromDisposition, filenameFromUrl, uniquePath, categoryOf } = require('./util');

const MIN_SPLIT = 1024 * 1024; // 1 MB'tan küçük kalanlar bölünmez
const MAX_RETRIES = 8;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, msg) {
    super(msg || `HTTP ${status}`);
    this.status = status;
    // 4xx (408/429 hariç) kalıcı hatadır; tekrar denemenin anlamı yok.
    this.fatal = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

// Yönlendirmeleri takip eden tek istek. Yanıt gövdesi akış olarak döner.
function request(url, { headers = {}, signal, timeout = 30000 } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Geçersiz adres: ' + url)); }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return reject(new Error('Desteklenmeyen protokol: ' + u.protocol));
    const req = mod.request(u, { method: 'GET', headers: { 'User-Agent': DEFAULT_UA, ...headers }, signal });
    req.setTimeout(timeout, () => req.destroy(new Error('Bağlantı zaman aşımı')));
    req.on('error', reject);
    req.on('response', (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 10) return reject(new Error('Çok fazla yönlendirme'));
        const next = new URL(res.headers.location, u).toString();
        return resolve(request(next, { headers, signal, timeout }, redirects + 1));
      }
      res.finalUrl = url;
      // Gövde akarken de bağlantı donarsa düşür.
      res.socket?.setTimeout(timeout, () => req.destroy(new Error('Veri akışı durdu')));
      resolve(res);
    });
    req.end();
  });
}

async function probe(url, headers) {
  const res = await request(url, { headers: { ...headers, Range: 'bytes=0-0' } });
  res.resume();
  res.destroy();
  if (res.statusCode >= 400) throw new HttpError(res.statusCode);
  const h = res.headers;
  let size = -1;
  let resumable = false;
  if (res.statusCode === 206) {
    const m = /\/(\d+)\s*$/.exec(h['content-range'] || '');
    if (m) { size = Number(m[1]); resumable = true; }
  } else if (h['content-length']) {
    size = Number(h['content-length']);
  }
  return {
    finalUrl: res.finalUrl,
    size,
    resumable,
    filename: filenameFromDisposition(h['content-disposition']) || filenameFromUrl(res.finalUrl),
    mime: (h['content-type'] || '').split(';')[0],
    validator: h.etag && !/^W\//.test(h.etag) ? h.etag : h['last-modified'] || null,
  };
}

// ---------------------------------------------------------------------------
// Tek bir HTTP indirmesini yürüten sınıf.
class HttpTask {
  constructor(item, manager) {
    this.item = item;
    this.m = manager;
    this.ac = new AbortController();
    this.fh = null;
    this.workers = new Set();
    this.stopped = false;
  }

  headers() {
    const h = { ...(this.item.headers || {}) };
    if (this.item.validator) h['If-Range'] = this.item.validator;
    return h;
  }

  async run() {
    const it = this.item;
    if (!it.segments || !it.segments.length) {
      it.status = 'probing';
      this.m.touch(it);
      const info = await probe(it.url, it.headers);
      if (this.stopped) return;
      if (it.savePath) await fsp.rm(it.savePath + '.sdmpart', { force: true }).catch(() => {});
      it.finalUrl = info.finalUrl;
      it.size = info.size;
      it.resumable = info.resumable;
      it.validator = info.validator;
      if (!it.userFilename) {
        let name = sanitizeFilename(info.filename || 'indirme');
        if (!path.extname(name) && info.mime) name += extFromMime(info.mime);
        it.filename = name;
        it.category = categoryOf(name);
      }
      const dir = this.m.targetDir(it);
      await fsp.mkdir(dir, { recursive: true });
      it.savePath = uniquePath(dir, it.filename, this.m.reservedPaths(it.id));
      it.filename = path.basename(it.savePath);
      it.segments = makeSegments(it.size, it.resumable ? this.m.settings.segments : 1);
    }

    const part = it.savePath + '.sdmpart';
    let fresh = !fs.existsSync(part);
    if (fresh && it.segments.some((s) => s.pos > s.start)) {
      // Geçici dosya silinmiş: baştan başla.
      it.segments = makeSegments(it.size, it.resumable ? this.m.settings.segments : 1);
    }
    this.fh = await fsp.open(part, fresh ? 'w' : 'r+');
    if (this.stopped) { await this.fh.close(); return; }
    it.status = 'downloading';
    this.m.touch(it);

    try {
      for (const seg of it.segments) if (seg.pos <= seg.end) this.spawn(seg);
      while (this.workers.size) await Promise.race(this.workers);
      if (this.stopped) return;
      if (this.error) throw this.error;
      const done = it.segments.every((s) => s.pos > s.end || (s.end === Infinity && s.eof));
      if (!done) throw new Error('İndirme eksik kaldı');
    } finally {
      await this.fh.close().catch(() => {});
      this.fh = null;
    }

    if (it.size > 0) {
      const st = await fsp.stat(part);
      if (st.size !== it.size) throw new Error(`Boyut uyuşmuyor (${st.size} / ${it.size})`);
    }
    // Hedef bu arada başka biri tarafından oluşturulduysa üzerine yazma.
    if (fs.existsSync(it.savePath)) {
      it.savePath = uniquePath(path.dirname(it.savePath), path.basename(it.savePath));
      it.filename = path.basename(it.savePath);
    }
    await fsp.rename(part, it.savePath);
    if (it.size < 0) it.size = it.segments.reduce((a, s) => a + (s.pos - s.start), 0);
  }

  spawn(seg) {
    const p = this.worker(seg).finally(() => this.workers.delete(p));
    this.workers.add(p);
  }

  async worker(seg) {
    let retries = 0;
    while (!this.stopped && !this.error && seg.pos <= seg.end && !seg.eof) {
      try {
        await this.fetchInto(seg);
        retries = 0;
      } catch (e) {
        if (this.stopped) return;
        if (e.fatal || e.restart || ++retries > MAX_RETRIES) { this.error = this.error || e; this.ac.abort(); return; }
        this.m.log(this.item, `Parça ${seg.start}: ${e.message} — yeniden deneniyor (${retries})`);
        await sleep(Math.min(30000, 1000 * 2 ** (retries - 1)));
      }
    }
    if (!this.stopped && !this.error) this.rebalance();
  }

  async fetchInto(seg) {
    const it = this.item;
    const ranged = it.resumable;
    const headers = this.headers();
    if (ranged) headers.Range = `bytes=${seg.pos}-${seg.end === Infinity ? '' : seg.end}`;
    const res = await request(it.finalUrl || it.url, { headers, signal: this.ac.signal });
    if (res.statusCode >= 400) { res.resume(); throw new HttpError(res.statusCode); }
    if (ranged && res.statusCode === 200) {
      res.destroy();
      // If-Range eşleşmedi ya da sunucu Range'i artık yok sayıyor: dosya değişmiş.
      const e = new Error('Sunucudaki dosya değişmiş ya da devam etme desteklenmiyor; baştan indirilmeli');
      e.restart = true;
      throw e;
    }
    if (!ranged && seg.pos > seg.start) {
      // Devam desteklemeyen sunucu: tek parça baştan.
      seg.pos = seg.start;
    }
    for await (const chunk of res) {
      if (this.stopped) { res.destroy(); return; }
      const remaining = seg.end === Infinity ? chunk.length : seg.end - seg.pos + 1;
      if (remaining <= 0) { res.destroy(); return; }
      const len = Math.min(chunk.length, remaining);
      seg.inflight = len;
      await this.fh.write(chunk, 0, len, seg.pos);
      seg.pos += len;
      seg.inflight = 0;
      await this.m.throttle(len);
      if (seg.end !== Infinity && seg.pos > seg.end) { res.destroy(); return; }
    }
    if (seg.end === Infinity) seg.eof = true;
    else if (seg.pos <= seg.end) throw new Error('Bağlantı erken kapandı');
  }

  // Boşta kalan bağlantıya en büyük kalan parçanın yarısını ver.
  rebalance() {
    const it = this.item;
    if (!it.resumable || this.workers.size > this.m.settings.segments) return;
    let best = null;
    let bestRem = 0;
    for (const s of it.segments) {
      if (s.end === Infinity) continue;
      const rem = s.end - (s.pos + (s.inflight || 0)) + 1;
      if (rem > bestRem) { best = s; bestRem = rem; }
    }
    if (!best || bestRem < MIN_SPLIT * 2) return;
    const mid = best.pos + (best.inflight || 0) + Math.floor(bestRem / 2);
    const seg = { start: mid, end: best.end, pos: mid };
    best.end = mid - 1;
    it.segments.push(seg);
    it.segments.sort((a, b) => a.start - b.start);
    this.spawn(seg);
  }

  stop() {
    this.stopped = true;
    this.ac.abort();
  }
}

function makeSegments(size, n) {
  if (!(size > 0)) return [{ start: 0, end: Infinity, pos: 0 }];
  n = Math.max(1, Math.min(n, Math.ceil(size / MIN_SPLIT)));
  const step = Math.ceil(size / n);
  const segs = [];
  for (let s = 0; s < size; s += step) segs.push({ start: s, end: Math.min(size, s + step) - 1, pos: s });
  return segs;
}

function extFromMime(mime) {
  const map = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
    'application/pdf': '.pdf', 'application/zip': '.zip', 'image/jpeg': '.jpg', 'image/png': '.png',
    'application/x-msdownload': '.exe', 'application/x-7z-compressed': '.7z',
  };
  return map[mime] || '';
}

// ---------------------------------------------------------------------------
// Kuyruk, kalıcılık, hız ölçümü ve hız sınırı.
class DownloadManager extends EventEmitter {
  constructor({ statePath, settings, runners = {} }) {
    super();
    this.statePath = statePath;
    this.settings = settings;
    this.runners = { http: HttpTask, ...runners };
    this.items = new Map();
    this.tasks = new Map();
    this.samples = new Map();
    this.bucket = { tokens: 0, last: Date.now() };
    this.load();
    this.tick = setInterval(() => this.measure(), 500);
    this.tick.unref?.();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      for (const it of data.items || []) {
        for (const s of it.segments || []) {
          if (s.end === null) s.end = Infinity;
          s.inflight = 0;
        }
        if (['downloading', 'probing', 'queued'].includes(it.status)) it.status = this.settings.autoResume ? 'queued' : 'paused';
        it.speed = 0;
        this.items.set(it.id, it);
      }
    } catch { /* ilk çalıştırma */ }
    setImmediate(() => this.pump());
  }

  // Kısıtlama (throttle), erteleme (debounce) değil: indirme sürerken sürekli çağrılsa da
  // en geç 1 sn'de bir diske yazılır; çökme anında en fazla 1 sn'lik ilerleme kaybolur.
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 1000);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const items = [...this.items.values()].map(({ speed, eta, ...rest }) => rest);
    const tmp = this.statePath + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ items }, (k, v) => (v === Infinity ? null : v)));
      fs.renameSync(tmp, this.statePath);
    } catch (e) {
      console.error('Durum kaydedilemedi:', e);
    }
  }

  list() {
    return [...this.items.values()].map((it) => this.view(it));
  }

  view(it) {
    const downloaded = it.kind === 'video'
      ? it.downloaded || 0
      : (it.segments || []).reduce((a, s) => a + Math.max(0, Math.min(s.pos, s.end + 1) - s.start), 0);
    const segments = it.size > 0 && it.segments
      ? it.segments.map((s) => [s.start / it.size, (Math.min(s.pos, s.end + 1) - s.start) / it.size, (s.end + 1 - s.start) / it.size])
      : null;
    return {
      id: it.id, kind: it.kind, url: it.url, pageUrl: it.pageUrl, filename: it.filename, savePath: it.savePath,
      category: it.category, size: it.size, downloaded, status: it.status, error: it.error,
      speed: it.speed || 0, eta: it.eta, resumable: it.resumable, createdAt: it.createdAt,
      completedAt: it.completedAt, connections: this.tasks.get(it.id)?.workers?.size || 0, segments,
      note: it.note,
    };
  }

  touch(it) {
    this.emit('update', this.view(it));
    this.save();
  }

  log(it, msg) {
    this.emit('log', { id: it.id, msg });
  }

  targetDir(it) {
    const base = it.dir || this.settings.downloadDir;
    return this.settings.sortByCategory && !it.dir ? path.join(base, it.category || 'Diğer') : base;
  }

  reservedPaths(exceptId) {
    const s = new Set();
    for (const it of this.items.values()) if (it.id !== exceptId && it.savePath && it.status !== 'completed') s.add(it.savePath);
    return s;
  }

  add(opts) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const name = opts.filename ? sanitizeFilename(opts.filename) : null;
    const it = {
      id,
      kind: opts.kind || 'http',
      url: opts.url,
      pageUrl: opts.pageUrl,
      headers: opts.headers || {},
      cookies: opts.cookies,
      candidates: opts.candidates,
      quality: opts.quality,
      title: opts.title,
      filename: name || filenameFromUrl(opts.url) || 'indirme',
      userFilename: !!name,
      dir: opts.dir || null,
      category: opts.kind === 'video' ? 'Video' : categoryOf(name || filenameFromUrl(opts.url)),
      size: -1,
      status: opts.start === false ? 'paused' : 'queued',
      createdAt: Date.now(),
    };
    this.items.set(id, it);
    this.touch(it);
    this.pump();
    return this.view(it);
  }

  pump() {
    const active = [...this.tasks.keys()].length;
    let slots = this.settings.maxConcurrent - active;
    for (const it of this.items.values()) {
      if (slots <= 0) break;
      if (it.status === 'queued' && !this.tasks.has(it.id)) { this.start(it); slots--; }
    }
  }

  start(it) {
    const Runner = this.runners[it.kind];
    const task = new Runner(it, this);
    this.tasks.set(it.id, task);
    it.error = null;
    this.samples.set(it.id, { t: Date.now(), bytes: this.view(it).downloaded, speed: 0 });
    task.run().then(
      () => {
        if (task.stopped) return;
        this.tasks.delete(it.id);
        it.status = 'completed';
        it.completedAt = Date.now();
        it.speed = 0;
        delete it.cookies; // oturum çerezlerini kalıcı olarak tutma
        this.emit('completed', this.view(it));
      },
      (e) => {
        if (task.stopped) return;
        if (e.restart) { it.segments = null; it.validator = null; }
        it.status = 'error';
        it.error = e.message;
        it.speed = 0;
      }
    ).finally(() => {
      this.tasks.delete(it.id);
      this.touch(it);
      this.pump();
    });
  }

  pause(id) {
    const it = this.items.get(id);
    if (!it) return;
    this.tasks.get(id)?.stop();
    if (it.status !== 'completed') { it.status = 'paused'; it.speed = 0; }
    this.touch(it);
  }

  resume(id) {
    const it = this.items.get(id);
    if (!it || it.status === 'completed' || this.tasks.has(id)) return;
    it.status = 'queued';
    this.touch(it);
    this.pump();
  }

  async remove(id, deleteFile = false) {
    const it = this.items.get(id);
    if (!it) return;
    const task = this.tasks.get(id);
    task?.stop();
    this.items.delete(id);
    this.emit('removed', id);
    this.save();
    if (task) await new Promise((r) => setTimeout(r, 300)); // açık dosya tanıtıcıları kapansın
    if (it.savePath) {
      await fsp.rm(it.savePath + '.sdmpart', { force: true }).catch(() => {});
      if (deleteFile && it.status === 'completed') await fsp.rm(it.savePath, { force: true }).catch(() => {});
    }
  }

  // Ortak hız sınırı (token bucket). settings.speedLimit KB/s, 0 = sınırsız.
  async throttle(bytes) {
    const limit = (this.settings.speedLimit || 0) * 1024;
    if (!limit) return;
    const b = this.bucket;
    const now = Date.now();
    b.tokens = Math.min(limit, b.tokens + ((now - b.last) / 1000) * limit);
    b.last = now;
    b.tokens -= bytes;
    if (b.tokens < 0) await sleep((-b.tokens / limit) * 1000);
  }

  measure() {
    const now = Date.now();
    for (const [id] of this.tasks) {
      const it = this.items.get(id);
      if (!it) continue;
      const v = this.view(it);
      const s = this.samples.get(id) || { t: now, bytes: v.downloaded, speed: 0 };
      const dt = (now - s.t) / 1000;
      if (dt <= 0) continue;
      const inst = Math.max(0, (v.downloaded - s.bytes) / dt);
      const speed = it.kind === 'video' && it.reportedSpeed != null ? it.reportedSpeed : s.speed ? s.speed * 0.7 + inst * 0.3 : inst;
      this.samples.set(id, { t: now, bytes: v.downloaded, speed });
      it.speed = speed;
      it.eta = speed > 0 && it.size > 0 ? Math.round((it.size - v.downloaded) / speed) : null;
      this.emit('update', this.view(it));
    }
    if (this.tasks.size) this.save();
  }

  async shutdown() {
    for (const t of this.tasks.values()) t.stop();
    for (const it of this.items.values()) if (this.tasks.has(it.id)) it.status = 'queued';
    clearInterval(this.tick);
    this.saveNow();
  }
}

module.exports = { DownloadManager, HttpTask, probe, request, makeSegments, HttpError, DEFAULT_UA };
