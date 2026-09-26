// Tiny block-based video codec simulator.
// It mimics what an MPEG-style encoder/decoder does (motion estimation, motion
// compensation, 8x8 DCT residual quantization) so that glitches such as a lost
// I-frame (datamosh) or lost packets (macroblocking) look like the real thing.
// All planes are stored as full-resolution YCbCr (BT.601 full range), padded to
// a multiple of 32 pixels in each direction.

export const PAD = 32;

export class Planes {
  constructor(pw, ph) {
    this.pw = pw;
    this.ph = ph;
    const n = pw * ph;
    this.Y = new Uint8ClampedArray(n);
    this.U = new Uint8ClampedArray(n);
    this.V = new Uint8ClampedArray(n);
  }
  copyFrom(o) {
    this.Y.set(o.Y);
    this.U.set(o.U);
    this.V.set(o.V);
    return this;
  }
  clone() {
    return new Planes(this.pw, this.ph).copyFrom(this);
  }
  fill(y, u, v) {
    this.Y.fill(y);
    this.U.fill(u);
    this.V.fill(v);
    return this;
  }
  snapshot() {
    return { Y: this.Y.slice(), U: this.U.slice(), V: this.V.slice() };
  }
  restore(s) {
    this.Y.set(s.Y);
    this.U.set(s.U);
    this.V.set(s.V);
  }
}

export function padSize(v) {
  return Math.ceil(v / PAD) * PAD;
}

// ---------------------------------------------------------------- color

export function rgbaToPlanes(rgba, w, h, P) {
  const { pw, ph, Y, U, V } = P;
  for (let y = 0; y < h; y++) {
    let si = y * w * 4;
    let di = y * pw;
    for (let x = 0; x < w; x++, si += 4, di++) {
      const r = rgba[si], g = rgba[si + 1], b = rgba[si + 2];
      Y[di] = 0.299 * r + 0.587 * g + 0.114 * b;
      U[di] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      V[di] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    // replicate the right edge into the padding
    const last = y * pw + w - 1;
    for (let x = w; x < pw; x++) {
      Y[y * pw + x] = Y[last];
      U[y * pw + x] = U[last];
      V[y * pw + x] = V[last];
    }
  }
  // replicate the bottom edge
  const lastRow = (h - 1) * pw;
  for (let y = h; y < ph; y++) {
    Y.copyWithin(y * pw, lastRow, lastRow + pw);
    U.copyWithin(y * pw, lastRow, lastRow + pw);
    V.copyWithin(y * pw, lastRow, lastRow + pw);
  }
}

export function planesToRgba(P, w, h, rgba) {
  const { pw, Y, U, V } = P;
  for (let y = 0; y < h; y++) {
    let si = y * pw;
    let di = y * w * 4;
    for (let x = 0; x < w; x++, si++, di += 4) {
      const yy = Y[si], cb = U[si] - 128, cr = V[si] - 128;
      rgba[di] = yy + 1.402 * cr;
      rgba[di + 1] = yy - 0.344136 * cb - 0.714136 * cr;
      rgba[di + 2] = yy + 1.772 * cb;
      rgba[di + 3] = 255;
    }
  }
}

// ---------------------------------------------------------------- DCT
// Fast float AAN DCT (same algorithm as libjpeg's jfdctflt / jidctflt).
// fdct() output is scaled by 8*aan[u]*aan[v]; idct() expects input scaled by
// aan[u]*aan[v]/8. The scale factors are folded into the quantizer tables.

const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379];
const FWD = new Float32Array(64); // coefficient -> orthonormal DCT value
const INV = new Float32Array(64); // orthonormal DCT value -> idct input
for (let v = 0; v < 8; v++) {
  for (let u = 0; u < 8; u++) {
    FWD[v * 8 + u] = 1 / (8 * AAN[u] * AAN[v]);
    INV[v * 8 + u] = (AAN[u] * AAN[v]) / 8;
  }
}

