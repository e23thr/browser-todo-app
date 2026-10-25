# Commands, shortcuts & local notifications — S5/S8 dev contract

Owner: h_senior_coder (V1 E9 card t_ee8ecb0b). Normative for the shortcut layer
(`src/features/commands/`), the command palette, and the local-reminder engine
(`src/features/notifications/`). Refs: PROJECT_ANALYSIS §3 (P4 JTBD), §4 S5/S8,
§8, §9.1, §10 E11, §12 Q6.

## 1. Keyboard shortcut map (S8) — conflict review

Binding decision (t_ee8ecb0b): **shortcuts must not shadow browser or
screen-reader combos.** The shipped map (single source of truth:
`src/features/commands/keymap.ts` → `SHORTCUTS`; the help dialog renders from
the same table) was re-audited browser-by-browser against the §9.4 floor after
review B2 (t_8f41af00) found `Ctrl+Shift+S` to be a floor-browser chord — the
evidence is §1.1 below:

| Binding | Combo | Action | Conflict review (post-B2 re-audit) |
|---|---|---|---|
| `palette` | `Ctrl/⌘ + Shift + F` | Command palette | The ONLY letter chord the floor leaves free (§1.1): Chrome/Edge list no `Ctrl+Shift+F`; Firefox's only `Shift+Ctrl+F` is the Style-Editor **Replace** (toolbox-scoped — the keystroke never reaches the page); macOS `⇧⌘F` "Open the Recents window" (102650) is a **Finder** accelerator with no Safari menu item |
| `quickAdd` | `Ctrl/⌘ + Shift + 1` | Quick add (composer) | Digit family — no floor browser and no macOS system shortcut binds it. **Moved off `Ctrl+Shift+E` in the re-audit**: Firefox "Network" (common-shortcuts page) and Edge "Open search in sidebar" own that chord |
| `search` | `Ctrl/⌘ + Shift + 2` | Search view | Digit family — ditto. **Moved off `Ctrl+Shift+S` (review B2)**: Firefox "Take a screenshot", Edge Screenshot (Web Capture) and macOS `⇧⌘S` "Save As" own it on 3 of the 4 floor browsers |
| `help` | `?` (the `?` character) | Shortcuts help dialog | `?` is not a browser combo and not in any screen-reader quick-nav set. Matched on the PRODUCED CHARACTER (review N2), so layouts that type `?` unshifted still fire, while bare `/` — Firefox quick-find — never does |

### 1.1 Re-audit evidence (review B2, fix card t_2b1300c0)

Method: every shipped binding was checked against one cited vendor reference
per floor browser (§9.4: last 2 majors of Chrome/Edge/Firefox/Safari), fetched
2026-10-26. A chord is treated as **browser-owned** when the vendor's published
shortcut list binds it to a browser-level action (window/tab/page/devtools), or
— on macOS — when the accelerator exists in Safari's menus (document-family
items such as Save As). Tool-internal devtools bindings (Firefox toolbox) and
Finder-family accelerators do not shadow the page and are noted but not
treated as conflicts.

| Source | URL | Retrieval |
|---|---|---|
| Chrome | support.google.com/chrome/answer/157179 ("Chrome keyboard shortcuts") | live, 2026-10-26 |
| Edge | support.microsoft.com/en-us/edge/keyboard-shortcuts-in-microsoft-edge ("Keyboard shortcuts in Microsoft Edge") | live, 2026-10-26 |
| Edge (Screenshot/Web Capture) | learn.microsoft.com/en-us/deployedge/microsoft-edge-policies#webcaptureenabled | live, 2026-10-26 |
| Firefox | support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly | via Internet Archive snapshot 2026-01-01 (live page serves a bot challenge to this tooling) |
| Firefox Screenshots | support.mozilla.org/en-US/kb/take-screenshots-firefox | via Internet Archive snapshot 2026-01-01 |
| Firefox DevTools | firefox-source-docs.mozilla.org/devtools-user/keyboard_shortcuts/ | live, 2026-10-26 |
| Safari / macOS | support.apple.com/en-us/102650 ("Mac keyboard shortcuts") | live, 2026-10-26 |

`Ctrl/⌘+Shift+<key>` ownership per browser (verbatim from the sources above):

