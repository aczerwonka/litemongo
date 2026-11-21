import path from 'node:path';
import { app, BrowserWindow, Menu, session, shell, dialog } from 'electron';
import { buildApp } from '../../server/src/app.ts';

// A FIXED port keeps the web origin stable: connection profiles live in the
// renderer's localStorage, which is scoped per origin (a random port would
// silently "lose" them on every launch).
const PREFERRED_PORT = Number(process.env.LITEMONGO_DESKTOP_PORT ?? 38017);
const HOST = '127.0.0.1';

const clientDist = app.isPackaged
  ? path.join(process.resourcesPath, 'client')
  : path.resolve(import.meta.dirname, '../../client/dist');

let server;
let win;

async function startServer() {
  server = await buildApp({ logger: false, clientDist });
  try {
    await server.listen({ port: PREFERRED_PORT, host: HOST });
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;
    await server.listen({ port: 0, host: HOST }); // fallback; profiles will not carry over
  }
  const addr = server.server.address();
  return typeof addr === 'object' && addr ? addr.port : PREFERRED_PORT;
}

async function createWindow() {
  const port = await startServer();
  const origin = `http://${HOST}:${port}`;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#09090b',
    title: 'LiteMongo',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Anything that is not our own server opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  // The PWA service worker precaches the client and serves it cache-first, so a
  // rebuilt client would only show up after a second reload. The desktop app
  // talks to its own local server and needs no offline cache: drop it on start.
  await session.defaultSession.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] });
  await win.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
    try {
      await createWindow();
    } catch (err) {
      dialog.showErrorBox('LiteMongo', `Failed to start: ${err instanceof Error ? err.message : String(err)}`);
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { void server?.close(); });
}
