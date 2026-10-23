# Design Spec: Data-safety, backup & onboarding UX (E3)

Status: FINAL — ready for implementation handoff
Author: h_designer (task t_b859b131)
Date: 2026-10-23
Deliverable of: kanban task t_b859b131 (Epic E3 Data Safety & Portability, decomposition card t_1b9ee0e6)

---

## 1. Feature context (from h_pm)

- Epic: E3 Data Safety & Portability.
- Sources of truth: PROJECT_ANALYSIS.md §5.5 (MVP R1 mitigation stack), §7.4 (portability/deletion),
  §10 (E1/E2/E3/E10), §4 (M10–M12, M14).
- Binding decisions (NOT re-decided here):
  - No backend, no accounts. Data never leaves the browser except user-initiated export.
  - MVP ships NO PWA install (PO Q12) — onboarding is honest about the residual iOS Safari
    eviction risk and points to backups as the protection path.
  - Import default = replace, with the pre-import auto-snapshot as the undo (§7.4).
  - Tone: plain, non-alarming, unambiguous.
- Acceptance criteria this spec must satisfy:
  1. Panel layout (mobile + desktop), every dialog/nudge with exact copy drafts, warning
     hierarchy, first-run/empty states.
  2. Copy explicitly names the iOS 7-day rule and the backup protection path.
  3. Import confirm + pre-import-snapshot-undo interaction fully specified.
  4. Handoff section lists UI states for implementation.

### 1.1 Scope of this surface

Six surfaces, one vocabulary, one severity system:

| # | Surface | Trigger | Blocking? |
|---|---------|---------|-----------|
| S1 | Onboarding "Your data lives in this browser" | First run ever (localStorage flag absent) | Yes (one screen, skippable by CTA only) |
| S2 | Settings → Storage & back up panel (M14) | User navigates to settings | No |
| S3 | Backup-reminder nudge | `lastBackupAt` older than 14 days (or never) | No |
| S4 | QuotaExceededError dialog | Any write throws `QuotaExceededError` | Yes, non-destructive |
| S5 | Eviction / wipe detection warning + recovery screen | Boot validation finds store empty or shrunken after prior use; or first run after ≥ 7-day absence | Banner if data intact; screen if data gone |
| S6 | Private-browsing / ephemeral-storage warning | Heuristic detected at first meaningful write | One-time dialog |

Plus the import flow (confirm + snapshot undo) specified in §8, which is the only place data
crosses the trust boundary.

### 1.2 Design principles for this surface

1. Never silently lose a write. If a save fails, the user sees it and keeps the pending content.
2. Name the risk, name the remedy. Every risk statement is paired with the backup path.
3. One primary action per surface. Export is always one tap away; it is never the only option
   in a crisis dialog (cleanup matters too).
4. Plain language. No "persistence bucket", no "eviction" without explanation, no alarm-red
   unless data is actually at stake.
5. Honesty over comfort: the iOS 7-day rule is stated, not softened (PO Q12 accepted the
   residual risk; the copy must not pretend it away).

---

## 2. Warning hierarchy (severity system)

Every message in this surface belongs to exactly one tier. Tier decides placement, color,
dismissability, and escalation. Implementation must not invent new placements.

| Tier | Name | Color token | Placement | Dismissible | Used by |
|------|------|-------------|-----------|-------------|---------|
| T0 | Info / onboarding | `info` (neutral accent) | Onboarding screen, panel explainer text | n/a (screen) | S1 |
| T1 | Nudge | `warning-subtle` (amber tint bg, no icon alarm) | Banner slot under app header, above content | Yes: "Remind me later" (7-day snooze) + close; auto-dismiss on successful export | S3, S5-long-absence |
| T2 | Warning | `warning` (amber icon + amber left-rule) | Banner slot (same as T1) + panel row state | Persistent until condition clears; close = "Hide for7 days" | Quota ≥ 80%, persistence denied, S5-data-intact |
| T3 | Blocking dialog | `danger` (red icon only, calm body) | Modal, focus-trapped, `role="alertdialog"` | Only via explicit action (never a bare close on destructive paths; Escape = safe cancel) | S4, S6, import confirm, delete-all-data, S5 recovery screen |
| T4 | Success / confirmation | `success` | Toast, `role="status"` | Auto (8 s) or click | Export done, import done + undo |

Escalation rules:

- A T1/T2 banner never stacks more than two visible at once. Priority order: S5 > S6 >
  S4-context > quota 80% > persistence denied > backup nudge. If more would show, the
  highest-priority banner shows with a "2 more notices" text button that opens the panel.