| Key | Chrome | Edge | Firefox | Safari / macOS |
|---|---|---|---|---|
| `B` | Show/hide the Bookmarks bar | Show/hide the favorites bar | Bookmarks toolbar | — |
| `D` | Save all open tabs as bookmarks | Save all tabs as favorites | Bookmark All Tabs (win) | ⇧⌘D desktop folder (Finder) |
| `E` | — | **Open search in sidebar** | **"Network" (Network Monitor)** | — |
| `F` | — | — | (Style-Editor "Replace" — toolbox-scoped only) | ⇧⌘F Recents window (Finder family, no Safari menu item) |
| `G` | Jump to previous find match | Jump to previous find result | Find Previous | ⇧⌘G Find Previous (text family) / Go to Folder (Finder) |
| `I` | (DevTools inspect, not on the list) | Open Developer Tools | Toggle Developer Tools | ⇧⌘I iCloud Drive (Finder) |
| `J` | Open Developer Tools (Ctrl+Shift+j or F12) | — | Browser Console | — |
| `K` | — | Duplicate the current tab | Web Console | ⇧⌘K Network window (Finder) |
| `L` | — | Paste and search / Paste and go | — | — |
| `M` | Log in a different user / browse as Guest | Sign in as a different user or Guest | Responsive Design View | — |
| `N` | New Incognito window | New InPrivate window | Reopen last closed window | ⇧⌘N new empty folder (Finder) |
| `O` | Bookmarks Manager | Open Favorites | Show All Bookmarks | ⇧⌘O Documents folder (Finder) |
| `P` | — | Print using the system dialog | New Private Window | ⇧⌘P Preview pane (Finder) |
| `Q` | — | — | Exit (Windows) | ⇧⌘Q Log Out (system) |
| `R` | Reload ignoring cache | Reload ignoring cache | Reload (override cache) | ⇧⌘R AirDrop window (Finder) |
| `S` | — | **Screenshot / Web Capture ("CTRL+SHIFT+S")** | **"Take a screenshot"** | **⇧⌘S "Show the Save As dialog, or duplicate the current document"** |
| `T` | Reopen closed tab | Reopen last closed tab | Reopen last closed tab | ⇧⌘T tab bar (Finder) |
| `U` | — | Start or stop Read Aloud | — | ⇧⌘U Utilities folder (Finder) |
| `V` | — | Paste without formatting | Paste (as plain text) | — |
| `W` | Close window | Close current window | Close Window | — |
| `X` | — | — | Moves the URL left/right (address bar) | — |
| `Y` | — | Open Collections | Downloads (Linux) | — |
| `A`,`C` | (tab search / DevTools inspect families) | — | Add-ons Manager / Inspector | `C`: ⇧⌘C Computer window (Finder); `A`: — |
| `Z` | — | — | Redo | ⇧⌘Z Redo (text family) |
| `3`,`4`,`5`,`6` | — | — | — | **⇧⌘3/⇧⌘4 screenshots, ⇧⌘5 screenshot toolbar, ⇧⌘6 macOS 27 Siri family — system-owned** |
| `Tab`,`PgUp`,`PgDn`,`Home`,`End`,`Enter`,`Delete` | tab moves / clear browsing data | tab moves / clear browsing data | tab moves / clear history | — |

Conclusion: **every `Ctrl/⌘+Shift+letter` is browser-owned on the floor except
`F`** (the chord the palette owns). The two remaining actions therefore moved
to the digit family (`1`/`2`) — the only code-stable family with zero floor
bindings (macOS `3`–`6` reserved as system screenshots). Options considered and
rejected: platform-scoping (no OS frees `S` — Firefox/Edge bind it on
Windows/Linux too, and macOS owns `⇧⌘S`); browser-sniffing (unstable, worse
than the disease); keeping `S`/`E` and relying on `preventDefault` (violates
the binding decision — the browser owns the chord, it dies or double-fires).
The old doc's "Free on the floor" claims for `S`, `E` and `F` were wrong or
imprecise in exactly the way review B2 described.

Policy rules enforced in code and pinned in
`tests/unit/commands/keymap.test.ts` (via `RESERVED_COMBOS`):

1. **No unmodified keys** — screen readers (NVDA/JAWS/VoiceOver browse mode)
   bind bare letters for quick-nav and Firefox binds `/` and `'` to quick find.
   The single unmodified-family binding is `?`, matched on the produced
   character (some layouts type `?` unshifted — review N2).
2. **No `Ctrl/⌘` + letter, and no `Ctrl/⌘+Shift` + letter except `F`** — see
   the §1.1 table: the floor browsers between them own the whole letter space
   under Shift apart from `F`. Digits under `Ctrl/⌘+Shift` are free except
   macOS `3`/`4`/`5`/`6` (system screenshots).
