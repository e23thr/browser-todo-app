/**
 * F2/N5 (review) — the crypto section's component contract:
 *  - turn OFF goes through the D6.2 confirmation dialog: one click never
 *    disables, and a wrong passphrase leaves the store `on`;
 *  - a `migrating` store resumes automatically while unlocked (F1a — the
 *    sweep has a production caller, with the section landing on the end
 *    state) and a ciphertext-blocked store offers the join fix (D3.3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { openForTests } from '../../src/storage/db';
import type { AppDBImpl } from '../../src/storage/db';
import { DEFAULT_SETTINGS } from '../../src/domain/model';
import { vault as appVault } from '../../src/crypto/vault';
import { mintKeyEntry } from '../../src/crypto/keys';
import { migrationRun } from '../../src/crypto/service';
import { foreignCiphertext } from '../../src/crypto/foreignData';
import { initCryptoForApp } from '../../src/features/crypto/wiring';
import { CryptoSection } from '../../src/features/crypto/CryptoSection';
import { resetRowCryptoSeam } from '../../src/storage/cryptoSeam';
import { resetMergeCryptoSeam } from '../../src/sync/mergeSeam';
import { makeTask } from '../unit/storage/fixtures';

const T0 = 1_700_000_000_000;
const PASSPHRASE = 'correct horse battery staple';
/** Fast mint for seeds — the slot stores its own KDF parameters. */
const KEY_ITERS = 1000;

let db: AppDBImpl;
let clock = T0;

function now(): number {
  clock += 1000;
  return clock;
}

async function freshDb(): Promise<AppDBImpl> {
  const created = await openForTests({
    dbName: `crypto-section-${Math.random().toString(36).slice(2)}`,
  });
  if (!created.ok) throw new Error('db open failed');
  return created.value;
}

async function seedRing(status: 'on' | 'migrating', titles: string[]): Promise<void> {
  await db.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: T0 + 10 });
  const keyId = `key-${Math.random().toString(36).slice(2)}`;
  const minted = await mintKeyEntry({ keyId, passphrase: PASSPHRASE, now: T0, iters: KEY_ITERS });
  if (!minted.ok) throw new Error('mint failed');
  appVault.acceptSessionKey(keyId, minted.value.dmk);
  const saved = await appVault.saveState({
    status,
    enabledAt: T0,
    keys: [minted.value.entry],
    lockAfterMinutes: 15,
    ...(status === 'migrating'
      ? {
          migration: {
            startedAt: T0,
            done: 0,
            total: titles.length,
            direction: 'encrypt' as const,
          },
        }
      : { migration: null }),
  });
  if (!saved.ok) throw new Error('seed saveState failed');
  for (const title of titles) {
    await db.put('tasks', makeTask({ title, updatedAt: now() })); // seam encrypts while on+unlocked
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
  foreignCiphertext.value = false;
});

describe('CryptoSection — turn off (ADR-007 D6.2, review F2)', () => {
  it('gates the disable behind the confirmation dialog: a wrong passphrase leaves the store on', async () => {
    await seedRing('on', ['alpha']);
    render(<CryptoSection db={db} now={now} />);

    expect(screen.getByTestId('crypto-status').textContent).toContain('On');

    // One click does NOT disable — the D6.2 dialog gates it.
    fireEvent.click(screen.getByTestId('crypto-turn-off'));
    const dialog = screen.getByRole('dialog', { name: 'Turn off encryption?' });
    expect(appVault.status).toBe('on');

    // A wrong passphrase fails verification and leaves the store enabled.
    const passphraseInput = dialog.querySelector<HTMLInputElement>('input[type="password"]');
    if (passphraseInput === null) throw new Error('passphrase input missing');
    fireEvent.input(passphraseInput, { target: { value: 'definitely not the passphrase' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off encryption' }));
    await waitFor(() => {
      const alerts = within(dialog).getAllByRole('alert');
      expect(alerts.some((el) => el.textContent.includes('Wrong passphrase.'))).toBe(true);
    });
    expect(appVault.status).toBe('on');
    expect(appVault.isUnlocked).toBe(true);

    // The real passphrase turns it off (decrypt sweep, then keys wiped).
    fireEvent.input(passphraseInput, { target: { value: PASSPHRASE } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off encryption' }));
    await waitFor(
      () => {
        expect(appVault.status).toBe('off');
      },
      { timeout: 5000 },
    );
    expect(appVault.state?.keys ?? []).toEqual([]);
    expect(screen.getByTestId('crypto-status').textContent).toContain('Off');
  });
});

describe('CryptoSection — migration resume + blocked store (F1a/D3.3)', () => {
  it('a migrating store resumes automatically while unlocked — the section lands on "on"', async () => {
    await seedRing('migrating', ['bravo', 'charlie']);
    render(<CryptoSection db={db} now={now} />);

    // The section's own effect resumes the sweep (no direct service call here).
    await waitFor(
      () => {
        expect(appVault.status).toBe('on');
      },
      { timeout: 5000 },
    );
    expect(screen.getByTestId('crypto-status').textContent).toContain('On');
    expect(migrationRun.value.phase).toBe('idle');
  });

  it('a ciphertext-blocked store shows the blocked notice and the join affordance (D3.3)', async () => {
    await seedRing('on', ['mine']);
    foreignCiphertext.value = true;
    render(<CryptoSection db={db} now={now} />);

    expect(screen.getByTestId('crypto-blocked')).toBeTruthy();
    expect(screen.getByTestId('crypto-join')).toBeTruthy();
  });
});