- T3 dialogs are mutually exclusive (queue, don't stack).
- Color is never the only signal: every tier carries an icon + a text label ("Note",
  "Worth a look", "Action needed", "Done") so color-blind users and screen readers get the
  tier (WCAG 2.2 AA §1.4.1).

---

## 3. User flows

### 3.1 Flow A — First run (S1)

1. App opens for the first time (`localStorage['onboarding.step']` unset).
2. Onboarding screen "Your data lives in this browser" (§6.1) appears before any task UI.
3. User reads the three facts (where data lives, iOS 7-day rule, backups = protection).
4. Primary CTA "Get started" → main app, sets `onboarding.step = done`, requests
   `navigator.storage.persist()` lazily at first task creation (not here).
5. Secondary link "How backups work" → scrolls/expands the inline explainer (same screen,
   no navigation).

### 3.2 Flow B — Backup discipline (S3)

1. On any app load, the shell computes `backupAgeDays = today − settings.lastBackupAt`
   (never → treat as +∞).
2. If `backupAgeDays ≥ 14` (default threshold; configurable in code constant
   `BACKUP_NUDGE_DAYS = 14`) and the nudge is not snoozed → show T1 nudge banner (§6.3).
3. Actions: "Back up now" (runs export; on success the banner auto-dismisses and
   `lastBackupAt` updates), "Remind me later" (snooze 7 days), close (same as snooze).
4. The panel row (§6.2) always shows the age regardless of nudge state.

### 3.3 Flow C — Quota pressure (S4)

1. Any write path catches `QuotaExceededError`.
2. The failed write is held in a pending queue in memory (the record stays visible as
   "Not saved yet" — see §9 states) and the T3 dialog opens (§6.4).
3. Dialog offers exactly three actions: "Free up space", "Export a backup", "Try again".
   There is no "OK"/dismiss that discards the pending write. Escape/close maps to
   "Try again" semantics = keep pending, close dialog, leave the app usable (banner T2
   persists until the write lands).
4. "Free up space" opens the panel with the cleanup affordances in view (delete completed
   tasks, delete old snapshots).
5. On successful retry: pending row turns normal, dialog never re-opens for that write,
   T2 banner clears.

### 3.4 Flow D — Eviction / wipe detection (S5)

Boot validation (M12) classifies each boot:

| Condition | Classification | Surface |
|-----------|----------------|---------|
| Store empty AND `localStorage` remembers prior use (`meta.lastOpenedAt` seen before, or `lastBackupAt` set) | **Wiped** | Full-screen recovery (§6.5) |
| Store present AND `meta.lastOpenedAt` gap ≥ 7 days | **Long absence** | T1 banner (§6.6) with `lastBackupAt` surfaced |
| Store present AND record count or `usage` shrinks > 30% vs snapshot metadata | **Shrunken** | T2 banner + panel row warning |
| Fresh profile, no memory of prior use | Normal | Onboarding (Flow A) |

Wiped flow: recovery screen names what happened (incl. the iOS 7-day rule when Safari), shows
"Your last backup was … / You have never backed up", and offers "Restore from a backup" (opens
import) and "Start fresh" (creates empty store, goes to main app). Nothing is auto-created
before the user chooses.

### 3.5 Flow E — Private browsing (S6)

1. At first meaningful write (first task created) run the ephemeral-storage heuristic:
   `navigator.storage.persist()` returns false AND (`storage.estimate().quota` < 50 MB OR
   `document.requestStorageAccess`/UA signals indicate private mode) — heuristic, best-effort.
2. If flagged → one-time T3 dialog (§6.7). Sets `localStorage['warned.private'] = 1` so it
   shows at most once per profile.
3. Actions: "Export a backup" (runs export now), "Got it" (dismiss, app fully usable).
   Copy never claims data is definitely lost — it says "may be deleted when this window
   closes".

### 3.6 Flow F — Import with snapshot undo (§8)

The only flow that crosses the trust boundary. Fully specified in §8.

---

## 4. Screen: Settings → Storage & back up (S2)

Route: `/settings#storage` (settings is route-split per §9.2 budgets; this section is lazy).
Purpose: one place that answers "is my data safe, and can I take it with me?".

### 4.1 Layout — desktop (≥ 1024px)

Settings content column max-width 720px, left-aligned within the settings shell. The panel is
a single card stack (sections in one continuous surface, separated by 1px rules):

```
┌──────────────────────────────────────────────────────────┐
│ Storage & back up                                (h2)    │
│ Everything here lives in this browser. …explainer (T0)   │
├──────────────────────────────────────────────────────────┤
│ Storage in this browser                          (h3)    │
│ [██████████████░░░░░░░░░░░░░] 41 MB of ~2 GB (2%)        │
│ Status line (color + label, e.g. "Note — plenty of room")│
├──────────────────────────────────────────────────────────┤
│ Keeping your data                                (h3)    │
│ ● Protected — this browser is keeping app data   (row)   │
│   [Ask again] (only when denied/not-requested)            │
├──────────────────────────────────────────────────────────┤
│ Backup                                           (h3)    │
│ Last backup: 18 days ago (5 Oct 2026)                    │
│ [ Back up now ]  (primary)      [ Import… ]   (secondary)│
├──────────────────────────────────────────────────────────┤
│ Snapshots                                  (h3)          │
│ • Before import — 23 Oct 2026, 14:02   [ Restore ]       │
│ • Automatic — 21 Oct 2026, 09:11       [ Restore ]       │
│ • Automatic — 19 Oct 2026, 09:08       [ Restore ]       │
├──────────────────────────────────────────────────────────┤
│ Danger zone                                      (h3)    │
│ Delete all data from this browser   [ Delete all data ]  │
└──────────────────────────────────────────────────────────┘
```

Desktop niceties: `Last backup` row uses two columns (label / value + action) at ≥ 768px.

### 4.2 Layout — mobile (< 768px)

Single column, same section order, same content. Differences only:

- Section headers stack above content; rows become full-width vertical pairs (label line,
  then action line).
- "Back up now" is a full-width primary button; "Import…" full-width secondary below it.
- The quota bar keeps its label above and value below (no side-by-side below 360px).
- Danger zone stays at the bottom; its button is full-width `danger-outline` (not filled —
  filled red reserved for the confirm dialog's final action).
- Touch targets ≥ 44×44 CSS px (M8).

Breakpoints used: 320 (min), 768, 1024, 1440. Content is identical at every width — no
desktop-only data.

### 4.3 Section specs

**Explainer (T0), always first:**
Copy: "Everything in {{appName}} is stored in this browser, on this device. There is no
account and no server — nothing is uploaded. Backups (export files) are the way to protect
your data and move it to another device."

**Storage in this browser (QuotaMeter):**
- Visual: 8px rounded progress track (`surface-2` bg, fill `accent` / `warning` / `danger`
  by tier), 3px min visible fill even at ~0%.
- Value line: "{{used}} of ~{{total}} ({{percent}}%)" — totals from
  `navigator.storage.estimate()`; round used to MB below 1 GB, GB above; total rounds to a
  friendly "≈2 GB".
- Tier thresholds: < 80% `accent` + label "Note — plenty of room" (hide the label when
  < 50% to reduce noise); 80–89% `warning` + "Worth a look — storage is filling up";
  ≥ 90% `danger` + "Action needed — storage is almost full"; estimate unavailable →
  track shows hatched/indeterminate state + "Your browser doesn't report storage use here."
- ARIA: `role="meter"`/`aria-valuenow/min/max` + visible text (text carries the meaning;
  the bar is decoration).

**Keeping your data (persistence row):**
Four states with exact copy (§10 state table). Denied/not-requested states show an "Ask
again" / "Request protection" button (calls `navigator.storage.persist()`; result updates
the row and announces politely).

**Backup:**
- Row: "Last backup: {{relative}} ({{absolute}})" where relative ∈
  "Never", "Today", "Yesterday", "N days ago", "N months ago". `Never` renders in
  `danger` text ONLY within this row when data exists; the nudge banner (T1) is the
  non-alarming channel.
- Primary button "Back up now" — always visible, never disabled except during export
  (loading state per §10). Triggers export (M11) → browser download of
  `{{appName}}-backup-YYYY-MM-DD.json` → on success update `lastBackupAt`, announce
  "Backup saved to your downloads."
- Secondary button "Import…" opens the import flow (§8).

**Snapshots:**
- Lists the rolling last-3 auto-snapshots (M12) newest first; each row: kind label
  ("Automatic" / "Before import" / "Before update"), taken-at timestamp, size,
  "Restore" secondary button.
- Restore runs the same confirm + snapshot-undo pattern as import (§8.4) with replace
  semantics.
- Empty state (no snapshots yet): "Snapshots are automatic safety copies made before big
  changes (like an import). You'll see up to three here."

**Danger zone:**
- Explainer: "This permanently deletes every task, list and setting from this browser. Export
  a backup first if you might want this data again."
- Button "Delete all data" → T3 confirm (§6.8).

### 4.4 Interactions & accessibility

- Section headers are real `h3` under the page `h2`; landmarks preserved.
- Every async result announced via polite live region (`role="status"`): export done,
  persist() granted/denied, restore done.
- Focus order follows visual order; "Ask again" button is reachable by keyboard and shows
  the 2px `focus-ring` token.
- Snapshot list > 3 items is impossible (rolling 3); if the storage layer ever exposes more,
  virtualization is NOT needed — cap rendering at 3 and link "Show all" (deferred).

---

## 5. Component API (for coders)

All copy goes through i18n keys (§11); components take keys or resolved strings, never
hard-code English. TypeScript-first.

### 5.1 `<StoragePanel>`

```ts
interface StoragePanelProps {
  quota: { usedBytes: number; totalBytes: number | null };  // null total = unknown
  persistence: 'granted' | 'denied' | 'unsupported' | 'not-requested';
  lastBackupAt: number | null;          // epoch ms; null = never
  snapshots: SnapshotMeta[];            // newest first, max 3
  onRequestPersist: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onRestoreSnapshot: (id: string) => void;
  onDeleteAll: () => void;
  now?: number;                         // injectable clock for age math/tests
}
```
States: `idle | export-loading | import-loading | persist-loading | error(subsection)`.
Slots: `explainer`, `footerNote` (escape hatches for locale-specific copy).

### 5.2 `<QuotaMeter>`

```ts
interface QuotaMeterProps {
  usedBytes: number;
  totalBytes: number | null;            // null → indeterminate state
  thresholdWarn?: number;               // default 0.8
  thresholdCrit?: number;               // default 0.9
  labels: { ok?: string; warn: string; crit: string; unknown: string };
}
```
Emits: none (presentational). Internal tier: `ok | warn | crit | unknown`.
Visual states: `ok | warn | crit | unknown | loading` (loading = static shimmer track,
`prefers-reduced-motion` → flat `surface-2`).

### 5.3 `<PersistenceRow>`

```ts
interface PersistenceRowProps {
  state: 'granted' | 'denied' | 'unsupported' | 'not-requested';
  onRequest?: () => void;               // absent → button not rendered
  busy?: boolean;
}
```
Emits: `request`. States: the four `state` values × `busy | idle`.

### 5.4 `<BackupRow>`

```ts
interface BackupRowProps {
  lastBackupAt: number | null;
  dataExists: boolean;                  // false → "Never" neutral, no danger styling
  onExport: () => void;
  onImport: () => void;                 // opens file picker, then ImportFlow
  exportState: 'idle' | 'saving' | 'saved' | 'error';
}
```

### 5.5 `<NudgeBanner>`

```ts
type BannerKind = 'backup-reminder' | 'quota-warn' | 'persist-denied' | 'long-absence' | 'shrunken';
interface NudgeBannerProps {
  kind: BannerKind;
  tier: 1 | 2;                          // maps to warning-subtle / warning styling
  title: string;
  body: string;
  actions: Array<{ id: string; label: string; variant: 'primary' | 'secondary' | 'link' }>;
  onAction: (id: string) => void;
  onSnooze: (days: number) => void;     // banner close = snooze(7)
  moreCount?: number;                   // "N more notices" overflow control
  onShowAll?: () => void;               // → navigate to panel
}
```
States: `visible | entering (motion 200ms) | leaving | snoozed | suppressed-by-priority`.

### 5.6 `<SafetyDialog>`

One dialog component with typed payloads — keeps focus management consistent.

```ts
type SafetyDialogKind =
  | 'quota-exceeded' | 'import-confirm' | 'delete-all-confirm'
  | 'private-browsing' | 'restore-confirm';
type SafetyDialogProps =
  | { kind: 'quota-exceeded'; pendingCount: number; onFreeSpace(): void; onExport(): void; onRetry(): void; }
  | { kind: 'import-confirm'; file: ImportPreview; currentCounts: DataCounts; onConfirm(): void; onCancel(): void; }
  | { kind: 'delete-all-confirm'; dataCounts: DataCounts; onConfirm(): void; onCancel(): void; }
  | { kind: 'private-browsing'; onExport(): void; onDismiss(): void; }
  | { kind: 'restore-confirm'; snapshot: SnapshotMeta; currentCounts: DataCounts; onConfirm(): void; onCancel(): void; };
```
Behavior (all kinds): `role="alertdialog"`, `aria-labelledby`/`aria-describedby`, focus
initially on the SAFEST action (never on the destructive confirm), focus trap, Escape =
cancel/safe path, focus returns to trigger on close.
States: `open | closing (120ms) | busy (confirm pressed, buttons disabled) | error`.

### 5.7 `<ImportFlow>` (state machine, not a visual component)

```ts
type ImportState =
  | { step: 'pick' }
  | { step: 'validating' }
  | { step: 'invalid'; reason: 'bad-json' | 'schema-unknown' | 'too-large' | 'not-our-file' | 'newer-version' }
  | { step: 'preview'; file: ImportPreview }
  | { step: 'confirming' }                       // SafetyDialog 'import-confirm'
  | { step: 'importing' }
  | { step: 'done'; undoSnapshotId: string }     // → UndoToast
  | { step: 'failed'; recoverable: boolean };
```

```ts
interface ImportPreview {
  schemaVersion: number;
  counts: { lists: number; tasks: number; doneTasks: number; snapshots: number };
  exportedAt: number | null;                     // from file, may be absent
  fileSizeBytes: number;
}
```
Events: `stateChanged(ImportState)`, `imported(undoSnapshotId)`, `failed(reason)`.

### 5.8 `<UndoToast>`

```ts
interface UndoToastProps {
  message: string;                     // "Import complete. Your previous data is saved as a snapshot."
  actionLabel: string;                 // "Restore previous data"
  onAction: () => void;                // restore pre-import snapshot (replace back)
  onDismiss: () => void;
  variant: 'success';
}
```
Persistence rule: NO auto-dismiss while the undo snapshot still exists and the user has not
seen it (see §8.4); after first interaction it behaves like a normal 8 s toast.

---

## 6. Dialogs & nudges — exact copy drafts

`{{…}}` = runtime value. English is the source of truth; Thai strings are PO-validated
content delivered through the same i18n keys (§11).

### 6.1 Onboarding — "Your data lives in this browser" (S1, T0)

Placement: full-screen first-run screen. Heading `h1`.

- Eyebrow: "Before you start"
- H1: "Your data lives in this browser"
- Body 1: "{{appName}} stores your tasks on this device, in this browser. There is no
  account and no server — nothing you type is uploaded anywhere."
- Body 2 (fact, must be present verbatim in meaning): "One important thing: on iPhones and
  iPads, Safari can delete a website's data after 7 days if you don't visit the site. That
  can include your tasks."
- Body 3 (the protection path): "Your protection is backups. Every so often, tap Back up
  now in Settings → Storage & back up to save a backup file, and keep that file somewhere
  safe. If the browser ever clears this app's data, you can restore everything from that
  file."
- Expandable "How backups work" (details/summary, native): "A backup is a single .json file
  containing all your tasks and lists. It's created entirely on your device and saved to your
  downloads. Nothing is sent anywhere. To restore, use Import in Settings → Storage & back up."
- Primary CTA: "Get started"
- Footer note: "You'll find the storage and backup controls any time in Settings."

### 6.2 Panel explainer (S2, T0)

"Everything in {{appName}} is stored in this browser, on this device. There is no account
and no server — nothing is uploaded. Backups (export files) are the way to protect your data
and move it to another device."

### 6.3 Backup-reminder nudge (S3, T1)

Shows when `lastBackupAt` older than 14 days or never (and data exists).

- Tier label: "Worth a look"
- Title (age-aware):
  - Never: "You haven't backed up yet."
  - Otherwise: "It's been {{N}} days since your last backup."
- Body: "A backup file is your safety net — browsers (especially Safari on iPhone and iPad,
  which can remove website data after 7 days) can clear this app's data. Save a backup now
  and keep it somewhere safe."