function fdct(d) {
  for (let pass = 0; pass < 2; pass++) {
    const stride = pass === 0 ? 1 : 8;
    const step = pass === 0 ? 8 : 1;
    for (let k = 0, o = 0; k < 8; k++, o += step) {
      const i0 = o, i1 = o + stride, i2 = o + 2 * stride, i3 = o + 3 * stride;
      const i4 = o + 4 * stride, i5 = o + 5 * stride, i6 = o + 6 * stride, i7 = o + 7 * stride;
      const t0 = d[i0] + d[i7], t7 = d[i0] - d[i7];
      const t1 = d[i1] + d[i6], t6 = d[i1] - d[i6];
      const t2 = d[i2] + d[i5], t5 = d[i2] - d[i5];
      const t3 = d[i3] + d[i4], t4 = d[i3] - d[i4];
      let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      d[i0] = t10 + t11;
      d[i4] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      d[i2] = t13 + z1;
      d[i6] = t13 - z1;
      t10 = t4 + t5;
      t11 = t5 + t6;
      t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433;
      const z2 = 0.5411961 * t10 + z5;
      const z4 = 1.306562965 * t12 + z5;
      const z3 = t11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      d[i5] = z13 + z2;
      d[i3] = z13 - z2;
      d[i1] = z11 + z4;
      d[i7] = z11 - z4;
    }
  }
}

function idct(d) {
  for (let pass = 0; pass < 2; pass++) {
    const stride = pass === 0 ? 8 : 1;
    const step = pass === 0 ? 1 : 8;
    for (let k = 0, o = 0; k < 8; k++, o += step) {
      const i0 = o, i1 = o + stride, i2 = o + 2 * stride, i3 = o + 3 * stride;
      const i4 = o + 4 * stride, i5 = o + 5 * stride, i6 = o + 6 * stride, i7 = o + 7 * stride;
      let t0 = d[i0], t1 = d[i2], t2 = d[i4], t3 = d[i6];
      let t10 = t0 + t2, t11 = t0 - t2;
      let t13 = t1 + t3, t12 = (t1 - t3) * 1.414213562 - t13;
      t0 = t10 + t13;
      t3 = t10 - t13;
      t1 = t11 + t12;
      t2 = t11 - t12;
      let t4 = d[i1], t5 = d[i3], t6 = d[i5], t7 = d[i7];
      const z13 = t6 + t5, z10 = t6 - t5, z11 = t4 + t7, z12 = t4 - t7;
      t7 = z11 + z13;
      t11 = (z11 - z13) * 1.414213562;
      const z5 = (z10 + z12) * 1.847759065;
      t10 = 1.0823922 * z12 - z5;
      t12 = -2.61312593 * z10 + z5;
      t6 = t12 - t7;
      t5 = t11 - t6;
      t4 = t10 + t5;
      d[i0] = t0 + t7;
      d[i7] = t0 - t7;
      d[i1] = t1 + t6;
      d[i6] = t1 - t6;
      d[i2] = t2 + t5;
      d[i5] = t2 - t5;
      d[i4] = t3 + t4;
      d[i3] = t3 - t4;
    }
  }
}

// exported for tests
export function dctRoundTrip(block) {
  const b = Float32Array.from(block);
  fdct(b);
  const ortho = Array.from(b, (v, i) => v * FWD[i]);
  for (let i = 0; i < 64; i++) b[i] = ortho[i] * INV[i];
  idct(b);
  return { ortho, back: Array.from(b) };
}

// JPEG base tables (normalised so that DC == 1)
const JPEG_Y = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const JPEG_C = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** quality 0..100 -> quantizer step for a DC coefficient */
export function qualityToStep(quality) {
  const q = Math.max(0, Math.min(100, quality));
  return 0.6 * Math.pow(2, (100 - q) / 11.5);
}

/** per-coefficient tables: `r` maps raw fdct output to levels, `d` maps levels to idct input */
function makeTable() {
  return { r: new Float32Array(64), d: new Float32Array(64), min: 0 };
}

export class QuantTables {
  constructor() {
    this.step = -1;
    this.y = makeTable();
    this.c = makeTable();
  }
  set(step) {
    if (step === this.step) return;
    this.step = step;
    // flatten the weighting a little for small steps so high quality is really high quality
    const flat = Math.min(1, step / 12);
    let minY = Infinity, minC = Infinity;
    for (let i = 0; i < 64; i++) {
      const qy = Math.max(0.5, step * (1 + (JPEG_Y[i] / 16 - 1) * flat));
      const qc = Math.max(0.5, step * 1.2 * (1 + (JPEG_C[i] / 17 - 1) * flat));
      this.y.r[i] = FWD[i] / qy;
      this.y.d[i] = qy * INV[i];
      this.c.r[i] = FWD[i] / qc;
      this.c.d[i] = qc * INV[i];
      if (qy < minY) minY = qy;
      if (qc < minC) minC = qc;
    }
    this.y.min = minY;
    this.c.min = minC;
  }
}

const blk = new Float32Array(64);

