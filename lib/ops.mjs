// Point operations for shared sessions.
//
// A cloud is { count, centroid, positions, colors } where positions are
// float32 offsets from the double-precision centroid, in file units, and
// colors are RGB bytes or null. Callers speak in "coordinate units": the
// file's units scaled by `f` (millimetres per file unit, or 1 when unknown).
// Every edit returns a new cloud through finalize(), which recentres it.

export class OpError extends Error {}

const vec = (v, name) => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new OpError(`${name} must be three numbers [x, y, z].`);
  }
  return v;
};
const positive = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new OpError(`${name} must be a positive number.`);
  return v;
};

// Coordinates in caller units -> offsets from the centroid in file units.
const toRel = (c, cloud, f) => [0, 1, 2].map((k) => c[k] / f - cloud.centroid[k]);

export function finalize(positions, colors, count, centroid) {
  if (count === 0) throw new OpError('That would remove every point. Nothing was changed.');
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < count * 3; i += 3) { sx += positions[i]; sy += positions[i + 1]; sz += positions[i + 2]; }
  const shift = [sx / count, sy / count, sz / count];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let r2 = 0;
  for (let i = 0; i < count * 3; i += 3) {
    for (let k = 0; k < 3; k++) {
      const w = centroid[k] + positions[i + k];
      if (w < min[k]) min[k] = w;
      if (w > max[k]) max[k] = w;
      positions[i + k] -= shift[k];
    }
    const d = positions[i] ** 2 + positions[i + 1] ** 2 + positions[i + 2] ** 2;
    if (d > r2) r2 = d;
  }
  return {
    count,
    positions,
    colors,
    centroid: centroid.map((c, k) => c + shift[k]),
    min,
    max,
    radius: Math.sqrt(r2),
  };
}

function keepWhere(cloud, keep) {
  const { positions: p, colors: c, count: n } = cloud;
  const mask = new Uint8Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) if (keep(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], i)) { mask[i] = 1; kept++; }
  const np = new Float32Array(kept * 3);
  const nc = c ? new Uint8Array(kept * 3) : null;
  for (let i = 0, j = 0; i < n; i++) {
    if (!mask[i]) continue;
    np[j * 3] = p[i * 3]; np[j * 3 + 1] = p[i * 3 + 1]; np[j * 3 + 2] = p[i * 3 + 2];
    if (nc) { nc[j * 3] = c[i * 3]; nc[j * 3 + 1] = c[i * 3 + 1]; nc[j * 3 + 2] = c[i * 3 + 2]; }
    j++;
  }
  return { cloud: finalize(np, nc, kept, cloud.centroid), removed: n - kept };
}

function keepMode(keep, a, b) {
  if (keep === undefined || keep === a) return true;
  if (keep === b) return false;
  throw new OpError(`keep must be "${a}" or "${b}".`);
}

export function cropBox(cloud, f, { min, max, keep }) {
  const lo = toRel(vec(min, 'min'), cloud, f);
  const hi = toRel(vec(max, 'max'), cloud, f);
  const inside = keepMode(keep, 'inside', 'outside');
  return keepWhere(cloud, (x, y, z) => {
    const isIn = x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
    return isIn === inside;
  });
}

