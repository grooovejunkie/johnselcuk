'use strict';
// İndirmeleri Chromium'un ağ katmanıyla (Electron net) yapar.
//
// Neden: Cloudflare gibi korumalar, tarayıcıya verdikleri geçiş çerezini (cf_clearance)
// bağlantının TLS "parmak izine" de bağlar. Node'un kendi HTTP istemcisi farklı bir parmak
// izi bıraktığı için, tarayıcıda açılan dosya SDM'de 403 alır. Chromium ağ katmanı
// Chrome ile aynı parmak izini, aynı HTTP/2 davranışını ve sistem proxy ayarlarını kullanır.
//
// Çerezler: Electron, elle eklenen "Cookie" başlığını yönlendirmeden sonra düşürür (ölçüldü).
// Bu yüzden eklentiden gelen çerezler ayrı bir oturumun çerez kavanozuna konur; her istek
// o oturumla yapılır, böylece yönlendirmelerde de doğru alan adına doğru çerez gider.

const { net, session } = require('electron');
const { Readable } = require('stream');

const PARTITION = 'sdm-downloads';

function jar() {
  return session.fromPartition(PARTITION);
}

// Eklentinin chrome.cookies.getAll çıktısını çerez kavanozuna yazar.
async function importCookies(cookies) {
  const ses = jar();
  await Promise.all((cookies || []).map((c) => {
    const host = c.domain.replace(/^\./, '');
    const details = {
      url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };
    if (!c.hostOnly) details.domain = c.domain;
    if (c.expirationDate) details.expirationDate = c.expirationDate;
    if (c.sameSite && ['no_restriction', 'lax', 'strict', 'unspecified'].includes(c.sameSite)) details.sameSite = c.sameSite;
    return ses.cookies.set(details).catch(() => {});
  }));
}

// Eski sürümlerden kalan, yalnızca düz "Cookie" başlığı olan indirmeler için: başlıktaki
// çerezleri istek adresinin alan adına yazar.
async function importCookieHeader(url, header) {
  if (!header) return;
  const ses = jar();
  for (const part of String(header).split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    await ses.cookies.set({ url, name: part.slice(0, i), value: part.slice(i + 1) }).catch(() => {});
  }
}

async function request(url, opts = {}) {
  const cookie = Object.entries(opts.headers || {}).find(([k]) => k.toLowerCase() === 'cookie');
  if (cookie) await importCookieHeader(url, cookie[1]);
  return send(url, opts);
}

function send(url, { headers = {}, signal, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let finalUrl = url;
    let settled = false;
    const req = net.request({
      url,
      method: 'GET',
      session: jar(),
      useSessionCookies: true,
      redirect: 'manual',
      // Başka siteye ait Referer'i Chromium varsayılan politikayla reddeder (ölçüldü).
      referrerPolicy: 'unsafe-url',
    });
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'cookie' || v == null) continue; // çerezler kavanozdan gelir
      try { req.setHeader(k, String(v)); } catch { /* Chromium'un yasakladığı başlık */ }
    }
    let timer = null;
    const arm = (msg) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(msg)), timeout);
    };
    const fail = (e) => {
      clearTimeout(timer);
      try { req.abort(); } catch { /* zaten kapalı */ }
      if (!settled) { settled = true; reject(e); } else stream.destroy(e);
    };
    const stream = new Readable({ read() { if (resp) resp.resume?.(); } });
    let resp = null;

    if (signal) {
      if (signal.aborted) return reject(new Error('İptal edildi'));
      signal.addEventListener('abort', () => fail(new Error('İptal edildi')), { once: true });
    }
    arm('Bağlantı zaman aşımı');
    let redirects = 0;
    req.on('redirect', (status, method, redirectUrl) => {
      if (++redirects > 10) return fail(new Error('Çok fazla yönlendirme'));
      finalUrl = redirectUrl;
      req.followRedirect();
    });
    req.on('response', (res) => {
      resp = res;
      const h = {};
      for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      stream.statusCode = res.statusCode;
      stream.headers = h;
      stream.finalUrl = finalUrl;
      const origDestroy = stream.destroy.bind(stream);
      stream.destroy = (e) => { clearTimeout(timer); try { req.abort(); } catch { /* yok say */ } return origDestroy(e); };
      arm('Veri akışı durdu');
      res.on('data', (chunk) => {
        arm('Veri akışı durdu');
        if (!stream.push(chunk)) res.pause?.();
      });
      res.on('end', () => { clearTimeout(timer); stream.push(null); });
      res.on('error', (e) => fail(e));
      settled = true;
      resolve(stream);
    });
    req.on('error', (e) => fail(e));
    req.end();
  });
}

module.exports = { request, importCookies, PARTITION };
