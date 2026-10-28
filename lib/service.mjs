// Shared-session behaviour used by both the HTTP API and the MCP tools.

import { randomBytes } from 'node:crypto';
import { readPly, parseHeader, PlyError } from '../public/ply.js';
import { UNITS, guessUnits } from '../public/units.js';
import * as ops from './ops.mjs';
import { StoreError } from './store.mjs';

export const VIEWS = ['iso', 'top', 'front', 'side'];
export const COLOR_MODES = ['rgb', 'height', 'x', 'y', 'z', 'solid'];
export const UP_AXES = ['+z', '-z', '+y', '-y', '+x', '-x'];

export function createService(store, { maxPoints, maxUpload, screenshotMs = 15000, now = () => Date.now() }) {
  const lives = new Map();
  // One heavy job at a time keeps memory bounded.
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  // The most recently used cloud, so queries don't reload it.
  let cached = null;

  function live(s) {
    let l = lives.get(s.id);
    if (!l) {
      l = { seq: 1, view: { seq: 0 }, shot: null, shots: new Map(), seen: 0, polling: 0, viewer: null, waiters: new Set() };
      lives.set(s.id, l);
    }
    return l;
  }

  function bump(s) {
    const l = live(s);
    l.seq++;
    for (const w of l.waiters) w();
    l.waiters.clear();
  }

  const factor = (s) => UNITS[s.units]?.mm ?? 1;
  const coordinateUnit = (s) => (UNITS[s.units]?.mm ? 'mm' : 'file units');

  function current(s) {
    const version = store.current(s);
    if (!version) throw new StoreError('This session has no scan yet. Upload one or call load_sample.', 409);
    if (cached && cached.sid === s.id && cached.version === version) return cached.cloud;
    cached = null;
    const cloud = store.load(s, version);
    cached = { sid: s.id, version, cloud };
    return cloud;
  }

  function viewerConnected(s) {
    const l = live(s);
    return l.polling > 0 || now() - l.seen < 25000;
  }

  function info(s, baseUrl, token) {
    const meta = store.meta(s);
    const f = factor(s);
    const w = (v) => v && v.map((x) => Number((x * f).toPrecision(10)));
    return {
      session: token,
      name: s.name || null,
      status: meta ? 'ready' : s.upload_total ? 'uploading' : 'empty',
      points: meta?.count ?? 0,
      has_color: meta?.hasColor ?? false,
      file_units: s.units,
      file_units_source: s.units_source,
      coordinate_unit: coordinateUnit(s),
      centroid: w(meta?.centroid),
      min: w(meta?.min),
      max: w(meta?.max),
      size: meta ? meta.max.map((v, k) => Number(((v - meta.min[k]) * f).toPrecision(10))) : null,
      version: meta?.version ?? null,
      can_undo: s.versions.length > 1,
      history: s.history.slice(-10),
      viewer_connected: viewerConnected(s),
      viewer: live(s).viewer,
      expires_at: new Date(store.expiresAt(s)).toISOString(),
      viewer_link: `${baseUrl}/#session=${token}`,
      export_command: `curl -H "X-Point-Cloud-Session: ${token}" ${baseUrl}/api/session/export.ply -o scan.ply`,
      upload_command: `curl -T scan.ply -H "X-Point-Cloud-Session: ${token}" -H "Origin: ${baseUrl}" "${baseUrl}/api/session/ply?name=scan.ply"`,
    };
  }

  // State polled by the viewer.
  function state(s) {
    const l = live(s);
    const meta = store.meta(s);
    return {
      seq: l.seq,
      name: s.name,
      units: s.units,
      units_source: s.units_source,
      cloud: meta,
      upload: s.upload_total ? { received: s.upload_received, total: s.upload_total } : null,
      history: s.history.slice(-10),
      view: l.view,
      shot: l.shot,
      expires_at: store.expiresAt(s),
      ends_by: s.created + store.maxMs,
    };
  }

  function waitForChange(s, since, ms) {
    const l = live(s);
    if (since !== l.seq) return Promise.resolve();
    return new Promise((resolve) => {
      l.polling++;
      const done = () => {
        clearTimeout(timer);
        l.waiters.delete(done);
        l.polling--;
        l.seen = now();
        resolve();
      };
      const timer = setTimeout(done, ms);
      l.waiters.add(done);
    });
  }

  function seen(s) { live(s).seen = now(); }

  // ---- Uploads ----

  function beginUpload(s, total, name) {
    store.clearUpload(s);
    store.beginUpload(s, total, cleanName(name), maxUpload);
    bump(s);
  }

  function appendUpload(s, data) { store.appendUpload(s, data); }

  // Parses a complete upload and makes it the session's scan.
  function finishUpload(s) {
    return exclusive(async () => {
      try {
        const source = store.uploadSource(s);
        const header = parseHeader(await source.read(0, Math.min(source.size, 1 << 20)));
        const vertex = header.elements.find((e) => e.name === 'vertex');
        if (vertex && vertex.count > maxPoints) {
          throw new StoreError(`Shared scans can have up to ${maxPoints.toLocaleString('en-US')} points; this one has ${vertex.count.toLocaleString('en-US')}.`, 413);
        }
        const cloud = await readPly(source);
        const extent = Math.max(...cloud.max.map((v, k) => v - cloud.min[k]));
        const guess = guessUnits(cloud.comments, extent);
        cached = null;
        store.clearClouds(s);
        store.setUnits(s, guess.unit, guess.source);
        const meta = store.save(s, cloud, 'upload', `Loaded ${s.name || 'scan'} (${cloud.count.toLocaleString('en-US')} points).`);
        return meta;
      } catch (err) {
        if (err instanceof PlyError) throw new StoreError(err.message);
        throw err;
      } finally {
        store.clearUpload(s);
        bump(s);
      }
    });
  }

  async function loadBytes(s, bytes, name) {
    beginUpload(s, bytes.length, name);
    for (let i = 0; i < bytes.length; i += 4 << 20) appendUpload(s, bytes.subarray(i, i + (4 << 20)));
    return finishUpload(s);
  }

  // ---- Edits ----

  const EDITS = {
    crop_box: (c, f, a) => ops.cropBox(c, f, a),
    crop_sphere: (c, f, a) => ops.cropSphere(c, f, a),
    crop_plane: (c, f, a) => ops.cropPlane(c, f, a),
    remove_sparse: (c, f, a) => ops.removeSparse(c, f, a),
    transform: (c, f, a) => ops.transform(c, f, a),
    downsample: (c, f, a) => {
      if (a.method === 'voxel') return ops.voxelDownsample(c, f, a);
      if (a.method === 'random') return ops.downsampleRandom(c, a);
      throw new ops.OpError('method must be "voxel" or "random".');
    },
  };

  function edit(s, name, args) {
    return exclusive(() => {
      const before = current(s);
      const { cloud, removed } = EDITS[name](before, factor(s), args);
      if (cloud === before) return { changed: false, points: before.count, message: 'Nothing to change.' };
      const summary = name === 'transform'
        ? `transform: ${cloud.count.toLocaleString('en-US')} points moved.`
        : `${name}: removed ${removed.toLocaleString('en-US')} points, ${cloud.count.toLocaleString('en-US')} left.`;
      const meta = store.save(s, cloud, name, summary);
      cached = { sid: s.id, version: meta.version, cloud: { ...meta, positions: cloud.positions, colors: cloud.colors } };
      bump(s);
      return { changed: true, summary, points: cloud.count, removed, version: meta.version };
    });
  }

  function revert(s, to) {
    return exclusive(() => {
      const meta = to === 'original' ? store.reset(s) : store.undo(s);
      cached = null;
      bump(s);
      return { version: meta.version, points: meta.count, summary: s.history.at(-1).summary };
    });
  }

  const QUERIES = {
    stats: (c, f, a) => ops.stats(c, f, a),
    histogram: (c, f, a) => ops.histogram(c, f, a),
    sample_points: (c, f, a) => ops.samplePoints(c, f, a),
  };

  function query(s, name, args) {
    return exclusive(() => ({ coordinate_unit: coordinateUnit(s), ...QUERIES[name](current(s), factor(s), args) }));
  }

  function setUnits(s, units, source = 'set') {
    if (!UNITS[units]) throw new StoreError(`units must be one of ${Object.keys(UNITS).join(', ')}.`);
    store.setUnits(s, units, source);
    bump(s);
    return { file_units: units, coordinate_unit: coordinateUnit(s) };
  }

  // ---- Viewer control ----

  function setView(s, args) {
    const v = {};
    const meta = store.meta(s);
    if (args.origin !== undefined) {
      if (!meta) throw new StoreError('Load a scan before moving the origin.', 409);
      if (!Array.isArray(args.origin) || args.origin.length !== 3 || !args.origin.every(Number.isFinite)) {
        throw new StoreError('origin must be three numbers [x, y, z].');
      }
      v.origin = args.origin.map((x) => x / factor(s));
    }
    if (args.view !== undefined) {
      if (!VIEWS.includes(args.view)) throw new StoreError(`view must be one of ${VIEWS.join(', ')}.`);
      v.view = args.view;
    }
    if (args.point_size !== undefined) {
      if (!Number.isFinite(args.point_size) || args.point_size < 1 || args.point_size > 16) throw new StoreError('point_size must be from 1 to 16.');
      v.pointSize = args.point_size;
    }
    if (args.color_mode !== undefined) {
      if (!COLOR_MODES.includes(args.color_mode)) throw new StoreError(`color_mode must be one of ${COLOR_MODES.join(', ')}.`);
      v.colorMode = args.color_mode;
    }
    if (args.up_axis !== undefined) {
      if (!UP_AXES.includes(args.up_axis)) throw new StoreError(`up_axis must be one of ${UP_AXES.join(', ')}.`);
      v.upAxis = args.up_axis;
    }
    if (args.zoom !== undefined) {
      if (!Number.isFinite(args.zoom) || args.zoom <= 0) throw new StoreError('zoom must be a positive number.');
      v.zoom = args.zoom;
    }
    if (args.fit) v.fit = true;
    if (args.reset) v.reset = true;
    if (!Object.keys(v).length) throw new StoreError('Give at least one view setting to change.');
    const l = live(s);
    l.view = { seq: l.view.seq + 1, ...v };
    bump(s);
    return { sent: true, viewer_connected: viewerConnected(s) };
  }

  function reportViewer(s, body) {
    const l = live(s);
    l.seen = now();
    const f = factor(s);
    const num = (v) => (Number.isFinite(v) ? Number(v.toPrecision(8)) : null);
    l.viewer = {
      origin: Array.isArray(body.origin) ? body.origin.slice(0, 3).map((v) => num(v * f)) : null,
      looking_along: Array.isArray(body.forward) ? body.forward.slice(0, 3).map(num) : null,
      screen_up: Array.isArray(body.up) ? body.up.slice(0, 3).map(num) : null,
      distance: num(body.distance * f),
      visible_height: num(body.visibleHeight * f),
      point_size: num(body.pointSize),
      color_mode: COLOR_MODES.includes(body.colorMode) ? body.colorMode : null,
      up_axis: UP_AXES.includes(body.upAxis) ? body.upAxis : null,
    };
  }

  async function screenshot(s) {
    if (!viewerConnected(s)) {
      throw new StoreError('No viewer is open for this session. Ask the user to open the viewer link, then try again.', 409);
    }
    const l = live(s);
    const rid = randomBytes(8).toString('hex');
    l.shot = { rid };
    bump(s);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          l.shots.delete(rid);
          reject(new StoreError('The viewer did not send a picture in time. It may be in a background tab.', 504));
        }, screenshotMs);
        l.shots.set(rid, (img) => { clearTimeout(timer); resolve(img); });
      });
    } finally {
      if (l.shot?.rid === rid) l.shot = null;
    }
  }

  function deliverScreenshot(s, rid, data, mimeType) {
    const l = live(s);
    const done = l.shots.get(rid);
    if (!done) throw new StoreError('No picture was requested.', 404);
    l.shots.delete(rid);
    done({ data, mimeType });
  }

  function end(s) {
    if (cached?.sid === s.id) cached = null;
    store.end(s);
    const l = lives.get(s.id);
    if (l) {
      l.seq++;
      for (const w of l.waiters) w();
      lives.delete(s.id);
    }
  }

  function sweep() {
    const n = store.sweep();
    for (const id of lives.keys()) {
      if (!store.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)) {
        const l = lives.get(id);
        for (const w of l.waiters) w();
        lives.delete(id);
        if (cached?.sid === id) cached = null;
      }
    }
    return n;
  }

  return {
    exclusive, live, bump, seen, info, state, waitForChange, factor, coordinateUnit,
    beginUpload, appendUpload, finishUpload, loadBytes, edit, revert, query, setUnits,
    setView, reportViewer, screenshot, deliverScreenshot, end, sweep, current,
    EDITS: Object.keys(EDITS),
  };
}

export function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}
