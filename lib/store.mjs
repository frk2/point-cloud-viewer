// Temporary storage for shared sessions. Everything a session holds lives
// in its rows here and is deleted when the session ends or expires.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

export const CHUNK_POINTS = 1 << 19;
export const UNDO_DEPTH = 2;

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function openStore(path, { now = () => Date.now(), idleMs, maxMs, maxSessions, maxBytes }) {
  const db = new DatabaseSync(path);
  // Must precede table creation for a new file; later runs keep the mode.
  db.exec('PRAGMA auto_vacuum=INCREMENTAL;');
  // A file created elsewhere needs a VACUUM for the mode to take effect.
  if (db.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 2
    && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get()) db.exec('VACUUM;');
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, created INTEGER NOT NULL, touched INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '', units TEXT NOT NULL DEFAULT 'none', units_source TEXT NOT NULL DEFAULT 'size',
  versions TEXT NOT NULL DEFAULT '[]', history TEXT NOT NULL DEFAULT '[]', next_version INTEGER NOT NULL DEFAULT 1,
  upload_total INTEGER NOT NULL DEFAULT 0, upload_received INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS uploads(sid TEXT NOT NULL, off INTEGER NOT NULL, len INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(sid, off));
CREATE TABLE IF NOT EXISTS clouds(sid TEXT NOT NULL, version INTEGER NOT NULL, meta TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(sid, version));
CREATE TABLE IF NOT EXISTS cloud_chunks(sid TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(sid, version, kind, idx));
PRAGMA user_version=1;`);

  const q = (sql) => db.prepare(sql);
  const parse = (row) => row && { ...row, versions: JSON.parse(row.versions), history: JSON.parse(row.history) };

  function usage() {
    const a = q('SELECT COALESCE(SUM(upload_received), 0) AS n FROM sessions').get().n;
    const b = q('SELECT COALESCE(SUM(bytes), 0) AS n FROM clouds').get().n;
    return a + b;
  }

  function ensureRoom(bytes) {
    if (usage() + bytes > maxBytes) {
      throw new StoreError('The server is holding as many scans as it can right now. Try again later or with a smaller file.', 507);
    }
  }

  function deleteVersion(sid, version) {
    q('DELETE FROM cloud_chunks WHERE sid=? AND version=?').run(sid, version);
    q('DELETE FROM clouds WHERE sid=? AND version=?').run(sid, version);
  }

  function deleteSession(sid) {
    q('DELETE FROM cloud_chunks WHERE sid=?').run(sid);
    q('DELETE FROM clouds WHERE sid=?').run(sid);
    q('DELETE FROM uploads WHERE sid=?').run(sid);
    q('DELETE FROM sessions WHERE id=?').run(sid);
  }

  const expiresAt = (s) => Math.min(s.touched + idleMs, s.created + maxMs);

  return {
    db,
    usage,
    expiresAt,
    maxMs,

    create() {
      if (q('SELECT count(*) AS n FROM sessions').get().n >= maxSessions) {
        throw new StoreError('Too many sessions are open right now. Try again later.', 503);
      }
      const token = randomBytes(16).toString('hex');
      const t = now();
      q('INSERT INTO sessions(id, created, touched) VALUES(?, ?, ?)').run(hashToken(token), t, t);
      return token;
    },

    // The session for a token, or null when unknown or expired.
    find(token) {
      if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;
      const s = parse(q('SELECT * FROM sessions WHERE id=?').get(hashToken(token)));
      if (!s) return null;
      if (expiresAt(s) <= now()) {
        deleteSession(s.id);
        return null;
      }
      return s;
    },

    touch(s) {
      s.touched = now();
      q('UPDATE sessions SET touched=? WHERE id=?').run(s.touched, s.id);
    },

    end(s) { deleteSession(s.id); },

    // Deletes expired sessions; returns how many.
    sweep() {
      const t = now();
      const gone = q('SELECT id FROM sessions WHERE touched + ? <= ? OR created + ? <= ?').all(idleMs, t, maxMs, t);
      for (const { id } of gone) deleteSession(id);
      if (gone.length) db.exec('PRAGMA incremental_vacuum;');
      return gone.length;
    },

    setUnits(s, units, source) {
      q('UPDATE sessions SET units=?, units_source=? WHERE id=?').run(units, source, s.id);
      s.units = units;
      s.units_source = source;
    },

    // ---- Uploads: sequential byte ranges of a PLY file ----

    beginUpload(s, total, name, maxUpload) {
      if (!Number.isSafeInteger(total) || total < 1) throw new StoreError('Upload size is missing.');
      if (total > maxUpload) throw new StoreError(`Files up to ${Math.round(maxUpload / 2 ** 20)} MB can be shared.`, 413);
      ensureRoom(total);
      q('DELETE FROM uploads WHERE sid=?').run(s.id);
      q('UPDATE sessions SET upload_total=?, upload_received=0, name=? WHERE id=?').run(total, name, s.id);
      s.upload_total = total;
      s.upload_received = 0;
      s.name = name;
    },

    appendUpload(s, data) {
      if (s.upload_received + data.length > s.upload_total) throw new StoreError('More bytes than the declared file size.');
      q('INSERT INTO uploads(sid, off, len, data) VALUES(?, ?, ?, ?)').run(s.id, s.upload_received, data.length, data);
      s.upload_received += data.length;
      q('UPDATE sessions SET upload_received=? WHERE id=?').run(s.upload_received, s.id);
    },

    uploadSource(s) {
      const rows = q('SELECT off, len, data FROM uploads WHERE sid=? AND off < ? AND off + len > ? ORDER BY off');
      return {
        size: s.upload_received,
        async read(offset, length) {
          const end = Math.min(offset + length, s.upload_received);
          const out = new Uint8Array(Math.max(0, end - offset));
          for (const r of rows.all(s.id, end, offset)) {
            const from = Math.max(offset, r.off);
            const to = Math.min(end, r.off + r.len);
            out.set(r.data.subarray(from - r.off, to - r.off), from - offset);
          }
          return out;
        },
      };
    },

    clearUpload(s) {
      q('DELETE FROM uploads WHERE sid=?').run(s.id);
      q('UPDATE sessions SET upload_total=0, upload_received=0 WHERE id=?').run(s.id);
      s.upload_total = 0;
      s.upload_received = 0;
    },

    // ---- Cloud versions ----

    current(s) { return s.versions.at(-1) ?? null; },

    meta(s, version = s.versions.at(-1)) {
      const row = version && q('SELECT meta FROM clouds WHERE sid=? AND version=?').get(s.id, version);
      return row ? JSON.parse(row.meta) : null;
    },

    // Saves a new current version and trims undo history to the original
    // plus the last UNDO_DEPTH versions.
    save(s, cloud, action, summary) {
      const bytes = cloud.count * (cloud.colors ? 15 : 12);
      ensureRoom(bytes);
      const version = s.next_version;
      const meta = {
        version, count: cloud.count, centroid: cloud.centroid, min: cloud.min, max: cloud.max,
        radius: cloud.radius, hasColor: !!cloud.colors,
      };
      db.exec('BEGIN');
      try {
        const put = q('INSERT INTO cloud_chunks(sid, version, kind, idx, data) VALUES(?, ?, ?, ?, ?)');
        for (let i = 0, idx = 0; i < cloud.count; i += CHUNK_POINTS, idx++) {
          const n = Math.min(CHUNK_POINTS, cloud.count - i);
          const p = cloud.positions.subarray(i * 3, (i + n) * 3);
          put.run(s.id, version, 'p', idx, new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
          if (cloud.colors) put.run(s.id, version, 'c', idx, cloud.colors.subarray(i * 3, (i + n) * 3));
        }
        q('INSERT INTO clouds(sid, version, meta, bytes) VALUES(?, ?, ?, ?)').run(s.id, version, JSON.stringify(meta), bytes);
        s.versions.push(version);
        while (s.versions.length > UNDO_DEPTH + 2) deleteVersion(s.id, s.versions.splice(1, 1)[0]);
        s.history.push({ version, action, summary, at: new Date(now()).toISOString() });
        if (s.history.length > 50) s.history.splice(0, s.history.length - 50);
        q('UPDATE sessions SET versions=?, history=?, next_version=? WHERE id=?')
          .run(JSON.stringify(s.versions), JSON.stringify(s.history), version + 1, s.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      s.next_version = version + 1;
      return meta;
    },

    load(s, version = s.versions.at(-1)) {
      const meta = this.meta(s, version);
      if (!meta) throw new StoreError('This session has no scan yet. Upload one first.', 409);
      const positions = new Float32Array(meta.count * 3);
      const colors = meta.hasColor ? new Uint8Array(meta.count * 3) : null;
      for (const r of q('SELECT kind, idx, data FROM cloud_chunks WHERE sid=? AND version=? ORDER BY kind, idx').iterate(s.id, version)) {
        const at = r.idx * CHUNK_POINTS * 3;
        // Blobs may not be 4-byte aligned, so copy them as bytes.
        if (r.kind === 'p') new Uint8Array(positions.buffer).set(r.data, at * 4);
        else colors.set(r.data, at);
      }
      return { ...meta, positions, colors };
    },

    *chunks(s, version, kind) {
      for (const r of q('SELECT data FROM cloud_chunks WHERE sid=? AND version=? AND kind=? ORDER BY idx').iterate(s.id, version, kind)) {
        yield r.data;
      }
    },

    // A new upload replaces every version of the previous scan.
    clearClouds(s) {
      for (const v of s.versions) deleteVersion(s.id, v);
      s.versions = [];
      s.history = [];
      q('UPDATE sessions SET versions=?, history=? WHERE id=?').run('[]', '[]', s.id);
    },

    undo(s) {
      if (s.versions.length < 2) throw new StoreError('There is nothing to undo.', 409);
      const dropped = s.versions.pop();
      deleteVersion(s.id, dropped);
      s.history.push({ version: s.versions.at(-1), action: 'undo', summary: `Undid version ${dropped}.`, at: new Date(now()).toISOString() });
      q('UPDATE sessions SET versions=?, history=? WHERE id=?').run(JSON.stringify(s.versions), JSON.stringify(s.history), s.id);
      return this.meta(s);
    },

    reset(s) {
      if (s.versions.length < 2) throw new StoreError('The scan is already the original.', 409);
      for (const v of s.versions.splice(1)) deleteVersion(s.id, v);
      s.history.push({ version: s.versions[0], action: 'reset', summary: 'Back to the original upload.', at: new Date(now()).toISOString() });
      q('UPDATE sessions SET versions=?, history=? WHERE id=?').run(JSON.stringify(s.versions), JSON.stringify(s.history), s.id);
      return this.meta(s);
    },
  };
}
