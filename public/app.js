import { OrbitCamera, axisFrame, viewOrientation, slerp, mat4Mul, add, scale, dot } from './camera.js';
import { Renderer } from './renderer.js';
import { UNITS, guessUnits, niceLength, formatLength } from './units.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const stage = $('stage');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const settings = {
  size: 2,
  round: false,
  mode: 'height',
  adaptive: true,
  showOrigin: true,
  up: '+z',
  units: 'm',
};

let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  showError(err.message);
}

const camera = new OrbitCamera();
let cloud = null;
let worker = null;
let ranges = null;
let background = [0, 0, 0];
let solid = [1, 1, 1];

// ---- Loading ---------------------------------------------------------------

function openFile(file) {
  if (!file) return;
  hideError();
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  showProgress('Reading points', 0);
  const name = file.name;
  const size = file.size;
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      showProgress(data.phase, data.fraction);
    } else if (data.type === 'done') {
      worker.terminate();
      worker = null;
      showProgress('Sending points to the graphics card', 1);
      // Let the progress text paint before the upload blocks the thread.
      requestAnimationFrame(() => setTimeout(() => setCloud(data.cloud, name, size)));
    } else {
      worker.terminate();
      worker = null;
      hideProgress();
      showError(`${name}: ${data.message}`);
    }
  };
  worker.onerror = (e) => {
    hideProgress();
    showError(`Could not read this file: ${e.message || 'the reader stopped unexpectedly'}.`);
  };
  worker.postMessage({ file });
}

function setCloud(c, name, size) {
  if (!renderer) return;
  renderer.upload(c);
  const err = renderer.gl.getError();
  if (err === renderer.gl.OUT_OF_MEMORY) {
    hideProgress();
    showError('The graphics card ran out of memory for this many points.');
    return;
  }
  cloud = { ...c, name, size };
  $('filename').textContent = name;
  document.title = `${name} · Point Cloud Viewer`;
  budget = Math.min(cloud.count, 6e6);
  hideProgress();
  $('empty').hidden = true;
  const rgb = $('color-mode').querySelector('option[value="rgb"]');
  rgb.disabled = !cloud.hasColor;
  settings.mode = cloud.hasColor ? 'rgb' : 'height';
  $('color-mode').value = settings.mode;
  const extent = Math.max(...cloud.max.map((v, k) => v - cloud.min[k]));
  const guess = guessUnits(cloud.comments, extent);
  setUnits(guess.unit, guess.source === 'comment'
    ? 'Read from a comment in the file.'
    : 'PLY files don\'t record units; this is a guess from the cloud\'s size. Change it if it\'s wrong.');
  updateRanges();
  if (cloud.truncated) {
    showError(`The file ended early: read ${fmtInt(cloud.count + cloud.skipped)} of ${fmtInt(cloud.declared)} declared points.`);
  }
  resetView(false);
  canvas.focus({ preventScroll: true });
}

// ---- View ------------------------------------------------------------------

function frame() { return axisFrame(settings.up); }

function aspect() { return canvas.clientWidth / Math.max(1, canvas.clientHeight); }

function minDistance() { return Math.max(cloud ? cloud.radius * 1e-5 : 0, 1e-9); }

function fitDistance(q, target) {
  if (!cloud) return 1;
  const probe = new OrbitCamera();
  probe.q = q;
  probe.target = target;
  probe.fovy = camera.fovy;
  const d = probe.fitDistance(cloud.positions, cloud.count, aspect());
  return d > minDistance() ? d : Math.max(cloud.radius, 1);
}

function resetView(animate = true) {
  camera.worldUp = frame().up;
  const q = viewOrientation('iso', frame());
  const target = [0, 0, 0];
  moveTo({ target, q, distance: fitDistance(q, target) }, animate);
}

function fit() {
  moveTo({ ...camera.state, distance: fitDistance(camera.q, camera.target) });
}

function setView(name) {
  moveTo({ ...camera.state, q: viewOrientation(name, frame()) });
}

