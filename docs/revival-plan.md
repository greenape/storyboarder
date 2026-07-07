# Storyboarder Revival & Pre-Production Suite — Implementation Plan

> Status: **plan / handoff document**. Written to be executed by a coding agent (or
> human) working in an environment with full build access. It is self-contained:
> the file paths, data shapes, and entry points below were mapped from the current
> `master`, so you should not need to re-discover the codebase before starting.

## 1. What we're building and why

Storyboarder (v3.0.0) is an excellent 2D storyboarding app that has become
effective **abandonware**: it's pinned to 2022-era Electron 18, has **no CI**, and
still points at Wonder Unit's servers for updates/accounts. This fork
(`greenape/storyboarder`) revives it and grows it into a **lightweight collaborative
pre-production suite**:

- **Revive it** — modern Electron, reproducible builds, CI, cut over from Wonder
  Unit's infrastructure to our own. Keep the full feature set (2D core **and** the
  3D Shot Generator + VR/AR).
- **Scene → Shot hierarchy** — promote "shot" from a derived label to a first-class,
  addressable entity that groups under a scene.
- **Breakdown metadata** — assign location, lens, cast, etc. to scenes and/or shots.
- **Shoot order ≠ story order** — arrange shots in the order they appear in the story
  *and* in a separate shooting order (a stripboard / schedule) over the same shots.
- **Cloud + role-split collaboration** — writer inputs script/dialogue/breakdown;
  artist draws + adds lenses/annotations/notes; shared across devices.
  **Deferred to Phase 5** (design captured here, not built in this pass).

### Decisions locked with the product owner

| Decision | Choice |
|---|---|
| 3D Shot Generator + VR + AR extras | **Keep them** (full feature parity) |
| Electron version | **Bump now** to a current release as part of the revival |
| Cloud MVP shape | Role-split async collaboration (writer/text vs artist/draw), share + cross-device. Real-time ideal but not required. |
| Backend infrastructure | **None yet** — build it in Phase 5, keep the sync protocol host-portable |

### Sequencing at a glance

```
Phase 0  Foundation: reproducible build + CI + de-Wonder-Unit         (unblocks all)
Phase 1  Electron bump + @electron/remote removal + three.js + security refactor
Phase 2  Data model: first-class Scene → Shot + project manifest      (the spine)
Phase 3  Breakdown metadata (location / lens / cast on scenes+shots)
Phase 4  Shoot order vs story order (stripboard / schedule views)
Phase 5  Cloud + collaboration  ← NEXT PHASE, deferred (design only here)
```

Phases 0–1 are the "not abandonware" foundation. Phases 2–4 are the pre-production
feature set and are what most of this document details. Phase 5 is designed but not
built here.

---

## 2. Current-state map (ground truth for implementers)

### 2.1 Data model (today)

- A `.storyboarder` file **is one scene**. Its JSON shape (created at
  `src/js/main.js:967-973`, `src/js/window/main-window.js:4718-4724`):
  ```jsonc
  {
    "version": "<pkg.version>",     // rewritten on every save
    "aspectRatio": 2.35,
    "fps": 24,
    "defaultBoardTiming": 2000,     // ms per board
    "boards": [ /* ordered board objects */ ]
  }
  ```
- In memory this is the global `boardData` (`main-window.js:251`; loaded
  `:377-417`, saved by `saveBoardFile()` `:2413-2443` via atomic `.backup-*` +
  `fs.moveSync`). Migration hooks: `migrateScene()` / `migrateStringDurations()`
  `main-window.js:722-741`.
- **A "shot" is not stored** — it's a derived label. Each board carries a boolean
  `newShot`; the numbering loop at `main-window.js:4086-4116` walks boards and
  computes `board.shot` (e.g. `"1A"`, `"2B"`), `board.number`, and cumulative
  `board.time`. Toggling a shot boundary is the `toggleNewShot` IPC.
