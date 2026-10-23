# Project Analysis — Local-First Todo Web App

- Date: 2026-10-23 (PO-validated the same day)
- Author: h_pm (Project Manager / orchestrator), via kanban task t_368da4e7
- Status: FINAL — PO-validated 2026-10-23: all 15 frontier questions answered (§12); every
  RECOMMENDED and OPEN item is now DECIDED. Four answers deviate from the recommendations (Q7,
  Q9, Q11, Q12) and are folded into the affected sections explicitly — see §12.
- Method: grill-me adversarial interview (design-tree + frontier rounds), executed against the
  constraints stated in the task brief; the decision frontier is recorded in §12 with each
  recommendation and the PO's answer that settled it.
- Purpose: detailed enough for h_pm to decompose into epics and tasks (provisional epic preview in
  Appendix A).

---

## 0. How to read this document — decision register

Every material decision carries one of three markers:

- **DECIDED** — given in the task brief; not open for re-litigation without a scope change.
- **RECOMMENDED** — working assumption made to keep this document decomposition-ready.
  The PO may override; each is listed in §12 with its rationale.
- **OPEN** — genuinely needs a PO answer before the affected scope is committed. §12 carries the
  full grill-me frontier; recommendations are provided so no answer requires research from the PO.

### Settled constraints (DECIDED)

1. Local-first: the application works fully with zero network connectivity after first load.
2. Browser-only storage: all data lives in the user's browser origin storage. No database server.
3. No backend: no application server, no accounts, no API of our own.
4. Offline-capable as a first-class property, not a degraded mode.
5. Desktop + mobile: one responsive web application covering both device classes.

Everything else was RECOMMENDED or OPEN at draft time and is DECIDED as of the PO validation on
2026-10-23 (answers in §12). In-text markers are retained as provenance of what was still open at
draft time; where an answer deviated from the recommendation, the affected sections have been
rewritten to the PO's decision (Q7 -> §5.1/§5.2 + C2 moved to WON'T; Q9 -> M15 + §8 + §9.2;
Q11 -> §9.5; Q12 -> M9/S13 + §5.5 + R1).

---

## 1. Executive summary

A privacy-preserving, offline-first personal todo application delivered as a static web app on
GitHub Pages (PO Q11). All data is stored locally in the browser (IndexedDB as primary store),
with export/import as the MVP portability and backup story and optional user-owned sync (WebDAV)
deferred to V1. Home-screen install (PWA) is excluded from MVP by the PO (Q12) — so MVP's defence
against iOS Safari's storage-eviction policy is `storage.persist()` + backup discipline + eviction
detection + honest onboarding (§5.5, R1), and PWA installability (S13) is the structural fix,
scheduled first in V1. English + Thai ship at MVP (Q9). No telemetry, no third-party requests,
WCAG 2.2 AA, strict performance and bundle budgets.

The MVP is deliberately narrow: capture, organize into lists, schedule with due dates, complete,
search, reorder, and never lose data — in English and Thai (Q9). Complexity magnets — recurrence,
subtasks, sync protocols, encryption — are sequenced after the data-safety core is proven
(attachments are out of scope entirely per PO Q7).

---

## 2. Product vision and scope boundaries

**Vision:** The todo app for people who want their task list to be theirs: instant to open, fully
functional offline, invisible on the network, and reliable enough to be a trusted system.

**In scope (product):**
- Personal task management for a single user, multiple lists, desktop + mobile web.
- Full offline functionality (service-worker app-shell caching; home-screen install is V1 per
  PO Q12); local persistence with explicit data-safety tooling (export/import, snapshots, quota
  visibility). English + Thai locales at MVP (PO Q9).
- Accessibility as a release gate, not a backlog item.

**Explicitly out of scope (this release):**
- Accounts, user registration, authentication of any kind.
- Any server component, including sync servers we operate.
- Real-time collaboration, shared lists, multi-user features.
- Attachments of any kind (PO Q7: "No attachments") — which also removes the OPFS investment.
- Native mobile apps, desktop apps (Electron/Tauri), browser extensions (possible later).
- Push notifications that require a server (local notifications only, and only in V1).

---

## 3. User personas and jobs-to-be-done

### P1 — "The Daily Driver" (primary)
Knowledge worker or student managing personal and work tasks from a laptop and a phone.
- JTBD: Capture a task in under 5 seconds without leaving what I'm doing.
- JTBD: See what today owes me — and only today — in one glance.
- JTBD: Close loops; trust that completed and overdue items are accurate.
- Environment: desktop browser at a desk; mobile browser in transit/queues.

### P2 — "The Privacy Custodian" (primary)
Will not put a task list on a third-party server (sensitive personal or professional context, or
simply a privacy stance).
- JTBD: Keep my task system where no vendor can read, mine, or train on it.
- JTBD: Understand exactly where my data lives and prove I can take it with me.

### P3 — "The Offline Traveler" (primary)
Field worker, frequent traveler, or anyone on unreliable connectivity.
- JTBD: Full function with zero bars — never a spinner, never a blocked write.
- JTBD: Never lose a task to a failed sync or a reload.

