import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, LIMITS } from './server.mjs';
import { readPly } from './public/ply.js';
import * as ops from './lib/ops.mjs';

const dir = mkdtempSync(join(tmpdir(), 'point-cloud-test-'));
let clock = Date.UTC(2026, 9, 28, 12);
let app, base;

before(async () => {
  app = createApp({
    dbPath: join(dir, 'test.db'),
    now: () => clock,
    limits: { ...LIMITS, maxPoints: 500000, maxSessions: 5, pollMs: 200 },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  app.store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function rpc(method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

async function tool(name, args = {}) {
  const { result } = await rpc('tools/call', { name, arguments: args });
  const text = result.content.find((c) => c.type === 'text')?.text;
  if (result.isError) return { error: text };
  try { return JSON.parse(text); } catch { return { text, result }; }
}

const auth = (token) => ({ 'X-Point-Cloud-Session': token });

function ply(points) {
  const head = `ply\nformat binary_little_endian 1.0\ncomment units mm\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
  const body = Buffer.alloc(points.length * 12);
  points.forEach((p, i) => p.forEach((v, k) => body.writeFloatLE(v, i * 12 + k * 4)));
  return Buffer.concat([Buffer.from(head), body]);
}

// A 10 x 10 x 10 grid of points 1 mm apart, from 0 to 9 mm.
const grid = [];
for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) for (let z = 0; z < 10; z++) grid.push([x, y, z]);

test('MCP handshake lists the tools', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'point-cloud-viewer');
  const note = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const list = await rpc('tools/list');
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['create_session', 'crop_box', 'remove_sparse', 'transform', 'screenshot', 'set_view', 'end_session']) assert.ok(names.includes(n), n);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await rpc('nope')).error.code, -32601);
});

test('session endpoints refuse unknown or malformed codes', async () => {
  assert.equal((await fetch(`${base}/api/session/state`)).status, 404);
  assert.equal((await fetch(`${base}/api/session/state`, { headers: auth('0'.repeat(32)) })).status, 404);
  assert.equal((await fetch(`${base}/api/session/export.ply`, { headers: auth('x') })).status, 404);
  assert.match((await tool('get_info', { session: 'f'.repeat(32) })).error, /Unknown or expired/);
  assert.match((await tool('get_info', { session: '../etc' })).error, /Unknown or expired/);
});

test('chunked upload, edits, undo, export and end', async () => {
  const { session } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.match(session, /^[0-9a-f]{32}$/);
  const file = ply(grid);
  const half = 1000;
  let res = await fetch(`${base}/api/session/ply?offset=0&total=${file.length}&name=grid%0A.ply`, { method: 'PUT', headers: auth(session), body: file.subarray(0, half) });
  assert.deepEqual(await res.json(), { received: half, total: file.length });
  res = await fetch(`${base}/api/session/ply?offset=5&total=${file.length}`, { method: 'PUT', headers: auth(session), body: file.subarray(5) });
  assert.equal(res.status, 409);
  res = await fetch(`${base}/api/session/ply?offset=${half}&total=${file.length}`, { method: 'PUT', headers: auth(session), body: file.subarray(half) });
  const done = await res.json();
  assert.equal(done.cloud.count, 1000);
  assert.equal(done.units, 'mm');
  assert.equal(done.units_source, 'comment');

  const info = await tool('get_info', { session });
  assert.equal(info.name, 'grid.ply', 'control characters are stripped from names');
  assert.deepEqual(info.size, [9, 9, 9]);
  assert.equal(info.coordinate_unit, 'mm');

  const crop = await tool('crop_box', { session, min: [-0.5, -0.5, -0.5], max: [4.5, 9.5, 9.5] });
  assert.equal(crop.points, 500);
  const sphere = await tool('crop_sphere', { session, center: [0, 0, 0], radius: 1.5, keep: 'outside' });
  assert.equal(sphere.points, 500 - 7);
  const stats = await tool('stats', { session, box: { min: [-0.5, -0.5, 8.5], max: [4.5, 9.5, 9.5] } });
  assert.deepEqual(stats.plane_normal.map((v) => Math.abs(Math.round(v))), [0, 0, 1]);
  assert.ok(stats.plane_rms < 1e-6);
  const hist = await tool('histogram', { session, axis: 'x', bins: 5 });
  assert.equal(hist.counts.reduce((a, b) => a + b, 0), 493);
  const sample = await tool('sample_points', { session, count: 3 });
  assert.equal(sample.points.length, 3);

  assert.equal((await tool('revert', { session })).points, 500);
  assert.equal((await tool('revert', { session, to: 'original' })).points, 1000);
  assert.match((await tool('revert', { session })).error, /nothing to undo/);

  const moved = await tool('transform', { session, translate: [100, 0, 0], rotate_deg: [0, 0, 90] });
  assert.equal(moved.points, 1000);
  const after = await tool('get_info', { session });
  assert.deepEqual(after.min.map((v) => Math.round(v * 1e3) / 1e3), [100, 0, 0]);
  assert.deepEqual(after.max.map((v) => Math.round(v * 1e3) / 1e3), [109, 9, 9]);

  const exported = new Uint8Array(await (await fetch(`${base}/api/session/export.ply`, { headers: auth(session) })).arrayBuffer());
  const back = await readPly({ size: exported.length, read: async (o, l) => exported.subarray(o, o + l) });
  assert.equal(back.count, 1000);
  assert.deepEqual(back.comments.includes('units mm'), true);
  assert.ok(Math.abs(back.min[0] - 100) < 1e-4 && Math.abs(back.max[1] - 9) < 1e-4);

  const meta = after;
  const positions = await fetch(`${base}/api/session/cloud?kind=positions&version=${meta.version}`, { headers: auth(session) });
  assert.equal(Number(positions.headers.get('content-length')), 12000);

  assert.deepEqual(await tool('end_session', { session }), { ended: true });
  assert.equal((await fetch(`${base}/api/session/state`, { headers: auth(session) })).status, 404);
  for (const t of ['sessions', 'uploads', 'clouds', 'cloud_chunks']) {
    assert.equal(app.store.db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test('the viewer long-poll wakes for view commands and screenshots', async () => {
  const { session } = await tool('create_session');
  await tool('load_sample', { session });
  const state = await (await fetch(`${base}/api/session/state`, { headers: auth(session) })).json();
  assert.equal(state.cloud.count, 437863);
  const waiting = fetch(`${base}/api/session/state?since=${state.seq}&wait=1`, { headers: auth(session) }).then((r) => r.json());
  const sent = await tool('set_view', { session, view: 'top', point_size: 4, origin: [10, -300, 240] });
  assert.equal(sent.viewer_connected, true);
  const woke = await waiting;
  assert.equal(woke.view.view, 'top');
  assert.equal(woke.view.pointSize, 4);
  assert.ok(Math.abs(woke.view.origin[0] - 0.01) < 1e-12, 'origin is sent in file units');

  const shot = rpc('tools/call', { name: 'screenshot', arguments: { session } });
  let st;
  for (let i = 0; i < 20; i++) {
    st = await (await fetch(`${base}/api/session/state`, { headers: auth(session) })).json();
    if (st.shot) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const res = await fetch(`${base}/api/session/screenshot?rid=${st.shot.rid}`, { method: 'POST', headers: { ...auth(session), 'Content-Type': 'image/jpeg' }, body: jpeg });
  assert.equal(res.status, 200);
  const { result } = await shot;
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].data, jpeg.toString('base64'));
  assert.equal((await fetch(`${base}/api/session/screenshot?rid=nope`, { method: 'POST', headers: { ...auth(session), 'Content-Type': 'image/jpeg' }, body: jpeg })).status, 404);
  await tool('end_session', { session });
});

test('sessions expire after two idle hours and limits hold', async () => {
  const a = await tool('create_session');
  await tool('load_sample', { session: a.session });
  clock += 2 * 3600e3 + 1;
  assert.ok(app.service.sweep() >= 1);
  assert.match((await tool('get_info', { session: a.session })).error, /Unknown or expired/);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM cloud_chunks').get().n, 0);

  const b = await tool('create_session');
  const big = ply(Array.from({ length: 500001 }, (_, i) => [i, 0, 0]));
  const res = await fetch(`${base}/api/session/ply?name=big.ply`, { method: 'PUT', headers: auth(b.session), body: big });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /up to 500,000 points/);

  const made = [b.session];
  for (let i = 0; i < 4; i++) made.push((await tool('create_session')).session);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
  for (const s of made) await tool('end_session', { session: s });
});

test('the server serves only the viewer files', async () => {
  for (const path of ['/', '/app.js', '/share.js', '/samples/roi-world.ply']) {
    assert.equal((await fetch(base + path)).status, 200, path);
  }
  for (const path of ['/server.mjs', '/lib/ops.mjs', '/../server.mjs', '/test.db', '/thing.yaml']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('point operations', () => {
  const positions = new Float32Array(grid.flat());
  const cloud = ops.finalize(positions, null, grid.length, [0, 0, 0]);
  // A stray point far from the grid.
  const withStray = ops.finalize(new Float32Array([...grid.flat(), 50, 50, 50]), null, grid.length + 1, [0, 0, 0]);
  assert.equal(ops.removeSparse(withStray, 1, { radius: 1.01, min_neighbors: 3 }).removed, 1);
  assert.equal(ops.voxelDownsample(cloud, 1, { voxel_size: 2 }).cloud.count, 125);
  assert.equal(ops.cropPlane(cloud, 1, { point: [0, 0, 4.5], normal: [0, 0, 1] }).cloud.count, 500);
  assert.equal(ops.downsampleRandom(cloud, { count: 10 }).cloud.count, 10);
  assert.throws(() => ops.cropBox(cloud, 1, { min: [-1, -1, -1], max: [10, 10, 10], keep: 'outside' }), /every point/);
  assert.throws(() => ops.voxelDownsample(cloud, 1, { voxel_size: 1e-6 }), /too small/);
  // Units: coordinates in mm on a cloud stored in metres.
  const metres = ops.finalize(new Float32Array(grid.flat().map((v) => v / 1000)), null, grid.length, [0, 0, 0]);
  assert.equal(ops.cropBox(metres, 1000, { min: [-0.5, -0.5, -0.5], max: [4.5, 9.5, 9.5] }).cloud.count, 500);
});
