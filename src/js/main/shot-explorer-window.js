// Main-process creation of the Shot Explorer window (formerly created from the
// shot-generator renderer via remote.BrowserWindow in windows/shot-explorer/setup.js).
// The renderer drives it over IPC (create / reveal / relay / destroy) and receives
// ready / closed notifications; setup.js is now a thin client of these handlers.

const { app, ipcMain, BrowserWindow } = require('electron')
const path = require('path')
const url = require('url')

let win = null
let memento = { x: undefined, y: undefined, width: 1505, height: 1080 }

function install () {
  ipcMain.on('shot-explorer:create', (event) => {
    if (win && !win.isDestroyed()) return
    const opener = event.sender
    const { x, y, width, height } = memento
    win = new BrowserWindow({
      x, y, width, height,
      show: false, center: true, frame: true,
      backgroundColor: '#333333', titleBarStyle: 'hiddenInset',
      title: 'Shot Explorer', acceptFirstMouse: true, simpleFullscreen: true,
      webPreferences: {
        nodeIntegration: true, plugins: true, webSecurity: false,
        allowRunningInsecureContent: true, experimentalFeatures: true,
        backgroundThrottling: true, contextIsolation: false,
      },
    })
    win.on('resize', () => { memento = win.getBounds() })
    win.on('move', () => { memento = win.getBounds() })
    win.webContents.on('will-prevent-unload', (e) => {
      e.preventDefault()
      if (win && !win.isDestroyed()) win.hide()
    })
    win.once('closed', () => {
      win = null
      if (!opener.isDestroyed()) opener.send('shot-explorer:closed')
    })
    win.loadURL(url.format({
      pathname: path.join(app.getAppPath(), 'src', 'shot-explorer.html'),
      protocol: 'file:',
      slashes: true,
    }))
    win.once('ready-to-show', () => {
      if (!opener.isDestroyed()) opener.send('shot-explorer:ready')
    })
  })

  ipcMain.on('shot-explorer:reveal', () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus() }
  })
  ipcMain.on('shot-explorer:relay', (_event, channel, args) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...(args || []))
  })
  ipcMain.on('shot-explorer:destroy', () => {
    if (win && !win.isDestroyed()) win.destroy()
  })
}

module.exports = { install }