// Moves the origin to `p` (cloud coordinates) without turning the camera:
// the view slides sideways so the new origin sits at the centre.
function setOrigin(p) {
  const eye = camera.eye();
  const back = camera.axes().back;
  const depth = -dot(add(p, eye, -1), back);
  moveTo({ ...camera.state, target: p, distance: depth > minDistance() ? depth : camera.distance });
}

let anim = null;
function moveTo(state, animate = true) {
  if (!animate || reducedMotion.matches) {
    anim = null;
    camera.state = state;
    onCameraChange();
  } else {
    anim = { from: camera.state, to: state, start: performance.now(), ms: 320 };
  }
  requestDraw();
}

function stepAnimation(now) {
  if (!anim) return false;
  const t = Math.min(1, (now - anim.start) / anim.ms);
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const { from: a, to: b } = anim;
  camera.state = {
    target: add(a.target, add(b.target, a.target, -1), e),
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * e),
    q: slerp(a.q, b.q, e),
  };
  if (t >= 1) anim = null;
  onCameraChange();
  return !!anim;
}

function onCameraChange() {
  if (!cloud) return;
  const dec = decimals();
  const world = camera.target.map((v, k) => (v + cloud.centroid[k]) * shownScale());
  ['ox', 'oy', 'oz'].forEach((id, k) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = world[k].toFixed(dec);
  });
}

// ---- Drawing ---------------------------------------------------------------

let pending = false;
let interactingUntil = 0;
let budget = 6e6;
let lastFrame = 0;
let lastWasMoving = false;
let fps = 0;
let hudAt = 0;
let drawn = 0;

function requestDraw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(draw);
}

function interacted() {
  interactingUntil = performance.now() + 180;
  requestDraw();
}

function draw(now) {
  pending = false;
  if (!renderer) return;
  renderer.resize();
  const animating = stepAnimation(now);
  const moving = animating || now < interactingUntil;
  const total = cloud ? cloud.count : 0;

  if (moving && lastWasMoving) {
    const dt = now - lastFrame;
    fps = fps ? fps * 0.8 + (1000 / dt) * 0.2 : 1000 / dt;
    if (settings.adaptive && cloud) {
      if (dt > 34) budget = Math.max(2.5e5, budget * 0.75);
      else if (dt < 20) budget = Math.min(total, budget * 1.1 + 1e4);
    }
  }
  lastFrame = now;
  lastWasMoving = moving;
  drawn = moving && settings.adaptive ? Math.min(total, Math.round(budget)) : total;

  const view = camera.view();
  const proj = camera.projection(aspect(), cloud ? cloud.radius + Math.hypot(...camera.target) : 1);
  const mvp = mat4Mul(proj, view);
  const r = ranges ? ranges[settings.mode] : null;
  renderer.draw({
    mvp,
    count: drawn,
    size: settings.size,
    round: settings.round,
    mode: settings.mode === 'rgb' ? 0 : settings.mode === 'solid' ? 2 : 1,
    axis: r ? r.axis : [0, 0, 1],
    range: r ? r.range : [0, 1],
    solid,
    background,
    gizmo: cloud && settings.showOrigin ? gizmo() : null,
  });
  updateScaleBar();
  if (moving) requestDraw();
  if (!moving || now - hudAt > 250) {
    hudAt = now;
    renderHud(moving);
  }
}

function gizmo() {
  const px = (2 * camera.distance * Math.tan(camera.fovy / 2)) / Math.max(1, canvas.clientHeight);
  const L = 56 * px;
  const t = camera.target;
  const v = [];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const colors = [[0.94, 0.27, 0.27], [0.2, 0.78, 0.35], [0.26, 0.52, 0.96]];
  axes.forEach((a, i) => {
    v.push(...t, ...colors[i], ...add(t, a, L), ...colors[i]);
  });
  return new Float32Array(v);
}

