// Renderer-side drop-in replacement for @electron/remote.
//
// A file that did `const remote = require('@electron/remote')` becomes
// `const remote = require('<rel>/shared/remote-compat')` and keeps calling the same
// API; each call is an explicit IPC to the curated handlers in main/remote-bridge.js.
// This removes the deprecated @electron/remote dependency without a per-call-site
// rewrite. (Requires nodeIntegration; superseded by a contextBridge preload when the
// windows move to contextIsolation.)
//
// Not covered on purpose: constructing windows from the renderer
// (`new remote.BrowserWindow(...)`) — those sites move to an explicit main-process
// window-open IPC instead, and hit the throw below if missed.

const { ipcRenderer, shell, clipboard, nativeImage } = require('electron')
const { EventEmitter } = require('events')

// Forwarded BrowserWindow events (main/remote-bridge.js) re-emitted locally so that
// remote.getCurrentWindow().on('focus', …) keeps working.
const winEmitter = new EventEmitter()
winEmitter.setMaxListeners(0)
ipcRenderer.on('remote-compat:win-event', (_e, name) => winEmitter.emit(name))

const WINDOW_METHODS = [
  'minimize', 'maximize', 'unmaximize', 'isMaximized', 'restore', 'close', 'destroy',
  'hide', 'show', 'showInactive', 'focus', 'blur', 'isFocused', 'isVisible',
  'isDestroyed', 'setSize', 'getSize', 'setBounds', 'getBounds', 'setContentSize',
  'getContentSize', 'setFullScreen', 'isFullScreen', 'setResizable', 'center',
  'setAlwaysOnTop', 'setTitle', 'getTitle', 'reload', 'setMenuBarVisibility',
  'setPosition', 'getPosition', 'flashFrame', 'setProgressBar',
]

const currentWebContents = {
  openDevTools: (...a) => ipcRenderer.sendSync('remote-compat:webcontents-invoke', 'openDevTools', a),
  closeDevTools: (...a) => ipcRenderer.sendSync('remote-compat:webcontents-invoke', 'closeDevTools', a),
  isDevToolsOpened: (...a) => ipcRenderer.sendSync('remote-compat:webcontents-invoke', 'isDevToolsOpened', a),
  toggleDevTools: (...a) => ipcRenderer.sendSync('remote-compat:webcontents-invoke', 'toggleDevTools', a),
}

const currentWindow = {
  __isRemoteCompatWindow: true,
  webContents: currentWebContents,
  on: (ev, cb) => (winEmitter.on(ev, cb), currentWindow),
  addListener: (ev, cb) => (winEmitter.on(ev, cb), currentWindow),
  once: (ev, cb) => (winEmitter.once(ev, cb), currentWindow),
  off: (ev, cb) => (winEmitter.off(ev, cb), currentWindow),
  removeListener: (ev, cb) => (winEmitter.removeListener(ev, cb), currentWindow),
  removeAllListeners: (ev) => (winEmitter.removeAllListeners(ev), currentWindow),
}
for (const m of WINDOW_METHODS) {
  currentWindow[m] = (...args) => ipcRenderer.sendSync('remote-compat:win-invoke', m, args)
}

// Dialogs parent to the sender's window in main, so drop any leading window argument.
const stripWindowArg = (args) =>
  args.length && args[0] && args[0].__isRemoteCompatWindow ? args.slice(1) : args

const dialog = {
  showOpenDialog: (...a) => ipcRenderer.invoke('remote-compat:dialog', 'showOpenDialog', stripWindowArg(a)),
  showSaveDialog: (...a) => ipcRenderer.invoke('remote-compat:dialog', 'showSaveDialog', stripWindowArg(a)),
  showMessageBox: (...a) => ipcRenderer.invoke('remote-compat:dialog', 'showMessageBox', stripWindowArg(a)),
  showMessageBoxSync: (...a) => ipcRenderer.sendSync('remote-compat:dialog-sync', 'showMessageBoxSync', stripWindowArg(a)),
  showErrorBox: (...a) => ipcRenderer.sendSync('remote-compat:dialog-sync', 'showErrorBox', stripWindowArg(a)),
}

const app = {
  getPath: (name) => ipcRenderer.sendSync('remote-compat:app', 'getPath', [name]),
  getAppPath: () => ipcRenderer.sendSync('remote-compat:app', 'getAppPath', []),
  getVersion: () => ipcRenderer.sendSync('remote-compat:app', 'getVersion', []),
  getName: () => ipcRenderer.sendSync('remote-compat:app', 'getName', []),
  getLocale: () => ipcRenderer.sendSync('remote-compat:app', 'getLocale', []),
}

// remote.require('./prefs') → the shared main-process prefs instance, over IPC.
const prefsProxy = {
  getPrefs: (key) => ipcRenderer.sendSync('remote-compat:prefs-get', key),
  set: (keyPath, value, sync) => ipcRenderer.sendSync('remote-compat:prefs-set', keyPath, value, sync),
  savePrefs: () => ipcRenderer.sendSync('remote-compat:prefs-save'),
  init: () => {}, // main owns prefs.init()
}

function remoteRequire (moduleName) {
  if (moduleName === './prefs') return prefsProxy
  if (moduleName === 'electron-is-dev') return ipcRenderer.sendSync('remote-compat:is-dev')
  throw new Error(`remote-compat: unsupported remote.require('${moduleName}') — migrate this call to an explicit IPC handler`)
}

module.exports = {
  getCurrentWindow: () => currentWindow,
  getCurrentWebContents: () => currentWebContents,
  getGlobal: (name) => ipcRenderer.sendSync('remote-compat:get-global', name),
  require: remoteRequire,
  dialog,
  app,
  shell,
  clipboard,
  nativeImage,
}
