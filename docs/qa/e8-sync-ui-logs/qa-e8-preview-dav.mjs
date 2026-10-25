// E8 QA same-origin preview + WebDAV (t_98a1b4a5, h_reviewer).
//   node qa-e8-preview-dav.mjs [port] [distDir] [logPath]
// Serves dist/ like `vite preview` (SPA index fallback) and implements the
// mock WebDAV under /dav/ (healthy) and /dav-bad/ (401). EVERY request is
// logged (JSONL) for the zero-request and probe-target assertions.
//
// Root-dead mode: while the flag file `qa-e8-rootdead` exists, OPTIONS on
// '/' destroys the socket — simulating an unreachable server at the URL the
// engine's probe ACTUALLY targets (defect E8-UI-D5: probe hits the origin
// root, not the configured base path).

import http from 'node:http';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const port = Number(process.argv[2] ?? 4193);
const distDir = process.argv[3] ?? 'dist';
const logPath = process.argv[4] ?? 'qa-e8-dav-requests.jsonl';
const FLAG = 'qa-e8-rootdead';

const davStore = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(distDir, safe);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(distDir, 'index.html');
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), method: req.method, path: url, origin: req.headers.origin ?? null })}\n`);
  console.log(`${req.method} ${url}`);

  // Root-dead mode: the engine probe targets the ORIGIN ROOT (E8-UI-D5).
  if (req.method === 'OPTIONS' && (url === '/' || url === '') && existsSync(FLAG)) {
    req.socket.destroy();
    return;
  }

  if (url.startsWith('/dav')) {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'Authorization, Content-Type, Depth',
      DAV: '1, 2',
    };
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (url.startsWith('/dav-bad')) {
        res.writeHead(401, { ...cors, 'Content-Type': 'text/plain' });
        res.end('denied');
        return;
      }
      switch (req.method) {
        case 'PROPFIND':
          res.writeHead(404, cors);
          res.end();
          return;
        case 'PUT': {
          davStore.set(url, Buffer.concat(chunks));
          res.writeHead(201, cors);
          res.end();
          return;
        }
        case 'GET': {
          const body = davStore.get(url);
          if (body === undefined) {
            res.writeHead(404, cors);
            res.end();
            return;
          }
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Content-Length': String(body.length) });
          res.end(body);
          return;
        }
        case 'DELETE': {
          davStore.delete(url);
          res.writeHead(204, cors);
          res.end();
          return;
        }
        case 'MKCOL':
          res.writeHead(201, cors);
          res.end();
          return;
        default:
          res.writeHead(405, cors);
          res.end();
      }
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`qa preview+dav listening on http://localhost:${String(port)}/ (dav log: ${logPath})`);
});
