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

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (failingSw && pathname.endsWith('/sw.js')) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('sw update probe: failing');
      return;
    }

    const inMount = pathname === mount.slice(0, -1) || pathname.startsWith(mount);
    if (root === null || !inMount) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    const relative = pathname.startsWith(mount) ? pathname.slice(mount.length) : 'index.html';
    const file = normalize(join(root, relative === '' ? 'index.html' : relative));
    if (!file.startsWith(normalize(root + sep)) || !existsSync(file) || !statSync(file).isFile()) {
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

  return {
    origin: `http://127.0.0.1:${String(options.port)}`,
    mountPath: mount,
    setRoot: (dir) => {
      root = resolve(dir);
    },
    setFailingSw: (failing) => {
      failingSw = failing;
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