3. **No `Alt+…`** (OS menu accelerators, browser back/forward/home) and no
   `Ctrl/⌘+Alt+…` or Insert/CapsLock (screen-reader reserved). `Alt+↑/↓` and
   `Alt+Home/End` stay owned by the M6 reorder layer (core-domain §8.2) and are
   documented — never rebound — in the help dialog.
4. **An IME composition (Thai input) suppresses every binding**; so do
   auto-repeat, `defaultPrevented`, and any open modal dialog. The `?` binding
   additionally never fires while a form control has focus (typing wins).
5. `preventDefault()` runs only when a handler actually fires — unhandled chords
   keep their browser behavior (pinned test).

Discoverability (AC): the map is documented in the shortcuts help dialog
(`ShortcutsHelpDialog`, rendered from `SHORTCUTS` so it cannot go stale),
reachable via `?`, the palette ("Show keyboard shortcuts"), and the
"Keyboard shortcuts" nav button in both shell patterns.

## 2. Command palette (S8)

- Fuzzy ranking (`paletteIndex.ts`) over actions + task titles: subsequence match
  with word-start/consecutive bonuses, results capped at 20. Pinned 10k-task
  query budget in `tests/unit/commands/paletteIndex.test.ts` (§9.1 INP < 200 ms).
- Core loop covered by actions + a per-task stage (Open / Complete / Move to
  list… / Set reminder…), all reachable with arrows + Enter + Escape only
  (WCAG 2.2 AA; the input is a `combobox` over a `listbox` with
  `aria-activedescendant`). Escape steps back one stage before closing.
- Task "Open" navigates to the task's list and focuses its row
  (`[data-task-id]`); "Move to list…" hands the task to `MoveToListDialog`
  (F11 semantics, one order-key write).

## 3. Local reminders (S5)

**Q6 DECIDED: local only — there is no push (no backend).** A reminder fires
from a page timer while the app is open; missed instants never replay.

### Permission timing (binding decision)

`Notification.requestPermission` is called from exactly two first-use user
gestures — never at boot, never from the scheduler:

1. turning the **Reminders & notifications** switch ON in Settings
   (`NotificationsSettings`), and
2. saving a non-empty reminder (`ReminderDialog`), which also flips the master
   switch ON (a reminder the user just set must be able to fire).

`firstUse.ts` asks at most once per session while the state is `'default'`. A
`denied` or `unsupported` platform is never re-prompted and never surfaces an
error — **E11 silent degrade**: the schedule is simply empty and the in-app
due-date indicators (E2's due badges) remain the guaranteed surface. The
Settings row shows a quiet status line (granted/off/blocked/unsupported) — no
toasts, no announcements (pinned in `tests/component/notifications.test.tsx`).

### Scheduling semantics (`scheduler.ts`, pure)

- A task fires at its `reminderAt` instant (the model's only real instant —
  ADR-003). `dueDate` is an all-day label and is never converted to an instant.
- Past-due reminders of non-recurring tasks NEVER fire late and are never
  rewritten — the plan contains only future instants.
- With `recurrence` (S4's RRULE-lite, schema v2 reserved format), a past
  reminder rolls forward to the next occurrence: `daily`/`weekly`/`monthly`
  (day-clamped) by `interval`, `weekdays` counts weekday occurrences. `until`
  (`YYYY-MM-DD`, local day label) caps the roll. `count` is deliberately NOT
  consulted (it was removed from the reserved format by the E7 migration; full
  occurrence history belongs to S4's evaluator) — when S4 lands, `nextFireTime`
  is the single seam to re-point.
- The engine (`reminders.ts`) arms ONE timer (the earliest planned instant) and
  re-plans on every state change, `visibilitychange`, and fire. A reminder
  pushed later or cleared before its instant never fires at the stale instant.
- Platform timer throttling in background tabs makes exact-time fire
  best-effort; the due badges are the guaranteed channel.

### Gating

Fires only when `settings.notificationsEnabled` (ADR-002 field, persisted via
the guarded `patchSettings`) **and** `Notification.permission === 'granted'`.
Everything else is the silent E11 path.

## 4. Known gaps / follow-ups

- The task-editor reminder field was NOT landed here (the editor was under
  concurrent E7 reconstruction in the shared tree — see the hotspot note on
  t_ee8ecb0b); the V1 surface for `reminderAt` is the palette's "Set reminder…"
  dialog. Follow-up tracked on the board.
- Reminder clicks focus the window (`notification.onclick`); deep-linking to the
  task is a candidate follow-up.
- `recurrence.count`/exception semantics (S4) will replace the local roll
  forward at the single `nextFireTime` seam when that card lands.
