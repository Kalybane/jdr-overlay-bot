const { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─────────────────────────────────────────────
// CONFIG — le vrai mot de passe vit UNIQUEMENT dans electron-app/.env
// (jamais en dur ici, ce fichier main.js est public sur GitHub)
// ─────────────────────────────────────────────
const WS_URL = process.env.WS_URL || 'wss://jdr-overlay-bot.onrender.com';
const WS_PASSWORD = process.env.WS_PASSWORD || 'change_moi_avec_un_mot_de_passe_fort';

let win;
let tray;

// ─────────────────────────────────────────────
// DÉMARRAGE AUTOMATIQUE AU LANCEMENT DE WINDOWS
// ─────────────────────────────────────────────
app.setLoginItemSettings({
  openAtLogin: true,
  openAsHidden: true, // ne pas ouvrir de fenêtre visible au démarrage, juste l'icône en tray
});

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false, // pour ne pas voler le focus au jeu/aux apps en dessous
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setIgnoreMouseEvents(true); // le clic traverse l'overlay

  // Éviter le cache Chromium qui garde une ancienne config/URL en mémoire
  win.webContents.session.clearCache().then(() => {
    win.loadFile(path.join(__dirname, 'index.html'));
  });

  // On passe l'URL WS et le mot de passe à la page via une variable globale
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      window.__WS_URL__ = ${JSON.stringify(WS_URL)};
      window.__WS_PASSWORD__ = ${JSON.stringify(WS_PASSWORD)};
      window.dispatchEvent(new Event('overlay-config-ready'));
    `);
  });
}

// ─────────────────────────────────────────────
// ICÔNE DANS LA ZONE DE NOTIFICATION (SYSTEM TRAY)
// ─────────────────────────────────────────────
function createTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const trayIcon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(trayIcon);

  updateTrayStatus('connecting');

  tray.on('double-click', () => {
    // Double-clic sur l'icône : rien de spécial pour l'instant (l'overlay n'a pas de fenêtre à afficher)
  });
}

function updateTrayStatus(status) {
  if (!tray) return;

  const labels = {
    connected: '🟢 JDR Overlay — Connecté',
    connecting: '🟡 JDR Overlay — Connexion...',
    disconnected: '🔴 JDR Overlay — Déconnecté',
  };

  tray.setToolTip(labels[status] || 'JDR Overlay');

  const contextMenu = Menu.buildFromTemplate([
    { label: labels[status] || 'JDR Overlay', enabled: false },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
}

// Le renderer (index.html, via preload.js) informe le process principal
// des changements de statut de connexion, pour mettre à jour le tray.
ipcMain.on('connection-status', (event, status) => {
  updateTrayStatus(status);
});

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
