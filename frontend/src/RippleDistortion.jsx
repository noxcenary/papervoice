/**
 * RippleDistortion — OGL-based pointer-driven water displacement.
 * Ported from react-bits (David Haz / DavidHDev).
 * Uses a ping-pong FBO to simulate a decaying wave field that distorts
 * whatever is rendered beneath the canvas.
 */
import { useEffect, useRef } from 'react';

// ── Shaders ──────────────────────────────────────────────────────────────────

const SIM_VERT = /* glsl */ `
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

// Ripple simulation: add a Gaussian splash at pointer, then diffuse & decay
const SIM_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tPrev;
  uniform vec2 uPointer;
  uniform float uAspect;
  uniform float uSplash;
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;
    vec4 prev = texture2D(tPrev, uv);

    // Wave propagation (discrete wave equation)
    vec2 texel = vec2(1.0 / 512.0);
    float n = texture2D(tPrev, uv + vec2(0.0,  texel.y)).r;
    float s = texture2D(tPrev, uv + vec2(0.0, -texel.y)).r;
    float e = texture2D(tPrev, uv + vec2( texel.x, 0.0)).r;
    float w = texture2D(tPrev, uv + vec2(-texel.x, 0.0)).r;
    float wave = (n + s + e + w) * 0.5 - prev.g;
    wave *= 0.988; // damping

    // Gaussian splash at pointer
    vec2 diff = uv - uPointer;
    diff.x *= uAspect;
    float dist = length(diff);
    float splash = uSplash * exp(-dist * dist * 180.0);
    wave += splash;

    gl_FragColor = vec4(wave, prev.r, 0.0, 1.0);
  }
`;

// Final render: sample background, distort by gradient of wave field
const RENDER_VERT = /* glsl */ `
  attribute vec2 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const RENDER_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tWave;
  uniform sampler2D tBg;
  uniform float uStrength;
  varying vec2 vUv;

  void main() {
    vec2 texel = vec2(1.0 / 512.0);
    float waveR = texture2D(tWave, vUv).r;
    float dx = texture2D(tWave, vUv + vec2(texel.x, 0.0)).r
             - texture2D(tWave, vUv - vec2(texel.x, 0.0)).r;
    float dy = texture2D(tWave, vUv + vec2(0.0, texel.y)).r
             - texture2D(tWave, vUv - vec2(0.0, texel.y)).r;

    vec2 distort = vec2(dx, dy) * uStrength;
    vec4 color = texture2D(tBg, vUv + distort);
    // Subtle highlight on wave peaks
    color.rgb += vec3(waveR * 0.18);
    gl_FragColor = color;
  }
`;

// ── Raw WebGL helpers (no OGL dependency needed) ────────────────────────────

function createShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

function createProgram(gl, vert, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, createShader(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, createShader(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  return p;
}

function createFBO(gl, size) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fb };
}

