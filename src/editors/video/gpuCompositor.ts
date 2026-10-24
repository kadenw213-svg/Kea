import type { Project, Clip, BlendMode } from './model';
import { BLEND_MODES, mediaOf, propAt } from './model';
import type { LayerMod } from './transitions';
import { GRADE_GLSL, GRADE_UNIFORMS, setGradeUniforms, hexRgb, NEUTRAL_KEY } from './effects';
import { NEUTRAL_COLOUR } from './model';
import { mediaKey, knownColour, colourOf } from './media';
import { maskAt } from './segmentMask';
import { getLut, loadLut } from './lut';

/*
 * The 16-bit GPU compositor (WebGL2, RGBA16F render targets): the same picture as the 2D compositor, at the precision
 * pro editors work in.
 * - Each clip is graded in display (gamma) space, exactly as before (LUTs and the grade controls expect that), then
 *   converted to linear light and premultiplied.
 * - Resizing (Lanczos-3 when shrinking, Catmull-Rom when enlarging), blur, opacity, transitions and normal blending
 *   all happen in linear light, where they are physically right: no dark fringes on edges, no muddy dissolves.
 * - Blend modes (multiply, screen…) are worked out in gamma space, as every editor and Photoshop define them.
 * - Only the very last step goes back to 8 bits, with dithering, so smooth gradients stay smooth (no banding).
 * Text and shapes are drawn by the 2D renderer (fonts, shadows, karaoke) and composited here.
 */

type Target = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };
type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Drawable = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLImageElement | VideoFrame | YuvFrame;

/** A decoded frame's raw planes at full precision (10/12-bit samples in 16-bit words), for the 16-bit renderer. */
export interface YuvFrame {
  yuv: true;
  width: number;
  height: number;
  /** 'I420P10', 'I422P10', 'I444P10', 'I420P12'… */
  format: string;
  planes: { data: Uint16Array; stride: number; w: number; h: number }[];
  colour: VideoColorSpaceInit;
}
export const isYuv = (d: unknown): d is YuvFrame => !!d && (d as YuvFrame).yuv === true;

/** Copy a software-decoded high-bit-depth frame's planes out (null if its format isn't one we read). */
export async function yuvOf(f: { format: string | null; codedWidth: number; codedHeight: number; displayWidth: number; displayHeight: number; colorSpace: { toJSON?(): VideoColorSpaceInit } & VideoColorSpaceInit; allocationSize(): number; copyTo(dst: Uint8Array): Promise<PlaneLayout[]> }): Promise<YuvFrame | null> {
  const fmt = f.format || '';
  const m = /^I4(20|22|44)P1[02]$/.exec(fmt);
  if (!m) return null;
  const buf = new Uint8Array(f.allocationSize());
  const layout = await f.copyTo(buf);
  const W = f.codedWidth;
  const H = f.codedHeight;
  const cw = m[1] === '44' ? W : Math.ceil(W / 2);
  const ch = m[1] === '20' ? Math.ceil(H / 2) : H;
  const dims = [[W, H], [cw, ch], [cw, ch]];
  const planes = layout.slice(0, 3).map((l, i) => ({ data: new Uint16Array(buf.buffer, l.offset, (l.stride / 2) * dims[i][1]), stride: l.stride / 2, w: dims[i][0], h: dims[i][1] }));
  const cs = f.colorSpace.toJSON ? f.colorSpace.toJSON() : f.colorSpace;
  return { yuv: true, width: f.displayWidth, height: f.displayHeight, format: fmt, planes, colour: cs };
}

export interface GpuFrameSource {
  project: Project;
  t: number;
  scale: number;
  /** During playback: shrink with the GPU's mipmaps instead of Lanczos (much cheaper; paused frames and exports use
   *  full quality). */
  fast?: boolean;
  getFrame: (clip: Clip, srcTime: number) => Drawable | 'offline' | null;
}

export interface GpuHelpers {
  layers: (p: Project, t: number) => { clip: Clip; mod: LayerMod }[][];
  frameTime: (p: Project, c: Clip, t: number) => number;
  sizeOf: (d: Drawable) => [number, number];
  /** Draw one clip (text, shape or an offline placeholder) with the 2D renderer, normal blending, at output scale. */
  raster: (ctx: CanvasRenderingContext2D, clip: Clip, mod: LayerMod) => void;
  /** A string that changes whenever that drawing would (so an unchanged title isn't redrawn every frame). */
  rasterKey: (clip: Clip, mod: LayerMod) => string;
}

const QUAD_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const SRGB_GLSL = `
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toGamma(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}`;

// Grade (or just convert) a picture into a linear, premultiplied 16-bit layer. The input is either the source frame
// (8-bit display colour, straight alpha) or a layer already resized (linear, premultiplied).
// u_crop maps this layer onto the whole frame, for the mask and the vignette.
const GRADE_FRAG = `#version 300 es
precision highp float;
#define texture2D texture
in vec2 v_uv;
out vec4 o;
uniform vec4 u_crop;
uniform sampler2D u_src;
uniform int u_srcPremul;
uniform vec4 u_srcRect; // where the input texture sits in the whole frame
${SRGB_GLSL}
vec4 srcGamma(vec2 frameUv) {
  vec4 c = texture(u_src, (frameUv - u_srcRect.xy) / (u_srcRect.zw - u_srcRect.xy));
  if (u_srcPremul == 0) return c;
  c.rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  return vec4(toGamma(c.rgb), c.a);
}
#define GRADE_SOURCE(uv) srcGamma(uv)
${GRADE_GLSL}
void main() {
  vec4 g = grade(mix(u_crop.xy, u_crop.zw, v_uv));
  vec3 c = g.a > 0.0 ? g.rgb / g.a : vec3(0.0);
  o = vec4(toLinear(c) * g.a, g.a);
}`;