- Actions: "Back up now" (primary) · "Remind me later" (secondary, snooze 7 days) · close
  (snooze 7 days).
- On successful export: banner auto-dismisses and does not return until the threshold
  passes again.

### 6.4 QuotaExceededError dialog (S4, T3)

- Tier label: "Action needed"
- H2: "Not enough storage space"
- Body: "Your change couldn't be saved because this browser's storage for {{appName}} is
  full. Nothing has been lost — your change is waiting and will be saved as soon as there's
  space."
- Body 2: "Free up space, or export a backup first so nothing is at risk."
- Actions (in this order): "Free up space" (primary) · "Export a backup" (secondary) ·
  "Try again" (secondary).
- Escaping the dialog (Escape / close): allowed, but a persistent T2 banner replaces it:
  "1 change is waiting to be saved." with the same three actions. The pending change is
  NEVER dropped; if the tab closes with a pending change, the app attempts an emergency
  snapshot write on `visibilitychange` (best-effort, engineering detail).

### 6.5 Recovery screen — data gone after prior use (S5, T3-equivalent full screen)

- Eyebrow: "Action needed"
- H1: "We couldn't find your tasks"
- Body: "This browser's stored data for {{appName}} is gone or was reduced. That usually
  means browser data was cleared — or, on iPhones and iPads, that Safari removed the app's
  data after 7 days without a visit."