- **Board fields** (`src/js/models/board.js:79-103` + set as used): `uid` (5-char),
  `url` (`board-<n>-<uid>.png`), `newShot`, `lastEdited`, `layers` (keyed:
  `shot-generator`, `reference`, `fill`, `tone`, `pencil`, `ink`, `notes` → each
  `{url, opacity?, thumbnail?}`), and content fields `dialogue`, `action`, `notes`,
  `duration` (ms), `lineMileage`, `link` (linked PSD), `audio` `{filename,duration}`,
  `sg` (Shot Generator 3D data `{data:{sceneObjects,world,activeCamera}}`).
- **Multi-scene projects** are script-driven: separate per-scene folders
  `storyboards/Scene-<n>-<slug>-<sceneId>/<name>.storyboarder`
  (`models/shot-list.js:179-185 getSceneFolderName`; `main-window.js:4705-4729`
  creates folder+file lazily). Project-level state is a **thin** `storyboard.settings`
  = `{lastScene, aspectRatio}` (`main.js:984-996`).
- **Fountain screenplay import already derives scenes**: `src/js/vendor/fountain.js`
  → `src/js/fountain-data-parser.js:150-338` builds scene atoms
  `{type:'scene', script:[...], scene_number, scene_id, slugline, synopsis,
  duration, word_count, time, page}`. Scene IDs are injected back into the source by
  `src/js/fountain-scene-id-util.js` so boards re-match scenes across edits. Final
  Draft `.fdx` is a parallel path (`main.js:706-732`, `src/js/importers/`).
- **Board-creation entry points** (use these to generate structure from code):
  `insertNewBoardDataAtPosition(position)` `main-window.js:2209-2223` (pure data
  insert — the primitive), `newBoard(position, addToUndo)` `:2225-2274` (full async
  with thumbnails/undo), `migrateBoards`/`insertBoards` `:6107-6129` (batch/paste).
- **Board/scene IPC** lives in `main-window.js:6799-6910`
  (`deleteBoards`, `duplicateBoard`, `reorderBoardsLeft/Right`, `toggleNewShot`,
  `previousScene`, `nextScene`, …) and `:7197-7236` (Shot Generator `saveShot`,
  `insertShot`, `storyboarder:get-boards`).

### 2.2 Build & runtime health

- Expects **Node 18** (`DEVELOPERS.md:3`); **no `engines` field, no `.nvmrc`**.
- **7 parallel webpack 4 builds** (root `configs/*` + `server/`). Webpack 4 throws
  `ERR_OSSL_EVP_UNSUPPORTED` on Node 17+ unless
  `NODE_OPTIONS=--openssl-legacy-provider`. This is the first thing that breaks.
- **Electron `18.0.2`** (EOL). **`@electron/remote`** used across **57 files /
  67 occurrences**; `remoteMain.initialize()` at `main.js:1-2`, enabled at
  `main-window.js:6613,6996`. Every `BrowserWindow` uses `nodeIntegration:true`
  + `contextIsolation:false` (`main.js:383-384,420-421,448-449,464-465,
  1033-1034,1048-1049`). `electron-redux@2.0.0-alpha.9` is coupled to the remote
  module.
- **Native / per-arch deps**: `ffmpeg-static` (per-platform binary, asar-unpacked at
  `src/js/exporters/ffmpeg.js:8-23`), `deasync` (transitive, node-gyp), `fsevents`
  (mac, optional), `node-machine-id`. Plus a `github:wonderunit/alchemancy#38c4670`
  pin and two `file:` vendored deps (`tether-drop`, `tether-tooltip`).
- **3D stack** (kept, so in scope for the Electron bump): `three@^0.115.0`,
  `react-three-fiber@4.0.12`, `react@^16.10.1` — all old.
- **Size**: 475 JS files, ~105,800 LOC. Core `window/` ≈ 16,900 LOC
  (`main-window.js` alone is 7,294). Shot Generator ≈ 31,400. XR ≈ 11,500. AR ≈ 1,760.
  Shot Explorer ≈ 1,690.
- **Tests**: `npm test` = mocha 8 (node) + electron-mocha 11 (renderer/main),
  ~37 test files. **No CI** (`.github/` has only issue templates).