// Separable Lanczos-3 resize (shrinking), in linear light. One axis per pass; reads the region [u_off, u_off + len)
// of the source along that axis (the crop), and row u_rowOff + y across it. u_premul: the input is the 8-bit frame
// (display colour, straight alpha), converted to linear and premultiplied as it's read.
// The weights sinc(x)·sinc(x/3) are stepped with rotations instead of two sin() calls per tap.
const RESAMPLE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform float u_k;
uniform float u_off;
uniform int u_lo, u_hi, u_rowOff, u_premul;
out vec4 o;
vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool horiz = u_dir.x > 0.5;
  float pos = horiz ? float(p.x) : float(p.y);
  int row = (horiz ? p.y : p.x) + u_rowOff;
  float center = u_off + (pos + 0.5) / u_k - 0.5;
  float support = 3.0 / u_k;
  int lo = int(floor(center - support)) + 1;
  int hi = int(floor(center + support));
  const float PI = 3.14159265;
  float x0 = (float(lo) - center) * u_k;
  float a1 = PI * x0, a3 = PI * x0 / 3.0;
  vec2 r1 = vec2(cos(a1), sin(a1)), r3 = vec2(cos(a3), sin(a3));
  vec2 d1 = vec2(cos(PI * u_k), sin(PI * u_k)), d3 = vec2(cos(PI * u_k / 3.0), sin(PI * u_k / 3.0));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  float x = x0;
  for (int i = lo; i <= hi; i++) {
    float w = abs(x) < 1e-4 ? 1.0 : 3.0 * r1.y * r3.y / (PI * PI * x * x);
    int j = clamp(i, u_lo, u_hi);
    vec4 s = texelFetch(u_src, horiz ? ivec2(j, row) : ivec2(row, j), 0);
    if (u_premul == 1) s.rgb = lin(s.rgb) * s.a;
    acc += w * s;
    wsum += w;
    r1 = vec2(r1.x * d1.x - r1.y * d1.y, r1.x * d1.y + r1.y * d1.x);
    r3 = vec2(r3.x * d3.x - r3.y * d3.y, r3.x * d3.y + r3.y * d3.x);
    x += u_k;
  }
  o = max(acc / wsum, 0.0);
}`;

// Separable Gaussian blur (sigma in texels). Reads past the edges as transparent, like CSS blur; u_pad is the border
// added around the picture so the blur can spread out.
const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform float u_sigma;
uniform vec2 u_pad;
out vec4 o;
void main() {
  ivec2 sz = textureSize(u_src, 0);
  vec2 p = gl_FragCoord.xy - u_pad;
  float r = ceil(u_sigma * 3.0);
  float stp = max(1.0, r / 48.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (float x = -r; x <= r; x += stp) {
    float w = exp(-(x * x) / (2.0 * u_sigma * u_sigma));
    vec2 q = p + u_dir * x;
    vec4 s = (q.x < 0.0 || q.y < 0.0 || q.x >= float(sz.x) || q.y >= float(sz.y)) ? vec4(0.0) : texture(u_src, q / vec2(sz));
    acc += w * s;
    wsum += w;
  }
  o = acc / wsum;
}`;

// Place a layer on the frame: transform, edge anti-aliasing, transition clip / iris, opacity, blend mode.
const COMP_VERT = `#version 300 es
in vec2 a_pos;
uniform mat3 u_m;
uniform vec2 u_out;
uniform vec2 u_pad;
out vec2 v_uv;
void main() {
  vec2 unit = mix(-u_pad, 1.0 + u_pad, (a_pos + 1.0) * 0.5);
  vec2 px = (u_m * vec3(unit, 1.0)).xy;
  v_uv = vec2(unit.x, 1.0 - unit.y);
  gl_Position = vec4(px.x / u_out.x * 2.0 - 1.0, 1.0 - px.y / u_out.y * 2.0, 0.0, 1.0);
}`;

const COMP_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_layer;
uniform sampler2D u_dst;
uniform int u_bicubic;
uniform int u_mode;
uniform float u_alpha;
uniform vec2 u_out;
uniform vec4 u_clip;
uniform float u_iris;
uniform vec2 u_center;
uniform int u_linearMix;
${SRGB_GLSL}
vec4 cubicW(float t) {
  // Catmull-Rom weights for the four taps around t in [0, 1).
  float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}
