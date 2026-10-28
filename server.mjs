// Point Cloud Viewer: serves the viewer, and holds temporary shared sessions
// that Claude can work on through the MCP endpoint at /mcp.

import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, StoreError } from './lib/store.mjs';
import { createService } from './lib/service.mjs';
import { handleRpc } from './lib/mcp.mjs';
import { OpError } from './lib/ops.mjs';
import { UNITS } from './public/units.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const MB = 2 ** 20;
export const LIMITS = {
  idleMs: 2 * 3600e3,
  maxMs: 24 * 3600e3,
  maxSessions: 40,
  maxBytes: 4096 * MB,
  maxUpload: 1024 * MB,
  maxPoints: 10e6,
  pollMs: 20000,
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ply': 'application/octet-stream',
};

// Everything under public/ is served; nothing else is.
function listPublic(dir, prefix = '') {
  const out = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, listPublic(full, `${prefix}${name}/`));
    else if (TYPES[extname(name)]) out[`/${prefix}${name}`] = full;
  }
  return out;
}

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createApp({ dbPath, now, limits = LIMITS } = {}) {
  const store = openStore(dbPath, { now, ...limits });
  const service = createService(store, { ...limits, now });
  const files = listPublic(join(root, 'public'));
  const samplePath = join(root, 'public/samples/roi-world.ply');
  const sample = async () => new Uint8Array(await readFile(samplePath));

  const baseUrl = (req) => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    return `${local ? 'http' : 'https'}://${host}`;
  };

  // EmptyOS keeps the Authorization header for itself, so the session code
  // travels in its own header.
  const codeOf = (req) => String(req.headers['x-point-cloud-session'] || '');

  function session(req) {
    const s = store.find(codeOf(req));
    if (!s) throw new HttpError('Unknown or expired session.', 404);
    store.touch(s);
    return s;
  }

  async function readJson(req, max = 64 * 1024) {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError('Send JSON.', 415);
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > max) throw new HttpError('This request is too large.', 413);
    }
    try {
      return JSON.parse(body || '{}');
    } catch {
      throw new HttpError('Invalid JSON.');
    }
  }

  async function readBytes(req, max) {
    const parts = [];
    let n = 0;
    for await (const chunk of req) {
      n += chunk.length;
      if (n > max) throw new HttpError('This request is too large.', 413);
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  }

  async function writeAll(res, chunks) {
    for (const c of chunks) {
      if (!res.write(c)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }

  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };

  // Streams the body into the session's upload in 4 MB rows.
  async function upload(req, res, s, url) {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const length = Number(req.headers['content-length']);
    const total = Number(url.searchParams.get('total') ?? length);
    if (offset === 0) {
      service.beginUpload(s, total, url.searchParams.get('name') || 'scan.ply');
    } else if (!s.upload_total || offset !== s.upload_received) {
      json(res, { error: 'Upload out of order.', received: s.upload_received }, 409);
      req.resume();
      return;
    }
    let buf = [];
    let n = 0;
    for await (const chunk of req) {
      buf.push(chunk);
      n += chunk.length;
      if (n >= 4 * MB) {
        service.appendUpload(s, Buffer.concat(buf));
        buf = [];
        n = 0;
      }
    }
    if (n) service.appendUpload(s, Buffer.concat(buf));
    if (s.upload_received < s.upload_total) {
      json(res, { received: s.upload_received, total: s.upload_total });
      return;
    }
    const meta = await service.finishUpload(s);
    json(res, { received: s.upload_total, total: s.upload_total, cloud: meta, units: s.units, units_source: s.units_source });
  }

  async function exportPly(res, s) {
    const cloud = await service.exclusive(() => service.current(s));
    const { count, positions: p, colors: c, centroid: C } = cloud;
    const unitLine = UNITS[s.units]?.mm ? `comment units ${s.units}\n` : '';
    const header = `ply\nformat binary_little_endian 1.0\ncomment exported by Point Cloud Viewer\n${unitLine}element vertex ${count}\n`
      + 'property double x\nproperty double y\nproperty double z\n'
      + (c ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '') + 'end_header\n';
    const stride = c ? 27 : 24;
    const name = (s.name || 'scan.ply').replace(/\.ply$/i, '').replace(/[^\w.-]+/g, '_') || 'scan';
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}-edited.ply"`,
      'Content-Length': Buffer.byteLength(header) + count * stride,
      'Cache-Control': 'no-store',
    });
    function* rows() {
      yield Buffer.from(header);
      const step = 65536;
      for (let i = 0; i < count; i += step) {
        const n = Math.min(step, count - i);
        const b = Buffer.allocUnsafe(n * stride);
        for (let j = 0; j < n; j++) {
          const k = (i + j) * 3, o = j * stride;
          b.writeDoubleLE(C[0] + p[k], o);
          b.writeDoubleLE(C[1] + p[k + 1], o + 8);
          b.writeDoubleLE(C[2] + p[k + 2], o + 16);
          if (c) { b[o + 24] = c[k]; b[o + 25] = c[k + 1]; b[o + 26] = c[k + 2]; }
        }
        yield b;
      }
    }
    await writeAll(res, rows());
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    if ((method === 'GET' || method === 'HEAD') && (files[path] || path === '/')) {
      const file = files[path === '/' ? '/index.html' : path];
      const body = readFileSync(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)],
        'Content-Length': body.length,
        'Cache-Control': path.startsWith('/samples/') ? 'public, max-age=86400' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(method === 'HEAD' ? undefined : body);
      return;
    }

    if (path === '/mcp') {
      if (method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }
      const msg = await readJson(req, 1 * MB);
      const ctx = { service, store, baseUrl: baseUrl(req), sample };
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map((m) => handleRpc(m, ctx)))).filter(Boolean);
        if (!out.length) { res.writeHead(202); res.end(); return; }
        json(res, out);
        return;
      }
      const out = await handleRpc(msg, ctx);
      if (!out) { res.writeHead(202); res.end(); return; }
      json(res, out);
      return;
    }

    if (method === 'POST' && path === '/api/sessions') {
      await readJson(req);
      const token = store.create();
      json(res, { session: token, expires_at: store.expiresAt(store.find(token)) }, 201);
      return;
    }

    if (!path.startsWith('/api/session')) throw new HttpError('Not found.', 404);
    const s = session(req);

    if (method === 'GET' && path === '/api/session/state') {
      const since = Number(url.searchParams.get('since'));
      service.seen(s);
      if (url.searchParams.get('wait')) {
        await service.waitForChange(s, since, limits.pollMs);
        const again = store.find(codeOf(req));
        if (!again) throw new HttpError('This session has ended.', 404);
        json(res, service.state(again));
        return;
      }
      json(res, service.state(s));
      return;
    }
    if (method === 'PUT' && path === '/api/session/ply') {
      await upload(req, res, s, url);
      return;
    }
    if (method === 'GET' && path === '/api/session/cloud') {
      const kind = url.searchParams.get('kind') === 'colors' ? 'c' : 'p';
      const version = Number(url.searchParams.get('version'));
      const meta = store.meta(s, version);
      if (!meta || (kind === 'c' && !meta.hasColor)) throw new HttpError('That version is no longer stored.', 404);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': meta.count * (kind === 'p' ? 12 : 3),
        'Cache-Control': 'no-store',
      });
      await writeAll(res, store.chunks(s, version, kind));
      return;
    }
    if (method === 'GET' && path === '/api/session/export.ply') {
      await exportPly(res, s);
      return;
    }
    if (method === 'POST' && path === '/api/session/units') {
      const body = await readJson(req);
      json(res, service.setUnits(s, body.units));
      return;
    }
    if (method === 'POST' && path === '/api/session/viewer') {
      service.reportViewer(s, await readJson(req, 4096));
      json(res, { ok: true });
      return;
    }
    if (method === 'POST' && path === '/api/session/screenshot') {
      const type = String(req.headers['content-type']);
      if (type !== 'image/jpeg' && type !== 'image/png') throw new HttpError('Send a JPEG or PNG.', 415);
      service.deliverScreenshot(s, url.searchParams.get('rid'), await readBytes(req, 8 * MB), type);
      json(res, { ok: true });
      return;
    }
    if (method === 'DELETE' && path === '/api/session') {
      service.end(s);
      json(res, { ended: true });
      return;
    }
    throw new HttpError('Not found.', 404);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      const status = err.status || (err instanceof OpError ? 400 : 500);
      if (status === 500) console.error(err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      req.resume();
      json(res, { error: status === 500 ? 'Something went wrong on the server.' : err.message }, status);
    }
  });
  server.requestTimeout = 0;

  const sweeper = setInterval(() => service.sweep(), 60e3);
  sweeper.unref();
  service.sweep();
  server.on('close', () => clearInterval(sweeper));
  return { server, store, service };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.POINT_CLOUD_TEST_DB || process.env.EMPTYOS_DATASET_POINT_CLOUD_VIEWER_DATA;
  if (!dbPath) throw new Error('EMPTYOS_DATASET_POINT_CLOUD_VIEWER_DATA is required. Tests may use POINT_CLOUD_TEST_DB.');
  const { server } = createApp({ dbPath });
  server.listen(Number(process.env.PORT) || 4351, '127.0.0.1');
}
