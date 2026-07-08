// contextIsolation preload for the loading-status window (loading-status.html).
//
// The window runs with contextIsolation:true + nodeIntegration:false, so its page has
// no require/ipcRenderer. This preload runs in a privileged (Node) context and exposes
// exactly what the page needs on window.loadingStatus via contextBridge — nothing more.
//
// This is the first window of the Phase-1 contextIsolation migration; see
// docs/phase-1-electron-modernization.md.

const { contextBridge, ipcRenderer } = require('electron')

// Inlined from js/utils (truncateMiddle) so the preload stays dependency-free.
const truncateMiddle = (string, maxLength = 30, separator = '…') => {
  if (!string) return string
  if (maxLength < 1) return string
  if (string.length <= maxLength) return string
  if (maxLength === 1) return string.substring(0, 1) + separator
  const midpoint = Math.ceil(string.length / 2)
  const toremove = string.length - maxLength
  const lstrip = Math.ceil(toremove / 2)
  const rstrip = toremove - lstrip
  return string.substring(0, midpoint - lstrip) + separator + string.substring(midpoint + rstrip)
}

contextBridge.exposeInMainWorld('loadingStatus', {
  truncateMiddle: (str) => truncateMiddle(str),
  onLog: (callback) => ipcRenderer.on('log', (_event, opt) => callback(opt)),
})