export function cropSphere(cloud, f, { center, radius, keep }) {
  const c = toRel(vec(center, 'center'), cloud, f);
  const r = positive(radius, 'radius') / f;
  const r2 = r * r;
  const inside = keepMode(keep, 'inside', 'outside');
  return keepWhere(cloud, (x, y, z) => ((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= r2) === inside);
}

export function cropPlane(cloud, f, { point, normal, keep }) {
  const p0 = toRel(vec(point, 'point'), cloud, f);
  const nv = vec(normal, 'normal');
  const len = Math.hypot(...nv);
  if (!len) throw new OpError('normal must not be zero.');
  const n = nv.map((v) => v / len);
  const front = keepMode(keep, 'front', 'back');
  return keepWhere(cloud, (x, y, z) => ((x - p0[0]) * n[0] + (y - p0[1]) * n[1] + (z - p0[2]) * n[2] >= 0) === front);
}

// The points are stored shuffled, so the first `count` are a uniform sample.
export function downsampleRandom(cloud, { count }) {
  if (!Number.isInteger(count) || count < 1) throw new OpError('count must be a positive whole number.');
  if (count >= cloud.count) return { cloud, removed: 0 };
  return keepWhere(cloud, (x, y, z, i) => i < count);
}

// Open-addressing set of voxel keys packed into doubles (17 bits per axis).
const AXIS = 2 ** 17;
function voxelKeys(cloud, size) {
  const { positions: p, count: n } = cloud;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < lo[k]) lo[k] = p[i + k];
      if (p[i + k] > hi[k]) hi[k] = p[i + k];
    }
  }
  for (let k = 0; k < 3; k++) {
    if ((hi[k] - lo[k]) / size >= AXIS - 2) throw new OpError('That size is too small for this cloud: it would need more than 131,000 cells along one axis.');
  }
  // One cell of padding on each side so neighbours never wrap.
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ix = Math.floor((p[i * 3] - lo[0]) / size) + 1;
    const iy = Math.floor((p[i * 3 + 1] - lo[1]) / size) + 1;
    const iz = Math.floor((p[i * 3 + 2] - lo[2]) / size) + 1;
    keys[i] = (ix * AXIS + iy) * AXIS + iz;
  }
  return keys;
}

class KeyTable {
  constructor() {
    this.alloc(1 << 16);
  }

  alloc(cap) {
    this.mask = cap - 1;
    this.keys = new Float64Array(cap).fill(-1);
    this.vals = new Int32Array(cap);
    this.size = 0;
  }

  // Doubles the table once it is 60% full.
  grow() {
    const { keys, vals } = this;
    this.alloc(keys.length * 2);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === -1) continue;
      const s = this.slot(keys[i]);
      this.keys[s] = keys[i];
      this.vals[s] = vals[i];
      this.size++;
    }
  }

  slot(key) {
    const lo = key % 4294967296;
    const hi = Math.floor(key / 4294967296);
    // murmur3 finalizer: every input bit reaches the low (masked) bits.
    let h = lo ^ Math.imul(hi, 0x9e3779b1);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    let s = h & this.mask;
    while (this.keys[s] !== -1 && this.keys[s] !== key) s = (s + 1) & this.mask;
    return s;
  }

  // Returns the existing value, or stores `value` and returns -1.
  add(key, value) {
    if (this.size + 1 > this.keys.length * 0.6) this.grow();
    const s = this.slot(key);
    if (this.keys[s] === key) return this.vals[s];
    this.keys[s] = key;
    this.vals[s] = value;
    this.size++;
    return -1;
  }

  get(key) {
    const s = this.slot(key);
    return this.keys[s] === key ? this.vals[s] : -1;
  }
}

// Keeps one point per cubic cell (a random one, since points are shuffled).
export function voxelDownsample(cloud, f, { voxel_size }) {
  const size = positive(voxel_size, 'voxel_size') / f;
  const keys = voxelKeys(cloud, size);
  const table = new KeyTable();
  return keepWhere(cloud, (x, y, z, i) => table.add(keys[i], i) === -1);
}