- Body 2 (lastBackupAt surfaced, mandatory):
  - Has backup: "Your last backup was {{N}} days ago ({{date}}). You can restore everything
    from that file."
  - Never: "You haven't backed up before, so there may be nothing to restore from."
- Actions: "Restore from a backup" (primary) · "Start fresh" (secondary).
- "Start fresh" confirms in one inline line: "Starting fresh creates a new empty task list.
  Anything not restored from a backup is gone." then proceeds.

### 6.6 Long-absence banner (S5, T1)

Data intact, first run after ≥ 7-day gap.

- Tier label: "Worth a look"
- Title: "Welcome back — it's been {{N}} days."
- Body: "On iPhones and iPads, Safari can remove website data after 7 days without visits,
  so it's a good habit to back up. {{lastBackupLine}}"
  - `lastBackupLine` = "Your last backup was {{date}}." or "You have never backed up."
- Actions: "Back up now" (primary) · close ("Hide for 7 days").

### 6.7 Private-browsing warning (S6, T3, once per profile)

- Tier label: "Action needed"
- H2: "This looks like private browsing"
- Body: "In private or incognito windows, browsers delete {{appName}}'s data when the
  window closes. Anything you add here may not be there next time."
- Body 2: "Export a backup before you close this window to keep your tasks."
- Actions: "Export a backup" (primary) · "Got it" (secondary).