### P4 — "The GTD Power User" (secondary)
Wants projects, contexts/tags, recurring routines, and a weekly review, driven at keyboard speed.
- JTBD: Run a trusted system I can review weekly and drive without touching the mouse.

### P5 — "The Self-Hoster Syncer" (secondary; Q2 DECIDED: WebDAV sync is V1)
Has personal cloud storage (Nextcloud/WebDAV, or a drive provider) and wants multi-device through
their own storage, not ours.
- JTBD: Sync across MY devices through MY storage, with no vendor account.

**Anti-personas (deliberately unserved):** teams needing shared/real-time lists (requires backend);
users wanting email/Slack integrations (requires outbound services).

---

## 4. Core features and prioritisation

Legend: MUST = MVP; SHOULD = V1 (post-MVP, committed direction); COULD = stretch (explicitly
optional); WON'T = this release.

### MUST — MVP
| # | Feature | Notes |
|---|---------|-------|
| M1 | Task CRUD | title, notes, due date, list, priority (high/med/low), open/done |
| M2 | Lists | create, rename, reorder, delete (with task disposition choice) |
| M3 | Views | Today, Next 7 days, All open, per-list, Completed |
| M4 | Complete / uncomplete | optimistic UI; destructive actions confirm in MVP (undo toast = S7, V1) |
| M5 | Search | title + notes, client-side, instant filter |
| M6 | Manual reorder | drag-and-drop WITH a keyboard equivalent (move up/down/into) |
| M7 | Theme | light / dark / system; no-flash boot (localStorage read pre-paint) |
| M8 | Responsive + mobile-first UI | one codebase, touch targets ≥ 44px |
| M9 | Offline app shell | service worker app-shell cache + versioned caches, offline-complete; NO manifest/install in MVP (PO Q12) — installability = S13 (V1) |
| M10 | Persistence core | IndexedDB store, `navigator.storage.persist()` request, quota display |
| M11 | Export / import JSON | full backup and restore; also the MVP "sync" story |
| M12 | Data-safety plumbing | schema versioning + migrations, boot validation, auto-snapshots (last 3) |
| M13 | Accessibility baseline | WCAG 2.2 AA (§8) — release gate |
| M14 | Minimal settings | theme, week start, default list, storage/backup panel |
| M15 | i18n — English + Thai | both locales at MVP (PO Q9); all strings externalized day one, per-locale lazy-load, `lang` switching incl. screen-reader language (§8) |

### SHOULD — V1
- S1 Tags/labels + filtering (and rename propagation).
- S2 Subtasks / per-task checklists (Q4 DECIDED: yes — V1).
- S3 Proper priority model (P1–P4 or high/med/low refined per usage).
- S4 Recurring tasks — RRULE-lite subset: daily/weekly/monthly/weekdays + interval (Q5 DECIDED: V1).
- S5 Local reminders/notifications for due times where the platform allows (Q6 DECIDED: V1, local only).
- S6 Archive + completed history with retention view.
- S7 Undo toast for destructive operations (delete, complete, move).
- S8 Keyboard shortcuts + command palette (global quick-add).
- S9 Opt-in WebDAV sync to user-provided storage (Q2 DECIDED: WebDAV is the V1 sync path) + conflict-copy surfacing.
- S10 File System Access "save/open backup as file" on Chromium (fallback: download/upload, which remains the universal path).
- S11 Storage dashboard: quota usage, last backup timestamp, persistence status, snapshot list.
- S12 Importers: Todo.txt, CSV (Q8 DECIDED: V1).
- S13 PWA installability: manifest, install prompt timing, home-screen install — hard requirement
  for V1 and the structural mitigation for R1 (PO Q12 excluded it from MVP).

### COULD — stretch
- C1 Passphrase encryption at rest (WebCrypto AES-GCM) (Q3 DECIDED: stretch).
- C3 Week/calendar view.
- C4 Natural-language quick add ("milk friday 5pm").
- C5 Additional locales beyond English & Thai (both are MVP per Q9; strings stay externalized).
- C6 Web Share Target (share-to-task from mobile share sheet) + PWA shortcuts.
- C7 Additional visual themes; system font theming.
- C8 Peer-to-peer sync (WebRTC/CRDT) — R&D only; do not commit.
- C9 Markdown in notes (requires sanitization; plain text until then).

### WON'T — this release
- Accounts/identity, server sync we operate, real-time collaboration, shared lists, push
  notifications, integrations with external task/email/chat systems, native apps.
- Attachments on tasks (PO Q7: "No attachments" — supersedes the earlier stretch recommendation;
  no OPFS investment).

---

## 5. Data model and storage strategy

### 5.1 Candidate technologies — trade-offs (facts checked 2026-10-23, sources in Appendix B)

