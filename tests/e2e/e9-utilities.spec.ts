/**
 * E9 utilities against the REAL app (S10 save/open + S12 importers), on every
 * engine the suite supports — the §9.4 "no dead UI" contract and the acceptance
 * evidence for "FSA path AND download/upload fallback both exercised".
 *
 * Path matrix (what each engine can actually do):
 *  - chromium: `showSaveFilePicker`/`showOpenFilePicker` exist. The NATIVE
 *    dialogs cannot be driven headlessly, so the pickers are injected via
 *    `addInitScript` before any app script runs — the app's routing, the write
 *    to the handle and the resulting document are real; only the OS dialog is
 *    stubbed. A second run with a REJECTING picker proves the error → download
 *    fallback on the very same page.
 *  - firefox/webkit: the globals do not exist at all. The spec asserts that
 *    (`typeof … === 'undefined'` — the app can't even offer the FSA affordance)
 *    and then exercises the universal download (save) and file-input upload
 *    (open) paths for real, reading the downloaded bytes back.
 *  - S12 rides the upload fallback everywhere: a real CSV file goes through the
 *    picker → preview → confirm → rows; a malformed CSV must reject with the
 *    inline notice and leave existing data untouched.
 *
 * Locator policy (D1 guard): every getByRole(..., { name }) and getByText(...)
 * carries `exact: true` (eslint enforced).
 */
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { APP_URL, seedOnboardingDone } from './helpers';

/** Valid CSV: 2 tasks, 2 lists (row 2 falls back to the file-stem list). */
const CSV = ['title,priority,list', 'first CSV task,high,CSV list', 'second CSV task,low,'].join(
  '\n',
);
/** Every data row is malformed → whole-file NOTHING_TO_IMPORT, zero side effects. */
const BAD_CSV = ['title,status', 'mystery row,sortof'].join('\n');

declare global {
  // Injected by the init scripts below (type-only — no runtime reference).
  var __fsaMock: { writes: string[] } | undefined;
}

/** Install Chromium-side FSA pickers that capture the save + serve a CSV on open. */
async function installFsaMocks(page: Page): Promise<void> {
  await page.addInitScript((csvText: string) => {
    const g = globalThis as unknown as Record<string, unknown>;
    const state = { writes: [] as string[] };
    g['__fsaMock'] = state;
    g['showSaveFilePicker'] = async (options?: { suggestedName?: string }) => ({
      name: options?.suggestedName ?? 'backup.json',
      createWritable: async () => ({
        write: async (data: string): Promise<void> => {
          state.writes.push(data);
        },
        close: async (): Promise<void> => undefined,
      }),
    });
    g['showOpenFilePicker'] = async () => {
      const file = new File([csvText], 'picked.csv', { type: 'text/csv' });
      return [{ getFile: async () => file }];
    };
  }, CSV);
}

/** Install a Chromium-side picker that always fails (exercises the fallback). */
async function installFsaFailure(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    g['showSaveFilePicker'] = async (): Promise<never> => {
      throw new Error('simulated picker failure');
    };
    g['showOpenFilePicker'] = async (): Promise<never> => {
      throw new Error('simulated picker failure');
    };
  });
}

async function bootSettings(page: Page): Promise<void> {
  await seedOnboardingDone(page);
  await page.goto(`${APP_URL}#/settings`);
  await expect(
    page.locator('.backup-actions').getByRole('button', { name: 'Back up now', exact: true }),
  ).toBeVisible();
}

function backupButton(page: Page) {
  return page.locator('.backup-actions').getByRole('button', { name: 'Back up now', exact: true });
}

function importButton(page: Page) {
  return page.locator('.backup-actions').getByRole('button', { name: 'Import…', exact: true });
}

async function writesCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (globalThis as unknown as Record<string, { writes: string[] } | undefined>)['__fsaMock']
        ?.writes.length ?? 0,
  );
}

/* ------------------------------- S10: save ------------------------------- */

test('S10 chromium: save goes through the File System Access picker, no download', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('chromium'), 'FSA save evidence is Chromium-only');
  await installFsaMocks(page);
  await bootSettings(page);

  const downloadPromise = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
  await backupButton(page).click();

  await expect.poll(() => writesCount(page), { timeout: 10_000 }).toBe(1);
  const written = await page.evaluate(
    () =>
      (globalThis as unknown as Record<string, { writes: string[] } | undefined>)['__fsaMock']
        ?.writes[0] ?? '',
  );
  const doc = JSON.parse(written) as { format: string; counts: { tasks: number } };
  expect(doc.format).toBe('local-first-todo-backup');
  // The FSA path must NOT also fire an anchor download (double delivery = bug).
  expect(await downloadPromise).toBeNull();
  // Scoped to the toast: the same copy also rides the visually-hidden live region.
  await expect(
    page
      .locator('.toast-message')
      .getByText('Backup saved to the file you chose. Keep it somewhere safe.', {
        exact: true,
      }),
  ).toBeVisible();
});

test('S10 fallback: a failing picker falls back to the universal download', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith('chromium'),
    'failure injection only exists where the API exists',
  );
  await installFsaFailure(page);
  await bootSettings(page);

  const downloadPromise = page.waitForEvent('download');
  await backupButton(page).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^local-first-todo-backup-.*\.json$/u);
  const path = await download.path();
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { format: string };
  expect(doc.format).toBe('local-first-todo-backup');
});

