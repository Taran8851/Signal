/* Signal hero wave — a slow 3D wave surface behind the hero, hand-written WebGL 1.
   Rules: DESIGN.md §5 "The hero wave". No libraries.

   How it works
   - A flat grid of triangles (the "sea") is displaced in the vertex shader by three summed
     sine waves, then projected through a perspective camera looking slightly down at it.
   - Normals come from the analytic derivatives of the same sines, so light moves with the wave.
   - Colour: Mint → Sky across the surface, Periwinkle Mist in the troughs, a trace of Coral on
     crests — read from tokens.css so a palette change there changes the wave too.
     Never Lake Blue.
   - Faint Ash contour lines follow the grid rows: the technical-manual part of the look.
   - The surface fades out toward the top of the hero, so the headline sits on parchment.

   Behaviour
   - Paused when the hero is off-screen or the tab is hidden.
   - prefers-reduced-motion: one still frame, redrawn only on resize.
   - No WebGL, or the context is lost: the canvas is hidden and the CSS washes
     (.hero-glow) stay — html.wave-active is what swaps them. */
(function () {
  "use strict";

  /* ---- tuning — the only numbers worth editing ------------------------ */
  var SPEED = 0.22;          // time multiplier; lower = slower. One swell ≈ 20s at 0.22
  var OPACITY = 0.72;        // overall strength over parchment
  var GRID_X = 140;          // columns of the mesh
  var GRID_Z = 70;           // rows of the mesh (depth)
  var MAX_DPR = 1.5;         // cap device pixel ratio: soft surface, cheap to draw

  var canvas = document.querySelector(".hero-wave");
  var hero = document.querySelector(".hero");
  if (!canvas || !hero) return;

  var gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return; // no WebGL → CSS washes remain

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var root = document.documentElement;

  /* ---- shaders --------------------------------------------------------- */
  var VERT = [
    "attribute vec2 a_grid;",            // x in [-1,1], z in [0,1] (0 = near, 1 = far)
    "uniform mat4 u_viewProj;",
    "uniform float u_time;",
    "varying vec3 v_normal;",
    "varying float v_height;",
    "varying vec2 v_grid;",
    "varying float v_depth;",

    // Height field: three sines at different scales and directions.
    // Derivatives are written out by hand so normals are exact.
    "void wave(vec2 p, float t, out float h, out float dx, out float dz) {",
    "  float a = p.x * 0.9 + p.y * 0.6 + t * 1.0;",
    "  float b = p.y * 1.7 - p.x * 0.3 - t * 1.4;",
    "  float c = (p.x + p.y) * 2.6 + t * 2.1;",
    "  h  = 0.42 * sin(a) + 0.24 * sin(b) + 0.08 * sin(c);",
    "  dx = 0.42 * 0.9 * cos(a) - 0.24 * 0.3 * cos(b) + 0.08 * 2.6 * cos(c);",
    "  dz = 0.42 * 0.6 * cos(a) + 0.24 * 1.7 * cos(b) + 0.08 * 2.6 * cos(c);",
    "}",

    "void main() {",
    "  vec2 p = vec2(a_grid.x * 9.0, a_grid.y * 14.0);", // world size of the sea
    "  float h; float dx; float dz;",
    "  wave(p, u_time, h, dx, dz);",
    "  v_normal = normalize(vec3(-dx, 1.0, -dz));",
    "  v_height = h;",
    "  v_grid = a_grid;",
    "  v_depth = a_grid.y;",
    "  gl_Position = u_viewProj * vec4(p.x, h, p.y, 1.0);",
    "}"
  ].join("\n");

  var FRAG = [
    "precision mediump float;",
    "uniform vec3 u_mint;",
    "uniform vec3 u_sky;",
    "uniform vec3 u_mist;",
    "uniform vec3 u_coral;",
    "uniform vec3 u_ash;",
    "uniform float u_opacity;",
    "uniform float u_drift;",            // time for the fragment shader; own uniform because
                                          // vertex (highp) and fragment (mediump) precision differ
    "uniform vec2 u_resolution;",
    "varying vec3 v_normal;",
    "varying float v_height;",
    "varying vec2 v_grid;",
    "varying float v_depth;",

    "void main() {",
    "  vec3 light = normalize(vec3(-0.35, 0.9, 0.45));",
    "  float diffuse = clamp(dot(v_normal, light), 0.0, 1.0);",

    // Base hue drifts slowly from mint (left) to sky (right).
    "  float across = smoothstep(-1.0, 1.0, v_grid.x + 0.35 * sin(u_drift * 0.25));",
    "  vec3 col = mix(u_mint, u_sky, across);",
    // Troughs lean periwinkle, crests pick up a trace of coral.
    "  col = mix(u_mist, col, smoothstep(-0.55, 0.15, v_height));",
    "  col = mix(col, u_coral, smoothstep(0.45, 0.72, v_height) * 0.35);",
    // Soft lighting, kept bright: this is atmosphere, not drama.
    "  col *= 0.86 + 0.18 * diffuse;",

    // Contour lines along the rows, in Ash.
    "  float rows = v_grid.y * 36.0;",
    "  float line = 1.0 - smoothstep(0.0, 0.06, abs(fract(rows) - 0.5) - 0.44);",
    "  col = mix(col, u_ash, line * 0.35 * (1.0 - v_depth));",

    // Fade: far rows melt into the horizon, sides feather, top of the hero stays clear.
    "  float fade = (1.0 - smoothstep(0.55, 1.0, v_depth)) * (1.0 - smoothstep(0.75, 1.0, abs(v_grid.x)));",
    "  float screenY = gl_FragCoord.y / u_resolution.y;",           // 0 bottom, 1 top
    "  fade *= 1.0 - smoothstep(0.38, 0.62, screenY);",
    "  float a = u_opacity * fade;",
    "  gl_FragColor = vec4(col * a, a);",                            // premultiplied alpha
    "}"
  ].join("\n");

  function compile(type, source) {
    var s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  var program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (err) {
    console.warn("[wave] shader failed, keeping CSS washes:", err.message);
    return; // shader failure → CSS washes remain
  }
  gl.useProgram(program);

  /* ---- mesh: rows drawn far → near so alpha blends correctly ----------- */
  var vertices = new Float32Array((GRID_X + 1) * (GRID_Z + 1) * 2);
  var v = 0;
  for (var zi = 0; zi <= GRID_Z; zi++) {
    for (var xi = 0; xi <= GRID_X; xi++) {
      vertices[v++] = (xi / GRID_X) * 2 - 1;
      vertices[v++] = zi / GRID_Z;
    }
  }
  var indices = new Uint16Array(GRID_X * GRID_Z * 6);
  var k = 0;
  for (zi = GRID_Z - 1; zi >= 0; zi--) {
    for (xi = 0; xi < GRID_X; xi++) {
      var i0 = zi * (GRID_X + 1) + xi, i1 = i0 + 1, i2 = i0 + GRID_X + 1, i3 = i2 + 1;
      indices[k++] = i0; indices[k++] = i2; indices[k++] = i1;
      indices[k++] = i1; indices[k++] = i2; indices[k++] = i3;
    }
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  var aGrid = gl.getAttribLocation(program, "a_grid");
  gl.enableVertexAttribArray(aGrid);
  gl.vertexAttribPointer(aGrid, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  var u = {};
  ["u_viewProj", "u_time", "u_drift", "u_mint", "u_sky", "u_mist", "u_coral", "u_ash", "u_opacity", "u_resolution"]
    .forEach(function (name) { u[name] = gl.getUniformLocation(program, name); });

  /* ---- palette from tokens.css ----------------------------------------- */
  function token(name) {
    var hex = getComputedStyle(root).getPropertyValue(name).trim().replace("#", "");
    if (hex.length === 3) hex = hex.replace(/./g, "$&$&");
    var n = parseInt(hex, 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }
  gl.uniform3fv(u.u_mint, token("--mint"));
  gl.uniform3fv(u.u_sky, token("--sky"));
  gl.uniform3fv(u.u_mist, token("--mist"));
  gl.uniform3fv(u.u_coral, token("--coral"));
  gl.uniform3fv(u.u_ash, token("--ash"));
  gl.uniform1f(u.u_opacity, OPACITY);

  /* ---- camera (column-major 4×4 matrices, written out by hand) --------- */
  function perspective(fovY, aspect, near, far) {
    var f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(eye, target) {
    var z = normalize(sub(eye, target));
    var x = normalize(cross([0, 1, 0], z));
    var y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }
  function multiply(a, b) {
    var out = new Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return out;
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function normalize(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  /* ---- sizing ---------------------------------------------------------- */
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    var w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(u.u_resolution, w, h);
    var aspect = w / h;
    // Narrow screens: pull the camera back so the swell still spans the width.
    var back = aspect < 1 ? 6.5 : 4.2;
    var view = lookAt([0, 3.1, -back], [0, -0.2, 6.5]);
    gl.uniformMatrix4fv(u.u_viewProj, false, multiply(perspective(0.9, aspect, 0.1, 60), view));
  }

  /* ---- loop ------------------------------------------------------------ */
  var running = false, onScreen = true, frame = 0, startedAt = performance.now(), pausedTime = 0;

  function draw(seconds) {
    gl.uniform1f(u.u_time, seconds * SPEED);
    gl.uniform1f(u.u_drift, seconds * SPEED);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
  }

  function tick(now) {
    if (!running) return;
    draw((now - startedAt) / 1000);
    frame = requestAnimationFrame(tick);
  }

  function play() {
    if (running || reduced || !onScreen || document.hidden) return;
    running = true;
    startedAt = performance.now() - pausedTime * 1000; // resume where it paused, no jump
    frame = requestAnimationFrame(tick);
  }

  function pause() {
    if (!running) return;
    running = false;
    pausedTime = (performance.now() - startedAt) / 1000;
    cancelAnimationFrame(frame);
  }

  resize();
  draw(6); // first frame immediately (also the still frame for reduced motion)
  root.classList.add("wave-active");

  window.addEventListener("resize", function () {
    resize();
    if (!running) draw(reduced ? 6 : pausedTime || 6);
  });

  if (!reduced) {
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        onScreen ? play() : pause();
      }).observe(hero);
    }
    document.addEventListener("visibilitychange", function () {
      document.hidden ? pause() : play();
    });
    pausedTime = 6;
    play();
  }

  canvas.addEventListener("webglcontextlost", function (event) {
    event.preventDefault();
    pause();
    root.classList.remove("wave-active"); // fall back to the CSS washes
  });
})();