| Technology | Strengths | Limits / risks | Verdict for this app |
|---|---|---|---|
| **localStorage** | Synchronous, trivial API, pre-paint reads (no FOUC for theme) | Hard 5 MiB/origin cap (UTF-16 strings), string-only, main-thread blocking, no indexes/queries | **Boot-critical prefs only** (theme, onboarding flags). Never task data. |
| **sessionStorage** | Tab-scoped | Dies with the tab | Not used. |
| **IndexedDB** | Async, transactions (atomic multi-record writes), structured clone, indexes & cursors, quota is a large fraction of disk (gigabyte-class on most engines) | Verbose API (wrap it), async ergonomics, versioning must be handled by us | **PRIMARY store** for all app data (lists, tasks, tags, settings, snapshots metadata). |
| **OPFS** (origin private file system) | File-like, very fast in-worker `createSyncAccessHandle()` I/O, same large quota class | Not queryable — no indexes; sync handles are worker-only; iOS Safari has had `createSyncAccessHandle` quirks — test early | **Reserved**: large snapshot blobs only — attachments are out of scope (PO Q7), so no OPFS investment is planned. Not the task store. |
| **Cache API** | Great for HTTP response caching in service workers | Not a general data store | **Service-worker asset cache only.** Never app data. |
| **File System Access API** (`showSaveFilePicker` etc.) | True "save to my disk" UX, file handles | Chromium-only pickers; Safari (all platforms) and Firefox (all versions) do not support the pickers — OPFS only | **Progressive enhancement** (S10). Universal fallback = download/upload. |
| **WASM-SQLite over OPFS** (sql.js etc.) | Real SQL querying | +1–2 MB WASM payload against our bundle budget; complexity; sync-handle quirks | **Not chosen.** Revisit only if query needs outgrow IndexedDB indexes (100k+ tasks). |

### 5.2 Chosen storage strategy (RECOMMENDED)

1. **IndexedDB** (thin typed wrapper, e.g. `idb`; one ADR to finalize): stores `lists`, `tasks`,
   `tags`, `settings`, `meta`, `snapshots`. Task indexes: `listId`, `status`, `dueDate`, `updatedAt`.
2. **localStorage**: ≤ a few KB, synchronous, pre-paint prefs only (theme, dismissed banners,
   onboarding step). Rationale: theme must apply before first paint; async boot causes FOUC.
3. **OPFS**: reserved; MVP keeps auto-snapshot blobs in IndexedDB (simpler), migrate to OPFS only
   if snapshot volume demands it (attachments are out of scope per PO Q7).
4. **Cache API**: app-shell precache in the service worker only.
5. **Export/import JSON** (M11) is the portability/backup backbone and works everywhere.

**Ids:** ULID or UUIDv7, generated client-side. Sortable, collision-safe across devices — the
foundation for any future sync (Q2) with zero rework.

**Ordering:** fractional order-key strings (e.g. base-36 rank keys) per list, so drag reorder is a
single-record write instead of a renumbering transaction.

**Deletion:** soft-delete tombstones (`deletedAt`) so deletions can propagate in any future sync
model; purge tombstones older than 90 days (or on explicit "clean up" action).

**Timestamps:** `createdAt/updatedAt/completedAt` as epoch ms UTC; `dueDate` stored as a plain
local-date string (`YYYY-MM-DD`) to avoid timezone math on all-day semantics; `deviceId` on every
record for last-write-wins tie-breaks.

**Tag storage:** denormalized `tags: string[]` on tasks for MVP simplicity (rename = one
transaction sweep over tasks, fine at 10k scale); normalize into a `tags` store only if needed.

### 5.3 Data model sketch

```
meta      { schemaVersion, deviceId, createdAt, lastOpenedAt }
List      { id, name, color, sortOrder, createdAt, updatedAt, deletedAt|null }
Task      { id, listId, title, notes|null, status: open|done|archived,
            priority: 0|1|2, dueDate?: 'YYYY-MM-DD', reminderAt?: epochMs,
            recurrence?: RRULE-lite, tags: string[], parentTaskId?: id (V1),
            sortOrder, createdAt, updatedAt, completedAt?, deletedAt|null, deviceId }
Tag       { id, name, color }                    (V1; normalized)
Settings  { theme, locale, weekStart, defaultListId, notificationsEnabled, lastBackupAt }
Snapshot  { id, takenAt, kind: auto|manual, sizeBytes, payloadRef }
```

### 5.4 Schema versioning and migrations (M12)

- `meta.schemaVersion` checked on every boot; forward-only migration chain
  (`v1→v2→…`), each migration atomic in one IDB transaction.
- Boot-time validation: schema-check every record on load after migration; quarantine invalid
  records to a downloadable "recovery" file rather than crashing or silently dropping.
- Before any migration runs: take an automatic snapshot (M12) so rollback = import snapshot.
- Export JSON includes `schemaVersion`; import upgrades old export formats through the same chain.

### 5.5 Quota, persistence, and eviction (critical — see R1)

- **Persistence request:** call `navigator.storage.persist()` after first meaningful use
  (first task created); show granted/denied state in the storage dashboard (S11).
  `navigator.storage.estimate()` powers a quota usage bar; warn at 80% usage.
