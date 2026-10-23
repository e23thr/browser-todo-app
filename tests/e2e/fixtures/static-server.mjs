/**
 * Static fixture server for the offline/update E2E suites (ADR-005 Decision 9).
 *
 * `page.route` cannot intercept service-worker-driven fetches nor the browser's `sw.js` update
 * fetch, so the harness swaps build output AT THE SERVER at runtime — which is also exactly what
 * a GitHub Pages deploy looks like (same origin, byte-different `sw.js`).
 *
 * GitHub Pages semantics are emulated deliberately: no SPA rewrite (unknown paths 404 — the SW's
 * navigation fallback is what must handle them) and `cache-control: no-cache` (the update channel
 * is the `sw.js` byte diff, never the HTTP cache).
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/**
 * @param {{ mountPath: string, port: number }} options — `mountPath` mirrors the configured
 *   base path (`/<repo>/` for project pages, `/` for the root variant).
 * @returns {import('./static-server.d.mts').StaticServer}
 */
export function createStaticServer(options) {
  const mount = options.mountPath.endsWith('/') ? options.mountPath : `${options.mountPath}/`;
  /** @type {string | null} */
  let root = null;
  let failingSw = false;
  /** @type {boolean} */
  let failingAll = false;
  /** @type {number} */
  let latencyMs = 0;

  /**
   * Send a response, honouring the configured artificial latency (degraded-network probes).
   * @param {import('node:http').ServerResponse} response
   * @param {() => void} write
   */
  const send = (response, write) => {
    if (latencyMs > 0) {
      const timer = setTimeout(write, latencyMs);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    write();
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (failingAll) {
      send(response, () => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('degraded-network probe: failing');
      });
      return;
    }

    if (failingSw && pathname.endsWith('/sw.js')) {
      send(response, () => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('sw update probe: failing');
      });
      return;
    }

    const inMount = pathname === mount.slice(0, -1) || pathname.startsWith(mount);
    send(response, () => {
      if (root === null || !inMount) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }

      const relative = pathname.startsWith(mount) ? pathname.slice(mount.length) : 'index.html';
      const file = normalize(join(root, relative === '' ? 'index.html' : relative));
      if (
        !file.startsWith(normalize(root + sep)) ||
        !existsSync(file) ||
        !statSync(file).isFile()
      ) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }

      response.writeHead(200, {
        'content-type': MIME.get(extname(file)) ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      createReadStream(file).pipe(response);
    });
  });

  return {
    origin: `http://127.0.0.1:${String(options.port)}`,
    mountPath: mount,
    setRoot: (dir) => {
      root = resolve(dir);
    },
    setFailingSw: (failing) => {
      failingSw = failing;
    },
    /** Degraded-network probes: fail EVERY response (a dead upstream), not just `sw.js`. */
    setFailingAll: (failing) => {
      failingAll = failing;
    },
    /** Degraded-network probes: add artificial per-response latency (0 = off). */
    setLatency: (ms) => {
      latencyMs = ms;
    },
    listen: () =>
      new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(options.port, '127.0.0.1', () => {
          res();
        });
      }),
    close: () =>
      new Promise((res) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => {
          res();
        });
      }),
  };
}