### 6.8 Delete-all-data confirm (T3)

- H2: "Delete all data from this browser?"
- Body: "This permanently deletes {{tasks}} tasks, {{lists}} lists and all settings from
  this browser. It cannot be undone."
- Body 2 (protection path): "If you might want this data later, export a backup first."
- Actions: "Export a backup first" (secondary) · "Cancel" (secondary) · "Delete everything"
  (danger-filled, final action). Focus starts on "Export a backup first".
  Confirm requires the second click through `busy` state; no typed confirmation in MVP
  (single-user local data; keep friction proportionate).

---

## 7. First-run & empty states (complete list)

| Situation | Surface | Spec |
|-----------|---------|------|
| Very first launch | Onboarding screen (§6.1) | Shown before task UI; only "Get started" proceeds |
| Panel with zero tasks | Panel | QuotaMeter ≈ 0%, "Last backup" row shows "Never" in neutral text, Backup section explainer: "Nothing to back up yet — once you add tasks, save a backup here." Snapshots empty state (§4.3) |
| Panel with tasks, never backed up | Panel + S3 nudge | Row "Never" in `danger` text; nudge shows "You haven't backed up yet." |
| Snapshots empty | Panel | Copy from §4.3 |
| Backup succeeded (first ever) | Toast T4 | "Backup saved to your downloads. Keep it somewhere safe." |
| Storage estimate unavailable | Panel | QuotaMeter `unknown` state + "Your browser doesn't report storage use here. Backups are still your safety net." |
| Import file invalid | ImportFlow `invalid` | Inline error under picker + reason copy: e.g. "This file isn't a {{appName}} backup." / "This backup was made by a newer version of {{appName}}. Update the app and try again." Always offers "Choose another file" and never mutates data |

