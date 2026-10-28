import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPly, parseHeader, PlyError } from './public/ply.js';
import { OrbitCamera, axisFrame, viewOrientation, quatRotate, mat4Mul, dot } from './public/camera.js';

const enc = new TextEncoder();

function source(bytes) {
  return { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) };
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Deterministic points far from the world origin, like a robot-frame scan.
function makePoints(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push([1000.25 + Math.sin(i) * 0.5, -300.5 + Math.cos(i * 1.3) * 0.25, 42 + (i % 17) * 0.01]);
  }
  return pts;
}

function binary(pts, { le = true, type = 'double', color = false, before = '', beforeBytes = new Uint8Array(0), after = '', afterBytes = new Uint8Array(0) } = {}) {
  const size = type === 'double' ? 8 : 4;
  const stride = size * 3 + (color ? 3 : 0);
  const header = enc.encode(
    `ply\nformat binary_${le ? 'little' : 'big'}_endian 1.0\ncomment test\n${before}element vertex ${pts.length}\n` +
    `property ${type} x\nproperty ${type} y\nproperty ${type} z\n` +
    (color ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '') +
    `${after}end_header\n`);
  const body = new Uint8Array(pts.length * stride);
  const dv = new DataView(body.buffer);
  pts.forEach((p, i) => {
    for (let k = 0; k < 3; k++) {
      if (size === 8) dv.setFloat64(i * stride + k * 8, p[k], le);
      else dv.setFloat32(i * stride + k * 4, p[k], le);
    }
    if (color) for (let k = 0; k < 3; k++) dv.setUint8(i * stride + size * 3 + k, (i * 7 + k * 50) % 256);
  });
  return concat(header, beforeBytes, body, afterBytes);
}

function mean(pts) {
  return [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
}

// Puts the returned points back in world coordinates, sorted for comparison.
function worldPoints(cloud) {
  const out = [];
  for (let i = 0; i < cloud.count; i++) {
    out.push([0, 1, 2].map((k) => cloud.positions[i * 3 + k] + cloud.centroid[k]));
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

function assertSamePoints(cloud, pts, tol) {
  const got = worldPoints(cloud);
  const want = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  assert.equal(got.length, want.length);
  for (let i = 0; i < got.length; i++) {
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[i][k] - want[i][k]) < tol, `point ${i} axis ${k}: ${got[i][k]} vs ${want[i][k]}`);
  }
}

test('binary little-endian doubles keep precision far from the world origin', async () => {
  const pts = makePoints(5000);
  const cloud = await readPly(source(binary(pts)));
  assert.equal(cloud.count, 5000);
  assert.equal(cloud.format, 'binary_little_endian');
  assert.equal(cloud.hasColor, false);
  const c = mean(pts);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(cloud.centroid[k] - c[k]) < 1e-9);
  assertSamePoints(cloud, pts, 1e-6);
  assert.deepEqual(cloud.min, [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))));
  assert.deepEqual(cloud.max, [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]))));
});

test('small chunks give the same result as one large chunk', async () => {
  const pts = makePoints(3001);
  const bytes = binary(pts, { color: true });
  const a = await readPly(source(bytes));
  const b = await readPly(source(bytes), { chunkBytes: 97 });
  assert.deepEqual(Array.from(b.positions), Array.from(a.positions));
  assert.deepEqual(Array.from(b.colors), Array.from(a.colors));
});

test('big-endian floats with colours, after a fixed element and before faces', async () => {
  const pts = makePoints(400);
  const before = 'element camera 2\nproperty float a\nproperty uchar b\n';
  const beforeBytes = new Uint8Array(10).fill(0xff);
  const after = 'element face 1\nproperty list uchar int vertex_indices\n';
  const afterBytes = new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2]);
  const cloud = await readPly(source(binary(pts, { le: false, type: 'float', color: true, before, beforeBytes, after, afterBytes })), { chunkBytes: 64 });
  assert.equal(cloud.count, 400);
  assert.equal(cloud.hasColor, true);
  assertSamePoints(cloud, pts.map((p) => p.map(Math.fround)), 1e-3);
  // Colour sums survive the shuffle.
  const sum = Array.from(cloud.colors).reduce((s, v) => s + v, 0);
  const want = pts.reduce((s, _, i) => s + [0, 1, 2].reduce((t, k) => t + ((i * 7 + k * 50) % 256), 0), 0);
  assert.equal(sum, want);
});

test('a list element before the vertices is skipped', async () => {
  const pts = makePoints(50);
  const before = 'element tag 2\nproperty list uchar uchar name\n';
  const beforeBytes = new Uint8Array([2, 65, 66, 3, 67, 68, 69]);
  const cloud = await readPly(source(binary(pts, { before, beforeBytes })), { chunkBytes: 16 });
  assert.equal(cloud.count, 50);
  assertSamePoints(cloud, pts, 1e-6);
});

