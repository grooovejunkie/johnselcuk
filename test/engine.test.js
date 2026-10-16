'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DownloadManager, makeSegments } = require('../src/main/engine');
const { filenameFromDisposition, sanitizeFilename } = require('../src/main/util');

const DATA = crypto.randomBytes(12 * 1024 * 1024 + 12345);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let rangeRequests = 0;
let maxParallel = 0;
let open = 0;

function serve(req, res, { ranges = true, slow = 0 } = {}) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0;
  let end = DATA.length - 1;
  if (ranges && m) {
    start = +m[1];
    if (m[2]) end = Math.min(+m[2], end);
    rangeRequests++;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"v1"' });
  } else {
    res.writeHead(200, { 'Content-Length': DATA.length, 'Content-Disposition': `attachment; filename*=UTF-8''%C3%B6rnek%20dosya.bin` });
  }
  open++;
  maxParallel = Math.max(maxParallel, open);
  res.on('close', () => open--);
  let pos = start;
  const pump = () => {
    if (pos > end || res.destroyed) return res.end();
    const n = Math.min(64 * 1024, end - pos + 1);
    const ok = res.write(DATA.subarray(pos, pos + n));
    pos += n;
    if (slow) setTimeout(pump, slow);
    else if (ok) setImmediate(pump);
    else res.once('drain', pump);
  };
  pump();
}

let server;
let base;
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: req.url.includes('paced') ? '/paced.bin' : '/file.bin' }); return res.end(); }
    if (req.url === '/norange') return serve(req, res, { ranges: false });
    if (req.url === '/slow.bin') return serve(req, res, { slow: 20 });
    if (req.url === '/skew.bin') {
      const st = +(/bytes=(\d+)/.exec(req.headers.range || '') || [0, 0])[1];
      return serve(req, res, { slow: st < 3 * 1024 * 1024 && req.headers.range !== 'bytes=0-0' ? 15 : 0 });
    }
    if (req.url === '/paced.bin') return serve(req, res, { slow: 1 });
    if (req.url === '/404') { res.writeHead(404); return res.end(); }
    serve(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function mgr(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdm-'));
  const settings = { downloadDir: dir, segments: 8, maxConcurrent: 3, sortByCategory: false, speedLimit: 0, autoResume: false, ...extra };
  const m = new DownloadManager({ statePath: path.join(dir, 'state.json'), settings });
  return { m, dir, settings };
}
const waitFor = (m, id, status) => new Promise((resolve, reject) => {
  const check = (v) => {
    if (v.id !== id) return;
    if (v.status === status) { m.off('update', check); resolve(v); }
    else if (v.status === 'error' && status !== 'error') { m.off('update', check); reject(new Error(v.error)); }
  };
  m.on('update', check);
});

test('segment bölme dosyayı tam kapsar', () => {
  const segs = makeSegments(10 * 1024 * 1024 + 7, 8);
  assert.strictEqual(segs[0].start, 0);
  assert.strictEqual(segs.at(-1).end, 10 * 1024 * 1024 + 6);
  for (let i = 1; i < segs.length; i++) assert.strictEqual(segs[i].start, segs[i - 1].end + 1);
});

test('çok parçalı indirme: içerik birebir aynı, paralel bağlantı kullanıldı', async () => {
  const { m } = mgr();
  maxParallel = 0;
  const v = m.add({ url: `${base}/redirect?to=paced` });
  const done = await waitFor(m, v.id, 'completed');
  assert.strictEqual(done.filename, 'paced.bin');
  assert.strictEqual(sha(fs.readFileSync(done.savePath)), sha(DATA));
  assert.ok(maxParallel >= 4, `paralel bağlantı sayısı: ${maxParallel}`);
  await m.shutdown();
});

test('Range desteklemeyen sunucu: tek parça, Content-Disposition (UTF-8) adı', async () => {
  const { m } = mgr();
  const v = m.add({ url: `${base}/norange` });
  const done = await waitFor(m, v.id, 'completed');
  assert.strictEqual(done.filename, 'örnek dosya.bin');
  assert.strictEqual(sha(fs.readFileSync(done.savePath)), sha(DATA));
  await m.shutdown();
});

test('duraklat → uygulamayı kapat → yeniden aç → kaldığı yerden devam', async () => {
  const { m, dir, settings } = mgr({ segments: 4 });
  const v = m.add({ url: `${base}/slow.bin` });
  await new Promise((r) => {
    const f = (u) => { if (u.id === v.id && u.downloaded > 2 * 1024 * 1024) { m.off('update', f); r(); } };
    m.on('update', f);
  });
  m.pause(v.id);
  await new Promise((r) => setTimeout(r, 300));
  const partial = m.list()[0].downloaded;
  assert.ok(partial > 0 && partial < DATA.length);
  await m.shutdown();

  // "Yeniden başlatma": aynı durum dosyasından yeni yönetici.
  rangeRequests = 0;
  const m2 = new DownloadManager({ statePath: path.join(dir, 'state.json'), settings });
  const restored = m2.list()[0];
  assert.strictEqual(restored.status, 'paused');
  assert.ok(restored.downloaded >= partial - 1);
  m2.resume(v.id);
  const done = await waitFor(m2, v.id, 'completed');
  assert.strictEqual(sha(fs.readFileSync(done.savePath)), sha(DATA));
  assert.ok(!fs.existsSync(done.savePath + '.sdmpart'));
  await m2.shutdown();
});

test('dinamik bölme: yavaş parçanın kalanı boşta kalan bağlantıya devredilir', async () => {
  const { m } = mgr({ segments: 4 });
  const seen = [];
  const spy = (req) => { if (req.url === '/skew.bin' && req.headers.range) seen.push(req.headers.range); };
  server.prependListener('request', spy);
  const v = m.add({ url: `${base}/skew.bin` });
  const done = await waitFor(m, v.id, 'completed');
  server.off('request', spy);
  assert.strictEqual(sha(fs.readFileSync(done.savePath)), sha(DATA));
  const starts = seen.map((r) => +/bytes=(\d+)/.exec(r)[1]).filter((x) => x > 0 && x < 3 * 1024 * 1024);
  assert.ok(starts.length >= 1, `ilk parçanın içinden başlayan yeni istek yok: ${seen.join(', ')}`);
  assert.ok(done.segments.length > 4);
});

test('indirme sürerken durum en geç ~1 sn içinde diske yazılır (çökmeye dayanıklılık)', async () => {
  const { m, dir } = mgr({ segments: 2 });
  const v = m.add({ url: `${base}/slow.bin` });
  await new Promise((r) => setTimeout(r, 2500));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).items[0];
  assert.strictEqual(saved.id, v.id);
  assert.ok(saved.segments.some((s) => s.pos > s.start), 'kaydedilmiş ilerleme yok');
  m.pause(v.id);
  await m.shutdown();
});