---

## 8. Import confirm + pre-import snapshot undo (fully specified)

Ref §7.4: import default = replace; the pre-import auto-snapshot is the undo.

### 8.1 Step-by-step

1. **Pick.** "Import…" opens the native file picker (`<input type="file"
   accept="application/json,.json">`; File System Access picker where available per S10).
   Nothing is read into app state yet.
2. **Validate (client-side, untrusted input per §7.1 threat model).** Size cap 25 MB
   (constant `IMPORT_MAX_BYTES`); JSON.parse in a try/catch; require `schemaVersion` and our
   top-level shape; never eval; upgrade older schemaVersions through the migration chain
   (M12); a NEWER `schemaVersion` → `invalid(newer-version)`.
3. **Preview.** Show `ImportPreview` (counts + export date + file size) in the confirm
   dialog — the user sees exactly what will arrive before anything changes.
4. **Confirm dialog** (`SafetyDialog 'import-confirm'`, T3):

   - H2: "Replace everything with this backup?"
   - Body: "This backup contains {{tasks}} tasks in {{lists}} lists (exported {{date}})."
   - Body 2 (the replace semantics, unambiguous): "Importing will replace the data currently
     in this browser: {{currentTasks}} tasks in {{currentLists}} lists will be removed and
     replaced by the backup."
   - Body 3 (the undo promise): "Before importing, {{appName}} saves a snapshot of your
     current data. After the import you can restore it in one tap."
   - Actions: "Cancel" (secondary) · "Replace and import" (primary, final action; focus
     starts on Cancel). Single default = replace, per binding decision. No merge option in
     MVP UI (see §13 open question OQ-1; component leaves an optional slot for a future
     merge action).
5. **Snapshot.** On confirm: write a `Snapshot { kind: 'pre-import' }` of current data
   BEFORE any destructive write. If the snapshot write fails → abort the import and show
   `failed(recoverable: true)` copy: "Your backup couldn't be imported because the safety
   snapshot failed. Nothing was changed." — the import never proceeds without the undo.
6. **Import.** Replace inside ONE IndexedDB transaction where the store layout allows
   (otherwise: snapshot-guaranteed two-phase with rollback on error). Validate counts after
   write; on mismatch → roll back to snapshot automatically and report `failed`.
7. **Done → UndoToast** (§8.4).

### 8.2 Import failure copy (state `failed`)

- Recoverable (nothing changed): "Nothing was changed. Your data is exactly as it was."
- Unrecoverable (rare; only if rollback itself failed): "The import didn't finish and
  {{appName}} couldn't fully restore your previous data. Your snapshot 'Before import —
  {{date}}' is in Settings → Storage & back up. Restoring it brings back your previous data."
  Actions: "Open snapshots" · "Close".

### 8.3 What replaces what

Current data is replaced wholesale: lists, tasks, settings EXCEPT locale/theme preference
(UI prefs are device-local and survive import — decision: imported settings apply
`weekStart`, `defaultListId`, but NOT `theme`, `locale`, `lastBackupAt`; `lastBackupAt`
updates to now on successful import? NO — import is not a backup; `lastBackupAt` updates
only on export. Rationale: the nudge tracks whether the user has an external safety net.)

### 8.4 The undo (pre-import snapshot restore)

