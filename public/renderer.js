// WebGL2 point renderer: one vertex buffer, one draw call, colour computed in
// the vertex shader so height colouring costs no extra memory.

const VERTEX = `#version 300 es
in vec3 a_pos;
in vec3 a_col;
uniform mat4 u_mvp;
uniform float u_size;
uniform int u_mode;
uniform vec3 u_axis;
uniform vec2 u_range;
uniform vec3 u_solid;
out vec3 v_col;

vec3 turbo(float x) {
  const vec4 kr = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kg = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kb = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kr2 = vec2(-152.94239396, 59.28637943);
  const vec2 kg2 = vec2(4.27729857, 2.82956604);
  const vec2 kb2 = vec2(-89.90310912, 27.34824973);
  x = clamp(x, 0.0, 1.0);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2));
}

void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  gl_PointSize = u_size;
  if (u_mode == 0) {
    v_col = a_col;
  } else if (u_mode == 1) {
    v_col = turbo((dot(a_pos, u_axis) - u_range.x) / max(u_range.y - u_range.x, 1e-30));
  } else {
    v_col = u_solid;
  }
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec3 v_col;
uniform bool u_round;
out vec4 o_col;
void main() {
  if (u_round) {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
  }
  o_col = vec4(v_col, 1.0);
}`;

const LINE_VERTEX = `#version 300 es
in vec3 a_pos;
in vec3 a_col;
uniform mat4 u_mvp;
out vec3 v_col;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); v_col = a_col; }`;

const LINE_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 v_col;
out vec4 o_col;
void main() { o_col = vec4(v_col, 1.0); }`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, 'a_pos');
  gl.bindAttribLocation(prog, 1, 'a_col');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const { name } = gl.getActiveUniform(prog, i);
    uniforms[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, uniforms };
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser does not support WebGL2.');
    this.gl = gl;
    this.canvas = canvas;
    this.count = 0;
    this.hasColor = false;
    this.maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    this.init();
  }

  init() {
    const gl = this.gl;
    this.points = compile(gl, VERTEX, FRAGMENT);
    this.lines = compile(gl, LINE_VERTEX, LINE_FRAGMENT);
    this.vao = gl.createVertexArray();
    this.posBuf = gl.createBuffer();
    this.colBuf = gl.createBuffer();
    this.lineVao = gl.createVertexArray();
    this.lineBuf = gl.createBuffer();
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }

  // Called after a lost context is restored.
  restore(cloud) {
    this.init();
    if (cloud) this.upload(cloud);
  }

  upload(cloud) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cloud.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    if (cloud.colors) {
      gl.bufferData(gl.ARRAY_BUFFER, cloud.colors, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, 4, gl.STATIC_DRAW);
      gl.disableVertexAttribArray(1);
      gl.vertexAttrib3f(1, 1, 1, 1);
    }
    gl.bindVertexArray(null);
    this.count = cloud.count;
    this.hasColor = !!cloud.colors;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  // opts: { mvp, count, size, round, mode, axis, range, solid, background, gizmo }
  draw(o) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(o.background[0], o.background[1], o.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.count > 0 && o.count > 0) {
      gl.enable(gl.DEPTH_TEST);
      const { prog, uniforms: u } = this.points;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(u.u_mvp, false, o.mvp);
      gl.uniform1f(u.u_size, Math.min(this.maxPointSize, o.size * this.dpr));
      gl.uniform1i(u.u_mode, o.mode);
      gl.uniform3fv(u.u_axis, o.axis);
      gl.uniform2fv(u.u_range, o.range);
      gl.uniform3fv(u.u_solid, o.solid);
      gl.uniform1i(u.u_round, o.round ? 1 : 0);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, Math.min(o.count, this.count));
    }
    if (o.gizmo) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.lines.prog);
      gl.uniformMatrix4fv(this.lines.uniforms.u_mvp, false, o.mvp);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, o.gizmo, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, o.gizmo.length / 6);
    }
    gl.bindVertexArray(null);
  }
}
