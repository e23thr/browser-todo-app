/**
 * WebDAV transport tests (ADR-006 Decision 1) against the in-memory fake
 * server: discovery, verified uploads, idempotent MKCOL/DELETE, the error-code
 * mapping (AUTH/CONFLICT_WRITE/REMOTE_FULL/NETWORK), HTTPS enforcement and the
 * 207 multi-status parse. No real network.
 */

import { describe, expect, it } from 'vitest';

import { assertSecureRemote, parseMultiStatus, WebDavClient } from '../../../src/sync/webdav';
import { makeFakeWebDav } from './fixtures';

function clientFor(): ReturnType<typeof makeFakeWebDav> & { client: WebDavClient } {
  const fake = makeFakeWebDav();
  const client = new WebDavClient(
    { baseUrl: fake.baseUrl, user: 'alice', password: 'app-password' },
    { fetch: fake.fetch },
  );
  return { ...fake, client };
}

describe('WebDavClient', () => {
  it('ensureLayout creates the Decision 2 directory tree idempotently', async () => {
    const { client, state } = clientFor();
    expect((await client.ensureLayout('DEV1')).ok).toBe(true);
    expect(state.collections.has('todo-sync/v1/snapshots')).toBe(true);
    expect(state.collections.has('todo-sync/v1/changes/DEV1')).toBe(true);
    // Second call: MKCOL on existing collections must not fail.
    expect((await client.ensureLayout('DEV1')).ok).toBe(true);
  });

  it('putVerified stores bytes only after read-back verification; torn stores are retried then reported', async () => {
    const { client, state, faults } = clientFor();
    expect(
      (await client.putVerified('todo-sync/v1/changes/DEV1/0000000001.json', 'hello')).ok,
    ).toBe(true);
    expect(state.files.get('todo-sync/v1/changes/DEV1/0000000001.json')).toBe('hello');

    faults.tornPut = true;
    const torn = await client.putVerified(
      'todo-sync/v1/changes/DEV1/0000000002.json',
      'full-body-content',
    );
    expect(torn.ok).toBe(false); // treated as not-written (Decision 1)
    if (!torn.ok) expect(torn.error.code).toBe('NETWORK');
  });

  it('lists collections as PROPFIND Depth:1 with names resolved from hrefs', async () => {
    const { client } = clientFor();
    await client.ensureLayout('DEV1');
    await client.putVerified('todo-sync/v1/changes/DEV1/0000000001.json', 'x');
    const listed = await client.list('todo-sync/v1/changes/DEV1');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.some((e) => e.path.endsWith('/0000000001.json') && !e.collection)).toBe(
      true,
    );
  });

  it('maps statuses to the Decision 6 codes (AUTH / CONFLICT_WRITE / REMOTE_FULL / REMOTE_MISSING)', async () => {
    const { client, faults } = clientFor();

    faults.failStatus = 401;
    const auth = await client.get('todo-sync/v1/snapshots/a.json');
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.error.code).toBe('AUTH');

    faults.failStatus = 412;
    const conflict = await client.putVerified('p', 'x');
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('CONFLICT_WRITE');

    faults.failStatus = 507;
    const full = await client.putVerified('p', 'x');
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error.code).toBe('REMOTE_FULL');

    faults.failStatus = 500;
    const serverError = await client.probe();
    expect(serverError.ok).toBe(false);
    if (!serverError.ok) {
      expect(serverError.error.code).toBe('NETWORK');
      expect(serverError.error.retryable).toBe(true);
    }

    delete faults.failStatus;
    faults.hidePath = 'todo-sync/v1/changes';
    const missing = await client.list('todo-sync/v1/changes');
    expect(missing.ok).toBe(true); // 404 on discovery = empty, caller decides
  });

  it('get returns null for absent artifacts; delete is idempotent', async () => {
    const { client } = clientFor();
    expect((await client.get('nope.json')).ok && (await client.get('nope.json')).ok).toBe(true);
    const got = await client.get('nope.json');
    expect(got.ok && got.value).toBeNull();
    expect((await client.remove('nope.json')).ok).toBe(true);
  });

  it('HTTPS is enforced except localhost (CONFIG error is not retryable)', () => {
    expect(assertSecureRemote('https://cloud.example/remote.php/dav/files/a/')).toBeNull();
    expect(assertSecureRemote('http://localhost:8080/dav/')).toBeNull();
    expect(assertSecureRemote('http://127.0.0.1:8080/dav/')).toBeNull();
    const insecure = assertSecureRemote('http://cloud.example/dav/');
    expect(insecure?.code).toBe('CONFIG');
    expect(insecure?.retryable).toBe(false);
    const garbage = assertSecureRemote('not a url');
    expect(garbage?.code).toBe('CONFIG');
  });

  it('fetch rejection classifies as CORS with actionable guidance (browser reality, Decision 1)', async () => {
    const fake = makeFakeWebDav();
    fake.faults.reject = 'network';
    const client = new WebDavClient(
      { baseUrl: fake.baseUrl, user: 'u', password: 'p' },
      { fetch: fake.fetch },
    );
    const res = await client.probe();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('CORS');
    expect(res.error.detail).toContain('Access-Control-Allow-Origin');

    fake.faults.reject = 'abort';
    const timedOut = await client.probe();
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.error.code).toBe('NETWORK');
  });

  it('parses 207 multi-status XML prefix-agnostically', () => {
    const xml =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
      '<D:response><D:href>/base/todo-sync/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>' +
      '<D:response><D:href>/base/todo-sync/a.json</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response>' +
      '</D:multistatus>';
    const parsed = parseMultiStatus(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual([
      { path: '/base/todo-sync/', collection: true },
      { path: '/base/todo-sync/a.json', collection: false },
    ]);
    const broken = parseMultiStatus('<not-xml');
    expect(broken.ok).toBe(false);
  });
});
