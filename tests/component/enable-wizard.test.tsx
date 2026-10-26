/**
 * F1c/F3 (review) + N5 — the enable wizard's component contract:
 *  - the recovery code is on screen BEFORE any row is encrypted (D6.1 order,
 *    structural): mid-offer the store is `migrating`, no slot is persisted and
 *    zero rows are encrypted — the slot lands only after "I saved it";
 *  - a decline re-shows the lost-passphrase warning VERBATIM (F3) and the
 *    decline is recorded;
 *  - closing at the offer step rolls the store back to plaintext (D6.1);
 *  - the forced-backup gate blocks step 2 until a REAL export ran.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { openForTests } from '../../src/storage/db';
import type { AppDBImpl } from '../../src/storage/db';
import { CRYPTO_KEY } from '../../src/storage/schema';
import { DEFAULT_SETTINGS, isEncryptedRecord } from '../../src/domain/model';
import { vault as appVault } from '../../src/crypto/vault';
import { migrationRun } from '../../src/crypto/service';
import { foreignCiphertext } from '../../src/crypto/foreignData';
import { initCryptoForApp } from '../../src/features/crypto/wiring';
import { EnableWizard } from '../../src/features/crypto/EnableWizard';
import { resetRowCryptoSeam } from '../../src/storage/cryptoSeam';
import { resetMergeCryptoSeam } from '../../src/sync/mergeSeam';
import { makeTask } from '../unit/storage/fixtures';

const T0 = 1_700_000_000_000;
const PASSPHRASE = 'correct horse battery staple';

let db: AppDBImpl;
let clock = T0;

function now(): number {
  clock += 1000;
  return clock;
}

async function freshDb(): Promise<AppDBImpl> {
  const created = await openForTests({
    dbName: `enable-wizard-${Math.random().toString(36).slice(2)}`,
  });
  if (!created.ok) throw new Error('db open failed');
  return created.value;
}

/** A plaintext store with NO fresh backup — the gate must force an export. */
async function seedPlaintext(titles: string[]): Promise<void> {
  await db.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: null });
  for (const title of titles) {
    await db.put('tasks', makeTask({ title, updatedAt: now() }));
  }
}

beforeEach(async () => {
  window.localStorage.clear();
  db = await freshDb();
  await initCryptoForApp(db);
  migrationRun.value = { phase: 'idle', done: 0, total: 0, code: null, message: null };
  foreignCiphertext.value = false;
});

afterEach(() => {
  appVault.lockNow();
  resetRowCryptoSeam();
  resetMergeCryptoSeam();
});

function renderWizard(): void {
  render(
    <EnableWizard
      db={db}
      now={now}
      syncConfigured={false}
      onDone={() => undefined}
      onClose={() => undefined}
    />,
  );
}

/** Steps 1→3: export (the mechanical gate), acknowledge, passphrase. */
async function driveToPassphrase(wantRecovery: boolean): Promise<void> {
  const continueButton = screen.getByRole('button', { name: 'Continue' });
  expect(continueButton.hasAttribute('disabled')).toBe(true); // gate: no export yet
  fireEvent.click(screen.getByRole('button', { name: 'Export backup now' }));
  await waitFor(() => {
    expect(continueButton.hasAttribute('disabled')).toBe(false);
  });
  fireEvent.click(continueButton); // -> step 2 (the gate re-check is async)

  const checkbox = await screen.findByRole('checkbox');
  fireEvent.click(checkbox); // acknowledge the lost-passphrase warning
  fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // -> step 3

  if (!wantRecovery) fireEvent.click(screen.getByRole('checkbox')); // uncheck the offer
  const passwordInputs = document.querySelectorAll<HTMLInputElement>(
    '.dialog input[type="password"]',
  );
  fireEvent.input(passwordInputs.item(0), { target: { value: PASSPHRASE } });
  fireEvent.input(passwordInputs.item(1), { target: { value: PASSPHRASE } });
  fireEvent.click(screen.getByRole('button', { name: 'Encrypt my data' }));
}

