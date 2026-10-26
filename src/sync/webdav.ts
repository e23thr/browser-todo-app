/**
 * Hand-rolled WebDAV client on `fetch` (ADR-006 Decision 1) — ZERO new deps.
 *
 * Methods: PROPFIND (Depth:0 capability probe on the CONFIGURED base, Depth:1
 * discovery), GET, PUT, DELETE, MKCOL, MOVE. Multi-status `207` bodies parse
 * with the browser's own `DOMParser`. Basic auth over HTTPS only (`http://`
 * allowed for localhost development). Every PUT is read-back verified (GET +
 * byte compare) — a torn upload is treated as not-written and retried
 * (Decision 1 / Decision 6). Probe protocol: ADR-006 Addendum C.
 *
 * CORS (honest constraint, Decision 1): a browser-origin client can only reach
 * a WebDAV server that allows CORS from the app origin. The browser reports
 * CORS blocks and DNS/TLS failures identically (a rejected `fetch` TypeError),
 * so a TypeError on a cross-origin request is classified `CORS` with guidance
 * and `retryable: true`; offline + timeouts classify `NETWORK`. Surfaced, never
 * hidden — this is deployment friction on the USER'S server, not ours.
 */

import { err, ok } from '../domain/kernel';
import type { Result } from '../domain/kernel';
import type { SyncError, SyncErrorCode } from './types';

export type WebDavConfig = {
  /** HTTPS origin + base path of the user's WebDAV collection (never a server we operate). */
  baseUrl: string;
  user: string;
  password: string;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DavEntry = {
  /** Path relative to the base collection ('' = the collection itself). */
  path: string;
  collection: boolean;
};

export type WebDavDeps = {
  fetch?: FetchLike;
  timeoutMs?: number;
};

function syncError(
  code: SyncErrorCode,
  message: string,
  retryable: boolean,
  detail?: string,
): SyncError {
  return detail === undefined ? { code, message, retryable } : { code, message, retryable, detail };
}

function fromUnknown(e: unknown): SyncError {
  if (typeof e === 'object' && e !== null && 'name' in e) {
    const name = e.name;
    if (name === 'AbortError') {
      return syncError('NETWORK', 'request timed out', true, 'AbortError');
    }
    if (name === 'TypeError') {
      return syncError(
        'CORS',
        'request blocked or unreachable',
        true,
        'fetch rejected (TypeError): usually the WebDAV server missing Access-Control-Allow-Origin for the app origin (OPTIONS preflight); also DNS/TLS failure',
      );
    }
  }
  return syncError('NETWORK', 'network failure', true, String(e));
}

/** HTTPS only — `http://` is accepted for localhost development (Decision 1). */
export function assertSecureRemote(url: string): SyncError | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return syncError('CONFIG', 'remote URL is not a valid URL', false);
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return null;
    return syncError(
      'CONFIG',
      'remote URL must be HTTPS (localhost excepted for development)',
      false,
    );
  }
  return syncError('CONFIG', 'remote URL must be HTTPS', false);
}

function basicAuthHeader(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/** Minimal 207 multi-status parse — element match by localName (prefix-agnostic). */
export function parseMultiStatus(xml: string): Result<DavEntry[], SyncError> {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return err(syncError('CORRUPT_REMOTE', 'PROPFIND response is not parseable XML', false));
  }
  if (doc.querySelector('parsererror') !== null) {
    return err(syncError('CORRUPT_REMOTE', 'PROPFIND response is not parseable XML', false));
  }
  const entries: DavEntry[] = [];
  const responses = [...doc.getElementsByTagNameNS('*', 'response')];
  for (const response of responses) {
    const hrefEl = [...response.getElementsByTagNameNS('*', 'href')][0];
    if (hrefEl === undefined) continue;
    const href = hrefEl.textContent || '';
    const collection = [...response.getElementsByTagNameNS('*', 'collection')].length > 0;
    entries.push({ path: href, collection });
  }
  return ok(entries);
}