- After a successful import, `UndoToast` (T4, `role="status"`):
  - Message: "Import complete. Your previous data is saved as a snapshot."
  - Action: "Restore previous data" → runs the SAME confirm pattern as §8.1 step 4
    (`SafetyDialog 'restore-confirm'`): "Replace everything with the snapshot from {{date}}?"
    body mirrors replace semantics; confirm restores the pre-import snapshot wholesale.
  - Dismiss: closes the toast; the snapshot remains in the Snapshots list.
- Undo affordance is available as long as the pre-import snapshot exists.
- Snapshot retention: rolling last-3 (M12) EXCEPT `pre-import` snapshots are protected from
  rolling purge for 7 days (max 2 protected; oldest protected snapshot expires after 7
  days or when a newer protected one needs the slot). Panel labels them "Before import —
  {{date}}" with a subtle "can be restored" note.
- Restoring the pre-import snapshot is itself non-destructive to the undo concept: it
  creates NO new snapshot (restore target is already a snapshot; the replaced import data
  is discarded — it exists only as the file the user already has).

---

## 9. Interaction & micro-interaction rules

- Export progress: button enters `saving` (spinner + "Saving backup…"); ≤ 200ms typical;
  `prefers-reduced-motion` → text swap only, no spinner animation.
- Success toast (T4) copy variants: export → "Backup saved to your downloads."; import →
  §8.4; restore → "Snapshot restored." All announced via `role="status"`.
- Optimistic pending write (quota case): the failing task row shows a small clock icon +
  "Not saved yet" chip; stays visible until saved or the session ends.
- Snooze bookkeeping: `localStorage['nudge.backup.snoozedUntil']` epoch ms; banner suppression
  per §2 priority rules.
- All numeric ages computed from an injectable `now` (testability).

---

## 10. Handoff — UI states for implementation

Enumerate every component state the implementer must build. "All 7" = default, hover, focus,
active, disabled, loading, error (per team standard); where a state cannot apply, mark n/a.

### 10.1 Buttons (`primary`, `secondary`, `danger-outline`, `danger-filled`, `link`)

All 7 states for every variant. Focus = 2px `focus-ring` token, 2px offset. Disabled =
0.55 opacity + `not-allowed` cursor + `aria-disabled` (not `disabled` attr when it must stay
focusable). Loading = spinner replaces icon, label becomes gerund ("Saving backup…"),
`aria-busy="true"`.

### 10.2 QuotaMeter
`ok | warn | crit | unknown | loading` (loading in 7-state sense = `loading`; hover/focus
n/a, disabled n/a, error = `unknown` with retry link if estimate() rejects).

### 10.3 PersistenceRow
`granted | denied | unsupported | not-requested` × `idle | busy(button loading) | error`
(error = persist() threw; copy: "This browser wouldn't say. Backups are your safety net.").

### 10.4 BackupRow / lastBackup age label
`fresh (<14d) | stale (≥14d) | never-with-data | never-no-data | loading | error`.
Relative label states: Today / Yesterday / N days ago / N months ago / Never.

### 10.5 NudgeBanner
`visible | entering | leaving | snoozed | suppressed`; tiers T1/T2 styling; per-kind copy
§6.3/§6.6 + quota/persist variants (T2):
- Quota ≥80% banner: "Worth a look — storage is filling up" / "Storage for {{appName}} is
  {{pct}}% full. If it fills up, new tasks can't be saved. Export a backup and delete things
  you no longer need." Actions: "Open storage settings" · close ("Hide for 7 days").
- Persistence denied banner: "Keeping your data is limited" / "This browser hasn't granted
  extra protection for {{appName}}'s data. On iPhones and iPads, Safari can remove website
  data after 7 days — backups are your safety net." Actions: "Ask again" · "Back up now" ·
  close.

### 10.6 SafetyDialog
Kinds × states `open | closing | busy | error`; per-kind copy §6.4/§6.7/§6.8/§8; focus rules
§5.6; backdrop click = Escape semantics.

### 10.7 ImportFlow
`pick | validating | invalid(reason ×5) | preview | confirming | importing | done | failed
(recoverable|not)`; every state renders within the panel area or dialog per §8.

### 10.8 UndoToast
`pending-unseen (no auto-dismiss) | shown (8s auto) | action-pressed (busy) | dismissed |
error (restore failed)`.

### 10.9 Recovery screen
`has-backup | never-backup | start-fresh-confirming | restoring | error`.

---

## 11. Content & i18n

- Every string in this spec maps to a key in `locales/<lang>/data-safety.json`; English is
  the source of truth; Thai strings are PO-validated content (per PO Q9 interpretation) and
  land via the same keys — implementation must not inline English.
- Key namespace: `dataSafety.*` (e.g. `dataSafety.onboarding.h1`, `dataSafety.quota.warn`,
  `dataSafety.dialog.quota.body`). The copy in §6 is the authoritative English default.
