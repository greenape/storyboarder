// Main-process side of the @electron/remote replacement.
//
// @electron/remote is deprecated and lets a renderer invoke arbitrary main-process
// objects. We replace it with an explicit, curated IPC surface: the renderer uses
// `shared/remote-compat` (a drop-in `remote`-shaped shim) which talks to the handlers
// registered here. Only the operations the app actually uses are exposed.
//
// Call install() once, early in main.js, after app/ipcMain exist.

const { app, ipcMain, dialog, BrowserWindow } = require('electron')
const prefs = require('../prefs')

// Window events the renderer subscribes to via remote.getCurrentWindow().on(...).
const WIN_EVENTS = [
  'focus', 'blur', 'resize', 'move', 'hide', 'show', 'close', 'closed',
  'maximize', 'unmaximize', 'minimize', 'restore',
  'enter-full-screen', 'leave-full-screen',
]

function forwardWindowEvents (win) {
  const send = (name) => {
    if (win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send('remote-compat:win-event', name)
  }
  for (const name of WIN_EVENTS) win.on(name, () => send(name))
}

function install () {
  // Mirror BrowserWindow events into the owning renderer so the shim can re-emit them.
  app.on('browser-window-created', (_event, win) => forwardWindowEvents(win))
  for (const win of BrowserWindow.getAllWindows()) forwardWindowEvents(win)

  // Synchronous method call on the sender's own window (minimize/hide/close/isFocused/…).
  // Non-serializable results (e.g. a returned BrowserWindow) come back as undefined.
  ipcMain.on('remote-compat:win-invoke', (event, method, args) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    try {
      const result = win ? win[method](...(args || [])) : undefined
      event.returnValue = isSerializable(result) ? result : undefined
    } catch (_e) {
      event.returnValue = undefined
    }
  })

  // Synchronous webContents call on the sender's window (openDevTools/…).
  ipcMain.on('remote-compat:webcontents-invoke', (event, method, args) => {
    try {
      const result = event.sender[method](...(args || []))
      event.returnValue = isSerializable(result) ? result : undefined
    } catch (_e) {
      event.returnValue = undefined
    }
  })

  // Synchronous app methods (getPath/getAppPath/getVersion/getName/…).
  ipcMain.on('remote-compat:app', (event, method, args) => {
    try {
      event.returnValue = app[method](...(args || []))
    } catch (_e) {
      event.returnValue = undefined
    }
  })

  // BrowserWindow-returning APIs (getAllWindows/getParentWindow/getChildWindows) can't
  // send real window objects over IPC, so they return serialisable snapshots that the
  // shim wraps in per-window proxies (id + url + focused/destroyed).
  ipcMain.on('remote-compat:all-windows', (event) => {
    try { event.returnValue = BrowserWindow.getAllWindows().map(windowSnapshot) } catch (_e) { event.returnValue = [] }
  })
  ipcMain.on('remote-compat:parent-window', (event) => {
    try {
      const p = BrowserWindow.fromWebContents(event.sender)?.getParentWindow()
      event.returnValue = p ? windowSnapshot(p) : null
    } catch (_e) { event.returnValue = null }
  })
  ipcMain.on('remote-compat:child-windows', (event) => {
    try {
      const kids = BrowserWindow.fromWebContents(event.sender)?.getChildWindows() || []
      event.returnValue = kids.map(windowSnapshot)
    } catch (_e) { event.returnValue = [] }
  })

  // Method call on a specific window by id (close/hide/…) — fire-and-forget.
  ipcMain.on('remote-compat:window-op', (_event, id, method, args) => {
    const w = BrowserWindow.fromId(id)
    try { if (w && !w.isDestroyed()) w[method](...(args || [])) } catch (_e) { /* ignore */ }
  })

  // webContents call on a specific window by id (undo/redo/copy/paste/send/…).
  ipcMain.on('remote-compat:webcontents-op', (_event, id, method, args) => {
    const w = BrowserWindow.fromId(id)
    try { if (w && !w.isDestroyed() && w.webContents) w.webContents[method](...(args || [])) } catch (_e) { /* ignore */ }
  })

  // remote.getCurrentWindow().webContents.devToolsWebContents.executeJavaScript(...)
  // (copy/paste while DevTools has focus) — fire-and-forget on the sender's devtools.
  ipcMain.on('remote-compat:devtools-exec', (event, code) => {
    try { event.sender.devToolsWebContents?.executeJavaScript(code) } catch (_e) { /* ignore */ }
  })

  // Synchronous global read (remote.getGlobal). Serializable values only.
  ipcMain.on('remote-compat:get-global', (event, name) => {
    const value = global[name]
    event.returnValue = isSerializable(value) ? value : undefined
  })

  // Async dialogs (showOpenDialog/showSaveDialog/showMessageBox) — parented to the
  // sender's window (matches remote.getCurrentWindow() semantics); a leading window
  // argument from the caller is dropped by the shim.
  ipcMain.handle('remote-compat:dialog', (event, method, args) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? dialog[method](win, ...(args || [])) : dialog[method](...(args || []))
  })

  // Sync dialogs (showMessageBoxSync/showErrorBox).
  ipcMain.on('remote-compat:dialog-sync', (event, method, args) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    try {
      event.returnValue = win && method === 'showMessageBoxSync'
        ? dialog[method](win, ...(args || []))
        : dialog[method](...(args || []))
    } catch (_e) {
      event.returnValue = undefined
    }
  })

  // remote.process.mainModule — only .filename is read (asar-path detection).
  ipcMain.on('remote-compat:main-module', (event) => {
    const m = process.mainModule || require.main
    event.returnValue = m && m.filename ? { filename: m.filename } : undefined
  })

  // remote.require('electron-is-dev')
  ipcMain.on('remote-compat:is-dev', (event) => {
    try { event.returnValue = require('electron-is-dev') } catch (_e) { event.returnValue = false }
  })

  // Shared main-process prefs instance (remote.require('./prefs')).
  // NB: these are sendSync — a thrown error would hang the calling renderer forever
  // (no reply), so every handler must set event.returnValue on all paths.
  ipcMain.on('remote-compat:prefs-get', (event, key) => {
    try { event.returnValue = prefs.getPrefs(key) } catch (_e) { event.returnValue = undefined }
  })
  ipcMain.on('remote-compat:prefs-set', (event, keyPath, value, sync) => {
    try { prefs.set(keyPath, value, sync) } catch (_e) { /* ignore */ }
    event.returnValue = true
  })
  ipcMain.on('remote-compat:prefs-save', (event) => {
    try { prefs.savePrefs() } catch (_e) { /* ignore */ }
    event.returnValue = true
  })
}

function windowSnapshot (w) {
  let url = ''
  try { url = w.webContents ? w.webContents.getURL() : '' } catch (_e) { url = '' }
  return { id: w.id, url, focused: !w.isDestroyed() && w.isFocused(), destroyed: w.isDestroyed() }
}

function isSerializable (value) {
  if (value === null || value === undefined) return true
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (t === 'function' || t === 'symbol') return false
  try {
    JSON.stringify(value)
    return true
  } catch (_e) {
    return false
  }
}

module.exports = { install }