/** quantize one 8x8 block already loaded in `blk`; returns false if it became all zero */
function quantizeLoaded(t, rnd) {
  fdct(blk);
  const r = t.r, dq = t.d;
  let nz = false;
  for (let i = 0; i < 64; i++) {
    const f = blk[i] * r[i];
    const l = f < 0 ? -Math.floor(rnd - f) : Math.floor(f + rnd);
    if (l !== 0) {
      nz = true;
      blk[i] = l * dq[i];
    } else blk[i] = 0;
  }
  if (nz) idct(blk);
  return nz;
}

/** quantize an 8x8 luma-style block of `res` (stride pw) in place */
export function quantLumaBlock(res, pw, x0, y0, t, rnd) {
  let sumAbs = 0;
  for (let y = 0; y < 8; y++) {
    const r = (y0 + y) * pw + x0;
    for (let x = 0; x < 8; x++) {
      const v = res[r + x];
      blk[y * 8 + x] = v;
      sumAbs += v < 0 ? -v : v;
    }
  }
  if (0.25 * sumAbs < (1 - rnd) * t.min) {
    for (let y = 0; y < 8; y++) res.fill(0, (y0 + y) * pw + x0, (y0 + y) * pw + x0 + 8);
    return;
  }
  const nz = quantizeLoaded(t, rnd);
  for (let y = 0; y < 8; y++) {
    const r = (y0 + y) * pw + x0;
    if (!nz) res.fill(0, r, r + 8);
    else for (let x = 0; x < 8; x++) res[r + x] = blk[y * 8 + x];
  }
}

/** quantize a 16x16 chroma area of `res` subsampled 2x2 (4:2:0 style) in place */
export function quantChromaArea(res, pw, x0, y0, t, rnd) {
  let sumAbs = 0;
  for (let y = 0; y < 8; y++) {
    const r0 = (y0 + 2 * y) * pw + x0;
    const r1 = r0 + pw;
    for (let x = 0; x < 8; x++) {
      const v = 0.25 * (res[r0 + 2 * x] + res[r0 + 2 * x + 1] + res[r1 + 2 * x] + res[r1 + 2 * x + 1]);
      blk[y * 8 + x] = v;
      sumAbs += v < 0 ? -v : v;
    }
  }
  let nz = false;
  if (0.25 * sumAbs >= (1 - rnd) * t.min) nz = quantizeLoaded(t, rnd);
  for (let y = 0; y < 16; y++) {
    const r = (y0 + y) * pw + x0;
    if (!nz) res.fill(0, r, r + 16);
    else {
      const br = (y >> 1) * 8;
      for (let x = 0; x < 16; x++) res[r + x] = blk[br + (x >> 1)];
    }
  }
}

/** fills an 8x8 block of a plane with random DCT garbage (corrupt bitstream look) */
export function garbageBlock(plane, pw, x0, y0, rng, amp, base) {
  for (let i = 0; i < 64; i++) blk[i] = 0;
  blk[0] = (rng() - 0.5) * amp * 8;
  const n = 1 + Math.floor(rng() * 5);
  for (let k = 0; k < n; k++) {
    const u = Math.floor(rng() * rng() * 8), v = Math.floor(rng() * rng() * 8);
    blk[v * 8 + u] += (rng() - 0.5) * amp * 5;
  }
  for (let i = 0; i < 64; i++) blk[i] *= INV[i];
  idct(blk);
  for (let y = 0; y < 8; y++) {
    const r = (y0 + y) * pw + x0;
    for (let x = 0; x < 8; x++) plane[r + x] = base + blk[y * 8 + x];
  }
}

// ---------------------------------------------------------------- block ops

/** motion compensated copy of one block, clamping reads to the frame */
export function mcBlock(dst, src, pw, ph, x0, y0, bw, bh, dx, dy) {
  const sx0 = x0 + dx;
  const inside = sx0 >= 0 && sx0 + bw <= pw;
  for (let y = 0; y < bh; y++) {
    let sy = y0 + y + dy;
    if (sy < 0) sy = 0;
    else if (sy >= ph) sy = ph - 1;
    const d = (y0 + y) * pw + x0;
    const s = sy * pw;
    if (inside) {
      const o = s + sx0 - d;
      for (let x = d, e = d + bw; x < e; x++) dst[x] = src[x + o];
    } else {
      for (let x = 0; x < bw; x++) {
        let sx = sx0 + x;
        if (sx < 0) sx = 0;
        else if (sx >= pw) sx = pw - 1;
        dst[d + x] = src[s + sx];
      }
    }
  }
}