- **QuotaExceededError** on any write: catch, show a blocking-but-non-destructive dialog offering
  export/cleanup — never silently drop a write.
- **iOS Safari ITP 7-day cap (the #1 data-loss risk):** script-writable storage (localStorage,
  IndexedDB, Cache API) is subject to eviction after 7 days without user interaction — but
  **installed home-screen web apps are exempt** from this rule. The structural mitigation is PWA
  install — which the PO has excluded from MVP (Q12, authoritative and recorded as such). The MVP
  mitigation stack is restated accordingly (2026-10-23):
  - `navigator.storage.persist()` (M10) at first meaningful use — the only in-browser protection
    available without install; grants are heuristic and may be refused, so treat as best-effort
    and surface the granted/denied state (S11).
  - Backup discipline: onboarding copy explains "data lives in THIS browser" and names the iOS
    7-day rule; backup-reminder nudge (S11) when `lastBackupAt` is older than N days (default 14);
    one-click export (M11) always reachable.
  - Eviction detection: `persisted()` + boot validation detect wiped or shrunken storage and warn
    before the user starts re-entering data; `lastBackupAt` is surfaced on the first run after a
    long absence.
  - **Residual risk — explicitly ACCEPTED by the PO for MVP:** an iOS Safari user who neither
    installs (not available until V1) nor backs up, and is away from the app for 7+ days, can lose
    data. PWA installability (S13) is the structural fix and the first V1 item (R1).
- **Private browsing / ephemeral storage:** detect low-availability storage (e.g. `persist()`
  denied + estimate anomalies) and warn that data may vanish with the session.
- **Auto-snapshots:** rolling last-3 snapshots in IndexedDB for corruption recovery (M12).

---

## 6. Offline and sync requirements

### 6.1 Offline behavior

- **Zero network in the app's logic path:** no fetch/XHR for data, ever. All reads/writes local.
  Online status changes nothing about functionality; there is no "offline mode" toggle because
  offline is just the app.
- **Service worker (M9):** precache app shell (HTML/JS/CSS/icons/manifest) on install; versioned
  caches with cleanup on activate; navigation fallback to cached shell. Cache-first for assets,
  network only for checking for app updates.
- **Update flow:** version check when online → "Update available" toast → apply on user action,
  never force-reload mid-edit (edge case E9).
- **Performance parity:** every interaction (add, complete, reorder) is optimistic and confirmed by
  a local transaction; no network latency in the loop.

### 6.2 Sync requirements (Q2 DECIDED: manual export/import MVP, opt-in WebDAV V1, cloud OAuth stretch)

- **MVP (RECOMMENDED):** no automatic sync. Single browser profile is the unit of storage;
  multi-device = manual export → transfer → import (M11). Honest and loss-free.
- **V1 (SHOULD — Q2 confirmed):** opt-in **WebDAV sync** to user-provided storage (Nextcloud,
  etc.). Client pulls/pushes a snapshot + change manifest; merges happen entirely client-side.
  Cloud-provider OAuth flows (Drive/Dropbox) are stretch: doable client-side with PKCE but token
  handling adds security surface.
- **Conflict policy (pre-decided so no task has to invent one):** per-record **last-write-wins**
  keyed on `(updatedAt, deviceId)`; deletions propagate via tombstones; an unmergeable conflict is
  materialized as a visible "Conflict copy of <task>" — never a silent overwrite. CRDTs are
  explicitly out (C8, R&D only).
- **Guarantees:** sync is never required for correctness of local operation; sync failure leaves
  local data untouched and shows an error state; sync is user-triggered or periodic-when-online.

---

## 7. Privacy and security model

### 7.1 Trust boundary and threat model (RECOMMENDED)

- Trust boundary = the device's browser profile. Data never leaves the origin in normal operation.
- Assets we defend against: (a) network eavesdropping/tracking — eliminated by design (no network);
  (b) third-party script supply chain — eliminated by policy (no third-party code at runtime);
  (c) shared-device snooping — optional encryption (C1) + "delete all data" control;
  (d) malicious import files — schema validation, size caps, never eval'd, treated as untrusted.
- We do **not** defend against: an attacker with full device/browser-profile access (out of scope
  without C1).

### 7.2 Policies (all RECOMMENDED, cheap to hold from day one)

- **No telemetry. Ever.** No analytics, no error reporting that phones home. Local error log only.
- **No third-party runtime requests:** no CDNs, no hosted fonts (system font stack — also better
  for performance), no remote icons. Self-host everything.
- **CSP:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
  connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (MVP can tighten
  `connect-src` to `'none'` except for update checks). No inline scripts except a hashed
  theme-boot snippet. **GitHub Pages delivery note (PO Q11):** GitHub Pages cannot set custom
  response headers, so CSP ships as a `<meta http-equiv>` tag; `frame-ancestors` is ignored in meta
  and is dropped as a documented exception (accepted: there are no cookies or sessions to protect;
  the app runs entirely client-side).