test('ASCII with CRLF, comments, extra properties, a NaN point and faces', async () => {
  const text = [
    'ply', 'format ascii 1.0', 'comment made by hand', 'element vertex 5',
    'property float x', 'property float y', 'property float z', 'property float intensity',
    'property uchar red', 'property uchar green', 'property uchar blue',
    'element face 1', 'property list uchar int vertex_indices', 'end_header',
    '1 2 3 0.5 255 0 0', '-1.5e1 +2.25 3E-1 0.1 0 255 0', 'nan 0 0 0 1 1 1',
    '  4\t5   6 0 0 0 255', '', '7 8 9 1 10 20 30', '3 0 1 2', '',
  ].join('\r\n');
  const cloud = await readPly(source(enc.encode(text)), { chunkBytes: 23 });
  assert.equal(cloud.count, 4);
  assert.equal(cloud.skipped, 1);
  assert.equal(cloud.format, 'ascii');
  assertSamePoints(cloud, [[1, 2, 3], [-15, 2.25, 0.3], [4, 5, 6], [7, 8, 9]], 1e-5);
  const sum = Array.from(cloud.colors).reduce((s, v) => s + v, 0);
  assert.equal(sum, 255 * 3 + 60);
});

test('a truncated file returns the points it has and says so', async () => {
  const pts = makePoints(100);
  const bytes = binary(pts);
  const cloud = await readPly(source(bytes.subarray(0, bytes.length - 24 * 10 - 5)));
  assert.equal(cloud.truncated, true);
  assert.equal(cloud.count, 89);
  assert.equal(cloud.declared, 100);
});

test('every prefix is a spread-out sample after shuffling', async () => {
  const pts = makePoints(20000).map((p, i) => [i, 0, 0]);
  const cloud = await readPly(source(binary(pts)));
  let lowHalf = 0;
  for (let i = 0; i < 1000; i++) if (cloud.positions[i * 3] + cloud.centroid[0] < 10000) lowHalf++;
  assert.ok(lowHalf > 400 && lowHalf < 600, `first 1000 points: ${lowHalf} from the lower half`);
});

test('bad files fail with a readable message', async () => {
  await assert.rejects(readPly(source(enc.encode('hello'))), PlyError);
  await assert.rejects(readPly(source(enc.encode('ply\nformat ascii 1.0\nelement face 0\nend_header\n'))), /no "vertex"/);
  await assert.rejects(readPly(source(enc.encode('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nend_header\n1 2\n'))), /"z"/);
  await assert.rejects(readPly(source(enc.encode('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n'))), /end_header/);
  await assert.rejects(readPly(source(enc.encode('ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nend_header\n'))), /no points/);
  assert.equal(parseHeader(enc.encode('ply\nformat ascii 1.0\nelement vertex 2\nproperty double x\nend_header\n')).elements[0].count, 2);
});

test('the fitted view puts every point inside the viewport', async () => {
  const pts = makePoints(2000);
  const cloud = await readPly(source(binary(pts)));
  for (const up of ['+z', '+y', '-x']) {
    for (const view of ['iso', 'top', 'front', 'side']) {
      const cam = new OrbitCamera();
      const frame = axisFrame(up);
      cam.worldUp = frame.up;
      cam.q = viewOrientation(view, frame);
      const aspect = 16 / 9;
      cam.distance = cam.fitDistance(cloud.positions, cloud.count, aspect);
      const { right, up: u, back } = cam.axes();
      assert.ok(Math.abs(dot(right, u)) < 1e-9 && Math.abs(dot(u, back)) < 1e-9, 'orthonormal');
      const m = mat4Mul(cam.projection(aspect, cloud.radius), cam.view());
      let worst = 0;
      for (let i = 0; i < cloud.count; i++) {
        const [x, y, z] = [0, 1, 2].map((k) => cloud.positions[i * 3 + k]);
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
        const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
        const nz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
        assert.ok(nz > -1 && nz < 1, `point ${i} is clipped in depth (${up} ${view})`);
        worst = Math.max(worst, Math.abs(nx), Math.abs(ny));
      }
      assert.ok(worst <= 1 && worst > 0.85, `${up} ${view}: widest point at ${worst}`);
    }
  }
});

test('top view looks down the up axis', () => {
  const frame = axisFrame('+z');
  const q = viewOrientation('top', frame);
  const back = quatRotate(q, [0, 0, 1]);
  assert.ok(Math.abs(back[2] - 1) < 1e-9);
});

test('the page loads only its own files and carries the account badge', () => {
  const html = readFileSync('public/index.html', 'utf8');
  assert.match(html, /<title>Point Cloud Viewer<\/title>/);
  assert.match(html, /<emptyos-badge><\/emptyos-badge>\s*<\/header>/);
  assert.match(html, /<script src="\/_system\/app\/badge.js" defer><\/script>/);
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^[a-z]+:|^\/\//i.test(m[1]), `external reference ${m[1]}`);
  }
});

test('the bundled sample scan parses with its known centroid', async () => {
  const bytes = new Uint8Array(readFileSync('public/samples/roi-world.ply'));
  const cloud = await readPly(source(bytes));
  assert.equal(cloud.count, 437863);
  const want = [0.0127419064, -0.2967952111, 0.2412388697];
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(cloud.centroid[k] - want[k]) < 1e-9);
});
