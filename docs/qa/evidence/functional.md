# Functional verification evidence — offline loop, data loss, export/restore

**Card:** t_eff4b9fa (h_senior_coder) · **Run date:** 2026-10-25 16:44–17:16 UTC (2026-10-25/26 local, +07)
**Deliverable:** this file — evidence + PASS/FAIL verdict per sub-criterion of the functional
verification suite (Q15 DoD criteria 1–3 / gate criteria C1–C3).

## Verdict summary

| # | Sub-criterion | Verdict | Key evidence |
|---|---------------|---------|--------------|
| 1 | Capture→plan→complete loop works **offline**, desktop 1920×1080 (Chrome 120+) | **PASS** | 8/8 steps, 0 console errors, video + 8 timestamped screenshots — [§1](#1-sub-criterion-1--offline-loop-desktop-19201080) |
| 2 | Same loop **offline**, mobile iPhone 14 Pro 393×852 (DevTools device toolbar emulation) | **PASS** | 8/8 steps, 0 console errors, video + 8 timestamped screenshots — [§2](#2-sub-criterion-2--offline-loop-mobile-iphone-14-pro-393852) |
| 3 | Zero data loss: create 50 → complete 30 → delete 10 → refresh → 40 remaining with correct state | **PASS** | per-item IDB verification 40 live (30 completed + 10 open), 0 missing/wrong, IDB user-data snapshots before/after refresh canonically identical, 0 console errors — [§3](#3-sub-criterion-3--zero-data-loss) |
| 4 | Scripted export→wipe→import→restored journey, 100% fidelity of items, metadata, Thai/English content | **PASS** (with finding **F1**) | record fidelity 100% (tasks/lists/settings diff = 0), 16/16 Thai+English strings byte-exact, JSON diffs saved; `e2e:data-safety` 16/16 incl. scripted drill 1 — [§4](#4-sub-criterion-4--exportwipeimportrestored) |

**Overall: PASS on all four sub-criteria.** One new functional finding (**F1**, moderate, no data
loss): restored data is not visible in the *running* UI after an import until a manual reload —
routed as fix card **t_85e19c39** ([§5](#5-findings)).

## Run setup (what was tested, and how to reproduce)

| Item | Value |
|---|---|
| App under test | production build (`BASE_PATH=/browser-todo-app/ npm run build`) served by `vite preview` at `http://127.0.0.1:4290/browser-todo-app/` |
| Source pinned | `b820ad723e7c66317cb1e741b21891ada6de60b4` (HEAD at run start), built from a `git archive` snapshot in an isolated scratch dir |
| Why pinned | sibling cards were editing `src/` and rebuilding `dist/` in the shared workspace concurrently (an early attempt against the shared `dist/` hit a torn build — 404s on swapped asset hashes). The snapshot build's asset hashes (`index-CA0Rb68-.js`, `dbAccess-Bx1kHfMa.js`, `snapshots-api-B23rPcZQ.js`, `index-B7sWvTs_.css`) are identical to the release build the DoD gate verified live at `225a1f3` (`docs/qa/mvp-dod.md` §1 run 13) |
| Browser | Chromium **156.0.8078.4** via Playwright 1.64.1 (Chrome 120+ floor satisfied), Node v22.22.1 |
| Viewports | desktop `1920×1080` dsf 1; mobile `393×852` dsf 3, `isMobile`, `hasTouch` (iPhone 14 Pro device-toolbar emulation) |
| Drivers | `docs/qa/evidence/functional-logs/probes/probe-functional-loop.mjs`, `probe-data-loss.mjs`, `probe-export-restore.mjs` (shared harness `probes/qa-lib.mjs`) — all UI-driven (composer, editor, chips, checkboxes, Settings → Storage & backup); no test-only seams in `src/` |
| Repro | `BASE_PATH=/browser-todo-app/ npm run build && npx vite preview --port 4291 --strictPort &` then `APP_URL=http://127.0.0.1:4291/browser-todo-app/ node docs/qa/evidence/functional-logs/probes/<probe>.mjs` |
| Timestamps | every screenshot has ISO-8601 UTC in its **file name** and burned into the frame as a `QA <iso>` watermark; each run writes a timeline JSON (`*-summary.json` / `data-loss-timeline.json`) with per-step wall-clock times |

Note: the known SC 4.1.3 announce race (release-blocking finding of `docs/qa/mvp-dod.md` §7,
fix card `t_bb9053ec`) does **not** affect these probes — they assert behavior and data, never
announcements. The console logs below are therefore a clean signal.

---

## 1. Sub-criterion 1 — offline loop, desktop 1920×1080

**Verdict: PASS** — 8/8 steps at 2026-10-25T16:48:33Z–16:48:38Z, **0 console messages**
([console log](functional-logs/functional-loop-desktop-1920x1080-console.txt) is empty — no
errors, no warnings), full-session [video](functional-logs/videos/desktop-1920x1080.webm).

| Step | Result | Evidence (screenshots, timestamped) |
|---|---|---|
| Service worker controls the page **before** the network is cut | PASS | [`…16-48-34-272Z-01-boot-onboarding-dismissed.png`](functional-logs/screens/2026-10-25T16-48-34-272Z-01-boot-onboarding-dismissed.png) |
| List created through the Manage-lists screen (fresh profile) | PASS | [`…16-48-35-400Z-02-list-created.png`](functional-logs/screens/2026-10-25T16-48-35-400Z-02-list-created.png) |
| `context.setOffline(true)` — everything below runs with zero connectivity | PASS | — |
| **Capture** — task captured through the real composer on `#/all`, visible while offline | PASS | [`…16-48-36-547Z-03-capture-offline.png`](functional-logs/screens/2026-10-25T16-48-36-547Z-03-capture-offline.png) |
| **Plan** — editor → due-today chip → Save (offline) | PASS | [`…16-48-36-672Z-04-plan-editor-due-today.png`](functional-logs/screens/2026-10-25T16-48-36-672Z-04-plan-editor-due-today.png) |
| Plan result — the task is a member of the **Today** view (S2 membership) while offline | PASS | [`…16-48-37-177Z-05-plan-today-view.png`](functional-logs/screens/2026-10-25T16-48-37-177Z-05-plan-today-view.png) |
| **Complete** — checkbox toggle collapses the row out of open views (F3) | PASS | [`…16-48-38-579Z-06-complete-offline.png`](functional-logs/screens/2026-10-25T16-48-38-579Z-06-complete-offline.png) |
| **Reload while offline** — shell boots from the SW cache (`h1="Today"`) | PASS | [`…16-48-38-692Z-07-offline-reload-boot.png`](functional-logs/screens/2026-10-25T16-48-38-692Z-07-offline-reload-boot.png) |
| Data present after the offline reload — completed task in `#/completed`, checked | PASS | [`…16-48-38-745Z-08-data-present-after-reload.png`](functional-logs/screens/2026-10-25T16-48-38-745Z-08-data-present-after-reload.png) |

Machine-readable run record: [`functional-loop-desktop-1920x1080.json`](functional-logs/functional-loop-desktop-1920x1080.json) · summary [`functional-loop-summary.json`](functional-logs/functional-loop-summary.json).

## 2. Sub-criterion 2 — offline loop, mobile iPhone 14 Pro 393×852

**Verdict: PASS** — same 8/8 steps at 2026-10-25T16:48:39Z–16:48:44Z, **0 console messages**
([log](functional-logs/functional-loop-mobile-iphone14pro-393x852-console.txt)), full-session
[video](functional-logs/videos/mobile-iphone14pro-393x852.webm). Viewport emulation matches the
Chrome DevTools device-toolbar preset for iPhone 14 Pro (393×852, DPR 3, touch, mobile).

| Step | Result | Evidence (screenshots, timestamped) |
|---|---|---|
| SW controls the page before the network is cut | PASS | [`…16-48-39-351Z-01-boot-onboarding-dismissed.png`](functional-logs/screens/2026-10-25T16-48-39-351Z-01-boot-onboarding-dismissed.png) |
| List created (compact layout, sheet composer path) | PASS | [`…16-48-40-469Z-02-list-created.png`](functional-logs/screens/2026-10-25T16-48-40-469Z-02-list-created.png) |
| Offline engaged | PASS | — |
| **Capture** offline (FAB/sheet composer) | PASS | [`…16-48-41-996Z-03-capture-offline.png`](functional-logs/screens/2026-10-25T16-48-41-996Z-03-capture-offline.png) |
| **Plan** offline — editor → due-today chip → Save | PASS | [`…16-48-42-170Z-04-plan-editor-due-today.png`](functional-logs/screens/2026-10-25T16-48-42-170Z-04-plan-editor-due-today.png) |
| Task is a member of Today while offline | PASS | [`…16-48-42-722Z-05-plan-today-view.png`](functional-logs/screens/2026-10-25T16-48-42-722Z-05-plan-today-view.png) |
| **Complete** offline (optimistic toggle, row collapse) | PASS | [`…16-48-44-176Z-06-complete-offline.png`](functional-logs/screens/2026-10-25T16-48-44-176Z-06-complete-offline.png) |
| **Reload offline** boots the shell | PASS | [`…16-48-44-336Z-07-offline-reload-boot.png`](functional-logs/screens/2026-10-25T16-48-44-336Z-07-offline-reload-boot.png) |
| Completed task present + checked after the reload | PASS | [`…16-48-44-439Z-08-data-present-after-reload.png`](functional-logs/screens/2026-10-25T16-48-44-439Z-08-data-present-after-reload.png) |

Machine-readable run record: [`functional-loop-mobile-iphone14pro-393x852.json`](functional-logs/functional-loop-mobile-iphone14pro-393x852.json).

## 3. Sub-criterion 3 — zero data loss

**Verdict: PASS** — desktop 1920×1080, cycle run at 2026-10-25T16:54:07Z–16:54:55Z, **0 console
errors** ([full console log](functional-logs/data-loss-console.txt) — every `console.*`,
`pageerror` and `requestfailed` with wall-clock stamps; no error entries).

Cycle executed through the real UI: create **50** items (`Item 01`…`Item 50`, real composer) →
complete **30** (`Item 01`…`Item 30`, row checkboxes, F3 collapse each) → delete **10**
(`Item 41`…`Item 50`, editor → confirm dialog) → **refresh** → verify.

| Check | Result | Evidence |
|---|---|---|
| 50 items created (50 `li.task-row` visible) | PASS | [`…16-54-07-211Z-01-created-50-items.png`](functional-logs/screens/2026-10-25T16-54-07-211Z-01-created-50-items.png) |
| 30 completed via row checkboxes | PASS | [`…16-54-47-932Z-02-completed-30-items.png`](functional-logs/screens/2026-10-25T16-54-47-932Z-02-completed-30-items.png) |
| 10 deleted via editor → confirm | PASS | [`…16-54-50-984Z-03-deleted-10-items.png`](functional-logs/screens/2026-10-25T16-54-50-984Z-03-deleted-10-items.png) |
| **IndexedDB snapshot before the refresh** | captured | [`data-loss-idb-before-refresh.json`](functional-logs/data-loss-idb-before-refresh.json) |
| **IndexedDB snapshot after the refresh** | captured | [`data-loss-idb-after-refresh.json`](functional-logs/data-loss-idb-after-refresh.json) |
| Snapshots before vs after the refresh | **identical** on user-data stores (`tasks`/`lists`/`settings`: 0 differences, canonical compare) | [`data-loss-idb-diff-before-vs-after.json`](functional-logs/data-loss-idb-diff-before-vs-after.json) — the only whole-DB delta is volatile bookkeeping `meta.lastOpenedAt` |
| 40 remaining items, correct state, per item | PASS — `live=40 (completed=30, open=10)`, `missing=0`, `wrongState=0`, `deletedStillLive=0`; the 10 deleted items persist as tombstones (`deletedAt` set, 50 rows total in store — documented domain semantics, not data loss) | [`data-loss-item-state-after-refresh.json`](functional-logs/data-loss-item-state-after-refresh.json) |
| UI cross-check after the refresh | PASS — `#/all` 10 open rows, `#/completed` 30 rows all checked | [`…16-54-55-188Z-04-after-refresh-open-view.png`](functional-logs/screens/2026-10-25T16-54-55-188Z-04-after-refresh-open-view.png), [`…16-54-55-768Z-05-after-refresh-completed-view.png`](functional-logs/screens/2026-10-25T16-54-55-768Z-05-after-refresh-completed-view.png) |

Run record: [`data-loss-summary.json`](functional-logs/data-loss-summary.json) (all 6 steps ok,
`consoleErrors: []`) · step timeline: [`data-loss-timeline.json`](functional-logs/data-loss-timeline.json).

## 4. Sub-criterion 4 — export→wipe→import→restored

**Verdict: PASS** (100% fidelity verified; finding **F1** recorded in §5) — desktop 1920×1080,
2026-10-25T17:14:18Z–17:14:32Z, **0 console errors**
([log](functional-logs/export-restore-console.txt)).

Journey, all through the real UI: seed a mixed Thai/English corpus (2 lists, 9 records incl.
notes, due dates, priorities, completed items and 1 tombstone; settings theme=dark + locale=th)
→ **export** ("Back up now", download captured byte-exact) → **wipe** (the app's own
"Delete all data" confirm dialog, then DevTools "Clear site data" semantics via CDP
`Storage.clearDataForOrigin(all)` — IndexedDB + localStorage + CacheStorage + SW registrations)
→ **import** the exported file (import file input → "Replace and import" confirm dialog) →
**verify fidelity**.

| Check | Result | Evidence |
|---|---|---|
| Export via UI | PASS — `local-first-todo-backup-2026-10-25T171421Z.json` (5,640 bytes) captured byte-exact | [`export-pre-wipe.json`](functional-logs/export-pre-wipe.json), [`…17-14-21-332Z-02-exported-pre-wipe.png`](functional-logs/screens/2026-10-25T17-14-21-332Z-02-exported-pre-wipe.png) |
| App "Delete all data" → confirm dialog | PASS | [`…17-14-21-599Z-03-delete-all-confirm-dialog.png`](functional-logs/screens/2026-10-25T17-14-21-599Z-03-delete-all-confirm-dialog.png) |
| **All storage cleared** (instant of wipe) | PASS — `IndexedDB=[]`, `localStorage=0`, `caches=[]`, `swRegs=0` | [`storage-after-wipe.json`](functional-logs/storage-after-wipe.json) |
| Fresh install after wipe | PASS — first-run onboarding shown, `tasks=0`, `lists=0` (the app's own empty DB/SW shell cache legitimately return on boot — offline feature, not user data; the fresh boot carries 1 auto-snapshot row of its own) | [`storage-after-wipe-reload.json`](functional-logs/storage-after-wipe-reload.json), [`…17-14-25-132Z-04-after-full-storage-wipe.png`](functional-logs/screens/2026-10-25T17-14-25-132Z-04-after-full-storage-wipe.png) |
| Import via UI | PASS — confirm dialog → "Replace and import" → import-complete toast | [`…17-14-26-440Z-05-import-confirm-dialog.png`](functional-logs/screens/2026-10-25T17-14-26-440Z-05-import-confirm-dialog.png), [`…17-14-26-685Z-06-import-complete-toast.png`](functional-logs/screens/2026-10-25T17-14-26-685Z-06-import-complete-toast.png) |
| **Record fidelity 100%** — restored IndexedDB vs the exported file | PASS — `tasks diff=0`, `lists diff=0`, `settings diff=0` (canonical, sorted-by-id; every field incl. `createdAt`/`updatedAt`/`dueDate`/`notes`/`priority`/`listId`/`completedAt`/`deletedAt` and record `deviceId` provenance round-trips verbatim) | [`export-restore-idb-after-import.json`](functional-logs/export-restore-idb-after-import.json), [`diff-export-vs-restored.json`](functional-logs/diff-export-vs-restored.json) |
| **Thai/English content fidelity** | PASS — all 16 seeded strings (8 Thai + 8 English titles/notes, Unicode byte-exact) present in the restored data **and** visible in the UI after reload; the deleted item stays hidden (tombstone) | [`export-restore-content-check.json`](functional-logs/export-restore-content-check.json), [`…17-14-31-324Z-06c-restored-ui-completed-view.png`](functional-logs/screens/2026-10-25T17-14-31-324Z-06c-restored-ui-completed-view.png) |
| **Metadata round-trip** — settings incl. locale/theme | PASS — `locale=th` restored (`html lang=th`), `theme=dark` restored; weekStart/defaultListId round-trip inside the 0-diff settings compare | [`…17-14-31-837Z-07-restored-corpus.png`](functional-logs/screens/2026-10-25T17-14-31-837Z-07-restored-corpus.png), [`…17-14-32-297Z-08-restored-settings.png`](functional-logs/screens/2026-10-25T17-14-32-297Z-08-restored-settings.png) |
| Re-export after import vs the pre-wipe export | PASS — only documented device-local deltas (see below) | [`export-post-import.json`](functional-logs/export-post-import.json), [`export-vs-restored.diff`](functional-logs/export-vs-restored.diff) (unified diff, 57 lines) |

**Export/import JSON diffs.** [`export-vs-restored.diff`](functional-logs/export-vs-restored.diff)
(unified, human-readable) and [`diff-export-vs-restored.json`](functional-logs/diff-export-vs-restored.json)
(structured, with per-path classification) show exactly **5** documented difference paths and **0**
unexpected ones:

| Path | Why (documented semantics) |
|---|---|
| `$.exportedAt` | per-export timestamp (ADR-004 Decision 9) |
| `$.deviceId` | device identity is per browser profile; a full site-data wipe is a fresh profile and gets a fresh `deviceId` (ADR-002 §3.1 — identity is never imported across devices). Record-level `deviceId` provenance values inside `data.tasks`/`data.lists` round-trip byte-exact |
| `$.counts.snapshots`, `$.data.snapshots` | snapshot metadata + payloads are device-local and never restored from a file (ADR-004 drill 13); the post-import export carries the pre-import undo snapshot instead |
| `$.data.settings.lastBackupAt` | best-effort export stamp (ADR-004 Decision 9.2) |

**The existing scripted export→wipe→import→restored journey** (`npm run e2e:data-safety`,
ADR-004 Decision 10 drill 1 — engine-level, offline, byte-equivalent) was also run first-hand
against the same pinned build: **16/16 passed, exit 0** including drill 1
(`export -> wipe -> import -> restored byte-equivalent, offline`) — full log
[`e2e-data-safety-run.txt`](functional-logs/e2e-data-safety-run.txt).

Run record: [`export-restore-summary.json`](functional-logs/export-restore-summary.json) (10/10
steps ok, `consoleErrors: []`).

## 5. Findings

### F1 — restored data is not visible in the running UI after a successful import (moderate; no data loss)

- **Observed:** after the import-complete toast, the running UI still shows the pre-import
  (empty) state — 0 task rows on `#/all`, "No lists yet" in the sidebar — even though the same
  records are in IndexedDB (0-diff vs the file) and re-export through the app's own export path
  (see the two screenshots: [`…06b-post-import-ui-before-reload.png`](functional-logs/screens/2026-10-25T17-14-28-304Z-06b-post-import-ui-before-reload.png)
  = 0 rows, [`…07-restored-corpus.png`](functional-logs/screens/2026-10-25T17-14-31-837Z-07-restored-corpus.png)
  = 6 open + 2 completed rows after `page.reload()`). Reproduced in **all 3 probe runs** that
  reached the post-import check (2026-10-25T17:04Z, 17:13Z, 17:14Z — the earlier run's failure
  screenshot shows the same empty state).
- **Data safety impact: none** — durability and fidelity are proven 100% (§3, §4). The defect is
  *visibility* of restored data in the running session; the user must reload the page to see it.
- **Mechanism (source, at `b820ad7`):** `src/features/data-safety/importFlow.ts` `applyPlan()`
  refreshes only data-safety state (counts, snapshots, lastBackupAt, banners) — the
  tasks/lists/settings store is never reloaded after `applyImport()`; the import writes bypass
  `MutationRunner.onCommitted`, so no tab-sync announcement originates from the acting tab; and
  `src/app/tabSync.ts` `sweep()` only picks up rows with `updatedAt > watermark`, while imported
  rows keep their original `updatedAt` — so even a sweep can miss them. The same gap likely
  applies to the UndoToast "Restore previous data" path (`restoreSnapshot`).
- **Routing:** fix card **t_85e19c39** (h_senior_coder, parent = t_eff4b9fa) with root cause,
  repro commands and acceptance criteria (store refresh after import/restore + tab-sync `all`
  announcement without breaking the D4 watermark rules + regression tests).
- **Recorded by the probe itself:** [`export-restore-findings.json`](functional-logs/export-restore-findings.json).

### Non-findings (checked, explained)

- The 10 deleted items persist in the store as **tombstones** (`deletedAt` set) — documented
  domain semantics (the export format carries tombstones by design, ADR-004 §2.3); they are
  excluded from "40 remaining" and hidden in the UI (asserted).
- `meta.lastOpenedAt` changes across a refresh (volatile bookkeeping timestamp) — the only
  whole-DB delta in the before/after comparison; user-data stores are byte-identical.
- A fresh install already carries 1 auto-snapshot row + payload (the app's own snapshot
  mechanism) — empty-state content, no user data (`tasks=0`, `lists=0`).

## 6. Artifact index (all under `docs/qa/evidence/`)

| Artifact | Path |
|---|---|
| This report | [`functional.md`](functional.md) |
| Probes (reproducible drivers) | [`functional-logs/probes/qa-lib.mjs`](functional-logs/probes/qa-lib.mjs), [`probe-functional-loop.mjs`](functional-logs/probes/probe-functional-loop.mjs), [`probe-data-loss.mjs`](functional-logs/probes/probe-data-loss.mjs), [`probe-export-restore.mjs`](functional-logs/probes/probe-export-restore.mjs) |
| Videos (loop, full session) | [`functional-logs/videos/desktop-1920x1080.webm`](functional-logs/videos/desktop-1920x1080.webm), [`functional-logs/videos/mobile-iphone14pro-393x852.webm`](functional-logs/videos/mobile-iphone14pro-393x852.webm) |
| Screenshots (32, ISO-stamped + watermark) | [`functional-logs/screens/`](functional-logs/screens/) |
| Loop run records + console logs | [`functional-loop-summary.json`](functional-logs/functional-loop-summary.json), [`functional-loop-desktop-1920x1080.json`](functional-logs/functional-loop-desktop-1920x1080.json), [`functional-loop-mobile-iphone14pro-393x852.json`](functional-logs/functional-loop-mobile-iphone14pro-393x852.json) + `functional-loop-*-console.txt` |
| Data-loss evidence | [`data-loss-summary.json`](functional-logs/data-loss-summary.json), [`data-loss-timeline.json`](functional-logs/data-loss-timeline.json), [`data-loss-console.txt`](functional-logs/data-loss-console.txt), [`data-loss-idb-before-refresh.json`](functional-logs/data-loss-idb-before-refresh.json), [`data-loss-idb-after-refresh.json`](functional-logs/data-loss-idb-after-refresh.json), [`data-loss-idb-diff-before-vs-after.json`](functional-logs/data-loss-idb-diff-before-vs-after.json), [`data-loss-item-state-after-refresh.json`](functional-logs/data-loss-item-state-after-refresh.json) |
| Export/restore evidence | [`export-restore-summary.json`](functional-logs/export-restore-summary.json), [`export-pre-wipe.json`](functional-logs/export-pre-wipe.json), [`export-post-import.json`](functional-logs/export-post-import.json), [`export-vs-restored.diff`](functional-logs/export-vs-restored.diff), [`diff-export-vs-restored.json`](functional-logs/diff-export-vs-restored.json), [`export-restore-idb-after-import.json`](functional-logs/export-restore-idb-after-import.json), [`export-restore-content-check.json`](functional-logs/export-restore-content-check.json), [`export-restore-findings.json`](functional-logs/export-restore-findings.json), [`storage-after-wipe.json`](functional-logs/storage-after-wipe.json), [`storage-after-wipe-reload.json`](functional-logs/storage-after-wipe-reload.json), [`export-restore-console.txt`](functional-logs/export-restore-console.txt) |
| Existing scripted journey re-run | [`e2e-data-safety-run.txt`](functional-logs/e2e-data-safety-run.txt) (16/16 incl. drill 1) |