// A bar of a round length, true at the depth of the camera origin.
let scaleKey = '';
function updateScaleBar() {
  if (!cloud) { $('scalebar').hidden = true; return; }
  const filePerPx = (2 * camera.distance * Math.tan(camera.fovy / 2)) / Math.max(1, canvas.clientHeight);
  const perPx = filePerPx * shownScale();
  const len = niceLength(perPx * 120);
  const width = Math.round(len / perPx);
  const label = mmPerUnit() ? formatLength(len) : `${Number(len.toPrecision(12))} units`;
  const key = `${label}|${width}`;
  if (key === scaleKey) return;
  scaleKey = key;
  $('scalebar').hidden = false;
  $('scalebar-label').textContent = label;
  $('scalebar-bar').style.width = `${width}px`;
}

function renderHud(moving) {
  if (!cloud) { $('hud').textContent = ''; return; }
  let text = `${fmtInt(cloud.count)} points`;
  if (moving && drawn < cloud.count) text += ` · showing ${fmtCompact(drawn)} while moving`;
  if (moving && fps) text += ` · ${Math.round(fps)} fps`;
  $('hud').textContent = text;
}

// ---- Colour ranges ---------------------------------------------------------

function updateRanges() {
  if (!cloud) return;
  // The points are shuffled, so the first ones are a uniform sample.
  const n = Math.min(cloud.count, 200000);
  const p = cloud.positions;
  const axisFor = { height: frame().up, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  ranges = {};
  for (const [mode, axis] of Object.entries(axisFor)) {
    const vals = new Float32Array(n);
    for (let i = 0; i < n; i++) vals[i] = p[i * 3] * axis[0] + p[i * 3 + 1] * axis[1] + p[i * 3 + 2] * axis[2];
    vals.sort();
    const lo = vals[Math.floor((n - 1) * 0.002)];
    const hi = vals[Math.ceil((n - 1) * 0.998)];
    ranges[mode] = { axis, range: [lo, hi > lo ? hi : lo + 1e-9] };
  }
}

function readColors() {
  const css = getComputedStyle(document.documentElement);
  background = parseColor(css.getPropertyValue('--stage'));
  solid = parseColor(css.getPropertyValue('--ink'));
  requestDraw();
}

function parseColor(value) {
  const hex = value.trim().replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const n = parseInt(full, 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---- Picking ---------------------------------------------------------------

// Finds the nearest point drawn within a few pixels of the cursor.
function pick(cssX, cssY) {
  if (!cloud) return -1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const m = mat4Mul(camera.projection(aspect(), cloud.radius + Math.hypot(...camera.target)), camera.view());
  const reach = Math.max(6, settings.size / 2 + 3);
  const p = cloud.positions;
  let best = -1, bestW = Infinity;
  for (let i = 0, n = cloud.count; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0 || cw >= bestW) continue;
    const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * w;
    const sy = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5) * h;
    const dx = sx - cssX, dy = sy - cssY;
    if (dx * dx + dy * dy <= reach * reach) {
      best = i;
      bestW = cw;
    }
  }
  return best;
}

function pickOrigin(x, y) {
  const i = pick(x, y);
  if (i < 0) {
    flashHud('No point under the cursor.');
    return;
  }
  const p = cloud.positions;
  setOrigin([p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
}

let flashTimer = 0;
function flashHud(text) {
  $('hud').textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => renderHud(false), 1800);
}

// ---- Pointer, wheel and keyboard -------------------------------------------

const pointers = new Map();
let gesture = null;
let lastTap = null;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (!cloud) return;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // Synthetic pointers cannot be captured; the drag still works without it.
  }
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, sx: e.offsetX, sy: e.offsetY });
  const pan = e.button === 1 || e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey;
  gesture = pointers.size >= 2 ? 'pinch' : pan ? 'pan' : 'orbit';
  anim = null;
});

