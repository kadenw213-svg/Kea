/**
 * Spot healing, simplified: the painted area is filled smoothly from its surroundings
 * (membrane interpolation), then given texture copied from the best-matching nearby
 * patch, and blended in with the brush's soft edge. Not Photoshop's content-aware fill,
 * but it removes dust, spots and small blemishes convincingly.
 */

/**
 * `px`: RGBA of the region (edited in place). `mask`: 0–255 weight per pixel of what to heal.
 * Pixels outside the region must already be reasonable context (the caller pads the region).
 */
export function healRegion(px: Uint8ClampedArray, mask: Uint8Array, w: number, h: number) {
  const n = w * h;
  const hole = new Uint8Array(n);
  let cnt = 0;
  for (let p = 0; p < n; p++)
    if (mask[p] > 8) {
      hole[p] = 1;
      cnt++;
    }
  if (!cnt) return;

  // 1) Smooth fill: start from the average border colour, relax towards a membrane.
  const f = new Float32Array(n * 3);
  let br = 0,
    bg = 0,
    bb = 0,
    bn = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (hole[p]) continue;
      const near = (x > 0 && hole[p - 1]) || (x < w - 1 && hole[p + 1]) || (y > 0 && hole[p - w]) || (y < h - 1 && hole[p + w]);
      if (near) {
        br += px[p * 4];
        bg += px[p * 4 + 1];
        bb += px[p * 4 + 2];
        bn++;
      }
    }
  bn = Math.max(1, bn);
  for (let p = 0; p < n; p++) {
    if (hole[p]) {
      f[p * 3] = br / bn;
      f[p * 3 + 1] = bg / bn;
      f[p * 3 + 2] = bb / bn;
    } else {
      f[p * 3] = px[p * 4];
      f[p * 3 + 1] = px[p * 4 + 1];
      f[p * 3 + 2] = px[p * 4 + 2];
    }
  }
  const iters = Math.min(400, 40 + Math.round(Math.sqrt(cnt) * 4));
  for (let it = 0; it < iters; it++) {
    // Red-black ordering converges about twice as fast as plain Jacobi.
    for (let parity = 0; parity < 2; parity++)
      for (let y = 1; y < h - 1; y++)
        for (let x = 1 + ((y + parity) & 1); x < w - 1; x += 2) {
          const p = y * w + x;
          if (!hole[p]) continue;
          for (let c = 0; c < 3; c++) f[p * 3 + c] = (f[(p - 1) * 3 + c] + f[(p + 1) * 3 + c] + f[(p - w) * 3 + c] + f[(p + w) * 3 + c]) / 4;
        }
  }

  // 2) Texture: take detail (pixel minus local average) from the best nearby patch.
  let x0 = w,
    y0 = h,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (hole[y * w + x]) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  const bw = x1 - x0 + 1,
    bh = y1 - y0 + 1;
  const local = boxMean(px, w, h, Math.max(2, Math.round(Math.min(bw, bh) / 4)));
  let best: [number, number] | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const dx = Math.round(Math.cos(a) * (bw + 4)),
      dy = Math.round(Math.sin(a) * (bh + 4));
    if (x0 + dx < 0 || y0 + dy < 0 || x1 + dx >= w || y1 + dy >= h) continue;
    // Prefer a patch whose own pixels look like the smooth fill and that isn't inside the hole.
    let score = 0,
      m = 0;
    for (let y = y0; y <= y1; y += 2)
      for (let x = x0; x <= x1; x += 2) {
        const p = y * w + x,
          q = (y + dy) * w + x + dx;
        if (hole[q]) score += 1e4;
        for (let c = 0; c < 3; c++) score += Math.abs(px[q * 4 + c] - f[p * 3 + c]);
        m++;
      }
    score /= Math.max(1, m);
    if (score < bestScore) {
      bestScore = score;
      best = [dx, dy];
    }
  }

  for (let p = 0; p < n; p++) {
    if (!hole[p]) continue;
    const k = mask[p] / 255;
    let detail = [0, 0, 0];
    if (best) {
      const q = p + best[1] * w + best[0];
      detail = [0, 1, 2].map((c) => px[q * 4 + c] - local[q * 3 + c]);
    }
    for (let c = 0; c < 3; c++) {
      const v = f[p * 3 + c] + detail[c];
      px[p * 4 + c] = px[p * 4 + c] + (v - px[p * 4 + c]) * k;
    }
  }
}

/** Local average (box) of RGB, used to separate texture from colour. */
function boxMean(px: Uint8ClampedArray, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h * 3),
    out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += px[(y * w + Math.min(w - 1, Math.max(0, k))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = s / (2 * r + 1);
        s += px[(y * w + Math.min(w - 1, x + r + 1)) * 4 + c] - px[(y * w + Math.max(0, x - r)) * 4 + c];
      }
    }
  for (let x = 0; x < w; x++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = s / (2 * r + 1);
        s += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 3 + c] - tmp[(Math.max(0, y - r) * w + x) * 3 + c];
      }
    }
  return out;
}
