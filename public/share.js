// Sharing the open scan with Claude through a temporary session on this
// site. Claude edits it through the MCP endpoint; this page follows along.

const KEY = 'point-cloud-session';
const CHUNK = 8 << 20;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function initShare(app) {
  let token = null;
  let seq = 0;
  let version = null;
  let viewSeq = null;
  let lastShot = null;
  let busy = false;
  let reportTimer = 0;
  let last = null;

  const api = (path, opts = {}) => fetch(path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });

  async function failure(res) {
    let message = `The server answered ${res.status}.`;
    try { message = (await res.json()).error || message; } catch { /* not JSON */ }
    return new Error(message);
  }

  function mode(name, text = '', fraction = 0) {
    $('share-idle').hidden = name !== 'idle';
    $('share-busy').hidden = name !== 'busy';
    $('share-on').hidden = name !== 'on';
    if (name === 'busy') {
      $('share-progress').textContent = text;
      $('share-fill').style.width = `${Math.round(fraction * 100)}%`;
    }
    if (name === 'idle') {
      const c = app.cloud();
      $('share-btn').disabled = !c?.file;
      $('share-idle-note').textContent = c && !c.file ? 'Open the file again here to share it.' : '';
    }
  }

  function remember(t) {
    token = t;
    try {
      if (t) sessionStorage.setItem(KEY, t);
      else sessionStorage.removeItem(KEY);
    } catch { /* storage unavailable */ }
  }

  function renderOn() {
    $('share-code').textContent = token;
    $('share-mcp').textContent = `claude mcp add --transport http point-cloud ${location.origin}/mcp`;
    const lines = [];
    if (last) {
      const by = new Date(last.ends_by).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      lines.push(`Deleted 2 hours after this page and Claude stop using it, and by ${by} at the latest.`);
      if (!last.cloud && last.upload) lines.push(`Claude is uploading a scan: ${Math.round((last.upload.received / last.upload.total) * 100)}%.`);
      else if (!last.cloud) lines.push('No scan in this session yet.');
      const h = last.history.at(-1);
      if (h && h.action !== 'upload') lines.push(`Last change: ${h.summary}`);
    }
    $('share-status').textContent = lines.join(' ');
    mode('on');
  }

  // Reads a binary response into a buffer of known size.
  async function fetchBytes(path, size, onProgress) {
    const res = await api(path);
    if (!res.ok) throw await failure(res);
    const out = new Uint8Array(size);
    const reader = res.body.getReader();
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > size) throw new Error('The server sent more data than expected.');
      out.set(value, at);
      at += value.length;
      onProgress(at / size);
    }
    if (at !== size) throw new Error('The download stopped early.');
    return out;
  }

  async function download(st, keepView) {
    const meta = st.cloud;
    const total = meta.count * (meta.hasColor ? 15 : 12);
    const progress = (done) => (f) => app.progress('Downloading the scan', (done + f * (meta.count * 12)) / total);
    const p = await fetchBytes(`/api/session/cloud?kind=positions&version=${meta.version}`, meta.count * 12, progress(0));
    const c = meta.hasColor
      ? await fetchBytes(`/api/session/cloud?kind=colors&version=${meta.version}`, meta.count * 3, (f) => app.progress('Downloading the scan', (meta.count * 12 + f * meta.count * 3) / total))
      : null;
    app.setCloud({
      ...meta,
      positions: new Float32Array(p.buffer),
      colors: c,
      comments: [],
      properties: null,
      format: null,
      skipped: 0,
      truncated: false,
    }, { name: st.name || 'Shared scan', units: st.units, unitsSource: st.units_source, keepView });
    version = meta.version;
  }

  async function apply(st) {
    seq = st.seq;
    last = st;
    if (st.cloud && st.cloud.version !== version && !busy) {
      const sameScan = version !== null && app.cloud() && st.history.at(-1)?.action !== 'upload';
      await download(st, sameScan);
    } else if (st.cloud && st.units !== app.units()) {
      app.setUnitsFromServer(st.units, st.units_source);
    }
    if (viewSeq === null || st.view.seq < viewSeq) {
      // Commands sent before this page connected are stale.
      viewSeq = st.view.seq;
    } else if (st.view.seq > viewSeq) {
      viewSeq = st.view.seq;
      app.applyView(st.view);
    }
    if (st.shot && st.shot.rid !== lastShot) {
      lastShot = st.shot.rid;
      const blob = await app.snapshot();
      await api(`/api/session/screenshot?rid=${encodeURIComponent(st.shot.rid)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
    }
    renderOn();
  }

  async function poll(mine) {
    while (token === mine) {
      try {
        const res = await api(`/api/session/state?since=${seq}&wait=1`);
        if (token !== mine) return;
        if (res.status === 404) {
          ended('This session has ended, so the scan was deleted from the server. Your view here stays until you reload.');
          return;
        }
        if (!res.ok) throw await failure(res);
        await apply(await res.json());
      } catch {
        await sleep(3000);
      }
    }
  }

  function start(t) {
    remember(t);
    seq = 0;
    viewSeq = null;
    poll(t);
    report();
  }

  function ended(message) {
    remember(null);
    version = null;
    last = null;
    mode('idle');
    if (message) app.showError(message);
  }

  async function upload(file) {
    busy = true;
    try {
      const total = file.size;
      let res;
      for (let off = 0; off < total; off += CHUNK) {
        mode('busy', `Uploading ${Math.round((off / total) * 100)}%`, off / total);
        res = await api(`/api/session/ply?offset=${off}&total=${total}&name=${encodeURIComponent(file.name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file.slice(off, off + CHUNK),
        });
        if (!res.ok) throw await failure(res);
        if (off + CHUNK >= total) mode('busy', 'Preparing the scan on the server', 1);
      }
      const done = await res.json();
      const c = app.cloud();
      // The server reads files with the same code, so it holds the same points.
      if (c && done.cloud.count === c.count) version = done.cloud.version;
      if (done.units !== app.units()) {
        await api('/api/session/units', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: app.units() }),
        });
      }
    } finally {
      busy = false;
    }
  }

  async function share() {
    const c = app.cloud();
    if (!c?.file) return;
    mode('busy', 'Starting a session', 0);
    try {
      const res = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) throw await failure(res);
      const { session } = await res.json();
      remember(session);
      await upload(c.file);
      start(session);
      renderOn();
    } catch (err) {
      if (token) await api('/api/session', { method: 'DELETE' }).catch(() => {});
      ended(`Could not share the scan: ${err.message}`);
    }
  }

  async function connect(t) {
    remember(t);
    mode('busy', 'Connecting to the session', 0);
    try {
      const res = await api('/api/session/state');
      if (res.status === 404) {
        ended('That session has ended or does not exist. Sessions end after 2 hours without activity.');
        return;
      }
      if (!res.ok) throw await failure(res);
      const st = await res.json();
      if (st.cloud) await download(st, false);
      viewSeq = st.view.seq;
      seq = st.seq;
      last = st;
      renderOn();
      poll(t);
      report();
    } catch (err) {
      app.hideProgress();
      mode('idle');
      app.showError(`Could not connect to the session: ${err.message}`);
    }
  }

  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      const body = token && app.viewReport();
      if (!body) return;
      api('/api/session/viewer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    }, 700);
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const was = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = was; }, 1500);
    } catch {
      app.showError('Copying was blocked; select the text and copy it instead.');
    }
  }

  $('share-btn').addEventListener('click', share);
  $('share-end').addEventListener('click', async () => {
    const t = token;
    ended();
    await fetch('/api/session', { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
  });
  $('copy-code').addEventListener('click', (e) => copy(`Use the point-cloud tools with session ${token}.`, e.currentTarget));
  $('copy-mcp').addEventListener('click', (e) => copy($('share-mcp').textContent, e.currentTarget));

  // A link from Claude (#session=...) or a reload of a shared tab.
  const fromLink = /^#session=([0-9a-f]{32})$/.exec(location.hash);
  if (fromLink) history.replaceState(null, '', location.pathname + location.search);
  let stored = null;
  try { stored = sessionStorage.getItem(KEY); } catch { /* storage unavailable */ }
  const resume = fromLink?.[1] || stored;
  if (resume) connect(resume);
  else mode('idle');

  return {
    // A local file finished loading.
    async localLoaded() {
      if (!token) { mode('idle'); return; }
      const file = app.cloud()?.file;
      if (!file) return;
      try {
        await upload(file);
        renderOn();
      } catch (err) {
        app.showError(`Could not send the new file to Claude's session: ${err.message}`);
        renderOn();
      }
    },
    unitsChanged(units) {
      if (!token || busy) return;
      api('/api/session/units', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units }) }).catch(() => {});
    },
    viewChanged() { if (token) report(); },
  };
}
