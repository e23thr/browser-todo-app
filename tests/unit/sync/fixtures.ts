/**
 * Test fixtures for the ADR-006 sync suites: record builders (validated shapes)
 * and an in-memory fake WebDAV server (GET/PUT/DELETE/PROPFIND/MKCOL/MOVE +
 * 207 multi-status + fault-injection hooks). No real network, ever.
 */

import type { List, Task } from '../../../src/domain/model';
import { boot } from '../../../src/storage/boot';
import type { AppDB } from '../../../src/storage/db';
import { newUlid } from '../../../src/storage/id';
import { orderKeyFirst } from '../../../src/storage/orderKey';
import { ensureSyncState } from '../../../src/storage/syncState';
import type { SyncStateRecord } from '../../../src/storage/types';
import { runSyncOnce } from '../../../src/sync/engine';
import type { FetchLike, WebDavClient } from '../../../src/sync/webdav';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic 26-char ULID-shaped id (valid per storage/id's ULID_RE). */
export function testUlid(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = '';
  let x = h >>> 0;
  for (let i = 0; i < 26; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345 + i) >>> 0;
    out += ULID_ALPHABET.charAt(x % 32);
  }
  return out;
}

export const DEVICE_A = '0'.repeat(26);
export const DEVICE_B = '1'.repeat(26);
export const DEVICE_C = '2'.repeat(26);
export const LIST_1 = testUlid('list-1');

export function makeList(overrides: Partial<List> = {}): List {
  return {
    id: LIST_1,
    name: 'Inbox',
    color: '#3366ff',
    sortOrder: orderKeyFirst(),
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    deviceId: DEVICE_A,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: testUlid('task-1'),
    listId: LIST_1,
    title: 'Buy milk',
    notes: null,
    status: 'open',
    priority: 'P4',
    tags: [],
    sortOrder: orderKeyFirst(),
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    deviceId: DEVICE_A,
    ...overrides,
  };
}

/* --------------------------- fake WebDAV server --------------------------- */

export type FakeDavState = {
  files: Map<string, string>;
  collections: Set<string>;
  requests: { method: string; path: string }[];
};

export type FakeDavFaults = {
  /** Reject every request (unreachable server / CORS wall). */
  reject?: 'network' | 'abort';
  /** Answer every request with this status (401, 500, 507, ...). */
  failStatus?: number;
  /** After N successful requests, fail with `failStatusAfter` (mid-run outages). */
  failAfter?: number;
  failStatusAfter?: number;
  /** Store only half of PUT bodies (torn upload). */
  tornPut?: boolean;
  /** Serve corrupted content for specific paths (corrupt remote artifacts). */
  corruptGet?: Map<string, string>;
  /** Make PROPFIND for a specific path answer 404 (REMOTE_MISSING). */
  hidePath?: string;
  /**
   * Require matching Basic credentials — every request except `OPTIONS` (the
   * preflight is answered unauthenticated, exactly like real WebDAV servers,
   * which is why an OPTIONS-based probe can never validate a sign-in).
   */
  auth?: { user: string; password: string };
};

const BASE = 'https://dav.test/base/';

