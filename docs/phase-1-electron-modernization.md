# Phase 1 — Electron modernization: bump + `@electron/remote` removal + contextIsolation

> Status: **in progress**. Continues `revival-plan.md` §4 "Phase 1". Written after a
> full inventory of `master` (post-Phase-0), so file counts and API surfaces below are
> ground truth. Execute in the sequenced slices in §6 — one PR each.
>
> **Progress (Track A):**
> - ✅ **Electron 18 → 42.6.0 bump** (electron-builder 26, @electron/remote 2.1.3 en route
>   to removal). App launches and renders on Electron 42; verified by `npm run test:smoke`.
> - ✅ **`@electron/remote` fully removed** — 67 uses across 57 files replaced by a curated
>   IPC bridge (`main/remote-bridge.js` + `shared/remote-compat.js`); the three renderer
>   window-creators moved to main (`main/child-windows.js`, `main/shot-explorer-window.js`);
>   the dependency is gone from package.json/lockfile/node_modules. Verified: smoke + build +
>   test:node + `npm install` all green on Electron 42.
> - ✅ **Runtime smoke harness** (`test/e2e/smoke.js`) — launches the app, opens a fixture,
>   asserts boards render with no fatal renderer errors. The gate every slice above passed.
> - ✅ Removed the unused `parcel-bundler`; made `postinstall` tolerant of the optional,
>   dev-only `fsevents` copies that can't build against Electron 42's V8.
> - ⏳ **Remaining (this doc's §6 slices 2–6 minus remote):** flip windows to
>   `contextIsolation:true` + `nodeIntegration:false` behind preloads (the large piece —
>   moves `fs`/`path`/`require('electron')` out of ~50 renderer files and bundles the 11
>   raw-`require` 2D HTML entrypoints), and replace the `electron-redux` alpha. These need
>   per-window smoke tests (the current smoke covers the main + welcome windows).
> - **Manual smoke still owed** on non-main windows migrated off remote: Shot Generator /
>   Shot Explorer / XR / AR, export-web, worksheet import, and the per-window dialogs.
>
> **remote-compat audit — fixed vs deferred.** A full audit of the shim's interaction
> paths (the smoke only covers the main window's load+render) found and fixed the crashes:
> `getParentWindow()`/`getChildWindows()` returning undefined (worksheet import; main-window
> focus with a child open), `devToolsWebContents.executeJavaScript` (copy/paste in DevTools),
> and dialogs called with a literal `null` window arg (shot-generator delete confirmations,
> save-dialog defaultPath). **Deferred (silent-break, not crash):** `webContents.on(...)` is
> a no-op in the shim, so the per-window `before-input-event` menu-shortcut gating in the
> registration / upload / worksheet-import forms is lost (menu accelerators can fire while
> typing there), as is Shot Explorer's `will-prevent-unload` `isBoardShown` reset. Fix by
> porting those callback bodies into main (like `main.js`'s main-window handler).

## 1. The two tracks (important framing)

The plan lists "Electron bump + remote removal + three.js" as one phase, but the
inventory shows it is really **two loosely-coupled tracks** with very different risk and
blast radius. Splitting them is the single most important planning decision:

- **Track A — Runtime security modernization** (this document's focus): bump Electron,
  remove `@electron/remote`, replace the `electron-redux` alpha, and flip every
  `BrowserWindow` to `contextIsolation:true` + `nodeIntegration:false` behind preload
  bridges. Keeps `three@0.115` / `react-three-fiber@4` / `react@16` **as-is** — a modern
  Chromium runs old three.js and React 16 fine.

- **Track B — 3D stack upgrade** (deferred, its own plan): `three` 0.115 → current. This
  is *not* a self-contained three.js bump — it cascades:
  `three` → **react-three-fiber v4 → v9** → **React 16 → 19** → the whole pinned React
  ecosystem (react-redux, react-i18next, react-select, react-window, and the abandoned
  react-pose / react-reveal). Evidence: `useUpdate` (removed after r3f v4) is used **48×**
  across **48 files**, `THREE.Math` (→`MathUtils` at r128) **80×**, r3f v9 *requires*
  React 19. This is weeks of high-risk work touching the 31k-LOC Shot Generator + XR.

**Recommendation:** land Track A first (it delivers the security win the revival is
about and unblocks a supported Electron), and schedule Track B as a separate plan.
This matches the fallback `revival-plan.md` §4 Phase 1 already anticipated. The owner's
stated preference was a *full* modern bump including three.js — so **doing Track B at all,
and when, is an open decision for the owner** (see §7). Track A does not block on it.

## 2. Current-state inventory (ground truth, post-Phase-0 `master`)

Pinned: **Electron 18.0.2, @electron/remote ^2.0.4, electron-redux ^2.0.0-alpha.9,
three ^0.115.0, react ^16.10.1, react-three-fiber 4.0.12, webpack 4.46.0.**

**`@electron/remote` — 67 occurrences / 57 files.** By subsystem (files/occurrences):
`windows/` 18/20 · `shot-generator/` 14/14 · `window/` 12/19 · `services/` 4/4 ·
`exporters/` 2/2 · `shared/` 1/1 · misc 5/5. **`xr/`, `ar/`, `main/` use zero remote.**

APIs actually used (≈ call sites):
- `getCurrentWindow` **~53** — window sizing/parenting/close (the dominant API).
- `dialog` (open/save/message) **~26 member + 8 destructured files** — needs main-process handlers.
- `app` (`getPath`, …) **~13 member + 8 destructured files**.
- `remote.require('./prefs')` **~16** — renderer reaching into the main-process `prefs`
  module; the single biggest shared dependency. One preload-exposed prefs bridge covers most.
- `BrowserWindow` **8** (incl. two `new remote.BrowserWindow(` created *from the renderer*
  at `main-window.js:6591,6979`), `shell` 4, `getCurrentWebContents` 2,
  `getGlobal('sharedObj')` 1, `process.mainModule` 1.
- Init: `@electron/remote/main` + `remoteMain.initialize()` (`main.js:1-2`);
  `remoteMain.enable(webContents)` at **~16 sites**.

**BrowserWindows — 16 creation sites, every one `nodeIntegration:true` +
`contextIsolation:false`, several `webSecurity:false`. Zero `preload:` scripts exist —
all bridges are built from scratch.** No `<webview>`/`BrowserView`. `webContents.send`
(main→renderer IPC) is used ~40× and is migration-safe.

**The architecture split that dominates the work:** the 2D main window + helper windows
are **not webpack-bundled** — their HTML does raw `require('./js/window/...')` under
nodeIntegration across **11 HTML entrypoints** (`main-window.html`, `welcome.html`,
`keycommand-window.html`, `new.html`, `import-window.html`, `loading-status.html`,
`update.html`, …). Only 3 windows load a webpack bundle (shot-generator, shot-explorer,
language-preferences). Each raw-`require` entrypoint dies under `nodeIntegration:false`
and needs a preload.

**`electron-redux` — 5 files.** `shared/store/configureStore.js` switches on
`process.type` and wraps enhancers with the 2.0-alpha `composeWithStateSync`; four
renderer entrypoints `require('electron-redux/preload')`. Not coupled to remote, but
coupled to Node-in-renderer (breaks in the same contextIsolation flip).

**Node-in-renderer blast radius** (breaks under `contextIsolation:true`): `require('electron')`
in **35 files**, `fs` in **34**, `path` in **51**, `child_process` in **3**, bare
`__dirname` **32×** (webpack `node.__dirname:false` leaves these live). `ipcRenderer`
already used in **27 files** — that survives via a `contextBridge` preload. Heaviest
coupling: `windows/` (23 files) + `window/` (11) + `exporters/` (10); `xr`/`ar` are clean.

## 3. Target versions

| Package | From | To | Notes |
|---|---|---|---|
| `electron` | 18.0.2 | **latest supported stable (42.x; 43 shipping)** | Support = latest 3 majors (40–43). Node 24 / Chromium 150 runtime. Pin exact patch at bump time. |
| `electron-builder` | 24.13.3 | latest (26.x) | Must match the Electron target for `install-app-deps` / packaging. |
| `@electron/remote` | 2.0.4 | **removed** | End state. Kept working during the bump (§6 slice 1) until each subsystem is migrated. |
| `electron-redux` | 2.0.0-alpha.9 | replaced | Alpha, coupled to nodeIntegration. Options in §5. |
| native deps (`deasync`, `ffmpeg-static`, `node-machine-id`) | — | rebuilt | Must build against Electron 42's Node 24 ABI — a real risk (`deasync` is old; validate early). |

Track B (deferred): `three` → current, `react-three-fiber` → v9 (**requires React 19**),
`react`/`react-dom` → 19, and the dependent React libraries.

## 4. The preload bridge design (Track A core)

Replace `@electron/remote` with a `contextBridge`-exposed API + `ipcMain.handle`
handlers. The API surface follows the inventory above, so it is small and known:

```js
// src/preload/index.js  (runs with contextIsolation:true, isolated world)
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('storyboarder', {
  // window ops (replaces remote.getCurrentWindow().{minimize,maximize,close,setSize,…})
  win: { minimize: () => ipcRenderer.invoke('win:minimize'), /* … */ },
  // dialogs (replaces remote.dialog.*) — main-process owns the dialog
  dialog: { showOpen: o => ipcRenderer.invoke('dialog:open', o), /* save, message */ },
  // paths (replaces remote.app.getPath + bare __dirname)
  paths: { userData: () => ipcRenderer.invoke('paths:get', 'userData'), appDir: __dirname_from_main },
  // prefs (replaces remote.require('./prefs')) — read/subscribe/set over IPC
  prefs: { get: k => ipcRenderer.invoke('prefs:get', k), set: (k,v) => ipcRenderer.invoke('prefs:set', k, v) },
  shell: { openExternal: u => ipcRenderer.invoke('shell:openExternal', u) },
  ipc: { on: (ch, cb) => ipcRenderer.on(ch, (_e, ...a) => cb(...a)), send: (ch, ...a) => ipcRenderer.send(ch, ...a) },
})
```

Main-process handlers live in a new `src/js/main/bridge.js`, registered once at startup.
`remote.require('./prefs')` becomes the `prefs` namespace (the biggest single win — kills
~16 call sites). Renderer-created `new remote.BrowserWindow(...)` (2 sites) becomes an
`ipcMain.handle('window:openExportWeb'/'window:openImport')` that creates the window in main.

**Bundling caveat:** the 11 raw-`require` HTML entrypoints must either (a) get a small
per-window preload and switch their inline `require`s to `window.storyboarder.*`, or (b)
be moved under webpack. Track A takes path (a) incrementally; a future cleanup can bundle them.

## 5. `electron-redux` replacement options

The alpha is unmaintained and nodeIntegration-coupled. Pick one:
1. **`@reduxjs/toolkit` + a thin IPC sync** over the preload bridge (broadcast dispatched
   actions main↔renderer). Most control, no new heavy dep. **Recommended.**
2. A maintained state-sync lib (e.g. a current `electron-redux` successor). Faster but
   adds a dep whose Electron-42 support must be checked.

Either way the store must stop reading `process.type` and move its sync channel onto the
preload `ipc`. This lands with the `window/` slice (its stores break in the same flip).

## 6. Sequenced execution (one PR per slice)

Each slice is independently reviewable and revertible. **Every slice needs a runtime
smoke-test (see §8) before merge** — the build passing is necessary but not sufficient.

1. **Electron + electron-builder + native-dep bump, patterns unchanged.** Bump `electron`
   → 42.x and `electron-builder` → 26.x; keep `nodeIntegration:true`/`contextIsolation:false`
   and `@electron/remote` enabled (it still functions on modern Electron). Rebuild native
   deps against the new ABI. *Acceptance:* installs, builds, **and the app launches and the
   core 2D flow works** on Electron 42. This is the "bump now" foundation; do nothing else in it.
2. **Preload-bridge foundation + flip `xr` and `ar` windows.** Build `src/preload/` +
   `src/js/main/bridge.js` with the §4 surface. Flip the xr/ar windows to
   `contextIsolation:true`/`nodeIntegration:false` — they use **zero remote and ~zero
   Node-in-renderer**, so they prove the new window baseline at near-zero risk.
3. **`language-preferences` + `print-project` windows.** Small, already-bundled, shallow
   remote surface. Migrate onto the bridge, flip contextIsolation.
4. **`shot-generator` / `shot-explorer`.** Broad-but-shallow remote surface (14 files,
   mostly `app`/`dialog`/`getCurrentWindow` + the prefs bridge); already webpack-bundled,
   so the preload seam is clean. (Three.js stays on 0.115 here — Track B is separate.)
5. **`electron-redux` replacement** (§5) — do this immediately before the 2D window layer,
   since those stores break in the same step.
6. **The 2D `window/` layer + `windows/` helpers (largest risk, last).** `main-window.js`
   alone holds ~40 remote sites and 11 non-bundled HTML entrypoints. Add per-window
   preloads, migrate every inline `require` to the bridge, flip contextIsolation, delete
   `@electron/remote` from `package.json` and `remoteMain.*` from main.
7. **Optional: webpack 4 → 5** to drop the `--openssl-legacy-provider` shim from Phase 0.

## 7. Open decisions for the owner
- **Track B (three.js/React 19): do it, and when?** The stated preference was a full bump,
  but the cascade (§1) is large and high-risk. Recommend landing Track A first regardless;
  decide Track B as its own plan afterward.
- **Electron 42 vs 43** at bump time (both supported; pin the latest stable patch).
- **electron-redux replacement** approach (§5) — recommend option 1.

## 8. Runtime-verification protocol (why this can't be fully CI-gated)
Phase 1's acceptance is about *runtime* behaviour, and the webpack build treats `electron`
as external — **a green build does not prove the app runs.**

**Automated gate — `npm run test:smoke`** (`test/e2e/smoke.js`): launches the app on a real
display, opens a fixture storyboard, and asserts it renders boards with **zero fatal
renderer errors** (module-not-found, `require`/`remote` is-not-defined, contextIsolation
breakage, uncaught exceptions). Verified green on the pre-Phase-1 baseline. Run it after
every slice. It drives the app *bare* (child_process + `ELECTRON_ENABLE_LOGGING`), not via
Playwright: Playwright's renderer instrumentation is incompatible with the current app's
legacy inline-`require()` nodeIntegration windows — **once the contextIsolation migration
lands, a Playwright harness that also drives the UI (click, assert DOM) supersedes this**
and can move into CI (macOS runners have a display).

**Manual smoke (per slice, until the Playwright harness exists):** open/reorder boards,
toggle a shot, draw; dialogs (open/save/export); prefs persist; external links. For slice
4+: Shot Generator opens, a character poses, camera moves; XR/AR entry loads.

CI (from Phase 0) continues to gate install + build + `test:node`; extend it with the
Electron `*.main.test.js` suite once the bridge handlers exist (testable headlessly in the
main process), then the Playwright UI smoke once windows are contextIsolated.
