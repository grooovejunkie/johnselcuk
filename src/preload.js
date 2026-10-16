'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const h = (_e, v) => fn(v);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.off(ch, h);
};

contextBridge.exposeInMainWorld('sdm', {
  platform: process.platform,
  list: invoke('list'),
  add: invoke('add'),
  pause: invoke('pause'),
  resume: invoke('resume'),
  remove: invoke('remove'),
  pauseAll: invoke('pause-all'),
  resumeAll: invoke('resume-all'),
  clearCompleted: invoke('clear-completed'),
  openFile: invoke('open-file'),
  showInFolder: invoke('show-in-folder'),
  openDownloads: invoke('open-downloads'),
  probe: invoke('probe'),
  confirmPrompt: invoke('confirm-prompt'),
  getSettings: invoke('get-settings'),
  setSettings: invoke('set-settings'),
  chooseDir: invoke('choose-dir'),
  status: invoke('status'),
  openExtensionDir: invoke('open-extension-dir'),
  openExternal: invoke('open-external'),
  updateYtdlp: invoke('update-ytdlp'),
  readClipboard: invoke('read-clipboard'),
  onUpdate: on('update'),
  onRemoved: on('removed'),
  onPrompt: on('prompt'),
  onExtension: on('extension'),
});
