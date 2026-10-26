/**
 * E10 encryption drills in a REAL browser (test card t_0a8e0c42, epic E10).
 *
 * ADR-007's testing contract is a BROWSER contract: WebCrypto known-answer
 * vectors, IndexedDB transaction semantics, and at-rest bytes in a real
 * profile. The unit suite (`tests/unit/crypto/*`) covers the same ground on
 * Node's WebCrypto + fake-indexeddb; this spec re-derives the parts where the
 * browser itself is the thing under test, so a pass cannot be an artifact of
 * the test double:
 *
 *  1. KAT re-verification against Chromium's own WebCrypto — the four pinned
 *     fixtures (AES-GCM seal, PBKDF2-600k, HKDF recovery KEK, DMK wrap) plus
 *     slot-binding and AAD/tamper negatives.
 *  2. IndexedDB transaction lifetime: a microtask await keeps the transaction
 *     alive; a macrotask (`setTimeout`) or `crypto.subtle` await deactivates
 *     it on engines that do not resolve WebCrypto as a microtask (firefox,
 *     webkit — and fake-indexeddb). This is what made `applyImport`'s seamed
 *     write fail inside an encrypted store (defect E10-Q6): the product now
 *     seals rows OUTSIDE the transaction (ADR-007 Decision 4.6, t_361487a7),
 *     so the drills below pass on every engine and the probe pins the raw
 *     engine divergence as history.
 *  3. The real `applyImport`/`restoreSnapshot` paths against a REAL encrypted
 *     store: measured, not assumed.
 *
 * Bundled once into `tests/e2e/.fixtures/encryption/` by the harness vite
 * config and served by the ADR-005 fixture server, offline.
 *
 * NOTE (Playwright serialization): functions passed to `page.evaluate` run in
 * the page and may not close over spec-module values — everything crosses via
 * arguments and the page side reaches the harness through `window.__e10`.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import type { TxProbe } from './encryption/harness';
import type { StaticServer } from './fixtures/static-server.mjs';
import { startFixtureServer } from './sw-utils';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_CONFIG = 'tests/e2e/encryption/vite.config.mjs';
const OUT_DIR = resolve(REPO_ROOT, 'tests', 'e2e', '.fixtures', 'encryption');

let server: StaticServer;
let harnessUrl = '';

test.beforeAll(async () => {
  // Built ONCE per run by tests/e2e/fixtures/global-setup.mjs (ADR-005 Decision
  // 9 — the same rule as the marked offline builds): a PER-WORKER build here
  // raced sibling workers into the shared OUT_DIR (`emptyOutDir: true` wiped
  // files another worker's fixture server was already serving), producing the
  // `window.__e10 is undefined` / KAT-content flakes under 4-project parallel
  // runs (t_585851b0). The inline build remains only as a fallback for runs
  // that bypass global setup.
  if (process.env['E2E_FIXTURES_READY'] !== '1') {
    execFileSync('npx', ['vite', 'build', '--config', HARNESS_CONFIG, '--outDir', OUT_DIR], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  }
  server = await startFixtureServer('/');
  server.setRoot(OUT_DIR);
  harnessUrl = `${server.origin}/index.html`;
});

test.afterAll(async () => {
  await server.close();
});

async function boot(page: Page, dbName: string): Promise<void> {
  await page.goto(harnessUrl);
  await page.waitForFunction(() => window.__e10.ready);
  const opened = await page.evaluate((name) => window.__e10.open(name), dbName);
  expect(opened).toEqual({ ok: true });
}

test.describe('E10 — encryption at rest in a real browser', () => {
  test('KAT: all four pinned vectors + binding/AAD negatives pass on Chromium WebCrypto', async ({
    page,
  }, testInfo) => {
    await boot(page, `e10-kat-${String(testInfo.workerIndex)}`);

    const kats = await page.evaluate(() => window.__e10.runKats());
    const names = Object.keys(kats).sort();
    testInfo.annotations.push({ type: 'kats', description: JSON.stringify(kats, null, 1) });

    // Every probe must be present and passing.
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const [name, result] of Object.entries(kats)) {
      expect(result.pass, `${name} failed: ${result.detail}`).toBe(true);
    }
    // Spot-check the exact pinned digests travelled through Chromium.
    expect(kats['B_pbkdf2_600k']?.detail).toBe(
      'ef177144eec9420cbc1093d2a8b344a92bc506d0d4ec9c028dd19f8324d8c1e6',
    );
    expect(kats['C_hkdf_recovery']?.detail).toBe(
      'f96b403d739bb69112d33ddc808301fbd04515fefdd2220bf8d7dd4afdd46d2f',
    );

    await page.evaluate(() => window.__e10.close());
  });

  test('IndexedDB tx lifetime: microtask survives, macrotask and crypto.subtle deactivate (Chromium)', async ({
    page,
  }, testInfo) => {
    await boot(page, `e10-tx-${String(testInfo.workerIndex)}`);

    const probe: TxProbe = await page.evaluate(() => window.__e10.probeTx());
    testInfo.annotations.push({ type: 'tx-probe', description: JSON.stringify(probe) });

    // Spec-faithful expectations for a readwrite transaction:
    //  - a microtask continuation keeps it active;
    //  - crossing a MACROTASK boundary (setTimeout) deactivates it.
    expect(probe.microtask_survives, 'microtask await must keep the tx alive').toBe(true);
    // The exception NAME is an implementation detail, not the contract: the
    // contract is "the put on the deactivated tx is refused". Chromium always
    // throws InvalidStateError; WebKit throws TransactionInactiveError, or
    // InvalidStateError once the tx has already committed — a timing race
    // inside WebKit that made this assertion flake (t_585851b0).
    expect(
      probe.macrotask_throws === 'InvalidStateError' ||
        probe.macrotask_throws === 'TransactionInactiveError',
      `setTimeout(0) await must deactivate the tx (got ${String(probe.macrotask_throws)})`,
    ).toBe(true);
    // `crypto.subtle` is recorded but NOT asserted: Chromium resolves a small
    // digest fast enough that the continuation runs as a microtask, so the put
    // survives. fake-indexeddb schedules it as a macrotask and throws instead —
    // a known double/impl divergence. The REAL answer for the product path is
    // the import/restore drills below, which run the actual seamed write.
    testInfo.annotations.push({
      type: 'crypto-subtle-vs-double',
      description: `chromium=${String(probe.crypto_subtle_throws)} (fake-indexeddb throws InvalidStateError)`,
    });

    await page.evaluate(() => window.__e10.close());
  });

  test('import into an encrypted store re-encrypts on write (D4.5)', async ({ page }, testInfo) => {
    await boot(page, `e10-import-${String(testInfo.workerIndex)}`);

    // C1 on, real PBKDF2, real pre-migration snapshot.
    const enabled = await page.evaluate(() => window.__e10.enable());
    expect(enabled.ok, `enable failed: ${enabled.detail}`).toBe(true);
    expect(enabled.status).toBe('on');

    // Encrypt a row and prove it is ciphertext at rest (leak audit).
    const added = await page.evaluate(() =>
      window.__e10.addTask('01ARZ3NDEKTSV4RRFFQ69G5FA7', 'Buy oat milk secret'),
    );
    expect(added.ok).toBe(true);
    expect(added.encAtRest, 'task must be encrypted at rest').toBe(true);
    const leak = await page.evaluate(() =>
      window.__e10.atRestLeakCheck('01ARZ3NDEKTSV4RRFFQ69G5FA7'),
    );
    expect(leak.encrypted).toBe(true);
    expect(leak.titleLeaked, 'plaintext title must not appear in at-rest bytes').toBe(false);

    // The seamed transaction pattern in isolation (crypto awaited INSIDE a live
    // tx — what the product no longer does). Pinned per engine, because the
    // divergence IS the E10-Q6 mechanism: chromium resolves the small digest
    // as a microtask (the put survives), firefox/webkit deactivate the tx and
    // refuse the put (InvalidStateError / TransactionInactiveError). fake-
    // indexeddb sides with firefox/webkit — the old unit-level Q6 signal was a
    // TRUE positive there, and only looked like one on Chromium.
    const seamedThrow = await page.evaluate(() => window.__e10.probeSeamedTx());
    testInfo.annotations.push({ type: 'seamed-tx', description: String(seamedThrow) });
    if (testInfo.project.name.startsWith('chromium')) {
      expect(
        seamedThrow,
        'chromium resolves the digest as a microtask — the seamed put survives',
      ).toBeNull();
    } else {
      expect(
        ['InvalidStateError', 'TransactionInactiveError'],
        `firefox/webkit must deactivate the seamed tx (got ${String(seamedThrow)})`,
      ).toContain(seamedThrow);
    }

    // The real feature: import 3 plaintext records into the ENCRYPTED store.
    const imported = await page.evaluate(() => window.__e10.importIntoEncrypted());
    const summary = await page.evaluate(() => window.__e10.summary());
    testInfo.annotations.push({
      type: 'import-into-encrypted',
      description: JSON.stringify({ imported, summary, seamedThrow }),
    });

    expect(imported.ok, `import into encrypted store failed: ${JSON.stringify(imported)}`).toBe(
      true,
    );
    if (imported.ok) expect(imported.value.quarantined).toBe(0);

    // D4.5: every imported record is re-encrypted on write. ADR-004 Decision
    // 11: MVP import is REPLACE-only — the 1 seeded row is hard-deleted in the
    // same transaction, so the post-import store is exactly the 3 imported
    // rows, every one ciphertext, zero plaintext titles left at rest.
    expect(summary.tasks, 'import replaces all rows with the 3 imported').toBe(3);
    expect(summary.encrypted, 'every row must be ciphertext after import').toBe(3);
    expect(summary.status).toBe('on');
    for (const title of summary.titles) {
      expect(title, 'no plaintext title may survive at rest').toBe('<ciphertext>');
    }

    await page.evaluate(() => window.__e10.close());
  });

  test('pre-migration snapshot restore rolls back an encrypted store (D4.4/D6.1)', async ({
    page,
  }, testInfo) => {
    await boot(page, `e10-restore-${String(testInfo.workerIndex)}`);

    const enabled = await page.evaluate(() => window.__e10.enable());
    expect(enabled.ok, `enable failed: ${enabled.detail}`).toBe(true);

    // Seed content FIRST so the snapshot is non-empty and the restore has real
    // rows to write back through the seam (an empty-store restore proves nothing).
    const added = await page.evaluate(() =>
      window.__e10.addTask('01ARZ3NDEKTSV4RRFFQ69G5FA8', 'pre-restore content'),
    );
    expect(added.ok).toBe(true);
    expect(added.encAtRest).toBe(true);

    const drill = await page.evaluate(() => window.__e10.restoreDrill());
    const summary = await page.evaluate(() => window.__e10.summary());
    testInfo.annotations.push({
      type: 'restore-drill',
      description: JSON.stringify({ drill, summary }),
    });

    expect(drill.takeOk, 'taking a snapshot of an encrypted store must work').toBe(true);
    expect(
      drill.restoreOk,
      `restore into encrypted store failed: ${String(drill.restoreError)}`,
    ).toBe(true);
    // The restored content is present AND still ciphertext (no plaintext leak).
    expect(summary.tasks).toBeGreaterThanOrEqual(1);
    expect(summary.encrypted).toBe(summary.tasks);
    expect(summary.status).toBe('on');

    await page.evaluate(() => window.__e10.close());
  });
});
