// contextIsolation preload for the auto-update window (update.html).
// Exposes only the two update events the page listens for. See
// docs/phase-1-electron-modernization.md.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('updater', {
  onProgress: (callback) => ipcRenderer.on('progress', (_event, progressObj) => callback(progressObj)),
  onReleaseNotes: (callback) => ipcRenderer.on('release-notes', (_event, releaseNotes) => callback(releaseNotes)),
})