- **Dependency policy:** minimal dependencies (storage wrapper, router if any), lockfile committed,
  bundled output, license review, routine audit; user content rendered as text (no
  `dangerouslySetInnerHTML`; markdown only with sanitization, C9).
- **WebCrypto** for anything crypto; no hand-rolled primitives.

### 7.3 Encryption at rest (COULD C1 — Q3 DECIDED: stretch)

Passphrase → KDF (PBKDF2 native; Argon2 = WASM cost) → AES-GCM per-record or store-level
encryption of titles/notes; key held in memory per session, re-lock on idle. (Attachments do not
exist — PO Q7.)
**Non-negotiable UX constraints if built:** enabling it forces a backup export first, warns
explicitly that a lost passphrase means unrecoverable data, and offers an optional recovery key.

### 7.4 Data portability and deletion

- Export = complete, documented JSON (schema-versioned); import = validate → optional
  auto-snapshot → merge-or-replace (RECOMMENDED default: replace, with the pre-import snapshot as
  the undo).
- "Delete all data" button in settings (real, immediate, confirmed).
- No shadow copies, no hidden caches of user content outside app origin storage.

---

## 8. Accessibility targets

**Target: WCAG 2.2 AA as a release gate (M13).** Not aspirational — failed criteria block release.

- Full keyboard operability: every task/list/view operation reachable and visible-focusable,
  including a keyboard alternative to drag-reorder (move up / down / indent-style into-list).
- Semantics: real list semantics (`ul/li` + native checkboxes or `role="checkbox"` with correct
  state), labelled inputs, correct heading hierarchy, landmark regions.
- Feedback: ARIA live-region announcements for async/silent changes ("Task completed", "Task moved
  to Work", save errors).
- Dialogs/menus: focus trap, Escape to close, focus returned to trigger.
- Visual: contrast ≥ 4.5:1 text / 3:1 UI components; light + dark both compliant; status never
  encoded by color alone; `prefers-reduced-motion` respected; 200% text zoom reflow without loss.
- Touch: ≥ 44×44 CSS px targets on mobile; gestures always have button equivalents.
- Localization (M15, PO Q9): `html lang` follows locale; Thai text rendered via the system font
  stack (no webfont download); line-height and 200%-zoom reflow tested with Thai diacritic/vowel
  stacking; VoiceOver/NVDA language switching validated per locale (Thai voice availability is a
  known QA constraint).
- Testing: axe-core automated checks in CI + per-release manual passes with NVDA (Windows) and
  VoiceOver (macOS/iOS); a written keyboard-only test script (10 core flows).

---

## 9. Non-functional requirements

### 9.1 Performance budgets (RECOMMENDED; measured on mid-tier mobile — Moto-G class, 4× CPU
throttle, slow 4G — plus desktop cold cache)

| Metric | Budget |
|---|---|
| LCP (first load) | < 1.5 s |
| INP (core interactions: add/complete/reorder) | < 200 ms |
| CLS | < 0.1 |
| TBT | < 200 ms |
| Warm/offline start to interactive | < 300 ms |
| Task add → visible in list | < 100 ms perceived (optimistic) |
| Search over 10,000 tasks | < 50 ms |
| Boot with 10,000 tasks to first data paint | < 500 ms |
| Scroll | 60 fps; virtualize beyond ~200 DOM rows |

### 9.2 Bundle budgets

| Asset | Budget |
|---|---|
| Initial JS (gzip) | ≤ 100 KB (target 80 KB) |
| CSS (gzip) | ≤ 20 KB |
| Total app shell (gzip, excl. icons/manifest) | ≤ 200 KB |
| Runtime third-party bytes | **0** |
| WASM | 0 in MVP (a WASM payload is a budget exception requiring an ADR) |
| Locale strings (en + th, lazy per-locale) | ≤ 20 KB gzip total |

Route-level code-splitting for settings/sync/features beyond the core loop. Thai text (PO Q9) uses
the system font stack with Thai fallbacks — no webfont bytes, preserving the zero-third-party rule
(§7.2) and the shell budget. UI framework choice (Preact vs Svelte vs vanilla) is an h_senior_coder
ADR constrained by these budgets.

### 9.3 Reliability

- No data loss on crash/kill mid-write (IDB transactions are the guarantee; never partial writes).
- Corrupt-record recovery (§5.4); snapshot restore path tested like a feature.
- Concurrent tabs: IDB transactions + BroadcastChannel "data changed" refresh; per-record LWW.
- Target: 99.9% crash-free sessions (locally measured; no phoning home).

### 9.4 Compatibility (DECIDED — PO Q10: modern-only floor as stated)

- Last 2 major versions: Chrome, Edge, Firefox, Safari (desktop).
- iOS Safari ≥ 16.4; Android Chrome ≥ 110.
- Feature detection + graceful degradation for: File System Access pickers, OPFS sync handles,
  Notification API, Web Share Target. The core loop must work on every listed browser without
  any of these.