canvas.addEventListener('pointermove', (e) => {
  const pt = pointers.get(e.pointerId);
  if (!pt || !cloud) return;
  const h = Math.max(1, canvas.clientHeight);
  if (gesture === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const before = { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    pt.x = e.offsetX; pt.y = e.offsetY;
    const after = { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    camera.pan(after.mx - before.mx, after.my - before.my, h);
    if (after.d > 0 && before.d > 0) camera.zoom(before.d / after.d, minDistance());
  } else {
    const dx = e.offsetX - pt.x, dy = e.offsetY - pt.y;
    pt.x = e.offsetX; pt.y = e.offsetY;
    if (gesture === 'pan') {
      camera.pan(dx, dy, h);
    } else if (gesture === 'orbit') {
      camera.rotate((-dx * Math.PI) / h);
      camera.tilt((-dy * Math.PI) / h);
    }
  }
  onCameraChange();
  interacted();
});

function endPointer(e) {
  const pt = pointers.get(e.pointerId);
  if (!pt) return;
  pointers.delete(e.pointerId);
  const still = Math.hypot(e.offsetX - pt.sx, e.offsetY - pt.sy) < 6;
  if (e.type === 'pointerup' && still && gesture !== 'pinch' && e.button === 0) {
    const now = performance.now();
    if (lastTap && now - lastTap.t < 350 && Math.hypot(e.offsetX - lastTap.x, e.offsetY - lastTap.y) < 12) {
      lastTap = null;
      pickOrigin(e.offsetX, e.offsetY);
    } else {
      lastTap = { t: now, x: e.offsetX, y: e.offsetY };
    }
  }
  if (pointers.size === 1) {
    // Continue as a one-finger orbit after a pinch.
    gesture = 'orbit';
  } else if (pointers.size === 0) {
    gesture = null;
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (e) => {
  if (!cloud) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  camera.zoom(Math.exp(e.deltaY * unit * 0.0015), minDistance());
  anim = null;
  interacted();
}, { passive: false });

canvas.addEventListener('keydown', (e) => {
  if (!cloud || e.altKey || e.ctrlKey || e.metaKey) return;
  const step = (5 * Math.PI) / 180;
  const h = canvas.clientHeight;
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    const [x, y] = arrows[e.key];
    if (e.shiftKey) camera.pan(x * 40, y * 40, h);
    else {
      camera.rotate(-x * step);
      camera.tilt(-y * step);
    }
  } else if (e.key === '+' || e.key === '=') {
    camera.zoom(1 / 1.2, minDistance());
  } else if (e.key === '-' || e.key === '_') {
    camera.zoom(1.2, minDistance());
  } else if (e.key === 'f' || e.key === 'F') {
    fit();
  } else if (e.key === 'r' || e.key === 'R') {
    resetView();
  } else {
    return;
  }
  e.preventDefault();
  onCameraChange();
  interacted();
});

// ---- Panel controls --------------------------------------------------------

$('open-btn').addEventListener('click', () => $('file-input').click());
$('open-btn-2').addEventListener('click', () => $('file-input').click());
$('sample-btn').addEventListener('click', async () => {
  hideError();
  showProgress('Downloading the sample scan', 0);
  try {
    const res = await fetch('samples/roi-world.ply');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    openFile(new File([await res.blob()], 'roi-world.ply'));
  } catch (err) {
    hideProgress();
    showError(`Could not download the sample scan (${err.message}).`);
  }
});
$('file-input').addEventListener('change', (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
});

$('size').addEventListener('input', (e) => {
  settings.size = Number(e.target.value);
  $('size-out').textContent = `${settings.size} px`;
  requestDraw();
});
$('color-mode').addEventListener('change', (e) => { settings.mode = e.target.value; requestDraw(); });
$('round').addEventListener('change', (e) => { settings.round = e.target.checked; requestDraw(); });
$('adaptive').addEventListener('change', (e) => { settings.adaptive = e.target.checked; requestDraw(); });
$('show-origin').addEventListener('change', (e) => { settings.showOrigin = e.target.checked; requestDraw(); });
$('units').addEventListener('change', (e) => setUnits(e.target.value, 'Set by you.'));
$('up-axis').addEventListener('change', (e) => {
  settings.up = e.target.value;
  updateRanges();
  if (cloud) resetView();
});

document.querySelectorAll('[data-view]').forEach((b) => {
  b.addEventListener('click', () => cloud && setView(b.dataset.view));
});
$('fit').addEventListener('click', () => cloud && fit());
$('reset').addEventListener('click', () => cloud && resetView());

$('origin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!cloud) return;
  const ids = ['ox', 'oy', 'oz'];
  const vals = ids.map((id) => Number($(id).value.trim().replace(',', '.')) / shownScale());
  for (let k = 0; k < 3; k++) {
    const el = $(ids[k]);
    el.setCustomValidity(Number.isFinite(vals[k]) && $(ids[k]).value.trim() !== '' ? '' : 'Enter a number');
    if (!el.reportValidity()) return;
  }
  setOrigin(vals.map((v, k) => v - cloud.centroid[k]));
});
['ox', 'oy', 'oz'].forEach((id) => $(id).addEventListener('input', (e) => e.target.setCustomValidity('')));
$('origin-centroid').addEventListener('click', () => cloud && setOrigin([0, 0, 0]));
$('origin-box').addEventListener('click', () => {
  if (!cloud) return;
  setOrigin(cloud.min.map((v, k) => (v + cloud.max[k]) / 2 - cloud.centroid[k]));
});

$('panel-toggle').addEventListener('click', () => {
  const open = $('panel').classList.toggle('open');
  $('panel-toggle').setAttribute('aria-expanded', String(open));
});

// ---- Drag and drop ---------------------------------------------------------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  stage.classList.add('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) stage.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) openFile(file);
});

