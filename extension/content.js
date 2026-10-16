'use strict';
// Sayfadaki her <video>'nun üstünde, fare gelince ASCII "[ v SDM ile indir ]" düğmesi gösterir.
// Düğme kapalı bir Shadow DOM içindedir: sitenin CSS'i onu bozamaz, o da siteyi bozamaz.
(() => {
  if (window.__sdmInjected) return;
  window.__sdmInjected = true;

  const font = (f) => chrome.runtime.getURL(`fonts/jetbrains-mono-${f}-400-normal.woff2`);
  const host = document.createElement('sdm-grab');
  host.style.cssText = 'all:initial;position:absolute;z-index:2147483647;display:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      @font-face { font-family: SDMMono; src: url(${font('latin')}) format('woff2'); unicode-range: U+0000-00FF, U+0131; }
      @font-face { font-family: SDMMono; src: url(${font('latin-ext')}) format('woff2'); unicode-range: U+0100-02AF; }
      button {
        all: initial;
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
    <button type="button">[ v SDM ile indir ]</button>`;
  const btn = root.querySelector('button');
  const LABEL = '[ v SDM ile indir ]';
  let target = null;
  let hideTimer = null;

  const mount = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };

  function place(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 110) return false;
    mount();
    host.style.top = `${r.top + window.scrollY + 10}px`;
    host.style.left = `${r.right + window.scrollX - 10}px`;
    host.style.display = 'block';
    return true;
  }

  function videoAt(x, y) {
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width >= 200) return v;
    }
    return null;
  }

  // Oynatıcılar videonun üstüne şeffaf katmanlar koyar; bu yüzden olay hedefine değil,
  // fare koordinatına bakıyoruz.
  let raf = 0;
  document.addEventListener('mousemove', (e) => {
    if (raf) return;
    const { clientX: x, clientY: y } = e;
    const overBtn = e.composedPath().includes(host);
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (overBtn) { clearTimeout(hideTimer); return; }
      const v = videoAt(x, y);
      if (v && place(v)) { target = v; clearTimeout(hideTimer); }
      else if (host.style.display !== 'none') {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { host.style.display = 'none'; }, 900);
      }
    });
  }, { passive: true });

  window.addEventListener('scroll', () => { if (target && host.style.display !== 'none') place(target); }, { passive: true });

  function flash(text, cls) {
    btn.className = cls || '';
    btn.textContent = text;
    if (cls !== 'busy') setTimeout(() => { btn.className = ''; btn.textContent = LABEL; }, 2500);
  }

  btn.addEventListener('click', (e) => {
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
  });
})();
