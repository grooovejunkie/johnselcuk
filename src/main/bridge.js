'use strict';
// Chrome eklentisi ↔ uygulama köprüsü: yalnızca 127.0.0.1'de dinleyen küçük bir HTTP sunucusu.
//
// Neden native messaging değil: native messaging her bilgisayarda kayıt defterine/manifest
// dosyasına eklentinin ID'sini yazmayı gerektirir ve eklenti ID'si "paketlenmemiş" kurulumda
// bilgisayara göre değişir. Yerel HTTP, kurulumdan sonra ek ayar gerektirmez.
//
// Güvenlik: Tarayıcıdaki sıradan bir web sitesi de 127.0.0.1'e istek atabilir.
//  - İndirme başlatan POST istekleri yalnızca Origin'i chrome-extension:// (moz-extension://)
//    olan isteklerden kabul edilir. Tarayıcılar POST'ta Origin'i her zaman gönderir ve web
//    sayfalarının bunu taklit etmesine izin vermez.
//  - Chrome, eklentinin arka plan betiğinden yapılan GET'lerde Origin göndermez (ölçüldü).
//    Bu yüzden zararsız /ping, Origin'siz isteklere açıktır; web sitesi Origin'i olan
//    istekler yine reddedilir.

const http = require('http');

const PORT = 47321;
const MAX_BODY = 2 * 1024 * 1024;

function startBridge({ version, onDownload, onVideo, onPing }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const fromExtension = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
    const harmlessPing = req.method === 'GET' && req.url === '/ping' && !origin;
    if (!fromExtension && !harmlessPing) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('forbidden');
    }
    const cors = {
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Content-Type': 'application/json',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    const reply = (status, obj) => { res.writeHead(status, cors); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && req.url === '/ping') {
      return reply(200, { app: 'SDM', version, ...(onPing ? onPing() : {}) });
    }
    if (req.method !== 'POST' || !['/download', '/video'].includes(req.url)) return reply(404, { error: 'not found' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reply(413, { error: 'too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'bad json' }); }
      const url = body.url || body.pageUrl;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return reply(400, { error: 'bad url' });
      try {
        const out = await (req.url === '/video' ? onVideo(body) : onDownload(body));
        reply(200, { ok: true, ...(out || {}) });
      } catch (e) {
        // fallback: SDM bu dosyayı alamıyor; eklenti indirmeyi Chrome'da sürdürmeli.
        reply(e.fallback ? 409 : 500, { error: e.message, fallback: !!e.fallback });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startBridge, PORT };
