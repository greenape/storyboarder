// Thin renderer-side client for the Shot Explorer window, which is now created and
// owned by the main process (main/shot-explorer-window.js) instead of via
// remote.BrowserWindow. getWindow() returns a small proxy that forwards the only
// operations callers use — isDestroyed(), destroy(), and webContents.send() — over IPC.

const { ipcRenderer } = require('electron')

let created = false
let destroyed = false
let loaded = false
let onCompleteCb = null

ipcRenderer.on('shot-explorer:ready', () => {
  loaded = true
  if (onCompleteCb) onCompleteCb()
})
ipcRenderer.on('shot-explorer:closed', () => {
  created = false
  destroyed = true
})

const winProxy = {
  isDestroyed: () => destroyed,
  destroy: () => ipcRenderer.send('shot-explorer:destroy'),
  webContents: {
    send: (channel, ...args) => ipcRenderer.send('shot-explorer:relay', channel, args),
  },
}

const createWindow = async (onComplete /*, aspectRatio */) => {
  if (created) return
  created = true
  destroyed = false
  onCompleteCb = onComplete
  ipcRenderer.send('shot-explorer:create')
}

const reveal = () => ipcRenderer.send('shot-explorer:reveal')

module.exports = {
  createWindow,
  getWindow: () => (created && !destroyed ? winProxy : null),
  reveal,
  isLoaded: () => loaded,
}