- Interpolations are typed (`{{N}}`, `{{date}}`, `{{pct}}`, `{{tasks}}`, `{{lists}}`,
  `{{appName}}`, `{{currentTasks}}`, `{{currentLists}}`); plurals via ICU plural rules
  ("1 day" / "{{N}} days").
- Dates: localized absolute date (e.g. "5 Oct 2026") in copy; relative ages use the
  `Today/Yesterday/N days ago` family, localized.
- `lang` attribute follows locale incl. screen-reader language switching (§8 of
  PROJECT_ANALYSIS); Thai rendering uses the system font stack (no webfont).
- The iOS 7-day rule must appear in BOTH locales' strings for: onboarding (§6.1 body 2),
  backup nudge (§6.3 body), recovery screen (§6.5), long-absence banner (§6.6), persistence
  denied banner (§10.5). QA checklist item.

---

## 12. Design tokens used

No pre-existing system in the repo at spec time; the following is the token contract for
this surface (h_senior_coder co-designs the naming with the UI framework ADR). All pairs
meet WCAG 2.2 AA: text ≥ 4.5:1, UI components ≥ 3:1 (light and dark).

Colors (semantic; light / dark):
- `bg` #FFFFFF / #14171C — page background
- `surface-1` #F7F8FA / #1B1F26 — panel background
- `surface-2` #ECEEF2 / #232830 — meter track, hover fills
- `text` #1A1D21 / #E8EAED — primary text
- `text-muted` #55595F / #A5ABB4 — secondary text (4.6:1 on bg)
- `border` #D7DBE0 / #323842 — rules, outlines
- `accent` #1E5AD4 / #6FA1FF — primary actions, meter fill (ok)
- `accent-text` #16479F / #D6E4FF — accent text on bg
- `warning` #8A5A00 / #E8B33C — T2 icon/text (dark text on amber chip for contrast)
- `warning-subtle` #FFF6E5 / #2E2513 — T1 banner background
- `danger` #B3261E / #FF8A80 — T3 icon, destructive text
- `danger-filled` #B3261E / #C9372C — final destructive button fill (white text)
- `success` #1E7A3C / #66D18F — T4 text/icon
- `info` #1E5AD4 / #6FA1FF — T0 accent (same as accent; distinct token for semantics)
- `focus-ring` #1E5AD4 (light) / #6FA1FF (dark), 2px, offset 2px

Spacing scale (4px base): 4, 8, 12, 16, 24, 32, 48. Panel section padding: 24 desktop /
16 mobile. Banner padding: 12 16.

Typography (system stack: `system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Thai",
sans-serif`):
- h1 24/32 700 · h2 20/28 700 · h3 16/24 600 · body 15/24 400 · small 13/20 400 ·
  label 13/16 600. Thai-safe line-heights included (≥ 1.5 body).

Radius: 4 (chips), 8 (buttons, inputs), 12 (panels, dialogs), 999 (meter track).
Shadows: `0 1px 2px rgba(0,0,0,.06)` (row), `0 8px 24px rgba(0,0,0,.16)` (dialog). Dark
theme: same values with `rgba(0,0,0,.4)`.

Motion: duration fast 120ms (hover, dialog close), base 200ms (banner enter, dialog open),
ease `cubic-bezier(.2,0,0,1)`; all suppressed under `prefers-reduced-motion: reduce`
(changes become instant).

---

## 13. Open questions (for h_pm)

- [ ] **OQ-1 — Merge import:** §7.4 says "merge-or-replace (default: replace)". MVP UI ships
  replace-only (this spec); confirm that merge import is deferred to V1 (with the LWW
  policy of §6.2). Component API leaves a slot so adding it later is non-breaking.
- [ ] **OQ-2 — App name placeholder:** copy uses `{{appName}}`; confirm the product name for
  the string bundle (affects onboarding and dialog copy only).
- [ ] **OQ-3 — Emergency pending-write persistence:** §6.4 proposes a best-effort emergency
  snapshot on `visibilitychange` when a write is pending at quota; confirm this is in scope
  for the E3 impl card or should be dropped from MVP (copy stands either way).
- [ ] **OQ-4 — Backup nudge threshold:** 14 days is the default per §5.5; confirm no user
  facing setting in MVP (recommendation: no setting; constant in code).

## 14. Verification checklist (for h_reviewer)

- [ ] Every copy string in §6 present in both locales' keys; iOS 7-day rule named in the 5
  listed places (§11).
- [ ] Import flow: no destructive write before snapshot success; undo toast works; undo
  survives page reload via the Snapshots list.
- [ ] Quota dialog cannot dismiss-and-drop the pending write (test by filling quota).
- [ ] Keyboard-only pass: onboarding → settings panel → export → import → undo; Escape
  semantics on every dialog.
- [ ] axe-core clean; screen reader announces export/import/restore results; meter has text.
- [ ] Mobile 320px: no horizontal scroll; all targets ≥ 44px; danger zone reachable.
- [ ] Reduced-motion: no animated transitions in this surface.
