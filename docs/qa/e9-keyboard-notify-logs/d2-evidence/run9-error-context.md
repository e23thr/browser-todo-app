# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: qa-e9-keyboard-notify.spec.ts >> S8 palette covers the core loop with ZERO pointer events
- Location: tests/e2e/qa-e9-keyboard-notify.spec.ts:602:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('dialog', { name: 'Command palette', exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('dialog', { name: 'Command palette', exact: true }) with timeout 5000ms
  - waiting for getByRole('dialog', { name: 'Command palette', exact: true })

```

```yaml
- link "Skip to main content":
  - /url: "#main"
- banner:
  - paragraph: Todo
  - navigation "Views and lists":
    - list:
      - listitem:
        - link "Search":
          - /url: "#/search"
      - listitem:
        - link "Today":
          - /url: "#/today"
      - listitem:
        - link "Next 7 days":
          - /url: "#/week"
      - listitem:
        - link "All open":
          - /url: "#/all"
      - listitem:
        - link "Completed":
          - /url: "#/completed"
    - heading "Lists" [level=2]
    - list:
      - listitem:
        - link "Work":
          - /url: "#/list/01ARZ3NDEKTSV4RRFFR0000000"
      - listitem:
        - link "Errand":
          - /url: "#/list/01ARZ3NDEKTSV4RRFFR0000100"
    - list:
      - listitem:
        - link "Manage lists":
          - /url: "#/lists"
    - list:
      - listitem:
        - link "Settings":
          - /url: "#/settings"
      - listitem:
        - button "Command palette"
      - listitem:
        - button "Keyboard shortcuts"
- main:
  - status:
    - text: Worth a look
    - paragraph: Keeping your data is limited
    - paragraph: This browser hasn't granted extra protection for Todo's data. On iPhones and iPads, Safari can remove website data after 7 days — backups are your safety net.
    - button "Ask again"
    - button "Back up now"
    - button "Hide for 7 days"
  - status:
    - text: Worth a look
    - paragraph: You haven't backed up yet.
    - paragraph: A backup file is your safety net — browsers (especially Safari on iPhone and iPad, which can remove website data after 7 days) can clear this app's data. Save a backup now and keep it somewhere safe.
    - button "Back up now"
    - button "Remind me later"
    - button "Hide for 7 days"
  - heading "All open" [level=1]
  - paragraph: 3 tasks
  - text: Filter by tag
  - combobox "Filter by tag":
    - option "All tags" [selected]
  - text: Sort
  - combobox "Sort":
    - option "List order" [selected]
    - option "Priority (P1 first)"
  - button "Manage tags"
  - region "Add task":
    - text: Title
    - textbox "Title":
      - /placeholder: Add task…
    - button "Details"
    - button "Add" [disabled]
  - list "All open":
    - listitem:
      - heading "Work (2)" [level=2]
    - listitem:
      - checkbox "Mark \"Pay rent\" as complete"
      - button "Pay rent"
      - img "P3 (Low)"
      - text: Work
      - button "Actions for \"Pay rent\""
    - listitem:
      - checkbox "Mark \"Draft the report\" as complete"
      - button "Draft the report"
      - text: Work
      - button "Actions for \"Draft the report\""
    - listitem:
      - heading "Errand (1)" [level=2]
    - listitem:
      - checkbox "Mark \"Buy milk\" as complete"
      - button "Buy milk"
      - img "P3 (Low)"
      - text: Errand
      - button "Actions for \"Buy milk\""
- status: This browser did not grant extra protection.
- alert
```

# Test source

```ts
  653 | 
  654 |   // Run an action: settings (root-stage action, fuzzy 'set').
  655 |   await input.pressSequentially('open sett');
  656 |   await expect(palette.getByRole('option').first()).toContainText('Open settings');
  657 |   await page.keyboard.press('Enter');
  658 |   await expect.poll(() => page.url()).toContain('#/settings');
  659 |   // Wait for the LAZY Settings chunk to land and its route focus to finish — navigating
  660 |   // away mid-lazy-load would let the stale chunk resolve overwrite the next view.
  661 |   await expect(
  662 |     page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  663 |   ).toBeFocused();
  664 | 
  665 |   // Action: search.
  666 |   await page.goto(`${APP_URL}#/all`);
  667 |   await settleOnAllOpen(page);
  668 |   await parkFocusOnHeading(page);
  669 |   await page.keyboard.press('Control+Shift+F');
  670 |   await expect(input).toBeFocused();
  671 |   await input.pressSequentially('search tasks');
  672 |   await page.keyboard.press('Enter');
  673 |   await expect.poll(() => page.url()).toContain('#/search');
  674 |   // The search view autofocuses its own input under the same route contract.
  675 |   await expect(page.locator('main [data-autofocus]')).toBeFocused();
  676 | 
  677 |   // Action: add a task → composer opens focused, type + Enter captures it.
  678 |   await page.goto(`${APP_URL}#/all`);
  679 |   await settleOnAllOpen(page);
  680 |   await parkFocusOnHeading(page);
  681 |   await page.keyboard.press('Control+Shift+F');
  682 |   await expect(input).toBeFocused();
  683 |   await input.pressSequentially('add a task');
  684 |   await page.keyboard.press('Enter');
  685 |   const inlineTitle = page.locator('.composer-inline .composer-title-field input');
  686 |   // D1 (pinned as its own test below): focus should be HERE after the action — instead the
  687 |   // closing palette Dialog restores focus to its opener (the view h1), outrunning
  688 |   // startQuickAdd(). The capture loop below still runs: park focus in the composer manually.
  689 |   await inlineTitle.focus();
  690 |   await inlineTitle.pressSequentially('Draft the report');
  691 |   await page.keyboard.press('Enter');
  692 |   await expect(page.getByRole('button', { name: 'Draft the report', exact: true })).toBeVisible();
  693 |   // addTask().then(focusTitle) runs AFTER the optimistic row shows — wait for the creation
  694 |   // cycle to finish (the ack lands 60 ms after focusTitle) before moving focus again, or the
  695 |   // pending focusTitle steals focus back out of the palette opened next.
  696 |   await expect(politeRegion(page)).toContainText('Task added: Draft the report');
  697 | 
  698 |   // Task stage: complete via palette (Enter → stage → Mark complete).
  699 |   await page.keyboard.press('Control+Shift+F');
  700 |   await expect(input).toBeFocused();
  701 |   await input.pressSequentially('water');
  702 |   await page.keyboard.press('Enter'); // enter task stage
  703 |   await expect(palette.getByRole('option')).toHaveCount(4);
  704 |   await expect(palette.getByRole('option').nth(0)).toContainText('Open task');
  705 |   await expect(palette.getByRole('option').nth(1)).toContainText('Mark complete');
  706 |   await expect(palette.getByRole('option').nth(2)).toContainText('Move to list…');
  707 |   await expect(palette.getByRole('option').nth(3)).toContainText('Set reminder…');
  708 |   await page.keyboard.press('ArrowDown');
  709 |   await page.keyboard.press('Enter'); // Mark complete
  710 |   await expect(palette).toBeHidden();
  711 |   // "All open" lists OPEN tasks only — completing removes the row from this view (observed).
  712 |   // Prove the completion three ways: live ack, store ground truth, row leaving the list.
  713 |   await expect(politeRegion(page)).toContainText('Task completed');
  714 |   const water = await readTask(page, 'Water plants');
  715 |   expect(water?.['status'], 'store must show Water plants done').toBe('done');
  716 |   await expect(page.locator('li[data-task-id]').filter({ hasText: 'Water plants' })).toHaveCount(0);
  717 | 
  718 |   // Task stage: Move opens the move dialog (keyboard-only), Escape cancels.
  719 |   await page.keyboard.press('Control+Shift+F');
  720 |   await expect(input).toBeFocused();
  721 |   await input.pressSequentially('pay rent');
  722 |   await page.keyboard.press('Enter');
  723 |   await page.keyboard.press('ArrowDown');
  724 |   await page.keyboard.press('ArrowDown');
  725 |   await page.keyboard.press('Enter'); // Move to list…
  726 |   const moveDialog = page.getByRole('dialog', { name: 'Move to list…', exact: true });
  727 |   await expect(moveDialog).toBeVisible();
  728 |   await page.keyboard.press('Escape');
  729 |   await expect(moveDialog).toBeHidden();
  730 | 
  731 |   // Task stage: Set reminder opens the reminder dialog (keyboard-only), Escape cancels.
  732 |   await page.keyboard.press('Control+Shift+F');
  733 |   await expect(input).toBeFocused();
  734 |   await input.pressSequentially('buy milk');
  735 |   await page.keyboard.press('Enter');
  736 |   await page.keyboard.press('ArrowDown');
  737 |   await page.keyboard.press('ArrowDown');
  738 |   await page.keyboard.press('ArrowDown');
  739 |   await page.keyboard.press('Enter'); // Set reminder…
  740 |   const reminderDialog = page.getByRole('dialog', { name: 'Reminder', exact: true });
  741 |   await expect(reminderDialog).toBeVisible();
  742 |   await expect(reminderDialog.locator('input[type="datetime-local"]')).toHaveCount(1);
  743 |   await page.keyboard.press('Escape');
  744 |   await expect(reminderDialog).toBeHidden();
  745 | 
  746 |   // Escape semantics: task stage → root (palette stays open, query cleared) → close.
  747 |   await page.keyboard.press('Control+Shift+F');
  748 |   await expect(input).toBeFocused();
  749 |   await input.pressSequentially('buy milk');
  750 |   await page.keyboard.press('Enter');
  751 |   await expect(palette.getByRole('option')).toHaveCount(4);
  752 |   await page.keyboard.press('Escape');
> 753 |   await expect(palette).toBeVisible(); // stepped back, did NOT close
      |                         ^ Error: expect(locator).toBeVisible() failed
  754 |   await expect(input).toHaveValue('');
  755 |   await page.keyboard.press('Escape');
  756 |   await expect(palette).toBeHidden();
  757 | 
  758 |   const pointerCount = await page.evaluate(
  759 |     () => (globalThis as unknown as Record<string, number>)['__ptr'] ?? -1,
  760 |   );
  761 |   record('palette_keyboard_only', { pointerEventsDuringFlow: pointerCount });
  762 |   expect(pointerCount, 'palette core loop must be keyboard-only').toBe(0);
  763 | });
  764 | 
  765 | /* ------------------------------------------------------------------ *
  766 |  * 3. S8 — quick add < 5 s (human scale), both shells                  *
  767 |  * ------------------------------------------------------------------ */
  768 | 
  769 | test('S8 quick add: shortcut → captured task under 5 s on both shells', async ({ page }) => {
  770 |   await seedAndReload(page, { listName: 'Inbox', tasks: [] });
  771 |   await page.goto(`${APP_URL}#/all`);
  772 |   // Wait for the route-change focus contract (else the chord races it and the effect
  773 |   // can pull focus back out of the composer it just opened).
  774 |   await settleOnAllOpen(page);
  775 | 
  776 |   const runs: { shell: string; mode: string; ms: number; title: string }[] = [];
  777 | 
  778 |   // Wide shell → inline composer. Three human-paced runs (80 ms/char typing).
  779 |   for (let run = 0; run < 3; run += 1) {
  780 |     const title = `Human capture run ${String(run + 1)}`;
  781 |     await parkFocusOnHeading(page); // each run proves the CHORD moved focus, not the settle
  782 |     const t0 = Date.now();
  783 |     await page.keyboard.press('Control+Shift+1');
  784 |     const inlineTitle = page.locator('.composer-inline .composer-title-field input');
  785 |     await expect(inlineTitle).toBeFocused();
  786 |     await inlineTitle.pressSequentially(title, { delay: 80 });
  787 |     await page.keyboard.press('Enter');
  788 |     await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  789 |     runs.push({ shell: 'inline(wide)', mode: 'human(80ms/char)', ms: Date.now() - t0, title });
  790 |   }
  791 | 
  792 |   // Machine-speed reference run (no typing delay).
  793 |   {
  794 |     const title = 'Machine capture reference';
  795 |     await parkFocusOnHeading(page);
  796 |     const t0 = Date.now();
  797 |     await page.keyboard.press('Control+Shift+1');
  798 |     const inlineTitle = page.locator('.composer-inline .composer-title-field input');
  799 |     await expect(inlineTitle).toBeFocused();
  800 |     await inlineTitle.pressSequentially(title);
  801 |     await page.keyboard.press('Enter');
  802 |     await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  803 |     runs.push({ shell: 'inline(wide)', mode: 'machine', ms: Date.now() - t0, title });
  804 |   }
  805 | 
  806 |   // Compact path from a view WITHOUT an inline composer → the sheet opens.
  807 |   await page.goto(`${APP_URL}#/settings`);
  808 |   // The SPA route-change contract focuses the view h1 on a setTimeout(0); pressing the
  809 |   // shortcut in the same tick races it (the h1-focus would steal focus back from the
  810 |   // sheet). A human always presses after navigation settles — wait for that state.
  811 |   await expect(
  812 |     page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  813 |   ).toBeFocused();
  814 |   {
  815 |     const title = 'Sheet capture from settings';
  816 |     const t0 = Date.now();
  817 |     await page.keyboard.press('Control+Shift+1');
  818 |     const sheet = page.locator('.composer-sheet');
  819 |     await expect(sheet).toBeVisible();
  820 |     const sheetTitle = sheet.locator('.composer-title-field input');
  821 |     await expect(sheetTitle).toBeFocused();
  822 |     await sheetTitle.pressSequentially(title, { delay: 80 });
  823 |     await page.keyboard.press('Enter');
  824 |     // The sheet stays capture-ready (D6) — the store acknowledges via the live region.
  825 |     await expect(politeRegion(page)).toContainText(`Task added: ${title}`);
  826 |     runs.push({
  827 |       shell: 'sheet(compact path)',
  828 |       mode: 'human(80ms/char)',
  829 |       ms: Date.now() - t0,
  830 |       title,
  831 |     });
  832 |     await page.keyboard.press('Escape');
  833 |     await expect(sheet).toBeHidden();
  834 |   }
  835 | 
  836 |   record('quickadd_timing', runs);
  837 |   const worst = Math.max(...runs.map((run) => run.ms));
  838 |   expect(worst, `quick-add worst run ${String(worst)} ms exceeds the 5000 ms budget`).toBeLessThan(
  839 |     5000,
  840 |   );
  841 | });
  842 | 
  843 | /* ------------------------------------------------------------------ *
  844 |  * 3b. DEFECT PIN D1 — palette "Add a task" loses focus to the opener  *
  845 |  * ------------------------------------------------------------------ */
  846 | test('D1 [defect pin]: palette "Add a task" must land focus in the composer, not restore the opener', async ({
  847 |   page,
  848 | }) => {
  849 |   // D1 (live-reproduced at 595c1f0): the palette's closing Dialog runs its focus-restore
  850 |   // (to the element that OPEND the palette) AFTER startQuickAdd() has focused the composer,
  851 |   // so focus ends on the opener — on a heading/row the user's next keystrokes go nowhere.
  852 |   // Flip to a plain test() when Dialog stops restoring over a newer focus target.
  853 |   test.fail(true, 'D1: Dialog focus-restore on palette unmount outruns startQuickAdd() focus');
```