export class WebDavClient {
  readonly #base: URL;
  readonly #auth: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(cfg: WebDavConfig, deps: WebDavDeps = {}) {
    // Constructors cannot return Results; invalid config is caught by
    // `assertSecureRemote` in `connect()` — the engine calls that first.
    this.#base = new URL(cfg.baseUrl.endsWith('/') ? cfg.baseUrl : `${cfg.baseUrl}/`);
    this.#auth = basicAuthHeader(cfg.user, cfg.password);
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = deps.timeoutMs ?? 20_000;
  }

  /** The configured base URL, normalized with a trailing slash. */
  get baseUrl(): string {
    return this.#base.toString();
  }

  /** Relative artifact path → absolute URL (segments percent-encoded). */
  url(path: string): string {
    const segments = path.split('/').filter((s) => s.length > 0);
    // The empty path is the configured collection ITSELF (`DavEntry.path` '' =
    // the base collection). Resolving it as a root-relative reference ('/') —
    // the pre-Addendum C behavior — silently retargeted every request to the
    // ORIGIN ROOT (defect E8-UI-D5: the connection test validated a different
    // endpoint than the run would use). The base's canonical collection URL
    // (trailing slash, as `baseUrl` exposes it) is returned verbatim.
    if (segments.length === 0) return this.#base.toString();
    return new URL(segments.map((s) => encodeURIComponent(s)).join('/') + '/', this.#base)
      .toString()
      .replace(/\/$/u, '');
  }

  async #request(
    method: string,
    path: string,
    init: { body?: string; headers?: Record<string, string>; expect?: number[] } = {},
  ): Promise<Result<{ status: number; body: string; headers: Headers }, SyncError>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      const res = await this.#fetch(this.url(path), {
        method,
        headers: {
          Authorization: this.#auth,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
      const body = await res.text();
      const expect = init.expect ?? [200, 201, 204, 207];
      if (!expect.includes(res.status)) {
        return err(this.#statusError(res.status, method, body));
      }
      return ok({ status: res.status, body, headers: res.headers });
    } catch (e) {
      return err(fromUnknown(e));
    } finally {
      clearTimeout(timer);
    }
  }

  #statusError(status: number, method: string, body: string): SyncError {
    if (status === 401 || status === 403) {
      return syncError(
        'AUTH',
        'credentials rejected by the WebDAV server',
        false,
        `${String(status)} on ${method}`,
      );
    }
    if (status === 404) {
      return syncError(
        'REMOTE_MISSING',
        'remote collection or artifact is missing',
        false,
        `404 on ${method}`,
      );
    }
    if (status === 412) {
      return syncError(
        'CONFLICT_WRITE',
        'precondition failed (If-Match)',
        true,
        `412 on ${method}`,
      );
    }
    if (status === 507) {
      return syncError('REMOTE_FULL', 'remote storage is full', false, `507 on ${method}`);
    }
    if (status >= 500) {
      return syncError('NETWORK', 'WebDAV server error', true, `${String(status)} on ${method}`);
    }
    return syncError(
      'NETWORK',
      'unexpected WebDAV response',
      true,
      `${String(status)} on ${method}: ${body.slice(0, 200)}`,
    );
  }

  /**
   * Capability probe against the CONFIGURED base URL (Decision 5 phase 2,
   * protocol amended by ADR-006 Addendum C): a `PROPFIND` `Depth: 0` on the
   * typed collection — the exact endpoint the sync run will use.
   *
   * Why not `OPTIONS` on the base (the pre-Addendum C method): WebDAV servers
   * answer `OPTIONS` UNAUTHENTICATED (a CORS preflight cannot carry
   * credentials), so it can never validate the sign-in — and many answer it for
   * paths that do not exist. `PROPFIND` is authenticated and path-exact:
   * `207` = the collection exists and the credentials work; `401`/`403` → AUTH;
   * `404` → REMOTE_MISSING (a dead configured path fails the setup test).
   */
  async probe(): Promise<Result<void, SyncError>> {
    const res = await this.#request('PROPFIND', '', {
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      expect: [207],
    });
    if (!res.ok) return res;
    return ok(undefined);
  }

  /** PROPFIND Depth:1 listing of a collection. 404 → empty (caller decides). */
  async list(path: string): Promise<Result<DavEntry[], SyncError>> {
    const res = await this.#request('PROPFIND', path, {
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>',
      headers: { Depth: '1' },
      expect: [207, 404],
    });
    if (!res.ok) return res;
    if (res.value.status === 404) return ok([]);
    return parseMultiStatus(res.value.body);
  }

  /** GET an artifact; `null` when absent (404). */
  async get(path: string): Promise<Result<string | null, SyncError>> {
    const res = await this.#request('GET', path, { expect: [200, 404] });
    if (!res.ok) return res;
    return ok(res.value.status === 404 ? null : res.value.body);
  }

  /**
   * PUT with read-back verification (Decision 1): the artifact counts as
   * written only when a GET returns byte-identical content. A mismatch is
   * retried once with the SAME path (Decision 2's retry-reuses-seq rule), then
   * reported — the artifact is treated as not-written.
   */
  async putVerified(path: string, body: string): Promise<Result<void, SyncError>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const put = await this.#request('PUT', path, { body, expect: [200, 201, 204] });
      if (!put.ok) return put;
      const readBack = await this.get(path);
      if (!readBack.ok) return readBack;
      if (readBack.value === body) return ok(undefined);
    }
    return err(
      syncError(
        'NETWORK',
        'upload verification failed (stored bytes differ)',
        true,
        `read-back mismatch on ${path}`,
      ),
    );
  }

  /** DELETE is idempotent (Decision 8 compaction). 404 = already gone. */
  async remove(path: string): Promise<Result<void, SyncError>> {
    const res = await this.#request('DELETE', path, { expect: [200, 204, 404] });
    if (!res.ok) return res;
    return ok(undefined);
  }

  /** MKCOL, idempotent: an existing collection (405/301/409-on-existing) is success. */
  async mkcol(path: string): Promise<Result<void, SyncError>> {
    const res = await this.#request('MKCOL', path, { expect: [200, 201, 204, 301, 405, 409] });
    if (!res.ok) return res;
    return ok(undefined);
  }

  /** Ensure `<base>/todo-sync/v1/{snapshots,changes/<deviceId>}/` exists (Decision 5 phase 2). */
  async ensureLayout(deviceId: string): Promise<Result<void, SyncError>> {
    for (const dir of [
      'todo-sync',
      'todo-sync/v1',
      'todo-sync/v1/snapshots',
      'todo-sync/v1/changes',
      `todo-sync/v1/changes/${deviceId}`,
    ]) {
      const res = await this.mkcol(dir);
      if (!res.ok) return res;
    }
    return ok(undefined);
  }
}

export { syncError as makeSyncError };
