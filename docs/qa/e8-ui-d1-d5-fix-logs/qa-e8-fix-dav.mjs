// E8-UI-D5/D1 fix evidence (t_2dec7c9d, h_senior_coder) — fake WebDAV host + request log.
//   node qa-e8-fix-dav.mjs [port] [distDir] [logPath]
// Serves dist/ like `vite preview` (SPA fallback) and a WebDAV double under /dav/.
//
// Deliberately REALISTIC where the E8 QA double was not (that double is why the
// old OPTIONS-on-root probe passed setup):
//   - OPTIONS is answered 204 PRE-AUTH on every path (CORS preflight reality —
//     which is exactly why an OPTIONS probe can never validate credentials);
//   - every other method requires Basic alice:<password> or answers 401;
//   - PROPFIND is PATH-SENSITIVE: 207 only for KNOWN collections, 404 otherwise.
// EVERY request is logged as JSONL for the "typed path on the probe" assertion.

import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';

const port = Number(process.argv[2] ?? 4195);
const distDir = process.argv[3] ?? 'dist';
const logPath = process.argv[4] ?? 'qa-e8-fix-dav-requests.jsonl';
mkdirSync(dirname(logPath), { recursive: true });

const USER = 'alice';
const PASSWORD = 'correct-horse';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

// Known collections: the TYPED path the probe must hit, plus its ancestors.
const collections = new Set([
  '/dav/',
  '/dav/deep/',
  '/dav/deep/nested/',
  '/dav/deep/nested/coll/',
]);
const files = new Map();

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

function cors(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL',
    'Access-Control-Allow-Headers':
      req.headers['access-control-request-headers'] ?? 'Authorization, Content-Type, Depth',
    DAV: '1, 2',
    Vary: 'Origin',
  };
}

function multiStatus(href, isCollection) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:multistatus xmlns:d="DAV:"><d:response>' +
    `<d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${
      isCollection ? '<d:collection/>' : ''
    }</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` +
    '</d:response></d:multistatus>'
  );
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  const auth = req.headers.authorization ?? '';
  appendFileSync(
    logPath,
    `${JSON.stringify({
      t: new Date().toISOString(),
      method: req.method,
      path: url,
      authorization: auth === '' ? 'none' : auth === BASIC ? 'valid' : 'wrong',
    })}\n`,
  );
  console.log(`${req.method} ${url} auth=${auth === '' ? 'none' : auth === BASIC ? 'valid' : 'wrong'}`);

  if (!url.startsWith('/dav')) {
    serveStatic(req, res);
    return;
  }

  const headers = cors(req);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // CORS preflight: answered UNAUTHENTICATED (real-server behavior).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    // Everything else: authenticated, or 401.
    if (auth !== BASIC) {
      res.writeHead(401, { ...headers, 'Content-Type': 'text/plain' });
      res.end('denied');
      return;
    }
    const path = url.replace(/\?.*$/, '');
    switch (req.method) {
      case 'PROPFIND': {
        if (!collections.has(path)) {
          res.writeHead(404, headers); // dead path — the probe must FAIL on this
          res.end();
          return;
        }
        res.writeHead(207, { ...headers, 'Content-Type': 'application/xml' });
        res.end(multiStatus(path, true));
        return;
      }
      case 'MKCOL': {
        collections.add(path.endsWith('/') ? path : `${path}/`);
        res.writeHead(201, headers);
        res.end();
        return;
      }
      case 'PUT': {
        files.set(path, Buffer.concat(chunks));
        res.writeHead(201, headers);
        res.end();
        return;
      }
      case 'GET': {
        const body = files.get(path);
        if (body === undefined) {
          res.writeHead(404, headers);
          res.end();
          return;
        }
        res.writeHead(200, {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
        });
        res.end(body);
        return;
      }
      case 'DELETE': {
        files.delete(path);
        res.writeHead(204, headers);
        res.end();
        return;
      }
      default:
        res.writeHead(405, headers);
        res.end();
    }
  });
});

server.listen(port, () => {
  console.log(`qa-e8-fix dav listening on http://localhost:${String(port)}/ (log: ${logPath})`);
});