### 9.5 Quality and engineering

- TypeScript strict; unit tests (Vitest) for domain logic, migrations, merge/conflict rules —
  ≥ 80% coverage on those modules; component tests for task/list interactions; Playwright E2E:
  add → complete → reload → data present → export → wipe → import → data restored (run offline).
- CI on every PR: lint, typecheck, unit, E2E smoke, axe checks, bundle-size gate (fails over budget).
- ADRs required for: storage wrapper/schema, service worker strategy, sync protocol (V1),
  encryption (C1), UI framework.
- Distribution: **GitHub Pages** (PO Q11), deployed from CI (GitHub Actions → Pages). HTTPS
  mandatory (secure context for Service Worker, `persist()`, WebCrypto — `*.github.io` supplies
  it). Consequences folded in: no custom response headers (CSP via meta tag, §7.2); the build must
  accept a configurable base path (project pages serve under `/<repo>/`, which sets service-worker
  scope and, in V1, manifest `start_url`/`scope`); the 1 GB published-site soft limit is far above
  our ≤ 200 KB shell.

---

## 10. Edge cases and failure modes

| # | Case | Handling |
|---|---|---|
| E1 | iOS Safari 7-day eviction, non-installed tab | persist() (M10), backup nudges (S11), eviction detection + first-run-after-absence warning; PWA install (S13, V1) is the structural fix — PO Q12 kept it out of MVP |
| E2 | User clears browser data / new device | Onboarding truth-copies; export reminders; last-backup visible |
| E3 | QuotaExceededError on write | Catch → dialog with export/cleanup; never silent loss |
| E4 | Corrupt record / failed migration | Boot validation, quarantine-to-file, snapshot restore |
| E5 | Two tabs writing simultaneously | IDB transactions + BroadcastChannel refresh; per-record LWW |
| E6 | Clock skew / timezones | dueDate as local date string; timestamps UTC ms |
| E7 | 10–100× data growth (100k tasks) | Indexed queries, pagination, virtualized lists, in-memory search index |
| E8 | Malicious/corrupt import file | Size caps, schema validation, never eval, pre-import snapshot |
| E9 | App update mid-edit | Never force reload; apply on user action |
| E10 | Private-browsing ephemeral storage | Detect and warn loudly at first write |
| E11 | Notification permission denied / unsupported (V1) | Silent degrade to in-app due-date indicators |

---

## 11. Risk register

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | iOS Safari storage eviction wipes data (non-installed usage) | H | H | MVP (PO Q12: no install): persist() + backup discipline + eviction detection + honest onboarding (§5.5) — residual risk ACCEPTED by PO; PWA install (S13, V1) is the structural fix that brings impact back to M |
| R2 | User-caused data loss (clearing data, new device) without a backup | M | H | Export discipline, auto-snapshots, visible last-backup age, onboarding |
| R3 | Sync scope creep explodes the schedule (protocols, conflicts) | M | H | MVP has zero auto-sync; WebDAV only after Q2 answer + ADR; conflict policy pre-decided (§6.2) |
| R4 | Recurrence semantics balloon (exceptions, timezone edge cases) | M | M | RRULE-lite subset only (S4); defer exceptions |
| R5 | Browser API fragmentation (pickers, OPFS quirks on iOS) | M | M | Feature detection + universal fallbacks; early iOS device testing |
| R6 | Performance collapse at large task counts | L | H | Budgets enforced in CI; virtualization; indexed queries |
| R7 | Encryption UX: lost passphrase = lost data | M | H | Stretch-only; forced backup before enable; recovery key option |
| R8 | Dependency/supply-chain churn | L | M | Minimal deps, lockfile, bundle gate, no runtime third parties |
| R9 | Single-maintainer continuity | M | M | ADRs, schema docs, tests as onboarding docs |

---

## 12. Decision frontier — grill-me Q&A (PO-validated 2026-10-23)

