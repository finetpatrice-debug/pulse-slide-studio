const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('powerpointBridge', {
  isElectron: true,

  // Gestion du mode de fenêtre : 'trigger' (bouton compact en bas à droite du slide), 'panel' (barre de vote à droite), 'modal' (QR Code / PV)
  setWindowMode: (mode) => ipcRenderer.invoke('window:set-mode', mode),

  // Active ou désactive la traversée des clics vers PowerPoint (click-through)
  setIgnoreMouseEvents: (ignore) =>
    ipcRenderer.send('window:set-ignore-mouse-events', Boolean(ignore)),

  // Contrôles de fenêtre bureau (Minimiser, Maximiser, Fermer)
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // Commandes Microsoft PowerPoint (via COM Automation Windows)
  getStatus: () => ipcRenderer.invoke('ppt:status'),
  nextSlide: () => ipcRenderer.invoke('ppt:next'),
  prevSlide: () => ipcRenderer.invoke('ppt:prev'),
  gotoSlide: (slideNumber) => ipcRenderer.invoke('ppt:goto', slideNumber),
  startSlideShow: () => ipcRenderer.invoke('ppt:start-slideshow'),
  endSlideShow: () => ipcRenderer.invoke('ppt:end-slideshow'),

  // Nouvelles actions PowerPoint :
  // 1) Remplacer ClassPoint + QR code sur les slides de vote par "Vote en Direct" + QR code actif
  syncQrSlides: (qrDataUrl) => ipcRenderer.invoke('ppt:sync-qr-slides', qrDataUrl),

  // 2) Insérer automatiquement une diapositive de résultats juste en dessous du slide de vote
  insertResultSlide: (payload) => ipcRenderer.invoke('ppt:insert-result-slide', payload),

  // 3) Mettre à jour en direct le bouton intégré dans la diapositive PowerPoint (Vert = Lancer / Orange = Clôturer + nb de votes)
  updateSlideButton: (payload) => ipcRenderer.invoke('ppt:update-slide-button', payload),
});
