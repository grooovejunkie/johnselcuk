'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, PORT } = require('../src/main/bridge');

const EXT = 'chrome-extension://ehdjmmiodgkfkmklodemjccfblfecopb';
let server;
const got = [];
test.before(async () => {
  server = await startBridge({ version: 't', onDownload: async (b) => { got.push(b); return { queued: true }; }, onVideo: async (b) => { got.push(b); } });
});
test.after(() => server.close());
const call = (path, { method = 'GET', origin, body } = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method, body: body && JSON.stringify(body), headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
});

test('eklenti arka planından Origin\'siz ping kabul edilir', async () => {
  const r = await call('/ping');
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).app, 'SDM');
});
test('eklentiden gelen POST indirmeyi başlatır', async () => {
  const r = await call('/download', { method: 'POST', origin: EXT, body: { url: 'https://example.com/a.zip' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(got.at(-1).url, 'https://example.com/a.zip');
});
test('web sitesinden gelen istekler reddedilir', async () => {
  for (const [path, method] of [['/ping', 'GET'], ['/download', 'POST'], ['/video', 'POST']]) {
    const r = await call(path, { method, origin: 'https://kotu-site.example', body: method === 'POST' ? { url: 'https://x.y/z' } : undefined });
    assert.strictEqual(r.status, 403, `${method} ${path}`);
  }
});
test('Origin\'siz POST reddedilir', async () => {
  const n = got.length;
  const r = await call('/download', { method: 'POST', body: { url: 'https://example.com/b.zip' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(got.length, n);
});
test('http(s) olmayan adres reddedilir', async () => {
  const r = await call('/download', { method: 'POST', origin: EXT, body: { url: 'file:///etc/passwd' } });
  assert.strictEqual(r.status, 400);
});
