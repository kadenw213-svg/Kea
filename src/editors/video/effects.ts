import type { Clip, Colour, ChromaKey } from './model';
import { NEUTRAL_COLOUR } from './model';

/*
 * Per-clip pixel effects (colour correction, vignette, chroma key) run as one WebGL shader.
 * The result is drawn straight into the 2D compositor. Blur, opacity, blend modes and
 * transforms are done by the 2D canvas itself.
 */

export function hasColour(c: Colour) {
  return (Object.keys(NEUTRAL_COLOUR) as (keyof Colour)[]).some((k) => Math.abs(c[k]) > 1e-4);
}
export function needsFx(c: Clip) {
  return c.kind === 'media' && (hasColour(c.colour) || c.key.enabled || !!c.removeBg?.enabled || !!c.lut);
}

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_exposure, u_contrast, u_saturation, u_temp, u_tint, u_high, u_shadow, u_vignette;
uniform float u_keyOn, u_tol, u_soft, u_spill;
uniform vec3 u_key;
uniform sampler2D u_mask;
uniform float u_maskOn;
uniform sampler2D u_lut;
uniform float u_lutOn, u_lutSize, u_lutAmt;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// 3D LUT stored as N slices (one per blue level) side by side: sample the two nearest slices and blend.
vec3 lut3d(vec3 c) {
  float n = u_lutSize;
  float b = clamp(c.b, 0.0, 1.0) * (n - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, n - 1.0);
  float x = (clamp(c.r, 0.0, 1.0) * (n - 1.0) + 0.5) / (n * n);
  float y = (clamp(c.g, 0.0, 1.0) * (n - 1.0) + 0.5) / n;
  vec3 s0 = texture2D(u_lut, vec2(x + b0 / n, y)).rgb;
  vec3 s1 = texture2D(u_lut, vec2(x + b1 / n, y)).rgb;
  return mix(s0, s1, b - b0);
}
vec2 chroma(vec3 c) {
  return vec2(dot(c, vec3(-0.1146, -0.3854, 0.5)), dot(c, vec3(0.5, -0.4542, -0.0458)));
}
void main() {
  vec4 src = texture2D(u_tex, v_uv);
  vec3 rgb = src.rgb;
  float a = src.a;
  if (u_keyOn > 0.5) {
    vec2 kc = chroma(u_key);
    vec2 cc = chroma(rgb);
    float d = distance(cc, kc);
    float tol = u_tol * 0.35;
    float soft = max(u_soft * 0.35, 0.002);
    float m = smoothstep(tol, tol + soft, d);
    a *= m;
    // Spill: pull the key's tint out of what's left.
    vec2 dir = normalize(kc + vec2(1e-5));
    float amt = max(dot(cc, dir), 0.0) * u_spill;
    vec2 fixedC = cc - dir * amt;
    float y = dot(rgb, LUMA);
    rgb = vec3(y + 1.5748 * fixedC.y, y - 0.1873 * fixedC.x - 0.4681 * fixedC.y, y + 1.8556 * fixedC.x);
  }
  if (u_maskOn > 0.5) a *= texture2D(u_mask, v_uv).r;
  rgb *= exp2(u_exposure);
  rgb += vec3(u_temp * 0.08 + u_tint * 0.04, -u_tint * 0.08, -u_temp * 0.08 + u_tint * 0.04);
  float l = dot(rgb, LUMA);
  rgb += u_shadow * 0.25 * (1.0 - smoothstep(0.0, 0.55, l));
  rgb += u_high * 0.25 * smoothstep(0.45, 1.0, l);
  rgb = (rgb - 0.5) * (1.0 + u_contrast) + 0.5;
  l = dot(rgb, LUMA);
  rgb = mix(vec3(l), rgb, 1.0 + u_saturation);
  if (u_vignette > 0.0) {
    float r = length((v_uv - 0.5) * vec2(1.0, 1.0)) * 1.414;
    rgb *= mix(1.0, smoothstep(1.15, 0.35, r), u_vignette);
  }
  rgb = clamp(rgb, 0.0, 1.0);
  if (u_lutOn > 0.5) rgb = mix(rgb, lut3d(rgb), u_lutAmt);
  gl_FragColor = vec4(rgb * a, a);
}`;

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class ClipFx {
  canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private tex: WebGLTexture | null = null;
  private maskTex: WebGLTexture | null = null;
  private lutTex = new Map<string, WebGLTexture | null>();
  private mkTex: (() => WebGLTexture | null) | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true, antialias: false });
    if (this.gl) this.init(this.gl);
  }

  get ok() {
    return !!this.gl;
  }

  private init(gl: WebGLRenderingContext) {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn(gl.getProgramInfoLog(prog));
      this.gl = null;
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['u_tex', 'u_exposure', 'u_contrast', 'u_saturation', 'u_temp', 'u_tint', 'u_high', 'u_shadow', 'u_vignette', 'u_keyOn', 'u_tol', 'u_soft', 'u_spill', 'u_key', 'u_mask', 'u_maskOn', 'u_lut', 'u_lutOn', 'u_lutSize', 'u_lutAmt']) this.loc[n] = gl.getUniformLocation(prog, n);
    const mkTex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tex = mkTex();
    this.maskTex = mkTex();
    this.mkTex = mkTex;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** Run the effects on a frame at w×h; returns the canvas holding the result (or null without WebGL). */
  process(src: TexImageSource, w: number, h: number, colour: Colour, key: ChromaKey, mask?: TexImageSource | null, lut?: { key: string; size: number; data: Uint8Array; amount: number } | null): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl) return null;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch {
      return null;
    }
    const u = this.loc;
    gl.uniform1i(u.u_tex, 0);
    let maskOn = 0;
    if (mask) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
        gl.uniform1i(u.u_mask, 1);
        maskOn = 1;
      } catch {
        // If the mask upload fails, skip it rather than dropping the whole frame.
      }
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform1f(u.u_maskOn, maskOn);
    let lutOn = 0;
    if (lut && this.mkTex) {
      let t = this.lutTex.get(lut.key);
      gl.activeTexture(gl.TEXTURE2);
      if (t === undefined) {
        t = this.mkTex();
        gl.bindTexture(gl.TEXTURE_2D, t);
        // Raw table, not an image: no flipping.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lut.size * lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        this.lutTex.set(lut.key, t);
      } else gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(u.u_lut, 2);
      gl.uniform1f(u.u_lutSize, lut.size);
      gl.uniform1f(u.u_lutAmt, Math.max(0, Math.min(1, lut.amount / 100)));
      lutOn = 1;
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform1f(u.u_lutOn, lutOn);
    gl.uniform1f(u.u_exposure, colour.exposure);
    gl.uniform1f(u.u_contrast, colour.contrast / 100);
    gl.uniform1f(u.u_saturation, colour.saturation / 100);
    gl.uniform1f(u.u_temp, colour.temperature / 100);
    gl.uniform1f(u.u_tint, colour.tint / 100);
    gl.uniform1f(u.u_high, colour.highlights / 100);
    gl.uniform1f(u.u_shadow, colour.shadows / 100);
    gl.uniform1f(u.u_vignette, colour.vignette / 100);
    gl.uniform1f(u.u_keyOn, key.enabled ? 1 : 0);
    gl.uniform1f(u.u_tol, key.tolerance / 100);
    gl.uniform1f(u.u_soft, key.softness / 100);
    gl.uniform1f(u.u_spill, key.spill / 100);
    gl.uniform3fv(u.u_key, hexRgb(key.color));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

/** Rough colour correction with CSS filters, for when WebGL isn't available. */
export function cssColourFilter(c: Colour) {
  const parts: string[] = [];
  if (c.exposure) parts.push(`brightness(${Math.pow(2, c.exposure).toFixed(3)})`);
  if (c.contrast) parts.push(`contrast(${(1 + c.contrast / 100).toFixed(3)})`);
  if (c.saturation) parts.push(`saturate(${(1 + c.saturation / 100).toFixed(3)})`);
  if (c.temperature > 0) parts.push(`sepia(${(c.temperature / 300).toFixed(3)})`);
  if (c.temperature < 0) parts.push(`hue-rotate(${(c.temperature / 10).toFixed(1)}deg)`);
  return parts.join(' ');
}

/** Pick the most common strongly coloured pixel near the edges (for "pick the key colour automatically"). */
export function guessKeyColour(src: CanvasImageSource, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = Math.max(1, Math.round((64 * h) / w));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const bins = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      if (x > 6 && x < c.width - 7 && y > 4 && y < c.height - 5) continue;
      const i = (y * c.width + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 40) continue;
      const k = `${r >> 5},${g >> 5},${b >> 5}`;
      const e = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
      bins.set(k, e);
    }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of bins.values()) if (!best || e.n > best.n) best = e;
  if (!best) return '#00b140';
  const hx = (v: number) => Math.round(v / best!.n).toString(16).padStart(2, '0');
  return `#${hx(best.r)}${hx(best.g)}${hx(best.b)}`;
}
