'use strict';
// Videoların üstünde, fare bir süre durunca ASCII "[ v SDM ile indir ]" düğmesi gösterir.
//
// Sayfaya etkisi en aza indirildi (Instagram gibi sonsuz akışlı sitelerde sorun çıkmasın):
//  - Düğme yalnızca gösterildiği an DOM'a eklenir, gizlenince tamamen kaldırılır.
//  - position: fixed ve <html> altına eklenir: sayfanın düzenine, yüksekliğine,
//    body'nin çocuk listesine dokunmaz.
//  - Kaydırma/tekerlek başladığı an kaybolur; kaydırma sırasında imlecin altında durmaz.
//  - Fare hareketi en fazla 100 ms'de bir değerlendirilir; sayfada video yoksa hiç iş yapılmaz.
//  - Kapalı Shadow DOM: sitenin CSS'i düğmeyi, düğmenin CSS'i siteyi etkilemez.
//  - Açılır pencereden tamamen ya da site bazında kapatılabilir.
(() => {
  if (window.__sdmInjected) return;
  window.__sdmInjected = true;

  const LABEL = '[ v SDM ile indir ]';
  const videos = document.getElementsByTagName('video'); // canlı liste, ucuz
  let host = null;
  let btn = null;
  let target = null;
  let enabled = null; // ayar ilk video görülünce sorulur
  let last = 0;
  let pending = null;
  let restTimer = null;
  let hideTimer = null;

  function build() {
    const font = (f) => chrome.runtime.getURL(`fonts/jetbrains-mono-${f}-400-normal.woff2`);
    host = document.createElement('sdm-grab');
    host.style.cssText = 'all:initial;display:block;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        @font-face { font-family: SDMMono; src: url(${font('latin')}) format('woff2'); unicode-range: U+0000-00FF, U+0131; }
        @font-face { font-family: SDMMono; src: url(${font('latin-ext')}) format('woff2'); unicode-range: U+0100-02AF; }
        button {
          all: initial;
          pointer-events: auto;
          font: 12px/18px SDMMono, Consolas, "DejaVu Sans Mono", monospace;
          color: #4dff88;
          background: rgba(10, 11, 10, 0.92);
          padding: 2px 6px;
          cursor: pointer;
          white-space: pre;
          text-shadow: 0 0 6px rgba(77, 255, 136, 0.5);
          box-shadow: 0 0 0 1px #2a2f2a;
          transform: translateX(-100%);
          display: block;
        }
        button:hover { background: #4dff88; color: #000; text-shadow: none; }
        button.busy { color: #c9d1c9; }
        button.err { color: #ff5f56; }
        button.err:hover { background: #ff5f56; color: #000; }
      </style>
      <button type="button"></button>`;
    btn = root.querySelector('button');
    btn.textContent = LABEL;
    btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    btn.addEventListener('mouseleave', () => scheduleHide(600));
    btn.addEventListener('click', onClick);
  }

  function show(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 110 || r.bottom < 0 || r.top > innerHeight) return;
    if (!host) build();
    host.style.transform = `translate(${Math.round(r.right - 10)}px, ${Math.round(Math.max(r.top, 0) + 10)}px)`;
    if (!host.isConnected) document.documentElement.appendChild(host);
    target = v;
  }

  function hide() {
    clearTimeout(hideTimer);
    if (host && host.isConnected && !btn.classList.contains('busy')) host.remove();
    target = null;
  }

  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, ms);
  }

  function videoAt(x, y) {
    for (let i = 0; i < videos.length; i++) {
      const r = videos[i].getBoundingClientRect();
      if (r.width >= 200 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return videos[i];
    }
    return null;
  }

  function evaluate(x, y) {
    if (!videos.length) return;
    if (enabled === null) {
      enabled = false;
      chrome.runtime.sendMessage({ type: 'overlayAllowed', url: location.href }, (r) => {
        enabled = !chrome.runtime.lastError && !!(r && r.allowed);
      });
      return;
    }
    if (!enabled) return;
    const v = videoAt(x, y);
    if (v) {
      clearTimeout(hideTimer);
      // Fare videonun üstünde kısa bir süre durursa göster (kaydırırken gösterme).
      clearTimeout(restTimer);
      restTimer = setTimeout(() => show(v), target === v ? 0 : 250);
    } else if (host && host.isConnected) {
      clearTimeout(restTimer);
      scheduleHide(700);
    }
  }

  // Oynatıcılar videonun üstüne şeffaf katmanlar koyar; bu yüzden olay hedefine değil,
  // fare koordinatına bakılır.
  document.addEventListener('mousemove', (e) => {
    if (!videos.length) return;
    pending = [e.clientX, e.clientY];
    const now = Date.now();
    if (now - last < 100) return;
    last = now;
    const [x, y] = pending;
    evaluate(x, y);
  }, { passive: true, capture: true });

  const onScroll = () => { clearTimeout(restTimer); if (host && host.isConnected) hide(); };
  window.addEventListener('wheel', onScroll, { passive: true, capture: true });
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('touchmove', onScroll, { passive: true, capture: true });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.overlay || changes.overlayOff) { enabled = null; hide(); }
  });

  function flash(text, cls) {
    btn.className = cls || '';
    btn.textContent = text;
    if (cls !== 'busy') {
      setTimeout(() => { btn.className = ''; btn.textContent = LABEL; scheduleHide(1500); }, 2500);
    }
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const src = target && (target.currentSrc || target.src);
    flash('[ ... gönderiliyor ]', 'busy');
    chrome.runtime.sendMessage(
      { type: 'grabVideo', src: src && !src.startsWith('blob:') ? src : null, title: document.title, frameUrl: location.href },
      (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) flash(`[ ! ${(r && r.error) || "SDM'ye ulaşılamadı"} ]`, 'err');
        else flash("[ ok SDM'ye gönderildi ]");
      }
    );
  }
})();
