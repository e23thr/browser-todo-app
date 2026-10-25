// E8 QA minimal WebDAV mock (t_98a1b4a5, h_reviewer).
// Healthy, CORS-correct WebDAV-ish server for the browser-level sync probe.
//   node qa-e8-mock-webdav.mjs [port] [logPath]
// Logs EVERY request it receives (JSONL) — the zero-request assertion reads this.
// Paths containing '/bad' answer 401 (wrong-credentials scenario); everything
// else is served for real: PUT stores, GET reads back byte-identical (the
// engine's putVerified read-back), PROPFIND 404s (empty discovery), MKCOL 201s.

import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const port = Number(process.argv[2] ?? 4194);
const logPath = process.argv[3] ?? 'qa-e8-mock-requests.jsonl';
mkdirSync(dirname(logPath), { recursive: true });

const store = new Map();

function corsFor(req) {
  const origin = req.headers.origin;
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'Authorization, Content-Type, Depth',
    'Access-Control-Expose-Headers': 'DAV, ETag',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    DAV: '1, 2',
  };
}

const server = http.createServer((req, res) => {
  const cors = corsFor(req);
  appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), method: req.method, path: req.url, origin: req.headers.origin ?? null })}\n`);
  console.log(`REQ ${req.method} ${req.url}`);

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.url.includes('/bad')) {
      res.writeHead(401, { ...cors, 'Content-Type': 'text/plain' });
      res.end('denied');
      return;
    }
    switch (req.method) {
      case 'PROPFIND': {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      case 'PUT': {
        store.set(req.url, Buffer.concat(chunks));
        res.writeHead(201, cors);
        res.end();
        return;
      }
      case 'GET': {
        const body = store.get(req.url);
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
        store.delete(req.url);
        res.writeHead(204, cors);
        res.end();
        return;
      }
      case 'MKCOL': {
        res.writeHead(201, cors);
        res.end();
        return;
      }
      default: {
        res.writeHead(405, cors);
        res.end();
      }
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-webdav listening on http://127.0.0.1:${String(port)}/ (log: ${logPath})`);
});
