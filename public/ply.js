// Streaming PLY reader, shared by the browser worker and ./verify.
//
// The reader pulls the file in chunks, keeps only x/y/z (and RGB when the file
// has it), and returns float32 positions relative to the cloud's centroid so
// that large world coordinates keep their precision on the GPU. Points are
// shuffled, so any prefix of the arrays is a uniform sample of the cloud.

const SCALARS = {
  char: 'Int8', int8: 'Int8',
  uchar: 'Uint8', uint8: 'Uint8',
  short: 'Int16', int16: 'Int16',
  ushort: 'Uint16', uint16: 'Uint16',
  int: 'Int32', int32: 'Int32',
  uint: 'Uint32', uint32: 'Uint32',
  float: 'Float32', float32: 'Float32',
  double: 'Float64', float64: 'Float64',
};
const SIZES = { Int8: 1, Uint8: 1, Int16: 2, Uint16: 2, Int32: 4, Uint32: 4, Float32: 4, Float64: 8 };
const COLOR_NAMES = [
  ['red', 'green', 'blue'],
  ['r', 'g', 'b'],
  ['diffuse_red', 'diffuse_green', 'diffuse_blue'],
];
const HEADER_LIMIT = 1 << 20;
const DEFAULT_CHUNK = 32 << 20;

export class PlyError extends Error {}

export function parseHeader(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, HEADER_LIMIT));
  if (!/^ply[ \t]*\r?\n/.test(head)) {
    throw new PlyError('This is not a PLY file: it does not start with "ply".');
  }
  const end = /(^|\n)end_header[ \t]*(\r?\n|$)/.exec(head);
  if (!end) throw new PlyError('The PLY header never ends (no "end_header" line).');
  const headerLength = end.index + end[0].length;
  const lines = head.slice(0, end.index).split(/\r?\n/);
  let format = null;
  const elements = [];
  const comments = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    if (t[0] === 'format') {
      format = t[1];
      if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) {
        throw new PlyError(`Unsupported PLY format "${format}".`);
      }
    } else if (t[0] === 'element') {
      const count = Number(t[2]);
      if (!Number.isSafeInteger(count) || count < 0) throw new PlyError(`Bad element count in "${line}".`);
      elements.push({ name: t[1], count, props: [] });
    } else if (t[0] === 'property') {
      const el = elements.at(-1);
      if (!el) throw new PlyError(`Property before any element: "${line}".`);
      if (t[1] === 'list') {
        const countType = SCALARS[t[2]];
        const itemType = SCALARS[t[3]];
        if (!countType || !itemType) throw new PlyError(`Unknown property type in "${line}".`);
        el.props.push({ name: t[4], list: true, countType, itemType, typeName: `list ${t[2]} ${t[3]}` });
      } else {
        const type = SCALARS[t[1]];
        if (!type) throw new PlyError(`Unknown property type in "${line}".`);
        el.props.push({ name: t[2], list: false, type, typeName: t[1] });
      }
    } else if (t[0] === 'comment' || t[0] === 'obj_info') {
      comments.push(line.slice(t[0].length).trim());
    }
  }
  if (!format) throw new PlyError('The PLY header has no "format" line.');
  return { format, elements, comments, headerLength };
}

// Collects points; positions are stored relative to the first finite point
// until the centroid is known.
class Builder {
  constructor(capacity, withColor) {
    this.positions = new Float32Array(capacity * 3);
    this.colors = withColor ? new Uint8Array(capacity * 3) : null;
    this.n = 0;
    this.skipped = 0;
    this.anchor = null;
    this.sum = [0, 0, 0];
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
  }