// ---- Text ------------------------------------------------------------------

// Lengths are shown in millimetres when the file's unit is known.
function mmPerUnit() { return UNITS[settings.units].mm; }
function shownScale() { return mmPerUnit() ?? 1; }
function shownUnit() { return mmPerUnit() ? 'mm' : 'file units'; }

function setUnits(unit, hint) {
  settings.units = unit;
  $('units').value = unit;
  $('units-hint').textContent = hint;
  $('origin-unit').textContent = shownUnit();
  if (!cloud) return;
  renderFacts();
  onCameraChange();
  requestDraw();
}

function decimals() {
  const ext = Math.max(...cloud.max.map((v, k) => (v - cloud.min[k]) * shownScale()), 1e-12);
  return Math.min(10, Math.max(0, Math.ceil(-Math.log10(ext)) + 4));
}

const fmtInt = (n) => n.toLocaleString('en-US');
const fmtCompact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
function fmtBytes(b) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function renderFacts() {
  const dec = decimals();
  const s = shownScale();
  const u = shownUnit();
  const v3 = (v) => v.map((x) => (x * s).toFixed(dec)).join(', ');
  const format = { ascii: 'ASCII', binary_little_endian: 'Binary, little-endian', binary_big_endian: 'Binary, big-endian' }[cloud.format];
  const rows = [
    ['Points', fmtInt(cloud.count)],
    ...(cloud.skipped ? [['Skipped (not finite)', fmtInt(cloud.skipped)]] : []),
    ['File size', fmtBytes(cloud.size)],
    ['Format', format],
    ['Properties', cloud.properties.map((p) => `${p.name} (${p.type})`).join(', ')],
    [`Size X × Y × Z (${u})`, cloud.max.map((v, k) => ((v - cloud.min[k]) * s).toFixed(dec)).join(' × ')],
    [`Centroid (${u})`, v3(cloud.centroid)],
    [`Min (${u})`, v3(cloud.min)],
    [`Max (${u})`, v3(cloud.max)],
  ];
  const dl = $('facts');
  dl.replaceChildren(...rows.map(([k, v]) => {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    div.append(dt, dd);
    return div;
  }));
}

function showProgress(label, fraction) {
  $('progress').hidden = false;
  $('progress-label').textContent = `${label}…`;
  $('progress-fill').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}
function hideProgress() { $('progress').hidden = true; }
let errorTimer = 0;
function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
  clearTimeout(errorTimer);
  // Over a cloud the message only needs to be read, not kept.
  if (cloud) errorTimer = setTimeout(hideError, 10000);
}
function hideError() { $('error').hidden = true; }

// ---- Start -----------------------------------------------------------------

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  showError('The graphics context was lost. It will come back when the browser restores it.');
});
canvas.addEventListener('webglcontextrestored', () => {
  hideError();
  renderer.restore(cloud);
  requestDraw();
});

new ResizeObserver(() => requestDraw()).observe(canvas);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
readColors();