export function mcBlock3(dst, src, x0, y0, bw, bh, dx, dy) {
  const { pw, ph } = dst;
  mcBlock(dst.Y, src.Y, pw, ph, x0, y0, bw, bh, dx, dy);
  mcBlock(dst.U, src.U, pw, ph, x0, y0, bw, bh, dx, dy);
  mcBlock(dst.V, src.V, pw, ph, x0, y0, bw, bh, dx, dy);
}

export function fillBlock3(dst, x0, y0, bw, bh, y, u, v) {
  const pw = dst.pw;
  for (let j = 0; j < bh; j++) {
    const d = (y0 + j) * pw + x0;
    dst.Y.fill(y, d, d + bw);
    dst.U.fill(u, d, d + bw);
    dst.V.fill(v, d, d + bw);
  }
}

export function copyBlock3(dst, src, x0, y0, bw, bh) {
  const pw = dst.pw;
  const DY = dst.Y, DU = dst.U, DV = dst.V, SY = src.Y, SU = src.U, SV = src.V;
  for (let j = 0; j < bh; j++) {
    for (let i = (y0 + j) * pw + x0, e = i + bw; i < e; i++) {
      DY[i] = SY[i];
      DU[i] = SU[i];
      DV[i] = SV[i];
    }
  }
}

/** dst = pred + k * res (for one block, all planes). dst may be pred. */
export function addResBlock3(dst, pred, res, x0, y0, bw, bh, k) {
  const pw = dst.pw;
  const planes = ['Y', 'U', 'V'];
  for (let p = 0; p < 3; p++) {
    const D = dst[planes[p]], P = pred[planes[p]], R = res[planes[p]];
    for (let j = 0; j < bh; j++) {
      let i = (y0 + j) * pw + x0;
      const e = i + bw;
      if (k === 1) for (; i < e; i++) D[i] = P[i] + R[i];
      else for (; i < e; i++) D[i] = P[i] + k * R[i];
    }
  }
}

function downsample2(src, pw, ph, dst) {
  const w2 = pw >> 1, h2 = ph >> 1;
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * pw, r1 = r0 + pw, d = y * w2;
    for (let x = 0; x < w2; x++) {
      const s = 2 * x;
      dst[d + x] = (src[r0 + s] + src[r0 + s + 1] + src[r1 + s] + src[r1 + s + 1] + 2) >> 2;
    }
  }
}

function sad(cur, ref, w, x0, y0, rx, ry, bs, limit) {
  let s = 0;
  for (let y = 0; y < bs; y++) {
    let ci = (y0 + y) * w + x0;
    let ri = (ry + y) * w + rx;
    const e = ci + bs;
    for (; ci < e; ci++, ri++) {
      const d = cur[ci] - ref[ri];
      s += d < 0 ? -d : d;
    }
    if (s >= limit) return s;
  }
  return s;
}

