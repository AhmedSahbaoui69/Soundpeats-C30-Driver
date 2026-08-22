'use strict';

// Exposes an API to the renderer via the context bridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundpeats', {
  getStatus: () => ipcRenderer.invoke('soundpeats:status'),
  refresh: () => ipcRenderer.invoke('soundpeats:refresh'),
  send: (cmd, payload) => ipcRenderer.invoke('soundpeats:send', cmd, payload),
  queryBattery: () => ipcRenderer.invoke('soundpeats:queryBattery'),
  queryMode: () => ipcRenderer.invoke('soundpeats:queryMode'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('soundpeats:status', listener);
    return () => ipcRenderer.removeListener('soundpeats:status', listener);
  },
});