test('aynı ad varsa üzerine yazmaz, "(1)" ekler', async () => {
  const { m } = mgr();
  const a = m.add({ url: `${base}/file.bin` });
  const da = await waitFor(m, a.id, 'completed');
  const b = m.add({ url: `${base}/file.bin` });
  const db = await waitFor(m, b.id, 'completed');
  assert.notStrictEqual(da.savePath, db.savePath);
  assert.match(db.filename, /\(1\)/);
  await m.shutdown();
});

test('404 kalıcı hata olarak raporlanır (sonsuz deneme yok)', async () => {
  const { m } = mgr();
  const v = m.add({ url: `${base}/404` });
  const e = await waitFor(m, v.id, 'error');
  assert.match(e.error, /404/);
  await m.shutdown();
});

test('hız sınırı uygulanır', async () => {
  const { m } = mgr({ speedLimit: 4096 }); // 4 MB/s
  const t0 = Date.now();
  const v = m.add({ url: `${base}/file.bin` });
  await waitFor(m, v.id, 'completed');
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs > 2, `12 MB, 4 MB/s sınırla ${secs}s sürdü`);
  await m.shutdown();
});

test('dosya adı yardımcıları', () => {
  assert.strictEqual(filenameFromDisposition('attachment; filename="a b.zip"'), 'a b.zip');
  assert.strictEqual(sanitizeFilename('con.txt'), '_con.txt');
  assert.strictEqual(sanitizeFilename('a:b?c*.mp4'), 'a_b_c_.mp4');
});