Format per grill-me: question, recommendation, PO answer. All 15 questions were answered by the PO
on 2026-10-23 (comment thread of t_368da4e7); every RECOMMENDED/OPEN marker in this document is
now DECIDED. Four answers deviate from the recommendations and are folded into the affected
sections — Q7 (§5.1/§5.2, C2 -> WON'T), Q9 (M15, §8, §9.2), Q11 (§9.5), Q12 (M9/S13, §5.5, R1) —
not silently converted.

**Round 1 — product scope**

❓ Q1 — Collaboration horizon: Is this strictly single-user forever, or should shared/family lists
ever be possible? (It drives sync and identity design.)
➡️ Recommendation: single-user for this product; keep `deviceId`/timestamps (cheap, sync-ready)
but design nothing else for multi-user.
✅ PO answer (2026-10-23): **agree** — single-user. DECIDED.

❓ Q2 — Multi-device story: manual export/import only (MVP), opt-in WebDAV (V1), or cloud-provider
sync (stretch)? This is the biggest scope lever in the project.
➡️ Recommendation: MVP manual export/import; V1 opt-in WebDAV with the pre-decided LWW conflict
policy; cloud OAuth stretch. No server we operate, ever.
✅ PO answer (2026-10-23): **agree** — MVP manual export/import; V1 opt-in WebDAV with the pre-decided LWW policy; cloud OAuth stretch; never a server we operate. DECIDED.

❓ Q3 — Encryption at rest: MVP, V1, or never?
➡️ Recommendation: stretch (C1). Hold the "no plaintext-only assumptions" line in the schema now;
build crypto only with the forced-backup + recovery-key UX.
✅ PO answer (2026-10-23): **agree** — stretch (C1); schema stays encryption-ready. DECIDED.

❓ Q4 — Task model depth: flat tasks + lists for MVP, or subtasks/projects from day one?
➡️ Recommendation: flat tasks + lists MVP; subtasks in V1 (parentTaskId already in the model).
✅ PO answer (2026-10-23): **agree** — flat tasks + lists MVP; subtasks in V1. DECIDED.

❓ Q5 — Recurrence in MVP?
➡️ Recommendation: no. V1, RRULE-lite subset only (daily/weekly/monthly/weekdays + interval).
✅ PO answer (2026-10-23): **agree** — no recurrence in MVP; RRULE-lite subset in V1. DECIDED.

❓ Q6 — Reminders/notifications needed at all?
➡️ Recommendation: V1 local notifications where supported (no push — no backend); in-app due-date
indicators are the MVP mechanism.
✅ PO answer (2026-10-23): **agree** — in-app due-date indicators in MVP; V1 local notifications where supported. DECIDED.

❓ Q7 — Attachments: in scope ever? (Decides whether OPFS investment happens.)
➡️ Recommendation: stretch (C2); decide before V1 to protect quota and bundle budgets.
✅ PO answer (2026-10-23): **"No attachments"** — deviates from the recommendation (stretch): attachments are out of scope entirely (C2 moved to WON'T, §4), and no OPFS investment is planned (§5.1/§5.2). DECIDED.

❓ Q8 — Importers for existing tools (Todoist, Apple Reminders, Todo.txt, CSV)?
➡️ Recommendation: JSON export/import only in MVP; Todo.txt + CSV in V1.
✅ PO answer (2026-10-23): **agree** — JSON export/import only in MVP; Todo.txt + CSV in V1. DECIDED.

❓ Q9 — Languages beyond English?
➡️ Recommendation: English-only MVP, but all strings externalized from day one.
✅ PO answer (2026-10-23): **"English and Thai"** — deviates from the recommendation (English-only MVP): both locales ship at MVP (M15). Recorded interpretation: the answer means English AND Thai at MVP — the only reading that deviates from the recommendation; Thai strings are PO-validated content, English is the source of truth. Impacts folded: i18n infra + per-locale lazy-load with a §9.2 budget row, Thai system-font rendering (no webfont bytes), Thai text a11y checks (§8). DECIDED.

❓ Q10 — Browser floor: is "last 2 majors + iOS Safari 16.4 + Android Chrome 110" acceptable, or
is legacy support required?
➡️ Recommendation: modern-only floor as stated; legacy support would break the bundle budget.
✅ PO answer (2026-10-23): **agree** — modern-only browser floor as stated. DECIDED.

❓ Q11 — Hosting/distribution: where does this ship (GitHub Pages, Netlify, self-host, custom
domain)? Affects manifest/URL decisions and update-check mechanics.
➡️ Recommendation: any static host + HTTPS; decide late — it barely affects the build.
✅ PO answer (2026-10-23): **"GitHub Pages"** — deviates from "decide late": the deployment target is now fixed (§9.5). Consequences folded: CI deploys via GitHub Actions; CSP ships as a meta tag (GitHub Pages sets no response headers; `frame-ancestors` dropped as a documented exception, §7.2); configurable base path required. DECIDED.

❓ Q12 — Is PWA home-screen install a hard requirement or a nice-to-have?
➡️ Recommendation: HARD requirement — it is the mitigation for R1 (iOS eviction), and the app
should prompt for install at the right moment (after first task created).
✅ PO answer (2026-10-23): **"exclude PWA in MVP"** — deviates from the recommendation (HARD), and the PO decision is authoritative. Recorded interpretation: offline operation is a settled constraint (§0 items 1 & 4) and the Q15 DoD requires it, so MVP keeps the service-worker app-shell cache (M9) and drops only installability (manifest + install prompt -> S13, V1). The R1 mitigation is restated in §5.5 (persist() + backup discipline + eviction detection + honest onboarding); the residual iOS eviction risk for non-installed, non-backing-up users is explicitly ACCEPTED by the PO for MVP, and S13 is the first V1 item (R1). DECIDED.

❓ Q13 — Notes: plain text, or markdown/rich text?
➡️ Recommendation: plain text in MVP; markdown only as stretch with sanitization (C9).
✅ PO answer (2026-10-23): **agree** — plain text notes in MVP; markdown stays stretch (C9, sanitization required). DECIDED.

❓ Q14 — Completed-task retention: keep forever, archive view, or auto-purge?
➡️ Recommendation: keep until the user deletes; Completed + Archive views; no auto-purge.
✅ PO answer (2026-10-23): **agree** — keep until the user deletes; no auto-purge. DECIDED.

❓ Q15 — MVP success criteria: what must be true to call MVP done?
➡️ Recommendation: the capture→plan→complete loop works offline on desktop + mobile for 30 days of
daily use with zero data loss, export/restore verified, WCAG 2.2 AA passed, budgets green in CI.
✅ PO answer (2026-10-23): **agree** — MVP DoD as stated: capture→complete works offline on desktop + mobile through 30 days of daily use with zero data loss; export/restore verified; WCAG 2.2 AA passed; budgets green in CI. DECIDED.

**Explicitly out of scope** (settled): accounts, server-side anything, real-time collaboration,
push notifications, native apps (§2), attachments (PO Q7).

---

## Appendix A — Proposed epic decomposition preview (validated shape — PO answers folded 2026-10-23)

Sizing/ownership only; h_pm formalizes this into the kanban backlog (decomposition card
t_1b9ee0e6) now that §12 is answered.

1. **Epic: Infrastructure & DevOps** — static app scaffold on GitHub Pages (CI deploy; configurable
   base path — §9.5), CI (lint/type/test/bundle gates), UI framework ADR, storage layer ADR +
   IndexedDB wrapper, schema/migration framework. → h_senior_coder (arch + core), h_junior_coder
   (scaffold/config).
2. **Epic: Core Domain — Task & List Management** — CRUD, views (Today/Upcoming/All/list/
   Completed), search, reorder (drag + keyboard), optimistic UI. → Design first (h_designer),
   arch/complex impl h_senior_coder, standard impl h_junior_coder, test+review h_reviewer.
3. **Epic: Data Safety & Portability** — export/import, snapshots, boot validation + recovery,
   quota dashboard, backup nudges (the MVP R1 defence, §5.5). → h_senior_coder (migration/merge
   logic), h_reviewer (corruption drill tests).
4. **Epic: Offline & (V1) PWA Experience** — MVP: service worker, app-shell caching, update toast,
   iOS persistence story (§5.5). V1: PWA install flow + prompt timing (S13 — the R1 structural
   fix; PO Q12 excluded installability from MVP). → h_senior_coder (SW strategy), h_junior_coder
   (UI).
5. **Epic: UX Foundation, Accessibility & i18n** — responsive mobile-first shell, theme (no-FOUC),
   English + Thai locales (M15, PO Q9) incl. Thai text QA script, WCAG 2.2 AA implementation +
   test script. → h_designer (spec), h_junior_coder (impl), h_reviewer (a11y + Thai text gate).
6. **Epic: V1 Organization** — tags, subtasks, priorities, recurrence (RRULE-lite), undo.
   (Q4/Q5 DECIDED: V1 — no longer gated.)
7. **Epic: V1 Sync (WebDAV)** — protocol ADR, merge/LWW, conflict copies, sync UI. (Q2 DECIDED:
   WebDAV is the V1 sync path.)
8. **Epic: Stretch — Encryption (at rest)** — forced-backup + recovery-key UX, WebCrypto AES-GCM.
   (Q3 DECIDED: stretch. Q7 DECIDED: attachments out of scope — no attachments/OPFS epic exists.)

Dependency notes for decomposition: Design/Arch precede each Impl; Data Safety is the spine that
other epics hang on; Sync is a standalone late epic that must not gate MVP.

## Appendix B — Facts consulted (2026-10-23)

- localStorage: 5 MiB per origin (UTF-16 string data); QuotaExceededError at cap — MDN Storage
  quotas & eviction criteria (developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).
- IndexedDB/OPFS quotas are a large fraction of disk (gigabyte-class), but all browser storage is
  best-effort and evictable under pressure — MDN (above) + RxDB browser-storage comparison
  (rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html).
- Safari ITP 7-day cap applies to script-writable storage (Web Storage, IndexedDB, Cache API) after
  7 days without user interaction; **installed home-screen web apps are exempt** —
  browser-storage.com (iOS Safari 7-day eviction workaround), Synthetixis "PWAs on iPhone in 2026"
  (synthetixis.com/writing/pwa-ios-2026), near-wallet issue #479 (historical behavior).
- `navigator.storage.persist()` / `persisted()`: request persistent storage bucket; browser may
  decline; secure context — MDN StorageManager.persist (developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist).
- File System Access pickers (`showSaveFilePicker`/`showOpenFilePicker`/`showDirectoryPicker`):
  Chromium only; Safari supports OPFS only (15.2+); Firefox lacks the pickers — testmuai.com File
  System Access support summary; MDN File System API / OPFS pages.
- OPFS `createSyncAccessHandle()`: worker-only fast I/O; historical iOS Safari quirks (StackOverflow
  76113945) → verify on iOS early (R5).
