const { contextBridge, ipcRenderer } = require('electron');

// Pont sécurisé entre la page (index.html) et le process principal (main.js),
// utilisé uniquement pour remonter le statut de connexion WebSocket vers le tray.
contextBridge.exposeInMainWorld('electronAPI', {
  setConnectionStatus: (status) => ipcRenderer.send('connection-status', status),
});
