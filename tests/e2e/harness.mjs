import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function serveDist(port = 0) {
  const root = path.join(here, 'dist');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

export async function newBrowser() {
  // Phone-sized viewport, and a time zone that is NOT Malawi, to prove dates follow Malawi time.
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles', locale: 'en-GB' });
  // Nothing may leave the machine: only the local test server is reachable.
  await context.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  return { browser, context };
}

export class Results {
  constructor() { this.rows = []; }
  async check(id, name, fn) {
    try { const evidence = await fn(); this.rows.push({ id, name, status: 'PASS', evidence: evidence || '' }); console.log('PASS', id, name); }
    catch (e) { this.rows.push({ id, name, status: 'FAIL', evidence: String(e.message).split('\n')[0] }); console.log('FAIL', id, name, '-', String(e.message).split('\n')[0]); }
  }
  blocked(id, name, why) { this.rows.push({ id, name, status: 'BLOCKED', evidence: why }); console.log('BLOCKED', id, name); }
}
export function expect(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
export function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'mismatch'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }
