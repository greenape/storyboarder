# Phase 0 — Foundation: reproducible build + CI + de-Wonder-Unit

Status: **delivered** (first pass). This is the record for the Phase 0 PR described in
[`revival-plan.md`](./revival-plan.md) §4. Phase 0's goal is a reproducible build,
CI that proves it, and cutting the cord to Wonder Unit's infrastructure.

## What changed

### Reproducible build + Node pin
- **`.nvmrc`** pins Node **18**; **`package.json` `engines`** declares `>=18 <21`.
- The build is still **webpack 4**, whose md4 hashing fails with
  `ERR_OSSL_EVP_UNSUPPORTED` (`error:0308010C: digital envelope routines::unsupported`)
  on every OpenSSL-3 Node — that's Node 17+, **including Node 18**. So `.nvmrc`=18 does
  *not* dodge it: the `build`/`start` scripts set `NODE_OPTIONS=--openssl-legacy-provider`
  via `cross-env` (verified: full `npm run build`, all 7 targets, exit 0). The one
  wrinkle — **Electron refuses to launch with that flag set** — is handled by
  `start:electron` clearing `NODE_OPTIONS` again, so `npm start` runs both the webpack
  watchers and the app. This goes away with the Phase 1 webpack 5 migration. (CI caught
  the original omission — the build failed on `build:xr` before the flag was baked in.)
- `npm install --legacy-peer-deps` is the documented install command (peer-dep
  conflicts otherwise). Verified: a clean install resolves the full tree — Electron
  18.0.2, the `github:wonderunit/alchemancy` pin, the `file:` vendored `tether-*`
  deps, and native deps — 1157 packages, exit 0.

### CI (`.github/workflows/ci.yml`)
- Runs on every push (`master`, `claude/**`) and PR. Matrix over **macOS + Linux**:
  install (server + root, `--legacy-peer-deps`) → build all webpack targets →
  `npm run test:node`.
- Node comes from `.nvmrc` via `actions/setup-node` (18); the build scripts carry the
  OpenSSL-legacy flag, so the workflow needs no special env.

### Test suite made runnable
- `src/js/services/model-loader.js` read `window.__dirname` at **module load**, so
  requiring it in plain Node (the test suite / CI) crashed the whole Node mocha batch
  before any test ran. Made that path **lazy** (it's only read inside `builtInFolder()`,
  which runs in the renderer) — behaviour-preserving there, and the module now loads
  under Node. The Node suite went from "crashes on load" to **19 passing**.
- Added **`test:node`** (the mock-fs-free Node suite CI gates on — **16 passing, 0
  failing**: util, importers, models) and **`test:node:all`** (the full Node suite).

### De-Wonder-Unit
- **App identity:** `build.appId` `com.wonderunit.storyboarder` → **`net.nanosheep.storyboarder`**.
- **Update feed:** `repository.url` repointed to `greenape/storyboarder` and an explicit
  **`build.publish`** (github / `greenape` / `storyboarder`) added, so `electron-updater`
  pulls from **our** GitHub Releases, not wonderunit's.
- **Signaling host:** `STBR_HOST` (`src/js/shared/network/config.js`) is no longer
  hardcoded — it reads the `STBR_HOST` env var, defaulting to `stbr.link`. The default
  keeps the Shot Generator's phone/VR peering working today; the guard is safe once
  Phase 1 removes renderer `nodeIntegration`.

## Decisions (the plan's "decide keep/replace/remove")

| Wonder Unit dependency | Where | Decision |
|---|---|---|
| Update feed (`electron-updater`) | `repository.url` / `build.publish` | **Replaced** → our GitHub Releases. |
| App identity (`appId`) | `package.json` `build` | **Replaced** → `net.nanosheep.storyboarder`. |
| PeerJS signaling (`stbr.link`) | `shared/network/config.js` | **Kept as default, made overridable.** Standing up our own broker is Phase 5. |
| License / registration (`app.wonderunit.com`) | `models/license.js`, `windows/registration` | **No action** — already disabled in-app (`main.js:57`). Remove the dead UI in a later cleanup. |
| storyboarders.com upload + pose/hand-preset sharing | `exporters/web.js`, Shot Generator preset editors | **Deferred.** These are community features against Wonder Unit's servers; removing/replacing them is a feature decision, not foundation. They fail gracefully without an account. |
| wonderunit.com marketing (welcome-window ads iframe, help/FAQ menu links) | `window/welcome-window.js`, `main/menu.js` | **Deferred.** The welcome-window ads `<iframe>` phones home to wonderunit.com on launch — flag for removal in a UI pass. |
| Windows signing identity (`Wonder Unit, Inc.`) | `package.json` `build.win` | **Left in place** (inert without a cert). Replace with the fork owner's publisher name when Windows signing is set up. |

## Verified in this pass
- `npm install --legacy-peer-deps` → full tree, exit 0; `postinstall`
  (`electron-builder install-app-deps`) resolves the local electron-builder.
- Full `npm run build` → all 7 webpack targets, exit 0 (with the baked-in OpenSSL flag).
- `npm run test:node` → 16 passing, 0 failing.
- CI exercises the same install → build → unit-test path on GitHub's macOS + Linux
  runners (Node 18).

## Not verified here (needs a full build host)
- `dist:mac` packaging + notarization (needs Apple credentials; the toolchain was
  modernized earlier on this branch).
- The Electron renderer/main tests (`electron-mocha`) — they need a display; deferred
  to Phase 1 when Electron is modernized (enable via the macOS window server / xvfb).
- CI itself running green on GitHub's runners (this environment can't push-and-watch).

## Follow-ups
1. Repair the two `mock-fs@4.10.1` filesystem tests (copy-project, cleanup) — the lib
   is incompatible with modern Node; upgrade to mock-fs 5 or replace with a tmpdir.
2. Enable the Electron GUI tests in CI once Phase 1 lands.
3. Remove the dead registration UI and the welcome-window wonderunit.com ads iframe.
4. Set the fork owner's Windows publisher / code-signing identity.