vec4 sampleLayer(vec2 uv) {
  if (u_bicubic == 0) return texture(u_layer, uv);
  vec2 sz = vec2(textureSize(u_layer, 0));
  vec2 p = uv * sz - 0.5;
  vec2 f = fract(p);
  ivec2 b = ivec2(floor(p));
  vec4 wx = cubicW(f.x), wy = cubicW(f.y);
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    vec4 row = vec4(0.0);
    for (int i = 0; i < 4; i++) row += wx[i] * texelFetch(u_layer, clamp(b + ivec2(i - 1, j - 1), ivec2(0), ivec2(sz) - 1), 0);
    acc += wy[j] * row;
  }
  // Catmull-Rom can overshoot: keep premultiplied colour valid.
  acc.a = clamp(acc.a, 0.0, 1.0);
  acc.rgb = clamp(acc.rgb, 0.0, acc.a);
  return acc;
}
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float softLight(float b, float s) {
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
}
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
vec3 hardLight(vec3 b, vec3 s) { return mix(b * 2.0 * s, b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0), step(0.5, s)); }
vec3 blendFn(int m, vec3 b, vec3 s) {
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return hardLight(s, b);
  if (m == 4) return min(b, s);
  if (m == 5) return max(b, s);
  if (m == 6) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (m == 7) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (m == 8) return hardLight(b, s);
  if (m == 9) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (m == 10) return abs(b - s);
  if (m == 11) return b + s - 2.0 * b * s;
  if (m == 12) return setLum(setSat(s, sat(b)), lum(b));
  if (m == 13) return setLum(setSat(b, sat(s)), lum(b));
  if (m == 14) return setLum(s, lum(b));
  return setLum(b, lum(s));
}
void main() {
  // Edge coverage (anti-aliasing for rotated or sub-pixel edges).
  vec2 fw = max(fwidth(v_uv), vec2(1e-6));
  vec2 inside = min(v_uv, 1.0 - v_uv) / fw;
  float cov = clamp(min(inside.x, inside.y) + 0.5, 0.0, 1.0);
  vec2 px = vec2(gl_FragCoord.x, u_out.y - gl_FragCoord.y);
  vec2 f = px / u_out;
  vec2 edge = 1.0 / u_out;
  cov *= clamp((f.x - u_clip.x) / edge.x + 0.5, 0.0, 1.0) * clamp((u_clip.z - f.x) / edge.x + 0.5, 0.0, 1.0);
  cov *= clamp((f.y - u_clip.y) / edge.y + 0.5, 0.0, 1.0) * clamp((u_clip.w - f.y) / edge.y + 0.5, 0.0, 1.0);
  if (u_iris >= 0.0) cov *= clamp(u_iris - length(px - u_center) + 0.5, 0.0, 1.0);
  vec4 s = sampleLayer(clamp(v_uv, 0.0, 1.0)) * (u_alpha * cov);
  // Mixing in display colour (the frame so far is kept in display colour then): the layer goes from linear to display.
  if (u_linearMix == 0 && s.a > 0.0) s.rgb = toGamma(s.rgb / s.a) * s.a;
  if (u_mode == 0) {
    o = s;
    return;
  }
  vec4 d = texelFetch(u_dst, ivec2(gl_FragCoord.xy), 0);
  float as = s.a, ab = d.a;
  vec3 cs = as > 0.0 ? s.rgb / as : vec3(0.0);
  vec3 cb = ab > 0.0 ? d.rgb / ab : vec3(0.0);
  if (u_linearMix == 1) {
    cs = toGamma(cs);
    cb = toGamma(cb);
  }
  vec3 mixed = (1.0 - ab) * cs + ab * clamp(blendFn(u_mode, cb, cs), 0.0, 1.0);
  float ao = as + ab * (1.0 - as);
  vec3 co = ao > 0.0 ? (as * mixed + (1.0 - as) * ab * cb) / ao : vec3(0.0);
  o = vec4((u_linearMix == 1 ? toLinear(co) : co) * ao, ao);
}`;

// The input stage for HDR and 10-bit footage: whatever the source, out comes linear BT.709 light where 1.0 is SDR
// white, premultiplied, at the source's own size (the crop region only).
// u_src 0: an RGB signal texture (the browser's YUV→RGB of a hardware-decoded frame, still in the source's primaries
//          and transfer, 8-bit precision); 1: the raw Y/U/V planes (10 or 12 bits, from a software decode).
// Then: transfer → linear (PQ / HLG / SDR), primaries → BT.709, and HDR → SDR tone mapping that keeps hues: reference
// white (203 nits, BT.2408) lands near SDR white and highlights roll off smoothly up to the source's peak.
const INPUT_FRAG = `#version 300 es
precision highp float;
precision highp usampler2D;
out vec4 o;
uniform int u_srcKind;
uniform sampler2D u_rgb;
uniform usampler2D u_y, u_u, u_v;
uniform vec4 u_region;     // x, y (from the top), width, height, in source pixels
uniform vec2 u_size;       // source frame size
uniform vec2 u_chromaDiv;  // (2,2) 4:2:0, (2,1) 4:2:2, (1,1) 4:4:4
uniform float u_maxCode;   // 1023 (10-bit), 4095 (12-bit)
uniform int u_fullRange;
uniform vec2 u_krkb;       // the YUV matrix's red and blue luma weights
uniform int u_transfer;    // 0 SDR, 1 PQ, 2 HLG
uniform mat3 u_gamut;      // source primaries → BT.709, linear
uniform float u_refWhite;  // nits that become SDR white before the roll-off (203)
uniform float u_knee;      // linear level where the highlight roll-off starts
uniform float u_peak;      // the source's brightest level, in the same units (1000 nits / 203)
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 pqToNits(vec3 e) {
  const float m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  vec3 p = pow(clamp(e, 0.0, 1.0), vec3(1.0 / m2));
  return 10000.0 * pow(max(p - c1, 0.0) / (c2 - c3 * p), vec3(1.0 / m1));
}
vec3 hlgToNits(vec3 e) {
  const float a = 0.17883277, b = 0.28466892, c = 0.55991073;
  e = clamp(e, 0.0, 1.0);
  vec3 s = mix(e * e / 3.0, (exp((e - c) / a) + b) / 12.0, step(vec3(0.5), e));
  // HLG's display mapping (OOTF) for a 1000-nit display: system gamma 1.2 on the scene luminance.
  float ys = dot(s, vec3(0.2627, 0.6780, 0.0593));
  return 1000.0 * pow(max(ys, 1e-6), 0.2) * s;
}
float uyv(usampler2D t, ivec2 p, ivec2 lim) { return float(texelFetch(t, clamp(p, ivec2(0), lim), 0).r); }
float chroma(usampler2D t, vec2 pos) {
  // Bilinear chroma upsampling (chroma sited left, centred vertically, as H.264 / HEVC / VP9 4:2:0 are).
  ivec2 lim = textureSize(t, 0) - 1;
  vec2 c = vec2(pos.x / u_chromaDiv.x, (pos.y + 0.5) / u_chromaDiv.y - 0.5);
  vec2 f = fract(c);
  ivec2 b = ivec2(floor(c));
  return mix(mix(uyv(t, b, lim), uyv(t, b + ivec2(1, 0), lim), f.x), mix(uyv(t, b + ivec2(0, 1), lim), uyv(t, b + ivec2(1, 1), lim), f.x), f.y);
}
void main() {
  ivec2 op = ivec2(gl_FragCoord.xy);
  // Source pixel (from the top), for this output pixel (targets run bottom-up).
  int sx = int(u_region.x) + op.x;
  int syTop = int(u_region.y) + (int(u_region.w) - 1 - op.y);
  vec3 sig;
  if (u_srcKind == 0) {
    // (Uploaded flipped, like every picture: row 0 is the bottom.)
    sig = texelFetch(u_rgb, ivec2(sx, int(u_size.y) - 1 - syTop), 0).rgb;
  } else {
    float y = uyv(u_y, ivec2(sx, syTop), textureSize(u_y, 0) - 1);
    vec2 pos = vec2(float(sx), float(syTop));
    float cb = chroma(u_u, pos), cr = chroma(u_v, pos);
    float s = (u_maxCode + 1.0) / 256.0;
    float Y = u_fullRange == 1 ? y / u_maxCode : (y - 16.0 * s) / (219.0 * s);
    float Cb = u_fullRange == 1 ? (cb - 128.0 * s) / u_maxCode : (cb - 128.0 * s) / (224.0 * s);
    float Cr = u_fullRange == 1 ? (cr - 128.0 * s) / u_maxCode : (cr - 128.0 * s) / (224.0 * s);
    float kr = u_krkb.x, kb = u_krkb.y, kg = 1.0 - kr - kb;
    float R = Y + 2.0 * (1.0 - kr) * Cr;
    float B = Y + 2.0 * (1.0 - kb) * Cb;
    float G = (Y - kr * R - kb * B) / kg;
    sig = vec3(R, G, B);
  }
  vec3 lin;
  if (u_transfer == 1) lin = pqToNits(sig) / u_refWhite;
  else if (u_transfer == 2) lin = hlgToNits(sig) / u_refWhite;
  else lin = srgbToLinear(clamp(sig, 0.0, 1.0));
  lin = max(u_gamut * lin, 0.0);
  if (u_transfer != 0) {
    // Hue-preserving roll-off on the largest channel: straight up to the knee, then a shoulder (extended Reinhard)
    // that reaches SDR white exactly at the source's peak, so highlights keep their separation instead of clipping.
    float m = max(max(lin.r, lin.g), lin.b);
    if (m > u_knee) {
      float k = u_knee;
      float x = (m - k) / (1.0 - k);
      float xp = max((u_peak - k) / (1.0 - k), 1.0);
      float t = k + (1.0 - k) * min(1.0, x * (1.0 + x / (xp * xp)) / (1.0 + x));
      lin *= t / m;
    }
  }
  o = vec4(lin, 1.0);
}`;

const FILL_FRAG = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

// Back to 8-bit display colour with triangular dither (±1 code value), so gradients don't band.
const OUT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform float u_seed;
uniform int u_dither;
uniform int u_linearMix;
${SRGB_GLSL}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + u_seed);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 g = u_linearMix == 1 ? toGamma(c.rgb) : max(c.rgb, 0.0);
  if (u_dither == 1) g += (hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 17.3) - 1.0) / 255.0;
  o = vec4(clamp(g, 0.0, 1.0), 1.0);
}`;