const LDSP = [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const SDSP = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const REFINE = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// ---------------------------------------------------------------- encoder

export const MODE_INTER = 0;
export const MODE_INTRA = 1;

/**
 * Closed-loop encoder model. `enc` holds the encoder's reconstructed reference.
 * encode() fills per-macroblock modes / motion vectors and the quantized
 * residual `res` (relative to the prediction), then updates `enc`.
 */
export class Encoder {
  constructor(pw, ph, mb) {
    this.pw = pw;
    this.ph = ph;
    this.mb = mb;
    this.cols = pw / mb;
    this.rows = ph / mb;
    const n = this.cols * this.rows;
    this.n = n;
    this.enc = new Planes(pw, ph);
    this.pred = new Planes(pw, ph);
    const np = pw * ph;
    this.res = { Y: new Float32Array(np), U: new Float32Array(np), V: new Float32Array(np) };
    this.mode = new Uint8Array(n);
    this.mvx = new Int16Array(n);
    this.mvy = new Int16Array(n);
    this.mvxH = new Int16Array(n);
    this.mvyH = new Int16Array(n);
    this.pmvxH = new Int16Array(n);
    this.pmvyH = new Int16Array(n);
    this.sadArr = new Float32Array(n);
    this.goodH = new Uint8Array(n);
    this.curH = new Uint8Array((pw >> 1) * (ph >> 1));
    this.refH = new Uint8Array((pw >> 1) * (ph >> 1));
    this.q = new QuantTables();
  }

  snapshot() {
    return {
      enc: this.enc.snapshot(),
      pmvxH: this.pmvxH.slice(),
      pmvyH: this.pmvyH.slice(),
    };
  }
  restore(s) {
    this.enc.restore(s.enc);
    this.pmvxH.set(s.pmvxH);
    this.pmvyH.set(s.pmvyH);
  }

  /** set the reference as if an I-frame had been decoded perfectly */
  setReference(planes) {
    this.enc.copyFrom(planes);
    this.pmvxH.fill(0);
    this.pmvyH.fill(0);
  }

  motionSearch(cur) {
    const { pw, ph, mb, cols, rows } = this;
    const w2 = pw >> 1, h2 = ph >> 1, bs = mb >> 1;
    downsample2(cur.Y, pw, ph, this.curH);
    downsample2(this.enc.Y, pw, ph, this.refH);
    const curH = this.curH, refH = this.refH;
    const mvxH = this.mvxH, mvyH = this.mvyH;
    const range = 32;
    const lambda = (bs * bs) / 12;
    const cand = new Int16Array(10);
    const pts = new Int16Array(16);
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const i = by * cols + bx;
        const x0 = bx * bs, y0 = by * bs;
        const minX = Math.max(-range, -x0), maxX = Math.min(range, w2 - bs - x0);
        const minY = Math.max(-range, -y0), maxY = Math.min(range, h2 - bs - y0);
        let bestX = 0, bestY = 0;
        let best = sad(curH, refH, w2, x0, y0, x0, y0, bs, Infinity);
        // predictors
        let nc = 0;
        if (bx > 0) { cand[nc++] = mvxH[i - 1]; cand[nc++] = mvyH[i - 1]; }
        if (by > 0) {
          cand[nc++] = mvxH[i - cols]; cand[nc++] = mvyH[i - cols];
          if (bx < cols - 1) { cand[nc++] = mvxH[i - cols + 1]; cand[nc++] = mvyH[i - cols + 1]; }
        }
        cand[nc++] = this.pmvxH[i]; cand[nc++] = this.pmvyH[i];
        let np = nc;
        for (let k = 0; k < np; k++) pts[k] = cand[k];
        const good = bs * bs * 1.2; // "good enough" SAD: skip the search (static areas)
        // phase 0: predictors, then large diamond steps, then one small diamond
        for (let phase = 0; phase < 12; phase++) {
          if (phase === 1 && best < good) break;
          const cx = bestX, cy = bestY;
          if (phase > 0) {
            const pat = phase === 11 ? SDSP : LDSP;
            np = 0;
            for (let k = 0; k < pat.length; k++) {
              pts[np++] = cx + pat[k][0];
              pts[np++] = cy + pat[k][1];
            }
          }
          for (let k = 0; k < np; k += 2) {
            let mx = pts[k], my = pts[k + 1];
            if (mx < minX) mx = minX; else if (mx > maxX) mx = maxX;
            if (my < minY) my = minY; else if (my > maxY) my = maxY;
            if (mx === bestX && my === bestY) continue;
            const pen = lambda * ((mx < 0 ? -mx : mx) + (my < 0 ? -my : my)) * 0.25;
            if (pen >= best) continue;
            const sc = sad(curH, refH, w2, x0, y0, x0 + mx, y0 + my, bs, best - pen) + pen;
            if (sc < best) {
              best = sc;
              bestX = mx;
              bestY = my;
            }
          }
          if (phase > 0 && phase < 11 && cx === bestX && cy === bestY) phase = 10; // converged -> small diamond
        }
        mvxH[i] = bestX;
        mvyH[i] = bestY;
        this.goodH[i] = best < good ? 1 : 0;
      }
    }
    this.pmvxH.set(mvxH);
    this.pmvyH.set(mvyH);

    // full resolution refinement
    const cY = cur.Y, rY = this.enc.Y;
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const i = by * cols + bx;
        const x0 = bx * mb, y0 = by * mb;
        let bestX = mvxH[i] * 2, bestY = mvyH[i] * 2;
        let best = sad(cY, rY, pw, x0, y0, x0 + bestX, y0 + bestY, mb, Infinity);
        const cx = bestX, cy = bestY;
        for (let k = this.goodH[i] ? 8 : 0; k < 8; k++) {
          const mx = cx + REFINE[k][0], my = cy + REFINE[k][1];
          if (x0 + mx < 0 || x0 + mx + mb > pw || y0 + my < 0 || y0 + my + mb > ph) continue;
          const s = sad(cY, rY, pw, x0, y0, x0 + mx, y0 + my, mb, best);
          if (s < best) {
            best = s;
            bestX = mx;
            bestY = my;
          }
        }
        this.mvx[i] = bestX;
        this.mvy[i] = bestY;
        this.sadArr[i] = best;
      }
    }
  }

  /** mean absolute deviation of a luma macroblock (intra cost estimate) */
  activity(Y, x0, y0) {
    const { pw, mb } = this;
    let sum = 0;
    for (let y = 0; y < mb; y++) {
      const r = (y0 + y) * pw + x0;
      for (let x = 0; x < mb; x++) sum += Y[r + x];
    }
    const mean = sum / (mb * mb);
    let dev = 0;
    for (let y = 0; y < mb; y++) {
      const r = (y0 + y) * pw + x0;
      for (let x = 0; x < mb; x++) {
        const d = Y[r + x] - mean;
        dev += d < 0 ? -d : d;
      }
    }
    return dev;
  }

  /**
   * @param cur Planes of the frame to encode
   * @param opts.intraAll   code every macroblock as intra (I-frame)
   * @param opts.intraT     intra decision threshold (Infinity = never)
   * @param opts.step       quantizer step (see qualityToStep)
   */
  encode(cur, { intraAll = false, intraT = 2, step = 8 }) {
    const { pw, mb, cols, rows, pred, res, mode } = this;
    const area = mb * mb;
    if (!intraAll) this.motionSearch(cur);
    else {
      this.mvx.fill(0);
      this.mvy.fill(0);
      this.pmvxH.fill(0);
      this.pmvyH.fill(0);
    }
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const i = by * cols + bx;
        const x0 = bx * mb, y0 = by * mb;
        let intra = intraAll;
        if (!intra && intraT !== Infinity) {
          const s = this.sadArr[i];
          if (s > area * 3) intra = s > intraT * (this.activity(cur.Y, x0, y0) + area * 2);
        }
        mode[i] = intra ? MODE_INTRA : MODE_INTER;
        if (intra) {
          fillBlock3(pred, x0, y0, mb, mb, 128, 128, 128);
          this.mvx[i] = 0;
          this.mvy[i] = 0;
        } else mcBlock3(pred, this.enc, x0, y0, mb, mb, this.mvx[i], this.mvy[i]);
      }
    }
    // residual
    const n = pw * this.ph;
    const cy = cur.Y, cu = cur.U, cv = cur.V, py = pred.Y, pu = pred.U, pv = pred.V;
    const ry = res.Y, ru = res.U, rv = res.V;
    for (let i = 0; i < n; i++) {
      ry[i] = cy[i] - py[i];
      ru[i] = cu[i] - pu[i];
      rv[i] = cv[i] - pv[i];
    }
    this.quantize(step);
    // reconstruct
    const E = this.enc;
    for (let i = 0; i < n; i++) {
      E.Y[i] = py[i] + ry[i];
      E.U[i] = pu[i] + ru[i];
      E.V[i] = pv[i] + rv[i];
    }
  }

  quantize(step) {
    const { pw, ph, mb, cols, res, mode, q } = this;
    q.set(step);
    const RND_INTRA = 0.42, RND_INTER = 0.3;
    for (let y0 = 0; y0 < ph; y0 += 8) {
      const row = ((y0 / mb) | 0) * cols;
      for (let x0 = 0; x0 < pw; x0 += 8) {
        const rnd = mode[row + ((x0 / mb) | 0)] === MODE_INTRA ? RND_INTRA : RND_INTER;
        quantLumaBlock(res.Y, pw, x0, y0, q.y, rnd);
      }
    }
    for (let y0 = 0; y0 < ph; y0 += 16) {
      const row = ((y0 / mb) | 0) * cols;
      for (let x0 = 0; x0 < pw; x0 += 16) {
        const rnd = mode[row + ((x0 / mb) | 0)] === MODE_INTRA ? RND_INTRA : RND_INTER;
        quantChromaArea(res.U, pw, x0, y0, q.c, rnd);
        quantChromaArea(res.V, pw, x0, y0, q.c, rnd);
      }
    }
  }
}

// ---------------------------------------------------------------- random

export function hash32(a, b, c) {
  let h = 2166136261 ^ a;
  h = Math.imul(h ^ (b + 0x9e3779b9), 16777619);
  h = Math.imul(h ^ (c + 0x7f4a7c15), 2246822519);
  h ^= h >>> 15;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