  add(x, y, z, r, g, b) {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
      this.skipped++;
      return;
    }
    if (this.anchor === null) this.anchor = [x, y, z];
    const a = this.anchor;
    const dx = x - a[0], dy = y - a[1], dz = z - a[2];
    const i = this.n * 3;
    this.positions[i] = dx;
    this.positions[i + 1] = dy;
    this.positions[i + 2] = dz;
    if (this.colors) {
      this.colors[i] = r;
      this.colors[i + 1] = g;
      this.colors[i + 2] = b;
    }
    this.sum[0] += dx; this.sum[1] += dy; this.sum[2] += dz;
    const mn = this.min, mx = this.max;
    if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x;
    if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y;
    if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
    this.n++;
  }

  finish(onProgress) {
    const n = this.n;
    if (n === 0) throw new PlyError('The file has no points with finite x, y and z.');
    const shift = this.sum.map((s) => s / n);
    const centroid = this.anchor.map((a, k) => a + shift[k]);
    const p = this.positions.subarray(0, n * 3);
    const c = this.colors ? this.colors.subarray(0, n * 3) : null;
    let radius2 = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = (p[i] -= shift[0]);
      const y = (p[i + 1] -= shift[1]);
      const z = (p[i + 2] -= shift[2]);
      const d = x * x + y * y + z * z;
      if (d > radius2) radius2 = d;
    }
    onProgress('Arranging points', 0.5);
    shuffle(p, c, n);
    return {
      count: n,
      skipped: this.skipped,
      positions: p,
      colors: c,
      centroid,
      min: this.min,
      max: this.max,
      radius: Math.sqrt(radius2),
    };
  }
}

// Fisher-Yates with a fixed seed: deterministic, and every prefix is a
// uniform random sample.
function shuffle(p, c, n) {
  let s = 0x9e3779b9;
  for (let i = n - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    const a = i * 3, b = j * 3;
    let t;
    t = p[a]; p[a] = p[b]; p[b] = t;
    t = p[a + 1]; p[a + 1] = p[b + 1]; p[b + 1] = t;
    t = p[a + 2]; p[a + 2] = p[b + 2]; p[b + 2] = t;
    if (c) {
      t = c[a]; c[a] = c[b]; c[b] = t;
      t = c[a + 1]; c[a + 1] = c[b + 1]; c[b + 1] = t;
      t = c[a + 2]; c[a + 2] = c[b + 2]; c[b + 2] = t;
    }
  }
}

function colorScale(type) {
  if (type === 'Float32' || type === 'Float64') return 255;
  if (type === 'Uint16' || type === 'Int16') return 1 / 257;
  return 1;
}

function findColor(props) {
  for (const names of COLOR_NAMES) {
    const idx = names.map((nm) => props.findIndex((p) => p.name === nm && !p.list));
    if (idx.every((i) => i >= 0)) return idx;
  }
  return null;
}

