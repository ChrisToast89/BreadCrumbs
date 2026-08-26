import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppInfo, IpcChannel, IpcContract, Platform } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Register one IPC handler, typed against the contract in shared/types.ts.
 * Using this instead of a bare `ipcMain.handle` keeps channel names and payload
 * shapes from drifting apart between the two processes.
 */
function handle<C extends IpcChannel>(
  channel: C,
  handler: (request: IpcContract[C]['request']) => Promise<IpcContract[C]['response']> | IpcContract[C]['response'],
): void {
  ipcMain.handle(channel, (_event, request) => handler(request));
}

function registerHandlers(): void {
  handle('app:info', (): AppInfo => ({
    name: 'BreadCrumbs',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    // SPEC §1 targets Windows, macOS and Linux; no other platform is supported.
    platform: process.platform as Platform,
  }));
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    // SPEC §7 lays out three panes across a minimum useful width; the phase 5
    // gate requires a clean resize down to 1100px, so that is the floor.
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101014',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Nothing in this application should navigate away or spawn a browser window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

void app.whenReady().then(() => {
  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
