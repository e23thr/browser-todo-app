# E2 core UI — keyboard-only pass in a real browser (Playwright/chromium)

Every step below used Tab / typing / key presses only (no mouse, no pointer events).

## worker 249653 — 21 PASS step(s)
  SETUP. first-run screen (Epic E3) dismissed from the keyboard
  PASS 0. Tab → composer "New list" (<button type="button" class="button button-secondary">New list</button>) — zero-list state
  DEBUG. polite trace after list #1: []
  PASS 1. Enter → list created; polite region: "List created: Personal"
  PASS 2. Tab → sidebar "All open" → Enter → view, no pointer event
  PASS 3. F1: Tab → composer, type, Enter → row visible; polite: "Task added: Buy milk"
  PASS 4. optimistic add measured: row in the DOM +2.2 ms after Enter; IndexedDB write issued +7.2 ms, settled +6.8 ms (visible strictly before settle)
  PASS 5. F1 repeat: Enter → second task added without leaving the composer
  PASS 6. F2: Enter → editor (focus on Title), edit, Enter → saved, dialog closed, focus back on the row button, polite: "Task saved"
  PASS 7. F3: Space on the focused row → optimistic check + "Task completed", row held then collapsed (900 ms retention)
  PASS 8. F3 uncomplete: Completed view → Space → "Task reopened", row leaves again
  PASS 9. F4: End → last row, Delete → S7.1 confirm, initial focus on Cancel
  PASS 10. Escape → cancelled, task intact, focus back on the row
  PASS 11. Shift+Tab wraps to the confirm action (§9.6 trap) → Enter → removed; polite: "Task deleted"
  DEBUG. lists on screen after create: ["Personal","Work"]
  PASS 12. F5 create (keyboard): New list → dialog → Enter → "List created: Work"
  PASS 12b. row-menu opened from the keyboard; focus = <button type="button" role="menuitem" class="menu-item">Rename</button>
  PASS 12c. after End; focus = <button type="button" role="menuitem" class="menu-item menu-item-danger">Delete list</butt
  PASS 13. F6: row menu → Delete list → S7.2 dialog shows counts, focus on Cancel
  PASS 14. Enter → one transaction: list gone, tasks moved, "List \"Personal\" deleted (1 tasks)", focus on the h1
  PASS 15. disposition A verified: task still open, list badge now "Work"
  PASS 16. exactly one polite + one assertive live region mounted
  PASS 17. polite announcement sequence: List created: Personal | View: All open | Task added: Buy milk | Task added: Walk dog | Task saved | This browser did not grant extra protection. | Task completed | View: Completed | Task reopened | View: All open | Task deleted | View: Manage lists | List created: Work | List "Personal" deleted (1 tasks)
  PASS 18. assertive announcement sequence: (none)
