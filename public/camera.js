// Orbit camera: an origin (target) at the centre of the view, a distance to
// it, and an orientation quaternion (camera-to-world).

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const normalize = (a) => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

export function quatAxis(axis, angle) {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quatNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatRotate(q, v) {
  const u = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, t, q[3]), cross(u, t));
}

// Rotation whose columns are the camera's right, up and back axes.
export function quatFromBasis(r, u, b) {
  const m00 = r[0], m11 = u[1], m22 = b[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(u[2] - b[1]) / s, (b[0] - r[2]) / s, (r[1] - u[0]) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (u[0] + r[1]) / s, (b[0] + r[2]) / s, (u[2] - b[1]) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(u[0] + r[1]) / s, s / 4, (b[1] + u[2]) / s, (b[0] - r[2]) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(b[0] + r[2]) / s, (b[1] + u[2]) / s, s / 4, (r[1] - u[0]) / s];
  }
  return quatNormalize(q);
}

export function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) {
    return quatNormalize(a.map((v, i) => v + (b[i] * s - v) * t));
  }
  const th = Math.acos(d);
  const wa = Math.sin((1 - t) * th) / Math.sin(th);
  const wb = (Math.sin(t * th) / Math.sin(th)) * s;
  return a.map((v, i) => v * wa + b[i] * wb);
}

export function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// The world frame for each choice of up axis: right, forward (into the
// screen in the front view) and up, with right x forward = up.
export function axisFrame(upName) {
  const sign = upName[0] === '-' ? -1 : 1;
  const axis = upName.slice(1);
  const unit = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const up = scale(unit[axis], sign);
  const right = axis === 'x' ? [0, 1, 0] : [1, 0, 0];
  return { right, forward: cross(up, right), up };
}

export function viewOrientation(name, frame) {
  const { right: R, forward: F, up: U } = frame;
  let back, up;
  if (name === 'top') { back = U; up = F; }
  else if (name === 'front') { back = scale(F, -1); up = U; }
  else if (name === 'side') { back = R; up = U; }
  else {
    back = normalize(add(add(scale(R, 0.75), F, -1), U, 0.75));
    up = normalize(add(U, back, -dot(U, back)));
  }
  return quatFromBasis(cross(up, back), up, back);
}

export class OrbitCamera {
  constructor() {
    this.target = [0, 0, 0];
    this.distance = 1;
    this.q = [0, 0, 0, 1];
    this.fovy = (45 * Math.PI) / 180;
    this.worldUp = [0, 0, 1];
  }

  get state() { return { target: this.target, distance: this.distance, q: this.q }; }
  set state(s) { this.target = s.target; this.distance = s.distance; this.q = s.q; }

  axes() {
    return {
      right: quatRotate(this.q, [1, 0, 0]),
      up: quatRotate(this.q, [0, 1, 0]),
      back: quatRotate(this.q, [0, 0, 1]),
    };
  }

  eye() { return add(this.target, this.axes().back, this.distance); }

  // Turn around the world up axis.
  rotate(angle) { this.q = quatNormalize(quatMul(quatAxis(this.worldUp, angle), this.q)); }

  // Turn around the camera's own horizontal axis.
  tilt(angle) { this.q = quatNormalize(quatMul(this.q, quatAxis([1, 0, 0], angle))); }

  // Move the origin with the view by a screen offset in pixels.
  pan(dx, dy, viewportHeight) {
    const s = (2 * this.distance * Math.tan(this.fovy / 2)) / viewportHeight;
    const { right, up } = this.axes();
    this.target = add(add(this.target, right, -dx * s), up, dy * s);
  }

  zoom(factor, minDistance) { this.distance = Math.max(minDistance, this.distance * factor); }

  view() {
    const { right: r, up: u, back: b } = this.axes();
    const e = this.eye();
    return new Float32Array([
      r[0], u[0], b[0], 0,
      r[1], u[1], b[1], 0,
      r[2], u[2], b[2], 0,
      -dot(r, e), -dot(u, e), -dot(b, e), 1,
    ]);
  }

  // Clip planes that enclose a cloud of `radius` around the world origin.
  projection(aspect, radius) {
    const e = this.eye();
    const d = Math.hypot(e[0], e[1], e[2]);
    const far = d + radius * 1.5 + this.distance;
    const near = d > radius * 1.02 ? (d - radius) * 0.98 : Math.max(this.distance * 0.01, far * 1e-6);
    const f = 1 / Math.tan(this.fovy / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  }

  // The distance at which every point, seen from the current orientation
  // with the origin at the centre, lands inside the viewport.
  fitDistance(positions, count, aspect, margin = 0.94) {
    const { right: r, up: u, back: b } = this.axes();
    const ty = Math.tan(this.fovy / 2) * margin;
    const tx = ty * aspect;
    const [t0, t1, t2] = this.target;
    let best = 0;
    for (let i = 0, n = count * 3; i < n; i += 3) {
      const x = positions[i] - t0, y = positions[i + 1] - t1, z = positions[i + 2] - t2;
      const px = Math.abs(x * r[0] + y * r[1] + z * r[2]) / tx;
      const py = Math.abs(x * u[0] + y * u[1] + z * u[2]) / ty;
      const need = (px > py ? px : py) + (x * b[0] + y * b[1] + z * b[2]);
      if (need > best) best = need;
    }
    return best;
  }
}