- **`parcel-bundler@1.12.4`** is a dependency but **unused by any script** — a
  candidate for removal (it drags a large abandoned tree into `npm install`).

### 2.3 Cloud / network / config surface (for Phase 5)

- `server/` = a **PeerJS signaling + static host** (express + `peer` + winston),
  deployed to `stbr.link`. It is **not** a sync/document backend — it only brokers
  WebRTC rooms so the Shot Generator finds phone/VR clients. Client side:
  `src/js/shared/network/{config.js,p2p.js,client.js}` (`STBR_HOST='stbr.link'`).
- In-app LAN "draw on your phone" server: `src/js/express-app/app.js` (socket.io on
  port 1888). Not cloud.
- **Prefs**: `src/js/prefs.js` → `pref.json` in `userData`. `defaultPrefs`
  `prefs.js:13-60`; API `getPrefs()`/`set(keyPath, value, sync)`. Preferences UI is
  generic — inputs in `src/preferences.html` auto-bind by `name` attribute
  (`src/js/windows/preferences/editor.js:217-221`). Adding a setting is trivial.
- **Existing auth to reuse**: JWT everywhere (`jsonwebtoken`). storyboarders.com
  upload token in `prefs.auth.token` (`src/js/exporters/web.js`); app.wonderunit.com
  license via `src/js/shared/store/authStorage.js` → `userData/auth.json`, machine-
  bound `license.key` verified at `main.js:1175-1218` (registration "disabled
  currently", `main.js:57`). A `fetchWithTimeout` Bearer pattern and a secret-file
  store already exist to build on.
- **Auto-update**: `electron-updater@4.6.5` (`src/js/auto-updater.js`, `main.js:493`),
  provider inferred from `repository.url` → currently `wonderunit/storyboarder`
  releases. **Must be repointed** (Phase 0).
- **No LLM/AI code anywhere** (confirmed) — not part of this plan.

---

## 3. The data-model spine (Phases 2–4 depend on this)

Everything the owner asked for reduces to one change: **make Scene and Shot
first-class, addressable objects, and add a project manifest above the per-scene
files.** Story order and shoot order then become two orderings over the same stable
shot IDs.

### 3.1 Target shapes

**`project.json`** (new — replaces the thin `storyboard.settings`; lives at project
root):
```jsonc
{
  "version": 2,
  "aspectRatio": 2.35,
  "fps": 24,
  "sceneOrder": ["scn_a1", "scn_b2", "..."],   // STORY order of scenes
  "breakdown": {                                // controlled vocabularies
    "cast":      [ { "id": "c1", "name": "JANE", "role": "lead" } ],
    "locations": [ { "id": "l1", "name": "INT. KITCHEN" } ],
    "lensKit":   [ { "id": "ln1", "name": "35mm" }, { "id": "ln2", "name": "50mm" } ]
  },
  "schedule": {                                 // SHOOT order (Phase 4)
    "days": [
      { "id": "d1", "label": "Day 1 — Kitchen", "shotIds": ["sht_1","sht_4"] }
    ],
    "unscheduled": ["sht_2", "sht_3"]
  }
}
```

**Scene** — extend the existing `.storyboarder` boardData (backward compatible; old
files load because every new field is optional and defaulted by a migration):
```jsonc
{
  "version": "<pkg.version>",
  "id": "scn_a1",
  "slugline": "INT. KITCHEN - DAY",
  "aspectRatio": 2.35,
  "fps": 24,
  "defaultBoardTiming": 2000,
  "metadata": { "locationId": "l1", "castIds": ["c1"], "timeOfDay": "DAY", "notes": "" },
  "shots":  [ /* Shot objects, see below — ordered = story order within scene */ ],
  "boards": [ /* unchanged board objects, each gains "shotId" */ ]
}
```

**Shot** (new first-class entity, stored in the scene's `shots[]`):
```jsonc
{
  "id": "sht_1",
  "label": "1A",                 // still displayable; no longer the source of truth
  "boardUids": ["a1b2c", "d3e4f"],
  "metadata": {
    "lensId": "ln1",
    "locationId": null,          // null = inherit scene.metadata.locationId
    "castIds": ["c1"],
    "cameraMove": "static",
    "notes": ""
  }
}
```

### 3.2 Migration (critical — do not break existing files)

- Add `migrateToShots(boardData)` alongside `migrateScene()` (`main-window.js:722`):
  walk `boards[]`, start a new Shot at every board with `newShot === true` (and at
  index 0), assign `shot.id`, push board `uid`s into `shot.boardUids`, set
  `board.shotId`. Preserve the computed `board.shot` **label** by writing it to
  `shot.label`. Keep `newShot` as a derived mirror of "is this board the first in its
  shot" so legacy code paths and the numbering loop (`:4086-4116`) still work during
  transition.
- On projects with no `project.json`, synthesize one from `storyboard.settings` +
  the folder scan, then write it. Old single-file projects get a one-scene manifest.
- Keep the numbering loop as the renderer of labels, but source shot boundaries from
  `shots[]` rather than only the `newShot` flag.

### 3.3 Invariants to hold (write tests for these)

1. Loading and re-saving a **legacy** `.storyboarder` file produces first-class
   `shots[]` and `project.json` without changing rendered output.
2. `board.shotId` always resolves to a shot in the same scene; every board belongs to
   exactly one shot.
3. Reordering shots for the schedule (Phase 4) never mutates `sceneOrder` or the
   in-scene board/shot story order.
4. Deleting a shot re-parents or deletes its boards deterministically (define which)
   and removes its `shotIds` from the schedule.

---

## 4. Phase-by-phase plan

Each phase lists **objective → key files → tasks → acceptance**. Land each phase on
its own PR against this branch; keep phases independently revertible.

### Phase 0 — Foundation: reproducible build + CI + de-Wonder-Unit

**Objective:** anyone can clone, install, build, run, and package on a modern Mac,
and CI proves it on every push. Cut the cord to Wonder Unit's infrastructure.

**Key files:** `package.json`, new `.nvmrc`, new `.github/workflows/*.yml`,
`src/js/auto-updater.js`, `scripts/notarize.js` (already modernized on this branch),
`DEVELOPERS.md`.

**Tasks:**
1. Pin Node: add `.nvmrc` (`18`) and `"engines": { "node": ">=18 <21" }`. Document
   that Node 18 avoids the webpack-4/OpenSSL failure; if a newer Node is required,
   set `NODE_OPTIONS=--openssl-legacy-provider` until Phase 1's webpack 5 migration.
2. Get `npm install` reproducible: resolve peer-dep conflicts (likely
   `--legacy-peer-deps`), confirm the `github:` `alchemancy` pin and `file:` vendored
   `tether-*` resolve, ensure `deasync`/`ffmpeg-static` build for arm64 + x64.
   Consider dropping the unused `parcel-bundler` dependency.
3. Prove the pipeline end to end: `npm run build` (all 7 webpack targets) →
   `npm start` → `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --dir`.
4. **CI** (`.github/workflows/ci.yml`): matrix build on `macos-latest` (+ optionally
   ubuntu/windows) — install, lint (if added), `npm run build`, `npm test` under
   xvfb where needed. This is the single loudest "maintained again" signal.
5. **De-Wonder-Unit:** set our own `build.appId` / `productName`; add a
   `build.publish` block (or update `repository.url`) so `electron-updater` pulls from
   **our** GitHub Releases, not wonderunit's; decide keep/replace/remove for the
   storyboarders.com upload and the (already-disabled) app.wonderunit.com license
   flow; point `STBR_HOST` (`src/js/shared/network/config.js`) at our own signaling
   server or gate the P2P features until Phase 5.

**Acceptance:** green CI produces an installable (dev-signed) `.app`; update feed and
app identity are ours; `README`/`DEVELOPERS` reflect the real steps.

### Phase 1 — Electron bump + remote removal + three.js + security

**Objective:** run on a current Electron with the deprecated patterns removed. (Owner
chose "bump now"; because we keep the 3D/XR/AR extras, the three.js migration is
in-scope.)

**Key files:** `package.json` (electron, three, react-three-fiber, electron-redux),
`src/js/main.js` (remote init + BrowserWindow config), the **57 files** using
`@electron/remote`, `configs/*/webpack.config.js`, the shot-generator + xr + ar trees.

**Tasks:**
1. Bump `electron` to the current stable; bump `electron-builder` accordingly.
2. Remove `@electron/remote`: replace the 67 usages with `ipcRenderer.invoke` /
   `contextBridge` preload APIs. Do it subsystem by subsystem (window/, shot-generator,
   xr, ar) so each is reviewable. Replace the `electron-redux` alpha with a maintained
   main↔renderer store bridge (or IPC-backed store).
3. Flip `BrowserWindow` to `contextIsolation:true` + `nodeIntegration:false` with
   `preload` scripts across the 6 windows; move Node access behind the preload bridge.
4. Migrate **three.js 0.115 → current** and update `react-three-fiber`/`react` as
   needed so shot-generator, XR, and AR build and run. This is the largest single
   risk; treat it as its own work stream with visual regression checks against the
   `test/` fixtures and manual smoke tests of posing/camera/XR.
5. Consider (optional, can defer): webpack 4 → 5 to drop the OpenSSL workaround.

**Acceptance:** app builds and runs on current Electron with `contextIsolation:true`;
Shot Generator + XR + AR functional; CI green on the new Electron.

> This phase is deliberately large. If the three.js migration proves too costly, the
> fallback is to bump Electron only as far as the current `@electron/remote` +
> `three@0.115` still function, and schedule three.js separately — but the owner's
> stated preference is a full modern bump.

### Phase 2 — First-class Scene → Shot + project manifest

**Objective:** implement §3 — shots and scenes as addressable objects, plus
`project.json`, with lossless migration of existing files.

**Key files:** `src/js/models/board.js`, new `src/js/models/shot.js`, new
`src/js/models/project.js`, `src/js/window/main-window.js` (boardData lifecycle,
numbering loop `:4086-4116`, save/load, migration `:722-741`),
`src/js/models/shot-list.js` (already derives shots from `board.sg` — reconcile),
`src/js/fountain-data-parser.js` (map parsed scene atoms → Scene metadata).

**Tasks:**
1. Define `Shot` and `Project` models + a `project.json` reader/writer (mirror the
   atomic save in `saveBoardFile`).
2. Implement `migrateToShots()` and the `project.json` synthesis (§3.2); wire into the
   load path so every opened project is upgraded in memory and on next save.
3. Re-source the numbering/label loop from `shots[]`; keep `board.shot`/`newShot` as
   derived mirrors for compatibility.
4. Map Fountain/`.fdx` import onto the new model: scene atoms → Scene + `metadata`
   (slugline → `locationId` guess), shot boundaries preserved.
5. Tests for every §3.3 invariant, including the legacy-load-roundtrip.

**Acceptance:** legacy files open unchanged visually but now carry `shots[]` +
`project.json`; shots have stable IDs; all invariant tests pass.

### Phase 3 — Breakdown metadata (location / lens / cast)

**Objective:** assign location, lens, cast (and notes/time-of-day) to scenes and
shots, from controlled project vocabularies.

**Key files:** `project.json` `breakdown` (§3.1), `src/js/models/{scene,shot}.js`, a
new breakdown panel in `src/js/window/main-window.js` + `src/main-window.html`, the
preferences-style generic form wiring for reference.

**Tasks:**
1. Project-level vocab CRUD (cast/locations/lensKit) — add/rename/remove, with
   referential cleanup.
2. UI to assign vocab items to the current Scene and current Shot (dropdown/chips);
   shot-level `locationId=null` inherits the scene's.
3. Surface lens on the board/shot header; reconcile with the Shot Generator's existing
   camera focal-length data (`board.sg`) so a 3D shot can populate `lensId`.
4. Include breakdown fields in PDF/print/export (the print path already groups by
   scene — extend it to show location/lens/cast).

**Acceptance:** a scene and its shots can carry location/lens/cast; values persist,
survive reload, and appear in exports.

### Phase 4 — Shoot order vs story order (stripboard)

**Objective:** a second ordering over the same shots — a shooting schedule — without
disturbing story order.

**Key files:** `project.json` `schedule` (§3.1), a new schedule/stripboard view
(new renderer window or a panel), `src/js/window/main-window.js` navigation.

**Tasks:**
1. Schedule model: ordered **days**, each an ordered list of `shotId`s, plus an
   `unscheduled` pool; drag-drop reorder. Never mutates `sceneOrder` or in-scene order.
2. Stripboard UI: list all shots (grouped by scene = story order) on one side and the
   schedule (grouped by day) on the other; drag shots between them. Colour/group by
   location or cast (reuse breakdown metadata) — the classic stripboard affordance.
3. Auto-suggest grouping (e.g. "group by location") as a one-click arrangement the
   user can then hand-tune. (Rules-based, not AI.)
4. Export the schedule (CSV / printable stripboard).

**Acceptance:** shots can be arranged in a shoot order independent of story order;
both orderings persist; a shot edited in either view is the same underlying object.

### Phase 5 — Cloud + role-split collaboration  *(NEXT PHASE — design only here)*

**Objective (deferred):** share projects and work across devices; writer inputs
script/dialogue/breakdown while artist draws + adds lenses/annotations/notes;
async-first, with a path to real-time.

**Recommended design (captured now so Phases 2–4 don't paint us into a corner):**
- **Structure + metadata as a CRDT document** (Automerge or Yjs): the entire
  `project.json` + per-scene metadata/shots/text becomes a CRDT. This is offline-first
  and merges automatically on reconnect — the pragmatic middle ground between "async"
  and the "impractical" full real-time, with a clean upgrade path to live collab.
  **Phase 2 implication:** keep the metadata model JSON-serialisable and free of
  hidden derived state so it can be adopted into a CRDT without a rewrite.
- **Drawings as content-addressed assets** in object storage; per-`(board, layer)`
  last-writer-wins + version history. Conflicts are rare because the artist owns the
  image layers and the writer never touches them.
- **Roles enforced softly** by the field partition (writer → text/breakdown; artist →
  image layers/annotations/lens), not hard locks.
- **Backend (none exists yet):** a thin sync service + object storage + a small DB for
  accounts/projects/membership. Supabase (Postgres+auth+storage) or Cloudflare
  (D1+R2) to move fast; keep the sync protocol host-agnostic. Reuse the existing JWT
  Bearer / `fetchWithTimeout` / `auth.json` secret-store patterns; route all
  networking through the main process. **Do not reuse** the PeerJS `stbr.link` server
  (it's signaling-only).

**Not started in this pass.** A separate plan doc should detail the backend, auth,
sync protocol, conflict UX, and offline behaviour before implementation.

---

## 5. Cross-cutting notes for the executing agent

- **Work on branch `claude/modern-osx-update-llawzh`** (this branch). One PR per phase.
- The macOS notarization toolchain was already modernized on this branch
  (`scripts/notarize.js` uses `@electron/notarize` + `notarytool`;
  `@electron/osx-sign` replaces the deprecated `electron-osx-sign`). Don't redo it.
- **Backward compatibility is sacred**: real users have `.storyboarder` files. Every
  model change ships with a migration and a legacy-roundtrip test.
- **Keep `newShot` working** through Phase 2 as a derived mirror; a lot of renderer
  code and the numbering loop lean on it. Remove it only once nothing reads it.
- **Verify by running the app**, not just tests — this is a GUI drawing tool; the
  `test/` suite needs a real Electron binary (xvfb on Linux). Smoke-test: open a
  legacy project, add boards, toggle shots, import a Fountain script, export a PDF.
- **Biggest risks, in order:** (1) three.js 0.115→current across the 31k-LOC Shot
  Generator + XR (Phase 1); (2) `@electron/remote` removal across 57 files (Phase 1);
  (3) lossless model migration (Phase 2); (4) getting `npm install` reproducible at
  all (Phase 0).
