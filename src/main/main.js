'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { DownloadManager, probe } = require('./engine');
const { YtDlp, makeVideoTask } = require('./video');
const { startBridge, PORT } = require('./bridge');
const { formatBytes } = require('./util');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath('userData');
const settingsPath = path.join(userData, 'settings.json');
const DEFAULTS = {
  downloadDir: path.join(app.getPath('downloads'), 'SDM'),
  segments: 8,
  maxConcurrent: 3,
  sortByCategory: true,
  speedLimit: 0,
  autoResume: true,
  askBeforeDownload: true,
  startAtLogin: false,
  closeToTray: true,
  videoQuality: 'best',
  notify: true,
};
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); } catch { /* ilk çalıştırma */ }
const saveSettings = () => {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
};

const ytdlp = new YtDlp(path.join(userData, 'bin'));
const manager = new DownloadManager({
  statePath: path.join(userData, 'downloads.json'),
  settings,
  runners: { video: makeVideoTask(ytdlp) },
});

let win = null;
let tray = null;
let quitting = false;
let bridgeStatus = { ok: false, port: PORT, error: null };
let lastExtensionPing = 0;
const prompts = new Map();

const iconPath = path.join(__dirname, '..', 'renderer', 'icon.png');
const extensionDir = app.isPackaged
  ? path.join(process.resourcesPath, 'extension')
  : path.join(__dirname, '..', '..', 'extension');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: '#0a0b0a',
    icon: iconPath,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#0a0b0a', symbolColor: '#4dff88', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
  // Dış bağlantılar uygulama içinde değil, varsayılan tarayıcıda açılsın.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('SDM — İndirme Yöneticisi');
  const menu = Menu.buildFromTemplate([
    { label: 'SDM\'yi göster', click: showWindow },
    { label: 'Panodaki adresi indir', click: () => {
      const t = clipboard.readText().trim();
      if (/^https?:\/\//i.test(t)) { showWindow(); send('prompt', makePrompt({ kind: 'http', url: t })); }
    } },
    { type: 'separator' },
    { label: 'Tümünü duraklat', click: () => manager.list().forEach((d) => manager.pause(d.id)) },
    { label: 'Tümünü sürdür', click: () => manager.list().forEach((d) => d.status === 'paused' && manager.resume(d.id)) },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

function makePrompt(req) {
  const id = Math.random().toString(36).slice(2);
  const p = { id, quality: settings.videoQuality, ...req };
  prompts.set(id, p);
  return p;
}

function headersFrom(body) {
  const h = {};
  if (body.userAgent) h['User-Agent'] = body.userAgent;
  if (body.referrer) h.Referer = body.referrer;
  if (body.cookieHeader) h.Cookie = body.cookieHeader;
  return h;
}

function enqueue(req) {
  if (settings.askBeforeDownload) {
    showWindow();
    send('prompt', makePrompt(req));
    return { prompted: true };
  }
  return { item: manager.add(req) };
}

async function setupBridge() {
  try {
    await startBridge({
      version: app.getVersion(),
      onPing: () => { lastExtensionPing = Date.now(); send('extension', true); return {}; },
      onDownload: (b) => enqueue({
        kind: 'http',
        url: b.url,
        filename: b.filename || undefined,
        headers: headersFrom(b),
        size: b.fileSize,
      }),
      onVideo: (b) => enqueue({
        kind: 'video',
        url: b.pageUrl || b.url,
        pageUrl: b.pageUrl,
        candidates: b.candidates || [],
        title: b.title,
        cookies: b.cookies,
        headers: headersFrom(b),
        quality: b.quality,
      }),
    });
    bridgeStatus = { ok: true, port: PORT, error: null };
  } catch (e) {
    bridgeStatus = {
      ok: false,
      port: PORT,
      error: e.code === 'EADDRINUSE' ? `${PORT} portu başka bir program tarafından kullanılıyor` : e.message,
    };
  }
}

manager.on('update', (v) => send('update', v));
manager.on('removed', (id) => send('removed', id));
manager.on('completed', (v) => {
  if (settings.notify && Notification.isSupported()) {
    const n = new Notification({ title: 'İndirme tamamlandı', body: `${v.filename} · ${formatBytes(v.size)}`, icon: iconPath });
    n.on('click', () => v.savePath && shell.showItemInFolder(v.savePath));
    n.show();
  }
});

// ---- IPC --------------------------------------------------------------------
ipcMain.handle('list', () => manager.list());
ipcMain.handle('add', (_e, req) => manager.add(req));
ipcMain.handle('pause', (_e, id) => manager.pause(id));
ipcMain.handle('resume', (_e, id) => manager.resume(id));
ipcMain.handle('remove', (_e, id, del) => manager.remove(id, del));
ipcMain.handle('pause-all', () => manager.list().forEach((d) => manager.pause(d.id)));
ipcMain.handle('resume-all', () => manager.list().forEach((d) => ['paused', 'error'].includes(d.status) && manager.resume(d.id)));
ipcMain.handle('clear-completed', () => manager.list().filter((d) => d.status === 'completed').forEach((d) => manager.remove(d.id, false)));
ipcMain.handle('open-file', (_e, p) => p && fs.existsSync(p) && shell.openPath(p));
ipcMain.handle('show-in-folder', (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  else shell.openPath(settings.downloadDir);
});
ipcMain.handle('open-downloads', () => { fs.mkdirSync(settings.downloadDir, { recursive: true }); shell.openPath(settings.downloadDir); });
ipcMain.handle('probe', async (_e, url, headers) => {
  try { return await probe(url, headers || {}); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('confirm-prompt', (_e, id, overrides) => {
  const p = prompts.get(id);
  prompts.delete(id);
  if (!p || !overrides) return null;
  return manager.add({ ...p, ...overrides });
});
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (_e, patch) => {
  const allowed = Object.keys(DEFAULTS);
  for (const k of Object.keys(patch)) if (allowed.includes(k)) settings[k] = patch[k];
  settings.segments = Math.max(1, Math.min(32, Number(settings.segments) || 8));
  settings.maxConcurrent = Math.max(1, Math.min(10, Number(settings.maxConcurrent) || 3));
  settings.speedLimit = Math.max(0, Number(settings.speedLimit) || 0);
  saveSettings();
  if (process.platform !== 'linux') app.setLoginItemSettings({ openAtLogin: !!settings.startAtLogin, args: ['--hidden'] });
  manager.pump();
  return settings;
});
ipcMain.handle('choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.downloadDir });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('status', async () => ({
  bridge: bridgeStatus,
  extensionSeen: Date.now() - lastExtensionPing < 60000,
  ytdlp: await ytdlp.version(),
  version: app.getVersion(),
  extensionDir,
}));
ipcMain.handle('open-extension-dir', () => shell.openPath(extensionDir));
ipcMain.handle('open-external', (_e, url) => /^https?:\/\//.test(url) && shell.openExternal(url));
ipcMain.handle('update-ytdlp', async () => {
  try { await ytdlp.download(); return { ok: true, version: await ytdlp.version() }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle('read-clipboard', () => clipboard.readText());

// ---- yaşam döngüsü ------------------------------------------------------------
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; manager.shutdown(); });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('activate', showWindow);

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.johnselcuk.sdm');
  await setupBridge();
  createWindow();
  createTray();
  // yt-dlp'yi arka planda hazırla ki ilk video indirmesi beklemesin.
  ytdlp.ensure().catch(() => {});
});