export function makeFakeWebDav(): {
  fetch: FetchLike;
  state: FakeDavState;
  faults: FakeDavFaults;
  baseUrl: string;
} {
  const state: FakeDavState = { files: new Map(), collections: new Set(['']), requests: [] };
  const faults: FakeDavFaults = {};

  const pathOf = (input: string): string => {
    const url = new URL(input);
    return decodeURIComponent(url.pathname.replace(/^\/base\/?/u, '')).replace(/\/$/u, '');
  };

  const children = (dir: string): { path: string; collection: boolean }[] => {
    const prefix = dir.length === 0 ? '' : `${dir}/`;
    const out = new Map<string, { path: string; collection: boolean }>();
    for (const col of state.collections) {
      if (col === dir || !col.startsWith(prefix)) continue;
      const rest = col.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.set(rest, { path: `${prefix}${rest}`, collection: true });
    }
    for (const file of state.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.set(rest, { path: file, collection: false });
    }
    return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  };

  const multiStatus = (entries: { path: string; collection: boolean }[]): string => {
    const body = entries
      .map(
        (e) =>
          `<d:response><d:href>/base/${e.path}</d:href><d:propstat><d:prop><d:resourcetype>${
            e.collection ? '<d:collection/>' : ''
          }</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      )
      .join('');
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;
  };

  let served = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = pathOf(input);
    state.requests.push({ method, path });
    served += 1;

    if (faults.reject === 'network') {
      const e = new TypeError('fetch failed');
      throw e;
    }
    if (faults.reject === 'abort') {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (faults.failStatus !== undefined) {
      return new Response('', { status: faults.failStatus });
    }
    if (faults.failAfter !== undefined && served > faults.failAfter) {
      return new Response('', { status: faults.failStatusAfter ?? 500 });
    }
    if (faults.auth !== undefined && method !== 'OPTIONS') {
      const expected = `Basic ${btoa(`${faults.auth.user}:${faults.auth.password}`)}`;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if ((headers['Authorization'] ?? '') !== expected) {
        return new Response('', { status: 401 });
      }
    }

    switch (method) {
      case 'OPTIONS':
        return new Response('', { status: 200 });
      case 'PROPFIND': {
        if (faults.hidePath === path) return new Response('', { status: 404 });
        const isCol = state.collections.has(path);
        const isFile = state.files.has(path);
        if (!isCol && !isFile) return new Response('', { status: 404 });
        const entries = [{ path, collection: isCol }, ...(isCol ? children(path) : [])];
        return new Response(multiStatus(entries), { status: 207 });
      }
      case 'GET': {
        const corrupted = faults.corruptGet?.get(path);
        if (corrupted !== undefined) return new Response(corrupted, { status: 200 });
        const body = state.files.get(path);
        return body === undefined
          ? new Response('', { status: 404 })
          : new Response(body, { status: 200 });
      }
      case 'PUT': {
        const rawBody: unknown = init?.body;
        const body = typeof rawBody === 'string' ? rawBody : '';
        state.files.set(
          path,
          faults.tornPut === true ? body.slice(0, Math.floor(body.length / 2)) : body,
        );
        return new Response('', { status: 201 });
      }
      case 'DELETE':
        state.files.delete(path);
        return new Response(null, { status: 204 });
      case 'MKCOL': {
        if (state.collections.has(path)) return new Response('', { status: 405 });
        state.collections.add(path);
        return new Response('', { status: 201 });
      }
      case 'MOVE':
        return new Response('', { status: 201 });
      default:
        return new Response('', { status: 405 });
    }
  };

  return { fetch: fetchImpl, state, faults, baseUrl: BASE };
}

/** Seed a raw artifact file on the fake server (corrupt/format fixtures). */
export function seedFile(state: FakeDavState, path: string, body: string): void {
  state.files.set(path, body);
}

/* ------------------------------ engine harness ------------------------------ */

let dbSeq = 0;

/** Fresh booted AppDB (real meta.deviceId per boot, unique name per call). */
export async function bootDb(): Promise<AppDB> {
  dbSeq += 1;
  const name = `sync-test-${String(Date.now())}-${String(dbSeq)}`;
  const result = await boot({ dbName: name });
  if (!result.ok) throw new Error(`boot failed: ${result.error.code}`);
  return result.value;
}

/** The working sync_state row (seeded lazily exactly like the engine does). */
export async function stateOf(db: AppDB): Promise<SyncStateRecord> {
  const row = await ensureSyncState(db, db.deviceId);
  if (!row.ok) throw new Error('ensureSyncState failed');
  return row.value;
}

/** One engine run with a deterministic virtual clock (timestamps stay coherent
 *  with fixture rows: the push watermark derives from `now`). */
export const T0 = 1_700_000_000_000;

export async function runEngine(
  db: AppDB,
  client: WebDavClient,
  options: { trigger?: 'manual' | 'auto'; now?: () => number; newId?: () => string } = {},
): ReturnType<typeof runSyncOnce> {
  const state = await stateOf(db);
  let tick = T0;
  return runSyncOnce(
    {
      db,
      client,
      now: options.now ?? ((): number => (tick += 1)),
      newId: options.newId ?? ((): string => newUlid(T0 + Math.floor(Math.random() * 1000))),
    },
    { trigger: options.trigger ?? 'manual', state },
  );
}

/** Deterministic ULID factory for engine runs (identifiable copy ids). */
export function counterIds(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return testUlid(`${prefix}-${String(n)}`);
  };
}