test('S10 non-Chromium: no FSA globals exist and the download path delivers the backup', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith('chromium'),
    'covered by the failure-injection variant above',
  );
  await seedOnboardingDone(page);
  await page.goto(`${APP_URL}#/settings`);

  // §9.4 dead-UI proof: the APIs the app feature-detects simply do not exist.
  const apiTypes = await page.evaluate(() => ({
    save: typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker,
    open: typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker,
  }));
  expect(apiTypes).toEqual({ save: 'undefined', open: 'undefined' });

  const downloadPromise = page.waitForEvent('download');
  await backupButton(page).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^local-first-todo-backup-.*\.json$/u);
  const path = await download.path();
  const doc = JSON.parse(readFileSync(path, 'utf8')) as {
    format: string;
    counts: { tasks: number };
  };
  expect(doc.format).toBe('local-first-todo-backup');
});

/* ------------------------------- S10: open ------------------------------- */

test('S10 chromium: open goes through the File System Access picker into the import preview', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('chromium'), 'FSA open evidence is Chromium-only');
  await installFsaMocks(page);
  await bootSettings(page);

  await importButton(page).click();
  const dialog = page.getByRole('alertdialog', {
    name: 'Replace everything with this backup?',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  // The FSA-picked CSV reached the SAME confirm the upload path uses.
  await expect(
    dialog.getByRole('button', { name: 'Replace and import', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
});

/* --------------------- S10/S12: upload fallback + CSV -------------------- */

test('S10/S12 upload fallback: a real CSV file imports through picker → confirm → rows', async ({
  page,
}, testInfo) => {
  // On Chromium the REAL open picker would claim the gesture (and hang headless)
  // — reject it so the universal input fallback is what actually gets exercised.
  if (testInfo.project.name.startsWith('chromium')) await installFsaFailure(page);
  await seedOnboardingDone(page);
  await page.goto(`${APP_URL}#/settings`);

  const chooserPromise = page.waitForEvent('filechooser');
  await importButton(page).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'e9-import.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  });

  const dialog = page.getByRole('alertdialog', {
    name: 'Replace everything with this backup?',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Replace and import', exact: true }).click();
  await expect(
    page
      .locator('.undo-toast')
      .getByText('Import complete. Your previous data is saved as a snapshot.', {
        exact: true,
      }),
  ).toBeVisible();

  // The imported rows render in the app (All open, grouped by the imported lists).
  await page.goto(`${APP_URL}#/all`);
  await expect(page.getByRole('button', { name: 'first CSV task', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'second CSV task', exact: true })).toBeVisible();
});

test('S12 malformed CSV: rejected with the inline notice and ZERO side effects', async ({
  page,
}, testInfo) => {
  // Same Chromium guard as the upload test: the universal input must get the gesture.
  if (testInfo.project.name.startsWith('chromium')) await installFsaFailure(page);
  await seedOnboardingDone(page);
  await page.goto(APP_URL);

  // Seed one real task first — the "zero side effects" half of the drill.
  const newList = page
    .locator('.composer-nolist')
    .getByRole('button', { name: 'New list', exact: true });
  const composer = page.locator('.composer-inline input[type="text"]');
  // The domain store mounts asynchronously: wait for EITHER composer shape
  // (zero-list → New list button, otherwise the inline input) before branching.
  await page.waitForSelector('.composer-nolist button, .composer-inline input[type="text"]', {
    state: 'visible',
    timeout: 15_000,
  });
  if (await newList.isVisible()) {
    await newList.click();
    const listDialog = page.getByRole('dialog', { name: 'New list', exact: true });
    await listDialog.getByRole('textbox', { name: 'List name', exact: true }).fill('Guard');
    await page.keyboard.press('Enter');
    await expect(listDialog).toBeHidden();
  }
  await expect(composer).toBeVisible();
  await composer.fill('guard task');
  await page.keyboard.press('Enter');
  // All open always lists open tasks (the root route is Today, which filters
  // by due date — a task without one would never appear there).
  await page.goto(`${APP_URL}#/all`);
  await expect(page.getByRole('button', { name: 'guard task', exact: true })).toBeVisible();

  // Upload the malformed CSV through the universal picker.
  await page.goto(`${APP_URL}#/settings`);
  const chooserPromise = page.waitForEvent('filechooser');
  await importButton(page).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'broken.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(BAD_CSV, 'utf8'),
  });

  // Whole-file reject: the §7 inline notice (role=alert) names the outcome —
  // and the flow never reaches a confirm dialog. Scoped to the panel notice:
  // the assertive announcement copies the same sentence into the live region.
  const notice = page
    .locator('.storage-notice')
    .filter({ hasText: 'Nothing in this file could be imported.' });
  await expect(notice).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Choose another file', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('alertdialog', { name: 'Replace everything with this backup?', exact: true }),
  ).toHaveCount(0);

  // Zero side effects: the seeded task survives, the malformed row never lands.
  await page.goto(`${APP_URL}#/all`);
  await expect(page.getByRole('button', { name: 'guard task', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'mystery row', exact: true })).toHaveCount(0);
});
