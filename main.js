'use strict';

// Electron main process for the SOUNDPEATS C30 desktop app.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { SoundpeatsApp } = require('./src/app');

let mainWindow = null;
let controller = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: '#0b0f1a',
    title: 'SOUNDPEATS C30',
    frame: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Block the developer tools keyboard shortcuts (F12, Ctrl/Cmd+Shift+I/J/C).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      event.preventDefault();
    } else if ((input.control || input.meta) && input.shift) {
      const k = (input.key || '').toLowerCase();
      if (k === 'i' || k === 'j' || k === 'c') event.preventDefault();
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'web', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  controller = new SoundpeatsApp();

  // Push status updates to the renderer whenever anything changes.
  controller.on('status', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('soundpeats:status', controller.getStatus());
    }
  });

  ipcMain.handle('soundpeats:status', () => controller.getStatus());

  ipcMain.handle('soundpeats:refresh', () => controller.refresh());

  ipcMain.handle('soundpeats:send', async (_event, cmd, payload) => {
    const ok = await controller.sendCommand(cmd, payload);
    return { ok, error: controller.lastError };
  });

  ipcMain.handle('soundpeats:queryBattery', async () => {
    await controller.queryBattery();
    return controller.getStatus();
  });

  ipcMain.handle('soundpeats:queryMode', async () => {
    await controller.queryMode();
    return controller.getStatus();
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (controller) controller.disconnect();
});