const linearOf = (hex: string): [number, number, number] =>
  hexRgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))) as [number, number, number];

export class GpuCompositor {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private progs!: { grade: Prog; resample: Prog; blur: Prog; comp: Prog; fill: Prog; out: Prog; input: Prog };
  private targets = new Map<string, Target>();
  private srcTex!: WebGLTexture;
  private hdrTex!: WebGLTexture;
  private planeTex!: WebGLTexture[];
  private maskTex!: WebGLTexture;
  private lutTex = new Map<string, WebGLTexture>();
  private raster2d: CanvasRenderingContext2D | null = null;
  /** Last frame's converted picture of each text / shape clip, by clip id. */
  private rasterCache = new Map<string, { key: string; target: Target; used: number }>();
  private frameNo = 0;
  /** Dither the final 8-bit picture (on by default; tests turn it off to compare exactly). */
  dither = true;
  /**
   * Mix layers (opacity, dissolves, dips) in linear light (true: physically right, no muddy dissolves; Premiere's
   * "composite in linear colour") or in display colour (false: how Resolve and older editors mix by default).
   * Resizing and blur are always done in linear light.
   */
  linearMix = true;
  /** When set, each stage waits for the GPU and adds its time (ms) here: for measuring, never in normal use. */
  profile: Record<string, number> | null = null;
  private lastMark = 0;
  private mark(label: string) {
    if (!this.profile) return;
    // (finish() doesn't wait in Chrome; reading a pixel back does.)
    const gl = this.gl;
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const now = performance.now();
    if (label !== 'start') this.profile[label] = (this.profile[label] || 0) + now - this.lastMark;
    this.lastMark = now;
  }