function toByte(v, scale) {
  const b = Math.round(v * scale);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

// Re-reads from the file when the buffered bytes run out, so the caller only
// ever sees one contiguous chunk.
class Chunks {
  constructor(source, offset, chunkBytes) {
    this.source = source;
    this.chunkBytes = chunkBytes;
    this.base = offset;
    this.buf = new Uint8Array(0);
    this.at = 0;
  }

  get offset() { return this.base + this.at; }
  get available() { return this.buf.length - this.at; }

  async need(n) {
    if (this.available >= n) return true;
    const offset = this.offset;
    const len = Math.min(Math.max(n, this.chunkBytes), this.source.size - offset);
    this.buf = len > 0 ? await this.source.read(offset, len) : new Uint8Array(0);
    this.base = offset;
    this.at = 0;
    return this.available >= n;
  }
}

function scalarReader(type) {
  switch (type) {
    case 'Int8': return (dv, o) => dv.getInt8(o);
    case 'Uint8': return (dv, o) => dv.getUint8(o);
    case 'Int16': return (dv, o, le) => dv.getInt16(o, le);
    case 'Uint16': return (dv, o, le) => dv.getUint16(o, le);
    case 'Int32': return (dv, o, le) => dv.getInt32(o, le);
    case 'Uint32': return (dv, o, le) => dv.getUint32(o, le);
    case 'Float32': return (dv, o, le) => dv.getFloat32(o, le);
    default: return (dv, o, le) => dv.getFloat64(o, le);
  }
}

// Byte length of one record with list properties; -1 if it runs past `end`.
function recordLength(dv, start, end, props, le) {
  let o = start;
  for (const p of props) {
    if (!p.list) {
      o += SIZES[p.type];
      continue;
    }
    const cs = SIZES[p.countType];
    if (o + cs > end) return -1;
    const count = scalarReader(p.countType)(dv, o, le);
    o += cs + count * SIZES[p.itemType];
  }
  return o > end ? -1 : o - start;
}

async function readBinary(source, header, builder, onProgress, chunkBytes) {
  const le = header.format === 'binary_little_endian';
  const chunks = new Chunks(source, header.headerLength, chunkBytes);
  let truncated = false;
  for (const el of header.elements) {
    const isVertex = el.name === 'vertex';
    const fixed = el.props.every((p) => !p.list);
    const stride = fixed ? el.props.reduce((s, p) => s + SIZES[p.type], 0) : 0;
    const offsets = [];
    let off = 0;
    for (const p of el.props) {
      offsets.push(off);
      if (!p.list) off += SIZES[p.type];
    }
    let pick = null;
    if (isVertex) {
      const ix = ['x', 'y', 'z'].map((nm) => el.props.findIndex((p) => p.name === nm));
      const ic = findColor(el.props);
      pick = {
        ix,
        ic,
        read: ix.concat(ic || []).map((i) => scalarReader(el.props[i].type)),
        scale: ic ? colorScale(el.props[ic[0]].type) : 1,
      };
    }

    if (fixed && !isVertex) {
      // Skip a fixed-size element without reading it.
      const skip = el.count * stride;
      if (chunks.offset + skip > source.size) { truncated = true; break; }
      chunks.base = chunks.offset + skip;
      chunks.buf = new Uint8Array(0);
      chunks.at = 0;
      continue;
    }

    let remaining = el.count;
    while (remaining > 0) {
      const want = fixed ? Math.min(remaining, Math.max(1, Math.floor(chunkBytes / stride))) * stride : 1;
      await chunks.need(want);
      const avail = chunks.available;
      if (avail === 0 || (fixed && avail < stride)) { truncated = true; break; }
      const dv = new DataView(chunks.buf.buffer, chunks.buf.byteOffset + chunks.at, avail);
      let o = 0;
      let done = 0;
      while (done < remaining) {
        let len;
        if (fixed) {
          if (o + stride > avail) break;
          len = stride;
        } else {
          len = recordLength(dv, o, avail, el.props, le);
          if (len < 0) break;
        }
        if (pick) {
          let rec = offsets;
          if (!fixed) rec = listOffsets(dv, o, el.props, le);
          const r = pick.read;
          const x = r[0](dv, o + rec[pick.ix[0]], le);
          const y = r[1](dv, o + rec[pick.ix[1]], le);
          const z = r[2](dv, o + rec[pick.ix[2]], le);
          if (pick.ic) {
            const s = pick.scale;
            builder.add(x, y, z,
              toByte(r[3](dv, o + rec[pick.ic[0]], le), s),
              toByte(r[4](dv, o + rec[pick.ic[1]], le), s),
              toByte(r[5](dv, o + rec[pick.ic[2]], le), s));
          } else {
            builder.add(x, y, z, 0, 0, 0);
          }
        }
        o += len;
        done++;
      }
      if (done === 0) {
        // A record larger than the chunk: read it whole on the next pass.
        if (chunks.offset + avail >= source.size) { truncated = true; break; }
        await chunks.need(avail * 2);
        continue;
      }
      chunks.at += o;
      remaining -= done;
      onProgress('Reading points', chunks.offset / source.size);
    }
    if (truncated || isVertex) break;
  }
  return truncated;
}

function listOffsets(dv, start, props, le) {
  const out = [];
  let o = 0;
  for (const p of props) {
    out.push(o);
    if (!p.list) {
      o += SIZES[p.type];
    } else {
      const count = scalarReader(p.countType)(dv, start + o, le);
      o += SIZES[p.countType] + count * SIZES[p.itemType];
    }
  }
  return out;
}

const POW10 = Array.from({ length: 309 }, (_, i) => Number(`1e${i}`));
let P = 0;

// Parses one number at bytes[P], skipping spaces and tabs before it.
function asciiNumber(b, end) {
  let c = b[P];
  while (P < end && (c === 32 || c === 9 || c === 13)) c = b[++P];
  let neg = false;
  if (c === 45) { neg = true; c = b[++P]; } else if (c === 43) { c = b[++P]; }
  let m = 0, digits = 0, exp = 0;
  while (P < end && c >= 48 && c <= 57) { m = m * 10 + (c - 48); digits++; c = b[++P]; }
  if (c === 46) {
    c = b[++P];
    while (P < end && c >= 48 && c <= 57) { m = m * 10 + (c - 48); digits++; exp--; c = b[++P]; }
  }
  if (digits === 0) {
    const start = P;
    while (P < end && b[P] > 32) P++;
    const word = String.fromCharCode(...b.subarray(start, P)).toLowerCase();
    if (word.startsWith('inf')) return neg ? -Infinity : Infinity;
    return NaN;
  }
  if (c === 101 || c === 69) {
    c = b[++P];
    let eneg = false, e = 0;
    if (c === 45) { eneg = true; c = b[++P]; } else if (c === 43) { c = b[++P]; }
    while (P < end && c >= 48 && c <= 57) { e = e * 10 + (c - 48); c = b[++P]; }
    exp += eneg ? -e : e;
  }
  while (P < end && b[P] > 32) P++;
  let v = m;
  if (exp < 0) v = -exp < 309 ? m / POW10[-exp] : m * Math.pow(10, exp);
  else if (exp > 0) v = exp < 309 ? m * POW10[exp] : Infinity;
  return neg ? -v : v;
}

async function readAscii(source, header, builder, onProgress, chunkBytes) {
  const chunks = new Chunks(source, header.headerLength, chunkBytes);
  const vals = [];
  for (const el of header.elements) {
    const isVertex = el.name === 'vertex';
    const ix = ['x', 'y', 'z'].map((nm) => el.props.findIndex((p) => p.name === nm));
    const ic = isVertex ? findColor(el.props) : null;
    const scale = ic ? colorScale(el.props[ic[0]].type) : 1;
    // Only parse as many leading properties as the vertex needs.
    const needed = isVertex ? Math.max(...ix, ...(ic || [])) + 1 : 0;
    let remaining = el.count;
    while (remaining > 0) {
      await chunks.need(chunkBytes);
      const b = chunks.buf;
      if (chunks.available === 0) return true;
      const atEof = chunks.offset + chunks.available >= source.size;
      let end = b.length;
      if (!atEof) {
        end = b.lastIndexOf(10) + 1;
        if (end <= chunks.at) {
          await chunks.need(chunks.available * 2);
          continue;
        }
      }
      P = chunks.at;
      while (remaining > 0) {
        while (P < end && b[P] <= 32) P++;
        if (P >= end) break;
        if (isVertex) {
          for (let k = 0; k < needed; k++) {
            const p = el.props[k];
            if (p.list) {
              const n = asciiNumber(b, end);
              for (let j = 0; j < n; j++) asciiNumber(b, end);
              vals[k] = NaN;
            } else {
              vals[k] = asciiNumber(b, end);
            }
          }
          if (ic) {
            builder.add(vals[ix[0]], vals[ix[1]], vals[ix[2]],
              toByte(vals[ic[0]], scale), toByte(vals[ic[1]], scale), toByte(vals[ic[2]], scale));
          } else {
            builder.add(vals[ix[0]], vals[ix[1]], vals[ix[2]], 0, 0, 0);
          }
        }
        while (P < end && b[P] !== 10) P++;
        P++;
        remaining--;
      }
      chunks.at = Math.min(P, b.length);
      onProgress('Reading points', chunks.offset / source.size);
      if (atEof && remaining > 0 && chunks.available === 0) return true;
    }
    if (isVertex) break;
  }
  return false;
}

// source: { size, read(offset, length) -> Promise<Uint8Array> }
export async function readPly(source, { onProgress = () => {}, chunkBytes = DEFAULT_CHUNK } = {}) {
  const first = await source.read(0, Math.min(source.size, HEADER_LIMIT));
  const header = parseHeader(first);
  const vertex = header.elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new PlyError('This PLY file has no "vertex" element.');
  for (const nm of ['x', 'y', 'z']) {
    const p = vertex.props.find((q) => q.name === nm);
    if (!p || p.list) throw new PlyError(`The vertex element has no "${nm}" property.`);
  }
  const ic = findColor(vertex.props);
  const builder = new Builder(vertex.count, !!ic);
  const read = header.format === 'ascii' ? readAscii : readBinary;
  const truncated = await read(source, header, builder, onProgress, chunkBytes);
  const cloud = builder.finish(onProgress);
  return {
    ...cloud,
    declared: vertex.count,
    truncated,
    format: header.format,
    comments: header.comments,
    properties: vertex.props.map((p) => ({ name: p.name, type: p.typeName })),
    hasColor: !!ic,
  };
}
