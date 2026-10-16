'use strict';
// ASCII çizim yardımcıları. Tüm arayüz tek genişlikli fontun karakter ızgarasına oturur:
// çerçeveler, ilerleme çubukları ve hız grafiği gerçek karakterlerle çizilir.
const ASCII = (() => {
  let cw = 8.4;
  let lh = 18;

  function measure() {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(100);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
    document.body.appendChild(probe);
    cw = probe.getBoundingClientRect().width / 100;
    probe.remove();
    lh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lh')) || 18;
  }

  const fit = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n)) : s);

  // +-[ BAŞLIK ]--------------------[ SAĞ ]-+
  // |                                       |
  // +---------------------------------------+
  function frame(cols, rows, title, right) {
    if (cols < 4 || rows < 2) return '';
    const inner = cols - 2;
    let top = '-'.repeat(inner);
    if (title) {
      const t = fit(`[ ${title} ]`, inner - 2);
      top = '-' + t + top.slice(t.length + 1);
    }
    if (right) {
      const r = fit(`[ ${right} ]`, Math.max(0, inner - (title ? title.length + 7 : 2)));
      if (r) top = top.slice(0, inner - r.length - 1) + r + '-';
    }
    const mid = '|' + ' '.repeat(inner) + '|';
    const lines = ['+' + top + '+'];
    for (let i = 0; i < rows - 2; i++) lines.push(mid);
    lines.push('+' + '-'.repeat(inner) + '+');
    return lines.join('\n');
  }

  // .box öğelerine karakter çerçevesi çizer; boyut değişince yeniden çizer.
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) draw(e.target.closest('.box'));
  });

  function draw(box) {
    if (!box) return;
    let pre = box.querySelector(':scope > .frame');
    if (!pre) {
      pre = document.createElement('pre');
      pre.className = 'frame';
      pre.setAttribute('aria-hidden', 'true');
      box.prepend(pre);
    }
    const inner = box.querySelector(':scope > .in');
    // Yüksekliği satır yüksekliğinin katına yuvarla ki alt kenar tam bir satıra otursun.
    if (inner && !box.hasAttribute('data-fill')) {
      const rows = Math.max(1, Math.ceil((inner.offsetHeight - 0.5) / lh)) + 2;
      const h = `${rows * lh}px`;
      if (box.style.height !== h) box.style.height = h;
    }
    const r = box.getBoundingClientRect();
    const cols = Math.floor((r.width + 0.5) / cw);
    const rows = Math.floor((r.height + 0.5) / lh);
    const txt = frame(cols, rows, box.dataset.title, box.dataset.right);
    if (pre.textContent !== txt) pre.textContent = txt;
  }

  function attach(box) {
    draw(box);
    ro.observe(box);
    const inner = box.querySelector(':scope > .in');
    if (inner) ro.observe(inner);
  }

  function attachAll(root = document) {
    root.querySelectorAll('.box').forEach(attach);
  }

  // Parçalı ilerleme: her bağlantının indirdiği bölge '#', aktif uç '>' ile gösterilir.
  //   [##########>.....#########>......####>......]
  function bar(width, pct, segments, opts = {}) {
    const w = Math.max(4, width - 2);
    const out = new Array(w).fill('.');
    if (opts.indeterminate) {
      const span = 5;
      const p = opts.tick % (2 * (w - span));
      const x = p < w - span ? p : 2 * (w - span) - p;
      for (let i = 0; i < span; i++) out[x + i] = '<=>'[Math.min(2, Math.floor((i * 3) / span))];
      return '[' + out.join('') + ']';
    }
    if (segments && segments.length > 1) {
      for (const [start, done, size] of segments) {
        const a = start * w;
        const filled = (start + done) * w;
        for (let i = Math.floor(a); i < Math.min(w, Math.floor(filled)); i++) out[i] = '#';
        if (done < size - 1e-9 && opts.active) {
          const head = Math.min(w - 1, Math.floor(filled));
          if (head >= Math.floor(a)) out[head] = '>';
        }
      }
    } else {
      const n = Math.round((pct / 100) * w);
      for (let i = 0; i < n; i++) out[i] = '#';
      if (opts.active && n < w) out[n] = '>';
    }
    return '[' + out.join('') + ']';
  }

  // Hız grafiği: sütun yüksekliği, en üst hücrede yarım adım için '.' kullanır.
  function spark(values, cols, rows) {
    const vals = values.slice(-cols);
    while (vals.length < cols) vals.unshift(0);
    const max = Math.max(...vals, 1);
    const lines = [];
    for (let r = rows - 1; r >= 0; r--) {
      let line = '';
      for (const v of vals) {
        const h = (v / max) * rows;
        line += h >= r + 1 ? '|' : h >= r + 0.5 ? '.' : r === 0 ? '_' : ' ';
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  return {
    measure, frame, draw, attach, attachAll, bar, spark,
    get cw() { return cw; },
    get lh() { return lh; },
  };
})();
