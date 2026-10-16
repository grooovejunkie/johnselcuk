'use strict';
const fs = require('fs');
const path = require('path');

const CATEGORIES = {
  Video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm3u8'],
  Müzik: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma'],
  Arşiv: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'zst'],
  Belgeler: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'odt', 'epub', 'csv'],
  Programlar: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'apk', 'iso', 'img'],
  Resimler: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'heic'],
};

function categoryOf(filename) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  for (const [cat, exts] of Object.entries(CATEGORIES)) if (exts.includes(ext)) return cat;
  return 'Diğer';
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Windows'ta da geçerli olacak dosya adı üretir.
function sanitizeFilename(name) {
  let n = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!n) n = 'indirme';
  if (WIN_RESERVED.test(n)) n = '_' + n;
  if (Buffer.byteLength(n) > 200) {
    const ext = path.extname(n).slice(0, 16);
    let base = n.slice(0, n.length - ext.length);
    while (Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
    n = base + ext;
  }
  return n;
}

// RFC 6266 Content-Disposition: filename*=UTF-8''... öncelikli, sonra filename="..."
function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch { /* bozuk kodlama: düz filename'e düş */ }
  }
  const plain = /filename\s*=\s*("((?:\\.|[^"])*)"|[^;]+)/i.exec(header);
  if (plain) {
    let v = plain[2] !== undefined ? plain[2].replace(/\\(.)/g, '$1') : plain[1].trim();
    // Bazı sunucular UTF-8 baytlarını latin1 olarak gönderir.
    try {
      const fixed = Buffer.from(v, 'latin1').toString('utf8');
      if (!fixed.includes('�')) v = fixed;
    } catch { /* olduğu gibi bırak */ }
    return v;
  }
  return null;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
    return u.hostname;
  } catch {
    return null;
  }
}

// Hedef klasörde (ve aktif .part dosyalarında) çakışmayan bir ad bulur: "dosya (1).zip"
function uniquePath(dir, filename, reserved = new Set()) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const name = i === 0 ? filename : `${base} (${i})${ext}`;
    const full = path.join(dir, name);
    if (!reserved.has(full) && !fs.existsSync(full) && !fs.existsSync(full + '.sdmpart')) return full;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

module.exports = { CATEGORIES, categoryOf, sanitizeFilename, filenameFromDisposition, filenameFromUrl, uniquePath, formatBytes };