describe('EnableWizard — D6.1 order is structural (review F1c)', () => {
  it('shows the recovery code before ANY row is encrypted; the slot lands on the ack', async () => {
    await seedPlaintext(['alpha', 'bravo']);
    renderWizard();
    await driveToPassphrase(true);

    // Step 4 — the code is on screen and the sweep has NOT run yet.
    const code = await screen.findByTestId('recovery-code');
    expect(code.textContent.length).toBeGreaterThan(10);
    expect(appVault.status).toBe('migrating');
    expect(
      appVault.state?.keys.some((k) => k.slots.some((s) => s.kind === 'recovery')) ?? false,
    ).toBe(false); // NO undisclosed slot (the orphaned-slot defect)
    const mid = await db.readUnfiltered('tasks');
    expect(mid.ok).toBe(true);
    if (mid.ok) for (const row of mid.value) expect(isEncryptedRecord(row)).toBe(false);

    // "I saved it" persists the slot, then the sweep runs to `on`.
    fireEvent.click(screen.getByRole('button', { name: 'I saved it' }));
    await waitFor(
      () => {
        expect(appVault.status).toBe('on');
      },
      { timeout: 8000 },
    );
    const after = await db.readUnfiltered('tasks');
    expect(after.ok).toBe(true);
    if (after.ok) for (const row of after.value) expect(isEncryptedRecord(row)).toBe(true);
    expect(
      appVault.state?.keys.some((k) => k.slots.some((s) => s.kind === 'recovery')) ?? false,
    ).toBe(true); // the shown code now opens the store
  });

  it('a decline re-shows the step-2 warning verbatim and records the decline (F3)', async () => {
    await seedPlaintext(['charlie']);
    renderWizard();
    await driveToPassphrase(false);

    // Step 4 (decline face): the step-2 warning VERBATIM, not a silent skip.
    const warnings = await screen.findAllByRole('alert');
    expect(
      warnings.some(
        (el) =>
          el.textContent ===
          'If you forget your passphrase and lose your recovery key, your data is UNRECOVERABLE. There is no password reset — we have no server.',
      ),
    ).toBe(true);
    expect(appVault.state?.recoveryOfferedAt ?? null).not.toBeNull(); // recorded
    expect(
      appVault.state?.keys.some((k) => k.slots.some((s) => s.kind === 'recovery')) ?? false,
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Continue without a recovery key' }));
    await waitFor(
      () => {
        expect(appVault.status).toBe('on');
      },
      { timeout: 8000 },
    );
  });

  it('closing at the offer step rolls the store back to plaintext (D6.1: fail before step 5)', async () => {
    await seedPlaintext(['delta']);
    renderWizard();
    await driveToPassphrase(true);
    await screen.findByTestId('recovery-code');

    fireEvent.keyDown(document, { key: 'Escape' }); // Dialog: Esc -> onClose -> cancel
    await waitFor(() => {
      const read = appVault.state;
      expect(read?.status ?? 'off').toBe('off');
    });
    expect(appVault.state?.keys ?? []).toEqual([]);
    expect(appVault.state?.migration ?? null).toBeNull();
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok).toBe(true);
    if (raw.ok) for (const row of raw.value) expect(isEncryptedRecord(row)).toBe(false);
  });

  it('the enabled state is persisted through crypto_state (not just in memory)', async () => {
    await seedPlaintext(['echo']);
    renderWizard();
    await driveToPassphrase(true);
    await screen.findByTestId('recovery-code');
    fireEvent.click(screen.getByRole('button', { name: 'I saved it' }));
    await waitFor(
      () => {
        expect(appVault.status).toBe('on');
      },
      { timeout: 8000 },
    );

    const state = await db.get('crypto_state', CRYPTO_KEY);
    if (!state.ok || state.value === undefined) throw new Error('crypto_state missing');
    expect(state.value.status).toBe('on');
    expect(state.value.migration ?? null).toBeNull();
  });
});