function createBgTexture(gl, canvas) {
  // Draw a dark gradient matching the app background onto an offscreen canvas,
  // then upload as a WebGL texture.
  const size = 512;
  const oc = document.createElement('canvas');
  oc.width = oc.height = size;
  const ctx = oc.getContext('2d');

  // Match body background
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#0f0f0f');
  grad.addColorStop(0.5, '#080808');
  grad.addColorStop(1, '#0c0c0c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Subtle radial light at top-left (matching the CSS)
  const r1 = ctx.createRadialGradient(size * 0.2, size * 0.1, 0, size * 0.2, size * 0.1, size * 0.55);
  r1.addColorStop(0, 'rgba(255,255,255,0.06)');
  r1.addColorStop(1, 'transparent');
  ctx.fillStyle = r1;
  ctx.fillRect(0, 0, size, size);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, oc);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// ── React component ───────────────────────────────────────────────────────────

export default function RippleDistortion({
  strength = 28,
  className = '',
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) return;

    const SIM_SIZE = 512;

    // Full-screen quad
    const quadVerts = new Float32Array([-1, -1,  1, -1, -1,  1,  1,  1]);
    const quadUvs   = new Float32Array([ 0,  0,  1,  0,  0,  1,  1,  1]);

    function makeVAO(prog, verts, uvs) {
      const posLoc = gl.getAttribLocation(prog, 'position');
      const uvLoc  = gl.getAttribLocation(prog, 'uv');

      const posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

      const uvBuf = uvs ? gl.createBuffer() : null;
      if (uvs && uvLoc >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
        gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
      }
      return { posLoc, uvLoc, posBuf, uvBuf };
    }

    // Programs
    const simProg    = createProgram(gl, SIM_VERT, SIM_FRAG);
    const renderProg = createProgram(gl, RENDER_VERT, RENDER_FRAG);

    // Uniforms
    const simUniforms = {
      tPrev:    gl.getUniformLocation(simProg, 'tPrev'),
      uPointer: gl.getUniformLocation(simProg, 'uPointer'),
      uAspect:  gl.getUniformLocation(simProg, 'uAspect'),
      uSplash:  gl.getUniformLocation(simProg, 'uSplash'),
    };
    const renderUniforms = {
      tWave:     gl.getUniformLocation(renderProg, 'tWave'),
      tBg:       gl.getUniformLocation(renderProg, 'tBg'),
      uStrength: gl.getUniformLocation(renderProg, 'uStrength'),
    };

    // Buffers
    const simAttribs    = makeVAO(simProg, quadVerts, null);
    const renderAttribs = makeVAO(renderProg, quadVerts, quadUvs);

    // FBOs (ping-pong)
    let fbo0 = createFBO(gl, SIM_SIZE);
    let fbo1 = createFBO(gl, SIM_SIZE);

    // Background texture
    const bgTex = createBgTexture(gl, canvas);

    // Pointer state
    let pointer = { x: 0.5, y: 0.5, splash: 0 };
    let raf;

    function resize() {
      canvas.width  = canvas.offsetWidth  * devicePixelRatio;
      canvas.height = canvas.offsetHeight * devicePixelRatio;
    }

    resize();
    window.addEventListener('resize', resize);

    function onPointerMove(e) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = (e.clientX - rect.left) / rect.width;
      pointer.y = 1 - (e.clientY - rect.top) / rect.height; // flip Y
      pointer.splash = 1.4;
    }

    canvas.addEventListener('mousemove', onPointerMove);
    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      onPointerMove(e.touches[0]);
    }, { passive: false });

    function drawQuad(prog, attribs) {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, attribs.posBuf);
      gl.enableVertexAttribArray(attribs.posLoc);
      gl.vertexAttribPointer(attribs.posLoc, 2, gl.FLOAT, false, 0, 0);
      if (attribs.uvLoc >= 0 && attribs.uvBuf) {
        gl.bindBuffer(gl.ARRAY_BUFFER, attribs.uvBuf);
        gl.enableVertexAttribArray(attribs.uvLoc);
        gl.vertexAttribPointer(attribs.uvLoc, 2, gl.FLOAT, false, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function loop() {
      raf = requestAnimationFrame(loop);
      const aspect = canvas.offsetWidth / canvas.offsetHeight;

      // ── Simulation pass: fbo0 → fbo1 ──
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo1.fb);
      gl.viewport(0, 0, SIM_SIZE, SIM_SIZE);

      gl.useProgram(simProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbo0.tex);
      gl.uniform1i(simUniforms.tPrev, 0);
      gl.uniform2f(simUniforms.uPointer, pointer.x, pointer.y);
      gl.uniform1f(simUniforms.uAspect, aspect);
      gl.uniform1f(simUniforms.uSplash, pointer.splash);

      drawQuad(simProg, simAttribs);

      // Decay splash
      pointer.splash *= 0.85;

      // Swap FBOs
      [fbo0, fbo1] = [fbo1, fbo0];

      // ── Render pass: to screen ──
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);

      gl.useProgram(renderProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbo0.tex);
      gl.uniform1i(renderUniforms.tWave, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.uniform1i(renderUniforms.tBg, 1);
      gl.uniform1f(renderUniforms.uStrength, strength / 10000);

      drawQuad(renderProg, renderAttribs);
    }

    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', onPointerMove);
    };
  }, [strength]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        display: 'block',
      }}
    />
  );
}
