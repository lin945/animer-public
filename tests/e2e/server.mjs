// Static dist server only: no Worker bindings, database, proxy or external fetch.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeaders, headersForPath } from './static-headers.mjs';
const root = fileURLToPath(new URL('../../dist', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain', '.md': 'text/plain' };
await stat(resolve(root, 'index.html'));
const headerRules = parseHeaders(await readFile(resolve(root, '_headers'), 'utf8'));
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) { res.writeHead(500); res.end('Unmocked API request'); return; }
    let path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if (!extname(pathname)) path = resolve(root, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { ...headersForPath(headerRules, pathname), 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173, '127.0.0.1');
