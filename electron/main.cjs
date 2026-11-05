const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { PowerPointBridge } = require('./pptBridge.cjs');

process.on('uncaughtException', (err) => {
  console.error('[Main Process Uncaught Exception]', err);
});

// Stocker le cache Electron localement dans le dossier du projet
const localUserDataDir = path.join(__dirname, '..', '.electron-data-ui');
const localCacheDir = path.join(localUserDataDir, 'cache');
try {
  fs.mkdirSync(localCacheDir, { recursive: true });
  app.setPath('userData', localUserDataDir);
  app.setPath('sessionData', path.join(localUserDataDir, 'session'));
  app.commandLine.appendSwitch('disk-cache-dir', localCacheDir);
} catch {}

let mainWindow = null;
let pptBridge = null;

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

function extractUrlFromArgs(argv) {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('http://localhost:5173')) {
      return arg;
    }
  }
  return null;
}

function applyWindowLayoutMode(mode) {
  if (!mainWindow) return;
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint) || screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;

  if (mode === 'trigger') {
    // Mini barre discrète tout en haut à droite de l'écran pour laisser la diapositive PowerPoint 100% visible
    const barW = 430;
    const barH = 120;
    mainWindow.setBounds({
      x: x + width - barW - 16,
      y: y + 12,
      width: barW,
      height: barH,
    });
  } else if (mode === 'panel') {
    // Panneau latéral compact à droite de la slide PowerPoint
    const panelW = 440;
    const panelH = Math.min(640, height - 40);
    mainWindow.setBounds({
      x: x + width - panelW - 16,
      y: y + Math.floor((height - panelH) / 2),
      width: panelW,
      height: panelH,
    });
  } else {
    // Fenêtre centrée (uniquement pour le Procès-Verbal & Export CSV)
    const modalW = Math.min(920, width - 60);
    const modalH = Math.min(640, height - 60);
    mainWindow.setBounds({
      x: x + Math.floor((width - modalW) / 2),
      y: y + Math.floor((height - modalH) / 2),
      width: modalW,
      height: modalH,
    });
  }

  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  mainWindow.show();
  mainWindow.moveTop();
}

function positionWindowForUrl(url) {
  if (!mainWindow) return;
  if (url && url.includes('pptAction=history')) {
    applyWindowLayoutMode('modal');
  } else {
    // Par défaut, mini-barre discrète en haut à droite pour que tout se passe directement DANS le slide PowerPoint !
    applyWindowLayoutMode('trigger');
  }
}

function createMainWindow(initialUrl) {
  const targetUrl = initialUrl || extractUrlFromArgs(process.argv) || `${DEV_SERVER_URL}/?pptAction=qr`;

  mainWindow = new BrowserWindow({
    width: 920,
    height: 660,
    transparent: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#020617',
    resizable: true,
    show: true,
    alwaysOnTop: true,
    title: 'Vote en Direct — PowerPoint (OUI / NON / ABSTENTION)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  positionWindowForUrl(targetUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const child = new BrowserWindow({
      width: 430,
      height: 780,
      title: 'Téléphone Votant (Simulation)',
      autoHideMenuBar: true,
      alwaysOnTop: true,
    });
    child.loadURL(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(targetUrl);

  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (mainWindow) {
        mainWindow.loadURL(targetUrl);
      }
    }, 800);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const passedUrl = extractUrlFromArgs(commandLine);
    if (mainWindow) {
      if (passedUrl) {
        positionWindowForUrl(passedUrl);
        mainWindow.loadURL(passedUrl);
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  app.whenReady().then(() => {
    pptBridge = new PowerPointBridge();
    createMainWindow();

    ipcMain.handle('window:set-mode', (_event, mode) => {
      applyWindowLayoutMode(mode);
      return { mode };
    });

    ipcMain.on('window:set-ignore-mouse-events', () => {});

    ipcMain.on('window:minimize', () => {
      if (mainWindow) mainWindow.minimize();
    });

    ipcMain.on('window:maximize', () => {
      if (!mainWindow) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    });

    ipcMain.on('window:close', () => {
      if (mainWindow) mainWindow.close();
    });

    ipcMain.handle('ppt:status', async () => {
      if (!pptBridge) return null;
      return await pptBridge.sendCommand('STATUS');
    });

    ipcMain.handle('ppt:next', async () => {
      if (!pptBridge) return null;
      return await pptBridge.sendCommand('NEXT');
    });

    ipcMain.handle('ppt:prev', async () => {
      if (!pptBridge) return null;
      return await pptBridge.sendCommand('PREV');
    });

    ipcMain.handle('ppt:goto', async (_event, slideNumber) => {
      if (!pptBridge) return null;
      return await pptBridge.sendCommand(`GOTO:${Number(slideNumber) || 1}`);
    });

    ipcMain.handle('ppt:start-slideshow', async () => {
      if (!pptBridge) return null;
      return await pptBridge.sendCommand('START_SLIDESHOW');
    });

    ipcMain.handle('ppt:end-slideshow', async () => {
      if (!pptBridge) return null;
      return await pptBridge.sendCommand('END_SLIDESHOW');
    });

    ipcMain.handle('ppt:sync-qr-slides', async (_event, qrDataUrl) => {
      try {
        if (typeof qrDataUrl === 'string' && qrDataUrl.startsWith('data:image/png;base64,')) {
          const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
          const slidesDir = path.join(__dirname, '..', 'public', 'slides');
          fs.mkdirSync(slidesDir, { recursive: true });
          fs.writeFileSync(path.join(slidesDir, 'qr-session.png'), Buffer.from(base64, 'base64'));
        }
      } catch {}
      if (!pptBridge) return null;
      return await pptBridge.sendCommand('SYNC_QR_SLIDES', 6000);
    });

    ipcMain.handle('ppt:insert-result-slide', async (_event, payload) => {
      if (!pptBridge) return null;
      const b64 = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
      return await pptBridge.sendCommand(`INSERT_RESULT_SLIDE:${b64}`, 6000);
    });

    ipcMain.handle('ppt:update-slide-button', async (_event, payload) => {
      if (!pptBridge) return null;
      const b64 = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
      return await pptBridge.sendCommand(`UPDATE_SLIDE_BTN:${b64}`, 4000);
    });
  });
}

app.on('window-all-closed', () => {
  if (pptBridge) {
    pptBridge.destroy();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
