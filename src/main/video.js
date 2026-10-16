'use strict';
// Video indirme: sayfa adresini (YouTube, Vimeo, X, Instagram, ... ~1800 site) ya da
// eklentinin yakaladığı akış adresini (m3u8/mpd/mp4) yt-dlp'ye verir.
// yt-dlp ilk kullanımda GitHub'dan indirilir ve haftada bir güncellenir; siteler
// sık değiştiği için güncel olmayan yt-dlp en yaygın "video inmiyor" sebebidir.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { request } = require('./engine');
const { sanitizeFilename } = require('./util');

const WEEK = 7 * 24 * 3600 * 1000;

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) {
      const unpacked = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
      if (fs.existsSync(unpacked)) return unpacked;
      if (fs.existsSync(p)) return p;
    }
  } catch { /* paket yoksa sistemdekine bak */ }
  return null;
}

class YtDlp {
  constructor(binDir) {
    this.binDir = binDir;
    this.bin = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    this.pending = null;
  }

  async download() {
    await fsp.mkdir(this.binDir, { recursive: true });
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`;
    const res = await request(url, { timeout: 60000 });
    if (res.statusCode !== 200) { res.resume(); throw new Error(`yt-dlp indirilemedi (HTTP ${res.statusCode})`); }
    const tmp = this.bin + '.download';
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { mode: 0o755 });
      res.pipe(out);
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
    });
    await fsp.rename(tmp, this.bin);
    this.cachedVersion = undefined;
  }

  // Yoksa indir; eskiyse arka planda güncelle.
  async ensure() {
    if (!fs.existsSync(this.bin)) {
      this.pending = this.pending || this.download().finally(() => { this.pending = null; });
      await this.pending;
      return this.bin;
    }
    try {
      const st = await fsp.stat(this.bin);
      if (Date.now() - st.mtimeMs > WEEK && !this.pending) {
        this.pending = this.download().catch(() => {}).finally(() => { this.pending = null; });
      }
    } catch { /* yok say */ }
    return this.bin;
  }

  // Sürüm önbelleğe alınır: yt-dlp'yi her seferinde başlatmak 1-2 sn sürer.
  version() {
    if (this.cachedVersion !== undefined) return Promise.resolve(this.cachedVersion);
    return new Promise((resolve) => {
      if (!fs.existsSync(this.bin)) return resolve(null);
      execFile(this.bin, ['--version'], { windowsHide: true, timeout: 15000 }, (e, out) => {
        this.cachedVersion = e ? null : out.trim();
        resolve(this.cachedVersion);
      });
    });
  }
}

function netscapeCookies(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies || []) {
    const domain = c.hostOnly ? c.domain.replace(/^\./, '') : c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    lines.push([
      domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || 0), c.name, c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // yt-dlp birleştirme için ffmpeg başlatır; sadece yt-dlp'yi öldürmek ffmpeg'i yetim bırakır.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

function makeVideoTask(ytdlp) {
  return class VideoTask {
    constructor(item, manager) {
      this.item = item;
      this.m = manager;
      this.stopped = false;
      this.child = null;
    }

    async run() {
      const it = this.item;
      it.status = 'probing';
      it.note = 'yt-dlp hazırlanıyor…';
      this.m.touch(it);
      const bin = await ytdlp.ensure();
      if (this.stopped) return;

      // Önce sayfa adresi (en iyi kalite, doğru başlık), olmazsa yakalanan akışlar.
      const targets = [it.pageUrl || it.url, ...(it.candidates || [])].filter((v, i, a) => v && a.indexOf(v) === i);
      let lastErr;
      for (const target of targets) {
        try {
          await this.runOne(bin, target, target !== (it.pageUrl || it.url));
          return;
        } catch (e) {
          if (this.stopped) return;
          lastErr = e;
          this.m.log(it, `${target}: ${e.message}`);
        }
      }
      throw lastErr || new Error('İndirilecek video bulunamadı');
    }

    async runOne(bin, target, isRawStream) {
      const it = this.item;
      const audio = it.quality === 'audio';
      it.category = audio ? 'Müzik' : 'Video';
      const dir = this.m.targetDir(it);
      await fsp.mkdir(dir, { recursive: true });

      const title = it.title ? sanitizeFilename(it.title).slice(0, 150) : null;
      const template = isRawStream && title ? `${title}.%(ext)s` : '%(title).150B [%(id)s].%(ext)s';
      const args = [
        target, '--newline', '--progress', '--no-playlist', '--no-mtime', '--windows-filenames',
        '--no-colors', '-P', dir, '-o', template,
        '--progress-template', 'download:SDMP %(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s',
        '--print', 'before_dl:SDMT %(title)s', '--print', 'after_move:SDMF %(filepath)s', '--no-simulate',
      ];
      if (audio) {
        args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else {
        const cap = /^\d+$/.test(it.quality || '') ? `res:${it.quality},` : '';
        // mp4/m4a tercih: Windows'un kendi oynatıcısında da açılsın.
        args.push('-f', 'bv*+ba/b', '-S', `${cap}vcodec:h264,ext:mp4:m4a`, '--merge-output-format', 'mp4');
      }
      const ff = ffmpegPath();
      if (ff) args.push('--ffmpeg-location', ff);
      const h = it.headers || {};
      if (h['User-Agent']) args.push('--user-agent', h['User-Agent']);
      if (h.Referer) args.push('--referer', h.Referer);
      let cookieFile = null;
      if (it.cookies && it.cookies.length) {
        cookieFile = path.join(os.tmpdir(), `sdm-cookies-${it.id}-${Date.now()}.txt`);
        await fsp.writeFile(cookieFile, netscapeCookies(it.cookies), { mode: 0o600 });
        args.push('--cookies', cookieFile);
      }

      const parts = new Map();
      const errors = [];
      it.downloaded = 0;
      it.note = 'Video bilgisi alınıyor…';
      this.m.touch(it);

      try {
        await new Promise((resolve, reject) => {
          const child = spawn(bin, args, {
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
          });
          this.child = child;
          const onLine = (line) => {
            if (line.startsWith('SDMT ')) {
              const t = line.slice(5).trim();
              if (t && t !== 'NA') { it.filename = t; it.note = null; it.status = 'downloading'; this.m.touch(it); }
            } else if (line.startsWith('SDMF ')) {
              it.savePath = line.slice(5).trim();
              it.filename = path.basename(it.savePath);
            } else if (line.startsWith('SDMP ')) {
              const [fmt, done, total, est, speed] = line.slice(5).split('|');
              const tot = Number(total) || Number(est) || 0;
              parts.set(fmt, { done: Number(done) || 0, total: tot });
              let d = 0, t = 0;
              for (const p of parts.values()) { d += p.done; t += p.total; }
              it.downloaded = d;
              it.size = t || -1;
              it.reportedSpeed = Number(speed) || 0;
              if (it.status !== 'downloading') { it.status = 'downloading'; this.m.touch(it); }
              it.note = parts.size > 1 ? `Bölüm ${parts.size} (görüntü + ses)` : null;
            } else if (/^\[(Merger|ExtractAudio|FixupM3u8|VideoConvertor)\]/.test(line)) {
              it.note = line.includes('Merger') ? 'Görüntü ve ses birleştiriliyor…' : 'Dönüştürülüyor…';
              this.m.touch(it);
            }
          };
          let buf = '';
          child.stdout.on('data', (d) => {
            buf += d.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
          });
          child.stderr.on('data', (d) => {
            for (const l of d.toString('utf8').split(/\r?\n/)) if (l.startsWith('ERROR')) errors.push(l.replace(/^ERROR:\s*/, ''));
          });
          child.on('error', reject);
          child.on('close', (code) => {
            this.child = null;
            if (this.stopped) return resolve();
            if (code === 0) resolve();
            else reject(new Error(errors.at(-1) || `yt-dlp çıkış kodu ${code}`));
          });
        });
      } finally {
        if (cookieFile) fsp.rm(cookieFile, { force: true }).catch(() => {});
      }
      if (!this.stopped && it.size <= 0 && it.savePath) {
        try { it.size = it.downloaded = (await fsp.stat(it.savePath)).size; } catch { /* yok say */ }
      }
      it.note = null;
    }

    stop() {
      this.stopped = true;
      killTree(this.child);
    }
  };
}

module.exports = { YtDlp, makeVideoTask, netscapeCookies, ffmpegPath };
