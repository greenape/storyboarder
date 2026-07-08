// Main-process creation of the two windows the main-window renderer used to spawn
// itself via `new remote.BrowserWindow(...)`. With @electron/remote removed, window
// construction must happen in main; the renderer just sends a trigger.
//
// - export-web  (upload.html):  the storyboarders.com sign-in / upload modal
// - import      (import-window.html):  the worksheet import modal
//
// Both are modal children of the sender's window. Their renderers talk to main
// through shared/remote-compat like every other window (no remote.enable needed).

const { app, ipcMain, BrowserWindow } = require('electron')
const path = require('path')

let exportWebWindow = null
let importWindow = null

const pageUrl = (file) => `file://${path.join(app.getAppPath(), 'src', file)}`

// Suppress app-menu accelerators while a form window has focus, so a plain key
// (e.g. 'b') types instead of triggering a tool. This is the surviving half of these
// windows' old renderer before-input-event handlers — webContents.on is a no-op in the
// remote-compat shim, and before-input-event must be handled here in main anyway
// (its setIgnoreMenuShortcuts is synchronous). Exported so registration/main.js reuses it.
function guardFormMenuShortcuts (win) {
  win.webContents.on('before-input-event', (_event, input) => {
    if (win.isDestroyed()) return
    win.webContents.setIgnoreMenuShortcuts(!input.control && !input.meta)
  })
}

function install () {
  // showSignInWindow() in main-window.js
  ipcMain.on('child-window:open-export-web', (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (exportWebWindow && !exportWebWindow.isDestroyed()) exportWebWindow.destroy()
    exportWebWindow = new BrowserWindow({
      width: 1200, height: 800, minWidth: 600, minHeight: 600,
      backgroundColor: '#333333', show: false, center: true, parent,
      resizable: true, frame: false, modal: true,
      webPreferences: {
        webgl: true, experimentalFeatures: true, devTools: true, plugins: true,
        nodeIntegration: true, contextIsolation: false,
      },
    })
    guardFormMenuShortcuts(exportWebWindow)
    exportWebWindow.loadURL(pageUrl('upload.html'))
    exportWebWindow.once('ready-to-show', () => exportWebWindow.show())
    exportWebWindow.on('hide', () => {
      if (parent && !parent.isDestroyed()) parent.webContents.send('textInputMode', false)
    })
    exportWebWindow.on('closed', () => { exportWebWindow = null })
  })

  // ipcRenderer.on('importWorksheets', …) in main-window.js
  ipcMain.on('child-window:open-import', (event, args) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!importWindow || importWindow.isDestroyed()) {
      importWindow = new BrowserWindow({
        width: 1200, height: 800, minWidth: 600, minHeight: 600,
        backgroundColor: '#333333', show: false, center: true, parent,
        resizable: true, frame: false, modal: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      })
      guardFormMenuShortcuts(importWindow)
      importWindow.loadURL(pageUrl('import-window.html'))
      importWindow.on('closed', () => { importWindow = null })
    } else if (!importWindow.isVisible()) {
      importWindow.webContents.send('worksheetImage', args)
    }
    importWindow.once('ready-to-show', () => importWindow.webContents.send('worksheetImage', args))
  })
}

module.exports = { install, guardFormMenuShortcuts }