// Removes points with fewer than `min_neighbors` other points within `radius`.
export function removeSparse(cloud, f, { radius, min_neighbors }) {
  const r = positive(radius, 'radius') / f;
  if (!Number.isInteger(min_neighbors) || min_neighbors < 1 || min_neighbors > 1000) {
    throw new OpError('min_neighbors must be a whole number from 1 to 1000.');
  }
  const { positions: p, count: n } = cloud;
  // Group points by cell of size `radius`, with a copy of their positions in
  // cell order so each neighbour scan reads memory in sequence.
  let keys = voxelKeys(cloud, r);
  const table = new KeyTable();
  const cellOf = new Int32Array(n);
  const cellKey = [];
  for (let i = 0; i < n; i++) {
    const found = table.add(keys[i], cellKey.length);
    if (found === -1) {
      cellOf[i] = cellKey.length;
      cellKey.push(keys[i]);
    } else {
      cellOf[i] = found;
    }
  }
  keys = null;
  const cells = cellKey.length;
  const start = new Int32Array(cells + 1);
  for (let i = 0; i < n; i++) start[cellOf[i] + 1]++;
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cells);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[cellOf[i]]++] = i;
  const sp = new Float32Array(n * 3);
  for (let j = 0; j < n; j++) {
    const i = order[j];
    sp[j * 3] = p[i * 3]; sp[j * 3 + 1] = p[i * 3 + 1]; sp[j * 3 + 2] = p[i * 3 + 2];
  }
  // Own cell first, then faces, edges and corners: likeliest neighbours first.
  const offsets = [];
  for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) offsets.push([dx, dy, dz]);
  offsets.sort((a, b) => a.reduce((s, v) => s + Math.abs(v), 0) - b.reduce((s, v) => s + Math.abs(v), 0));
  const deltas = offsets.map(([dx, dy, dz]) => (dx * AXIS + dy) * AXIS + dz);
  const r2 = r * r;
  const keep = new Uint8Array(n);
  const near = new Int32Array(27);
  for (let c = 0; c < cells; c++) {
    let m = 0;
    for (const d of deltas) {
      const cc = table.get(cellKey[c] + d);
      if (cc >= 0) near[m++] = cc;
    }
    for (let j = start[c], e = start[c + 1]; j < e; j++) {
      const x = sp[j * 3], y = sp[j * 3 + 1], z = sp[j * 3 + 2];
      let found = 0;
      scan: for (let t = 0; t < m; t++) {
        for (let k = start[near[t]], ke = start[near[t] + 1]; k < ke; k++) {
          if (k === j) continue;
          const dx = sp[k * 3] - x, dy = sp[k * 3 + 1] - y, dz = sp[k * 3 + 2] - z;
          if (dx * dx + dy * dy + dz * dz <= r2 && ++found >= min_neighbors) break scan;
        }
      }
      if (found >= min_neighbors) keep[order[j]] = 1;
    }
  }
  return keepWhere(cloud, (x, y, z, i) => keep[i] === 1);
}

function rotation([rx, ry, rz]) {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const X = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Y = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Z = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
  return mul(Z, mul(Y, X));
}

// Either a 4x4 `matrix` (rows, translation in coordinate units) or
// scale -> rotate_deg (about X, then Y, then Z) about `pivot` -> translate.
export function transform(cloud, f, { matrix, translate, rotate_deg, scale, pivot }) {
  const C = cloud.centroid;
  let A, b;
  if (matrix !== undefined) {
    if (!Array.isArray(matrix) || matrix.length !== 4 || !matrix.every((row) => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite))) {
      throw new OpError('matrix must be 4 rows of 4 numbers.');
    }
    A = matrix.slice(0, 3).map((row) => row.slice(0, 3));
    b = matrix.slice(0, 3).map((row) => row[3] / f);
  } else {
    const s = scale === undefined ? 1 : positive(scale, 'scale');
    const R = rotation(rotate_deg === undefined ? [0, 0, 0] : vec(rotate_deg, 'rotate_deg'));
    A = R.map((row) => row.map((v) => v * s));
    const pv = pivot === undefined || pivot === 'centroid' ? C : vec(pivot, 'pivot').map((v) => v / f);
    const t = translate === undefined ? [0, 0, 0] : vec(translate, 'translate').map((v) => v / f);
    // x' = A (x - pivot) + pivot + t
    b = [0, 1, 2].map((k) => pv[k] + t[k] - (A[k][0] * pv[0] + A[k][1] * pv[1] + A[k][2] * pv[2]));
  }
  // With x = C + p: x' - C = A p + (A C + b - C).
  const off = [0, 1, 2].map((k) => A[k][0] * C[0] + A[k][1] * C[1] + A[k][2] * C[2] + b[k] - C[k]);
  const { positions: p, count: n } = cloud;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = A[0][0] * x + A[0][1] * y + A[0][2] * z + off[0];
    out[i + 1] = A[1][0] * x + A[1][1] * y + A[1][2] * z + off[1];
    out[i + 2] = A[2][0] * x + A[2][1] * y + A[2][2] * z + off[2];
  }
  return { cloud: finalize(out, cloud.colors, n, C), removed: 0 };
}

