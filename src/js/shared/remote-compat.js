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

// Well-known props that must NOT resolve to a callable, or a returned/awaited proxy
// would be mistaken for a thenable (JS reads `.then`) and hang the async chain.
const NON_METHOD = (prop) =>
  typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally' ||
  prop === 'toJSON' || prop === 'inspect' || prop === 'constructor'

// webContents proxy: any method → sync IPC on the sender's webContents.
const currentWebContents = new Proxy({}, {
  get (_t, prop) {
    if (NON_METHOD(prop)) return undefined
    return (...args) => ipcRenderer.sendSync('remote-compat:webcontents-invoke', prop, args)
  },
})

// getCurrentWindow() proxy: event methods emit locally (fed by forwarded window
// events); any other method → sync IPC on the sender's own window. Using a Proxy
// (rather than a fixed method list) keeps the shim robust to any BrowserWindow
// method a call site uses.
const currentWindow = new Proxy({}, {
  get (_t, prop) {
    switch (prop) {
      case '__isRemoteCompatWindow': return true
      case 'webContents': return currentWebContents
      case 'on': case 'addListener': return (ev, cb) => (winEmitter.on(ev, cb), currentWindow)
      case 'once': return (ev, cb) => (winEmitter.once(ev, cb), currentWindow)
      case 'off': case 'removeListener': return (ev, cb) => (winEmitter.removeListener(ev, cb), currentWindow)
      case 'removeAllListeners': return (ev) => (winEmitter.removeAllListeners(ev), currentWindow)
    }
    if (NON_METHOD(prop)) return undefined
    return (...args) => ipcRenderer.sendSync('remote-compat:win-invoke', prop, args)
  },
})

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

// remote.app.* — every use in the app is a method call (getPath/getAppPath/…).
const app = new Proxy({}, {
  get (_t, prop) {
    if (NON_METHOD(prop)) return undefined
    return (...args) => ipcRenderer.sendSync('remote-compat:app', prop, args)
  },
})

// remote.require('./prefs') → the shared main-process prefs instance, over IPC.
const prefsProxy = {
  getPrefs: (key) => ipcRenderer.sendSync('remote-compat:prefs-get', key),
  set: (keyPath, value, sync) => ipcRenderer.sendSync('remote-compat:prefs-set', keyPath, value, sync),
  savePrefs: () => ipcRenderer.sendSync('remote-compat:prefs-save'),
  init: () => {}, // main owns prefs.init()
}

function remoteRequire (moduleName) {
  // Callers reach the shared prefs module both as './prefs' and as an absolute
  // path (path.join(__dirname, '..', 'prefs')); match on the basename.
  const base = String(moduleName).replace(/\\/g, '/').split('/').pop().replace(/\.js$/, '')
  if (base === 'prefs') return prefsProxy
  if (moduleName === 'electron-is-dev') return ipcRenderer.sendSync('remote-compat:is-dev')
  throw new Error(`remote-compat: unsupported remote.require('${moduleName}') — migrate this call to an explicit IPC handler`)
}

// remote.process — only .mainModule (its .filename, for asar detection) is used.
const remoteProcess = {
  get mainModule () {
    return ipcRenderer.sendSync('remote-compat:main-module')
  },
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
  process: remoteProcess,
}
