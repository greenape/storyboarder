// Fallback for the `postinstall` when `electron-builder install-app-deps` aborts.
//
// On Electron 42 (newer V8) several OLD, OPTIONAL, dev-only fsevents copies nested
// under webpack (watchpack-chokidar2) / mocha / electron-mocha fail to compile —
// their bundled `nan` predates the V8 `PropertyCallbackInfo` change. The app never
// loads them (macOS file-watching via chokidar falls back to polling), so the
// failure is not fatal — but install-app-deps aborts the whole rebuild on the first
// one, which would fail `npm install` (and CI).
//
// This rebuilds the app's REAL production native modules against Electron directly,
// skipping the optional fsevents, so the install succeeds while the modules the app
// actually loads are built for the right ABI. It still exits non-zero if a required
// module fails, so a genuine break is not masked.
//
// Proper fix: the Phase-1 webpack 5 migration drops watchpack-chokidar2, and bumping
// mocha/electron-mocha drops their old fsevents. See docs/phase-1-electron-modernization.md.

const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const root = path.join(__dirname, '..')
const rebuildBin = path.join(root, 'node_modules', '.bin', 'electron-rebuild')

// The app's genuine native production dependencies. fsevents is intentionally NOT
// here: it is optional everywhere it appears and chokidar falls back without it.
const candidates = ['node-machine-id', 'deasync']
const present = candidates.filter((m) => fs.existsSync(path.join(root, 'node_modules', m)))

console.warn(
  '\npostinstall: `electron-builder install-app-deps` aborted on an optional, dev-only\n' +
  'native module (an old fsevents nested under webpack/mocha, incompatible with\n' +
  "Electron 42's V8). The app does not load it. Rebuilding the required native modules\n" +
  'directly and skipping the optional ones — see docs/phase-1-electron-modernization.md.\n'
)

if (present.length && fs.existsSync(rebuildBin)) {
  const result = spawnSync(rebuildBin, ['--force', '--only', present.join(',')], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error('postinstall: failed to rebuild required native modules for Electron.')
    process.exit(result.status || 1)
  }
}

process.exit(0)