// ---- Read-only queries ------------------------------------------------------

function boxFilter(cloud, f, box) {
  if (!box) return () => true;
  const lo = toRel(vec(box.min, 'box.min'), cloud, f);
  const hi = toRel(vec(box.max, 'box.max'), cloud, f);
  return (x, y, z) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
}

const round = (v, f) => Number(v.toPrecision(f));

export function samplePoints(cloud, f, { count = 500, box }) {
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new OpError('count must be a whole number from 1 to 5000.');
  const inBox = boxFilter(cloud, f, box);
  const { positions: p, colors: c, count: n, centroid: C } = cloud;
  const points = [];
  for (let i = 0; i < n && points.length < count; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    if (!inBox(x, y, z)) continue;
    const pt = [(C[0] + x) * f, (C[1] + y) * f, (C[2] + z) * f].map((v) => round(v, 9));
    if (c) pt.push(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
    points.push(pt);
  }
  return { points, columns: c ? ['x', 'y', 'z', 'r', 'g', 'b'] : ['x', 'y', 'z'] };
}

export function histogram(cloud, f, { axis = 'z', bins = 50, box }) {
  if (!Number.isInteger(bins) || bins < 1 || bins > 200) throw new OpError('bins must be a whole number from 1 to 200.');
  const unit = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const dir = typeof axis === 'string' ? unit[axis] : vec(axis, 'axis');
  if (!dir) throw new OpError('axis must be "x", "y", "z" or a direction [x, y, z].');
  const len = Math.hypot(...dir);
  const d = dir.map((v) => v / len);
  const base = (cloud.centroid[0] * d[0] + cloud.centroid[1] * d[1] + cloud.centroid[2] * d[2]) * f;
  const inBox = boxFilter(cloud, f, box);
  const { positions: p, count: n } = cloud;
  const vals = new Float64Array(n);
  let m = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    if (!inBox(x, y, z)) continue;
    const v = base + (x * d[0] + y * d[1] + z * d[2]) * f;
    vals[m++] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const counts = new Array(bins).fill(0);
  if (m === 0) return { count: 0, counts, min: null, max: null, bin_width: null };
  const w = (hi - lo) / bins || 1;
  for (let i = 0; i < m; i++) counts[Math.min(bins - 1, Math.floor((vals[i] - lo) / w))]++;
  return { count: m, min: round(lo, 9), max: round(hi, 9), bin_width: round(w, 9), counts };
}

// Symmetric 3x3 eigen-decomposition (Jacobi). Returns ascending eigenpairs.
function eigen(M) {
  const a = M.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => x.value - y.value);
}

// Count, bounds, centroid and principal axes; the smallest axis is the
// normal of the best-fit plane.
export function stats(cloud, f, { box } = {}) {
  const inBox = boxFilter(cloud, f, box);
  const { positions: p, count: n, centroid: C } = cloud;
  let m = 0;
  const s = [0, 0, 0];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    if (!inBox(x, y, z)) continue;
    m++;
    s[0] += x; s[1] += y; s[2] += z;
    if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
    if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
    if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
  }
  if (m === 0) return { count: 0 };
  const mu = s.map((v) => v / m);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    if (!inBox(x, y, z)) continue;
    const d = [x - mu[0], y - mu[1], z - mu[2]];
    for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) cov[a][b] += d[a] * d[b];
  }
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] = (a <= b ? cov[a][b] : cov[b][a]) / m;
  const eig = eigen(cov);
  const world = (rel) => rel.map((v, k) => round((C[k] + v) * f, 9));
  return {
    count: m,
    centroid: world(mu),
    min: world(lo),
    max: world(hi),
    size: hi.map((v, k) => round((v - lo[k]) * f, 9)),
    principal_axes: eig.slice().reverse().map((e) => ({
      direction: e.vector.map((v) => round(v, 6)),
      std_dev: round(Math.sqrt(Math.max(0, e.value)) * f, 6),
    })),
    plane_normal: eig[0].vector.map((v) => round(v, 6)),
    plane_rms: round(Math.sqrt(Math.max(0, eig[0].value)) * f, 6),
  };
}