  /** A compositor, or null if this computer's WebGL2 can't render to 16-bit float. */
  static create(): GpuCompositor | null {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const c = new GpuCompositor(canvas, gl);
      return c.progs ? c : null;
    } catch (err) {
      console.warn('GPU compositor unavailable', err);
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    const prog = (vs: string, fs: string, names: string[]): Prog => {
      const sh = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
        return s;
      };
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'a_pos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
      const u: Prog['u'] = {};
      for (const n of names) u[n] = gl.getUniformLocation(p, n);
      return { p, u };
    };
    this.progs = {
      grade: prog(QUAD_VERT, GRADE_FRAG, [...GRADE_UNIFORMS, 'u_crop', 'u_src', 'u_srcPremul', 'u_srcRect']),
      resample: prog(QUAD_VERT, RESAMPLE_FRAG, ['u_src', 'u_dir', 'u_k', 'u_off', 'u_lo', 'u_hi', 'u_rowOff', 'u_premul']),
      blur: prog(QUAD_VERT, BLUR_FRAG, ['u_src', 'u_dir', 'u_sigma', 'u_pad']),
      comp: prog(COMP_VERT, COMP_FRAG, ['u_m', 'u_out', 'u_pad', 'u_layer', 'u_dst', 'u_bicubic', 'u_mode', 'u_alpha', 'u_clip', 'u_iris', 'u_center', 'u_linearMix']),
      fill: prog(QUAD_VERT, FILL_FRAG, ['u_color']),
      input: prog(QUAD_VERT, INPUT_FRAG, ['u_srcKind', 'u_rgb', 'u_y', 'u_u', 'u_v', 'u_region', 'u_size', 'u_chromaDiv', 'u_maxCode', 'u_fullRange', 'u_krkb', 'u_transfer', 'u_gamut', 'u_refWhite', 'u_knee', 'u_peak']),
      out: prog(QUAD_VERT, OUT_FRAG, ['u_src', 'u_seed', 'u_dither', 'u_linearMix'])
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.srcTex = this.tex();
    this.maskTex = this.tex();
    this.hdrTex = this.tex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null);
    this.planeTex = [this.intTex(), this.intTex(), this.intTex()];
    for (const t of this.planeTex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(1));
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  private tex() {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private intTex() {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /**
   * HDR / 10-bit source → linear BT.709 16-bit layer of the crop region (at the source's size). frame: raw planes, or
   * a hardware-decoded frame / video element whose HDR signal is uploaded as is (8-bit precision, no browser tone map).
   */
  private inputPass(frame: YuvFrame | TexImageSource, sw: number, sh: number, region: [number, number, number, number], colour: { primaries: string; transfer: string; matrix: string; fullRange: boolean }, bitDepth: number): Target {
    const gl = this.gl;
    const { p, u } = this.progs.input;
    const [rx, ry, rw, rh] = region.map((v) => Math.round(v));
    const out = this.target('input', rw, rh);
    gl.useProgram(p);
    gl.disable(gl.BLEND);
    this.bindTarget(out);
    // Samplers: u_rgb on 0 (float), the planes on 1-3 (integer). Both kinds stay bound, so neither is ever empty or
    // shares a unit with the other (WebGL refuses to draw then).
    gl.uniform1i(u.u_rgb, 0);
    gl.uniform1i(u.u_y, 1);
    gl.uniform1i(u.u_u, 2);
    gl.uniform1i(u.u_v, 3);
    if (isYuv(frame)) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.hdrTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      frame.planes.forEach((pl, i) => {
        gl.activeTexture(gl.TEXTURE1 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.planeTex[i]);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, pl.stride);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, pl.w, pl.h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, pl.data);
      });
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      const sub = /^I4(\d\d)/.exec(frame.format)?.[1];
      gl.uniform2f(u.u_chromaDiv, sub === '44' ? 1 : 2, sub === '20' ? 2 : 1);
      gl.uniform1f(u.u_maxCode, /P12$/.test(frame.format) ? 4095 : 1023);
      gl.uniform1i(u.u_srcKind, 1);
    } else {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.hdrTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, sw, sh, 0, gl.RGBA, gl.HALF_FLOAT, frame);
      for (let i = 0; i < 3; i++) {
        gl.activeTexture(gl.TEXTURE1 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.planeTex[i]);
      }
      gl.uniform1i(u.u_srcKind, 0);
      gl.uniform1f(u.u_maxCode, bitDepth >= 12 ? 4095 : 1023);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform4f(u.u_region, rx, ry, rw, rh);
    gl.uniform2f(u.u_size, sw, sh);
    gl.uniform1i(u.u_fullRange, colour.fullRange ? 1 : 0);
    const krkb: Record<string, [number, number]> = { 'bt2020-ncl': [0.2627, 0.0593], bt709: [0.2126, 0.0722], smpte170m: [0.299, 0.114], bt470bg: [0.299, 0.114], rgb: [0.2126, 0.0722] };
    const [kr, kb] = krkb[colour.matrix] || krkb.bt709;
    gl.uniform2f(u.u_krkb, kr, kb);
    gl.uniform1i(u.u_transfer, colour.transfer === 'pq' ? 1 : colour.transfer === 'hlg' ? 2 : 0);
    // Source primaries → BT.709 (column-major).
    const toRec709: Record<string, number[]> = {
      bt2020: [1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187],
      smpte432: [1.2249, -0.042, -0.0197, -0.2247, 1.0419, -0.0786, 0, 0, 1.0979]
    };
    gl.uniformMatrix3fv(u.u_gamut, false, toRec709[colour.primaries] || [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    gl.uniform1f(u.u_refWhite, 203);
    gl.uniform1f(u.u_knee, 0.75);
    // (Mastering peak isn't in most files' metadata Kea can read: 1000 nits is what HLG assumes and HDR10 is usually graded to.)
    gl.uniform1f(u.u_peak, 1000 / 203);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return out;
  }

  /** A named 16-bit float render target of this size (reused between frames). */
  private target(name: string, w: number, h: number): Target {
    const gl = this.gl;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    // Keyed by size too: two clips at different sizes each keep their own (re-making them every frame is slow).
    const key = `${name}:${w}x${h}`;
    let t = this.targets.get(key);
    if (t) {
      // Most recently used last, so the oldest go first when there are too many.
      this.targets.delete(key);
      this.targets.set(key, t);
      return t;
    }
    while (this.targets.size >= 32) {
      const [oldKey, old] = this.targets.entries().next().value as [string, Target];
      gl.deleteTexture(old.tex);
      gl.deleteFramebuffer(old.fb);
      this.targets.delete(oldKey);
    }
    const tex = this.tex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { tex, fb, w, h };
    this.targets.set(key, t);
    return t;
  }

  /** A render target owned by the caller (not in the shared pool). */
  private ownTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = this.tex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  private freeTarget(t: Target) {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  private bindTarget(t: Target | null, w?: number, h?: number) {
    const gl = this.gl;
    // Unbind everything from the texture units first: a texture still bound while it's also the render target
    // is a feedback loop, and WebGL refuses the draw even if the shader never reads it.
    if (t)
      for (let i = 0; i < 4; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : w!, t ? t.h : h!);
  }

  /**
   * Upload a picture as plain 8-bit (the shaders convert it to linear light). An sRGB texture format would do that
   * for free on the GPU, but Chrome then converts every upload on the processor (~150 ms for a 4K frame).
   */
  private upload(tex: WebGLTexture, src: TexImageSource, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  private lutTexture(key: string, size: number, data: Uint8Array) {
    const gl = this.gl;
    let t = this.lutTex.get(key);
    if (!t) {
      t = this.tex();
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size * size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.lutTex.set(key, t);
    }
    return t;
  }

  /**
   * Grade (or just convert) a picture into a linear 16-bit target: the sRGB source frame (straight alpha) when input
   * is null, else a resized layer (linear, premultiplied). crop: where this picture sits in the whole frame.
   */
  private gradeInto(dst: Target, input: Target | null, crop: [number, number, number, number], c: Clip | null, mask: TexImageSource | null, lut: { key: string; size: number; data: Uint8Array; amount: number } | null) {
    const gl = this.gl;
    const { p, u } = this.progs.grade;
    gl.useProgram(p);
    this.bindTarget(dst);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input ? input.tex : this.srcTex);
    gl.uniform1i(u.u_src, 0);
    gl.uniform1i(u.u_srcPremul, input ? 1 : 0);
    let maskOn = 0;
    if (mask) {
      try {
        this.upload(this.maskTex, mask, 1);
        gl.uniform1i(u.u_mask, 1);
        maskOn = 1;
      } catch {
        // A mask that won't upload is skipped rather than dropping the frame.
      }
    }
    gl.uniform1f(u.u_maskOn, maskOn);
    if (lut) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTexture(lut.key, lut.size, lut.data));
      gl.uniform1i(u.u_lut, 2);
      gl.uniform1f(u.u_lutSize, lut.size);
      gl.uniform1f(u.u_lutAmt, Math.max(0, Math.min(1, lut.amount / 100)));
    }
    gl.uniform1f(u.u_lutOn, lut ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    setGradeUniforms(gl, u, c ? c.colour : NEUTRAL_COLOUR, c ? c.key : NEUTRAL_KEY);
    gl.uniform4f(u.u_crop, crop[0], crop[1], crop[2], crop[3]);
    // (The source frame is the whole picture; a resized layer is just the cropped part.)
    if (input) gl.uniform4f(u.u_srcRect, crop[0], crop[1], crop[2], crop[3]);
    else gl.uniform4f(u.u_srcRect, 0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Shrink with Lanczos-3 to w×h. src: a layer (linear, premultiplied, whole texture), or the sRGB source frame with
   * the region (in its pixels, origin bottom-left) to use.
   */
  private resample(src: Target | { region: [number, number, number, number]; sw: number; sh: number }, w: number, h: number, name: string): Target {
    const gl = this.gl;
    const fromFrame = !('tex' in src);
    const [rx, ry, rw, rh] = 'tex' in src ? [0, 0, src.w, src.h] : src.region;
    const [tw, th] = 'tex' in src ? [src.w, src.h] : [src.sw, src.sh];
    const { p, u } = this.progs.resample;
    gl.useProgram(p);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.u_src, 0);
    // Horizontal: rows ry .. ry+rh of the input, the region's columns → w columns.
    const rows = Math.max(1, Math.round(rh));
    const mid = this.target(`${name}-h`, w, rows);
    this.bindTarget(mid);
    gl.bindTexture(gl.TEXTURE_2D, 'tex' in src ? src.tex : this.srcTex);
    gl.uniform2f(u.u_dir, 1, 0);
    gl.uniform1f(u.u_k, w / rw);
    gl.uniform1f(u.u_off, rx);
    gl.uniform1i(u.u_lo, Math.max(0, Math.floor(rx)));
    gl.uniform1i(u.u_hi, Math.min(tw - 1, Math.ceil(rx + rw) - 1));
    gl.uniform1i(u.u_rowOff, Math.max(0, Math.min(th - rows, Math.round(ry))));
    gl.uniform1i(u.u_premul, fromFrame ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Vertical: the w×rows result → w×h.
    const out = this.target(name, w, h);
    this.bindTarget(out);
    gl.bindTexture(gl.TEXTURE_2D, mid.tex);
    gl.uniform2f(u.u_dir, 0, 1);
    gl.uniform1f(u.u_k, h / rows);
    gl.uniform1f(u.u_off, 0);
    gl.uniform1i(u.u_lo, 0);
    gl.uniform1i(u.u_hi, rows - 1);
    gl.uniform1i(u.u_rowOff, 0);
    gl.uniform1i(u.u_premul, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return out;
  }

  private blur(src: Target, sigma: number, pad: number, name: string): Target {
    const gl = this.gl;
    const { p, u } = this.progs.blur;
    gl.useProgram(p);
    gl.disable(gl.BLEND);
    gl.uniform1i(u.u_src, 0);
    gl.uniform1f(u.u_sigma, sigma);
    gl.activeTexture(gl.TEXTURE0);
    const a = this.target(`${name}-a`, src.w + 2 * pad, src.h + 2 * pad);
    this.bindTarget(a);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(u.u_dir, 1, 0);
    gl.uniform2f(u.u_pad, pad, pad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const b = this.target(`${name}-b`, a.w, a.h);
    this.bindTarget(b);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform2f(u.u_dir, 0, 1);
    gl.uniform2f(u.u_pad, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return b;
  }

  /** Composite a layer onto the frame. m maps the unit square (x right, y down) to output pixels. */
  private composite(
    acc: Target,
    accCopy: Target,
    layer: Target,
    m: number[],
    o: { alpha: number; blend: BlendMode; bicubic: boolean; pad: [number, number]; mod: LayerMod; outW: number; outH: number; scale: number; W: number; H: number }
  ) {
    const gl = this.gl;
    const mode = Math.max(0, BLEND_MODES.indexOf(o.blend));
    if (mode > 0) {
      // Blend modes read what's underneath: take a copy of the frame so far.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, acc.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, accCopy.fb);
      gl.blitFramebuffer(0, 0, acc.w, acc.h, 0, 0, acc.w, acc.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    const { p, u } = this.progs.comp;
    gl.useProgram(p);
    this.bindTarget(acc);
    if (mode === 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layer.tex);
    gl.uniform1i(u.u_layer, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, accCopy.tex);
    gl.uniform1i(u.u_dst, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniformMatrix3fv(u.u_m, false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
    gl.uniform2f(u.u_out, o.outW, o.outH);
    gl.uniform2f(u.u_pad, o.pad[0], o.pad[1]);
    gl.uniform1i(u.u_bicubic, o.bicubic ? 1 : 0);
    gl.uniform1i(u.u_mode, mode);
    gl.uniform1f(u.u_alpha, o.alpha);
    const [x0, x1] = o.mod.clipX || [0, 1];
    const [y0, y1] = o.mod.clipY || [0, 1];
    gl.uniform4f(u.u_clip, x0, y0, x1, y1);
    gl.uniform1f(u.u_iris, o.mod.iris === undefined ? -1 : (o.mod.iris * Math.hypot(o.W, o.H) * o.scale) / 2);
    gl.uniform2f(u.u_center, o.outW / 2, o.outH / 2);
    gl.uniform1i(u.u_linearMix, this.linearMix ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** A flat colour in the space the frame is mixed in. */
  private colourOf(hex: string): [number, number, number] {
    return this.linearMix ? linearOf(hex) : hexRgb(hex);
  }

  private fill(t: Target, rgb: [number, number, number], alpha: number) {
    const gl = this.gl;
    const { p, u } = this.progs.fill;
    gl.useProgram(p);
    this.bindTarget(t);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(u.u_color, rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha, alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private rasterCtx(w: number, h: number) {
    if (!this.raster2d) this.raster2d = document.createElement('canvas').getContext('2d', { willReadFrequently: false })!;
    const c = this.raster2d.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    } else this.raster2d.clearRect(0, 0, w, h);
    return this.raster2d;
  }

  /** Render one frame at outW×outH. Returns the canvas holding it (8-bit, dithered). */
  render(o: GpuFrameSource, h: GpuHelpers, outW: number, outH: number): HTMLCanvasElement {
    const gl = this.gl;
    const { project: p, t, scale } = o;
    const W = p.settings.width;
    const H = p.settings.height;
    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW;
      this.canvas.height = outH;
    }
    this.mark('start');
    const acc = this.target('acc', outW, outH);
    const accCopy = this.target('acc-copy', outW, outH);
    this.bindTarget(acc);
    const bg = this.colourOf(p.settings.background || '#000000');
    gl.disable(gl.BLEND);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const base = { outW, outH, scale, W, H };

    for (const layers of h.layers(p, t)) {
      let dip: LayerMod['dip'];
      for (const { clip: c, mod } of layers) {
        if (mod.dip) dip = mod.dip;
        if (mod.hidden) continue;
        const frame = c.kind === 'media' ? o.getFrame(c, h.frameTime(p, c, t)) : null;
        if (c.kind !== 'media' || frame === 'offline') {
          // Text, shapes and offline placeholders: drawn by the 2D renderer (with their own transform, opacity, clip
          // and iris), then composited with the clip's blend mode. A clip that looks the same as last frame (most
          // titles) reuses its picture: drawing and uploading a full frame is the slowest part.
          const key = frame === 'offline' ? `offline:${c.id}:${outW}x${outH}` : h.rasterKey(c, mod);
          let cached = this.rasterCache.get(c.id);
          if (!cached || cached.key !== key || cached.target.w !== outW || cached.target.h !== outH) {
            const ctx = this.rasterCtx(outW, outH);
            h.raster(ctx, { ...c, blend: 'normal' }, mod);
            this.mark('raster2d');
            this.upload(this.srcTex, ctx.canvas, 0);
            this.mark('rasterUpload');
            const target = cached && cached.target.w === outW && cached.target.h === outH ? cached.target : this.ownTarget(outW, outH);
            if (cached && cached.target !== target) this.freeTarget(cached.target);
            this.gradeInto(target, null, [0, 0, 1, 1], null, null, null);
            cached = { key, target, used: this.frameNo };
            this.rasterCache.set(c.id, cached);
          }
          cached.used = this.frameNo;
          const lay = cached.target;
          this.composite(acc, accCopy, lay, [outW, 0, 0, outH, 0, 0], { ...base, alpha: 1, blend: c.blend, bicubic: false, pad: [0, 0], mod: {} as LayerMod });
          this.mark('rasterComposite');
          continue;
        }
        if (!frame) continue;
        this.drawMedia(o, h, c, mod, frame, acc, accCopy, base);
      }
      if (dip && dip.alpha > 0) this.fill(acc, this.colourOf(dip.color), Math.min(1, dip.alpha));
    }

    // Forget pictures of clips not seen for a while (deleted, or far from the playhead).
    this.frameNo++;
    for (const [id, e] of this.rasterCache)
      if (this.frameNo - e.used > 120) {
        this.freeTarget(e.target);
        this.rasterCache.delete(id);
      }

    // Out to 8-bit display colour, dithered.
    const { p: op, u } = this.progs.out;
    gl.useProgram(op);
    this.bindTarget(null, outW, outH);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, acc.tex);
    gl.uniform1i(u.u_src, 0);
    gl.uniform1f(u.u_seed, (t * 7.31) % 1);
    gl.uniform1i(u.u_dither, this.dither ? 1 : 0);
    gl.uniform1i(u.u_linearMix, this.linearMix ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.mark('output');
    return this.canvas;
  }

  private drawMedia(o: GpuFrameSource, h: GpuHelpers, c: Clip, mod: LayerMod, frame: Drawable, acc: Target, accCopy: Target, base: { outW: number; outH: number; scale: number; W: number; H: number }) {
    const { project: p, t, scale } = o;
    const { W, H } = base;
    const alpha = (propAt(c, 'opacity', t) / 100) * mod.alpha;
    if (alpha <= 0.001) return;
    const m = mediaOf(p, c);
    const [mw, mh] = m && m.width ? [m.width, m.height] : [W, H];
    const fit = Math.min(W / mw, H / mh);
    const dw = mw * fit;
    const dh = mh * fit;
    const [sw, sh] = h.sizeOf(frame);
    if (!sw || !sh) return;
    const l = c.crop.left / 100;
    const r = c.crop.right / 100;
    const tp = c.crop.top / 100;
    const b = c.crop.bottom / 100;
    if (l + r >= 1 || tp + b >= 1) return;
    const s = (propAt(c, 'scale', t) / 100) * mod.scale;
    if (Math.abs(s) < 1e-6) return;

    // 1. Upload the frame. 8-bit SDR goes up as is (display colour); HDR and 10-bit footage goes through the input
    //    stage, which turns it into linear BT.709 light (tone-mapped to SDR) at full precision.
    const cw0 = sw * (1 - l - r);
    const ch0 = sh * (1 - tp - b);
    const colour = (m && (m.colour || knownColour(mediaKey(m)))) || null;
    // (Projects saved before Kea recorded colour: look the file up now; the next frame uses it.)
    if (m && m.kind === 'video' && !m.colour && knownColour(mediaKey(m)) === undefined) colourOf(mediaKey(m)).catch(() => {});
    let input: Target | null = null;
    try {
      if (isYuv(frame)) input = this.inputPass(frame, sw, sh, [l * sw, tp * sh, cw0, ch0], frame.colour.transfer ? (frame.colour as any) : colour || { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }, 10);
      // (Only a <video> element or a decoded frame still carries the HDR signal; a canvas was already tone-mapped by
      // the browser when it was drawn, so it's treated as ordinary 8-bit colour.)
      else if (colour?.hdr && (frame instanceof HTMLVideoElement || (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame))) input = this.inputPass(frame, sw, sh, [l * sw, tp * sh, cw0, ch0], colour, colour.bitDepth);
      else this.upload(this.srcTex, frame as TexImageSource, 0);
    } catch {
      return;
    }
    this.mark('frameUpload');
    const crop: [number, number, number, number] = [l, b, 1 - r, 1 - tp];
    const mask = c.removeBg?.enabled && m ? maskAt(mediaKey(m), h.frameTime(p, c, t)) : null;
    let lut: { key: string; size: number; data: Uint8Array; amount: number } | null = null;
    if (c.lut) {
      const lt = getLut(c.lut.path);
      if (lt) lut = { key: c.lut.path, size: lt.size, data: lt.data, amount: c.lut.amount };
      else loadLut(c.lut.path).catch(() => {}); // the preview redraws when it arrives
    }

    // 2. Shrinking: Lanczos straight from the frame to the size it's shown, then grade at that size (as Resolve
    //    does: scale, then grade at timeline resolution). Otherwise grade at the frame's own size (at most 4096 px)
    //    and let the bicubic sampler enlarge it.
    const shownW = dw * (1 - l - r) * Math.abs(s) * scale; // output pixels across
    let k = shownW / cw0;
    let layer: Target;
    if (k < 0.9 && o.fast && !input) {
      // Playback: let the GPU build mipmaps of the frame and grade straight from them at the size it's shown
      // (one cheap pass instead of a two-pass Lanczos over the full frame).
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      layer = this.target('graded', Math.max(1, Math.round(cw0 * k)), Math.max(1, Math.round(ch0 * k)));
      this.gradeInto(layer, null, crop, c, mask as TexImageSource | null, lut);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    } else if (k < 0.9) {
      // (From the input stage the crop is already applied: shrink its whole layer.)
      const region = input ?? { region: [l * sw, b * sh, cw0, ch0] as [number, number, number, number], sw, sh };
      let shrunk: Target | null = null;
      // (Big shrinks go in quarter steps first, so the filter never needs more than ~50 taps.)
      for (let n = 0; k < 0.125; n++, k *= 4) {
        const fw = shrunk ? shrunk.w : input ? input.w : cw0;
        const fh = shrunk ? shrunk.h : input ? input.h : ch0;
        shrunk = this.resample(shrunk ?? region, Math.max(1, Math.round(fw / 4)), Math.max(1, Math.round(fh / 4)), `quarter${n}`);
      }
      const fw = shrunk ? shrunk.w : input ? input.w : cw0;
      const fh = shrunk ? shrunk.h : input ? input.h : ch0;
      shrunk = this.resample(shrunk ?? region, Math.max(1, Math.round(fw * k)), Math.max(1, Math.round(fh * k)), 'shrunk');
      this.mark('resample');
      layer = this.target('graded', shrunk.w, shrunk.h);
      this.gradeInto(layer, shrunk, crop, c, mask as TexImageSource | null, lut);
    } else {
      const cap = Math.min(1, 4096 / Math.max(cw0, ch0));
      layer = this.target('graded', cw0 * cap, ch0 * cap);
      this.gradeInto(layer, input, crop, c, mask as TexImageSource | null, lut);
    }
    this.mark('grade');

    // 3. Blur in linear light, with room around the picture for it to spread.
    let padFrac: [number, number] = [0, 0];
    const blurOut = (propAt(c, 'blur', t) + (mod.blur || 0)) * scale * Math.abs(s); // sigma in output pixels
    if (blurOut > 0.3) {
      const sigma = blurOut * (layer.w / shownW);
      const pad = Math.ceil(sigma * 3);
      layer = this.blur(layer, sigma, pad, 'blur');
      padFrac = [pad / (layer.w - 2 * pad), pad / (layer.h - 2 * pad)];
    }

    // 4. Place it: centre + offsets, rotation, scale and flips, in output pixels.
    const x0 = -dw / 2 + dw * l;
    const y0 = -dh / 2 + dh * tp;
    const lw = dw * (1 - l - r);
    const lh = dh * (1 - tp - b);
    const rot = (propAt(c, 'rotation', t) * Math.PI) / 180;
    const sx = s * (c.props.flipH ? -1 : 1);
    const sy = s * (c.props.flipV ? -1 : 1);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const cx = W / 2 + propAt(c, 'x', t) + mod.dx;
    const cy = H / 2 + propAt(c, 'y', t) + (mod.dy || 0);
    // Local (unit square → layer rect, padding included) → rotate·scale → translate, all × output scale.
    const ux = lw * (1 + 2 * padFrac[0]);
    const uy = lh * (1 + 2 * padFrac[1]);
    const ox = x0 - lw * padFrac[0];
    const oy = y0 - lh * padFrac[1];
    const a = cos * sx;
    const bb = sin * sx;
    const cc = -sin * sy;
    const d = cos * sy;
    const mtx = [scale * a * ux, scale * bb * ux, scale * cc * uy, scale * d * uy, scale * (a * ox + cc * oy + cx), scale * (bb * ox + d * oy + cy)];
    // Edge padding for anti-aliasing: 1.5 output pixels in unit-square terms.
    const shownH = lh * Math.abs(s) * scale;
    const aa: [number, number] = [1.5 / Math.max(1, shownW * (1 + 2 * padFrac[0])), 1.5 / Math.max(1, shownH * (1 + 2 * padFrac[1]))];
    const enlarged = shownW / Math.max(1, layer.w * (1 / (1 + 2 * padFrac[0]))) > 1.1;
    this.composite(acc, accCopy, layer, mtx, { ...base, alpha, blend: c.blend, bicubic: enlarged, pad: aa, mod });
    this.mark('composite');
  }
}
