# Commands, shortcuts & local notifications — S5/S8 dev contract

Owner: h_senior_coder (V1 E9 card t_ee8ecb0b). Normative for the shortcut layer
(`src/features/commands/`), the command palette, and the local-reminder engine
(`src/features/notifications/`). Refs: PROJECT_ANALYSIS §3 (P4 JTBD), §4 S5/S8,
§8, §9.1, §10 E11, §12 Q6.

## 1. Keyboard shortcut map (S8) — conflict review

Binding decision (t_ee8ecb0b): **shortcuts must not shadow browser or
screen-reader combos.** The shipped map (single source of truth:
`src/features/commands/keymap.ts` → `SHORTCUTS`; the help dialog renders from
the same table):

| Binding | Combo | Action | Conflict review |
|---|---|---|---|
| `palette` | `Ctrl/⌘ + Shift + F` | Command palette | Not bound by Chrome/Edge/Firefox/Safari; `F` is one of the few letters free under Ctrl+Shift (the natural `Ctrl+K`/`Ctrl+Shift+P` are Firefox's search bar / private window) |
| `quickAdd` | `Ctrl/⌘ + Shift + E` | Quick add (composer) | Free on the §9.4 browser floor; `A`/`C`/`N` are browser-reserved (tab search, devtools inspect, incognito) |
| `search` | `Ctrl/⌘ + Shift + S` | Search view | Free on the floor; `Ctrl+S` (save page) is untouched because Shift is required |
| `help` | `?` (`Shift + /`) | Shortcuts help dialog | `?` is not a browser combo and not in any screen-reader quick-nav set; `Shift+Slash` code fallback covers layouts where `?` is unshifted |

Policy rules enforced in code and pinned in
`tests/unit/commands/keymap.test.ts` (via `RESERVED_COMBOS`):

1. **No unmodified keys** — screen readers (NVDA/JAWS/VoiceOver browse mode)
   bind bare letters for quick-nav and Firefox binds `/` and `'` to quick find.
   The single unmodified-family binding is `?`.
2. **No `Ctrl/⌘` + reserved letters** — browsers reserve Ctrl/Cmd + {A,B,D,E,F,
   G,H,J,K,L,N,O,P,Q,R,S,T,U,W,X,Y,Z,0-9} and most of Ctrl/⌘+Shift+{A,B,D,G,I,
   J,K,M,N,O,P,R,T,W} (new window, find-next, devtools, bookmark manager,
   private window, hard reload, tab search…).
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
