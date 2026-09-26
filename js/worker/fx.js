// Effect implementations. Every effect instance processes frames strictly in
// order (the engine guarantees this) and may keep state between frames.
//
// instance API:
//   observe(planes, n)        called for frame start-1 (the frame before it becomes active)
//   async process(planes, n)  returns output Planes (owned by the instance)
//   reset()                   forget state
//   snapshot() / restore(s)   checkpointing for fast seeking
//   stateBytes()              approximate size of a snapshot

import { EFFECTS, defaultParams } from '../effects/defs.js';
import {
  Planes, Encoder, MODE_INTRA, qualityToStep, mcBlock3, fillBlock3, copyBlock3, addResBlock3,
  garbageBlock, hash32, mulberry32,
} from './codec.js';

function intraThreshold(v) {
  // 0 -> never, 100 -> very eager
  if (v <= 0) return Infinity;
  return 0.45 / Math.pow(v / 100, 1.5);
}

// ---------------------------------------------------------------- datamosh

class Datamosh {
  constructor(layer, ctx) {
    this.ctx = ctx;
    this.p = { ...defaultParams('datamosh'), ...layer.params };
    this.mb = Number(this.p.blockSize) || 16;
    this.encoder = null;
    this.reset();
  }

  ensure() {
    if (this.encoder) return;
    const { pw, ph } = this.ctx;
    this.encoder = new Encoder(pw, ph, this.mb);
    this.dec = new Planes(pw, ph);
    this.pred = new Planes(pw, ph);
  }

  reset() {
    this.started = false;
    this.observed = null;
    this.frozen = null;
  }

  observe(planes) {
    this.observed = planes.clone();
  }

  async process(cur, n) {
    this.ensure();
    const p = this.p;
    const step = qualityToStep(p.quality);
    const enc = this.encoder;
    if (!this.started) {
      this.started = true;
      if (p.mode === 'bloom') {
        const prev = this.observed || cur;
        enc.setReference(prev);
        this.dec.copyFrom(prev);
        enc.encode(cur, { intraT: Infinity, step });
        this.frozen = {
          mvx: enc.mvx.slice(),
          mvy: enc.mvy.slice(),
          res: { Y: enc.res.Y.slice(), U: enc.res.U.slice(), V: enc.res.V.slice() },
        };
        this.observed = null;
        this.decodeP(null, this.frozen.mvx, this.frozen.mvy, this.frozen.res, 1, 1);
        return this.dec;
      }
      // The I-frame at `start` is lost: the decoder keeps showing the old
      // picture while the encoder (and every following P-frame) refers to the
      // real frame.
      let ref = this.observed;
      if (p.ref != null && p.ref >= 0) ref = await this.ctx.loadSource(p.ref);
      this.dec.copyFrom(ref || cur);
      enc.setReference(cur);
      this.observed = null;
      return this.dec;
    }
    if (p.mode === 'bloom') {
      const f = this.frozen;
      this.decodeP(null, f.mvx, f.mvy, f.res, p.motion, p.residual);
      return this.dec;
    }
    enc.encode(cur, { intraT: intraThreshold(p.intra), step });
    this.decodeP(enc.mode, enc.mvx, enc.mvy, enc.res, p.motion, p.residual);
    return this.dec;
  }

  decodeP(mode, mvx, mvy, res, scale, k) {
    const { mb } = this;
    const { cols, rows } = this.encoder;
    const dec = this.dec, pred = this.pred;
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const i = by * cols + bx;
        const x0 = bx * mb, y0 = by * mb;
        if (mode && mode[i] === MODE_INTRA) fillBlock3(pred, x0, y0, mb, mb, 128, 128, 128);
        else mcBlock3(pred, dec, x0, y0, mb, mb, Math.round(mvx[i] * scale), Math.round(mvy[i] * scale));
      }
    }
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const i = by * cols + bx;
        const intra = mode && mode[i] === MODE_INTRA;
        addResBlock3(dec, pred, res, bx * mb, by * mb, mb, mb, intra ? 1 : k);
      }
    }
  }

  snapshot() {
    if (!this.started) return { started: false, observed: this.observed ? this.observed.snapshot() : null };
    return {
      started: true,
      enc: this.encoder.snapshot(),
      dec: this.dec.snapshot(),
      frozen: this.frozen, // immutable once created
    };
  }

  restore(s) {
    this.reset();
    if (!s) return;
    if (!s.started) {
      if (s.observed) {
        this.observed = new Planes(this.ctx.pw, this.ctx.ph);
        this.observed.restore(s.observed);
      }
      return;
    }
    this.ensure();
    this.started = true;
    this.encoder.restore(s.enc);
    this.dec.restore(s.dec);
    this.frozen = s.frozen;
  }

  stateBytes() {
    const n = this.ctx.pw * this.ctx.ph;
    return this.started ? n * 6 : this.observed ? n * 3 : 0;
  }
}

// ---------------------------------------------------------------- macroblock / packet loss

class Macroblock {
  constructor(layer, ctx) {
    this.ctx = ctx;
    this.start = layer.start;
    this.p = { ...defaultParams('macroblock'), ...layer.params };
    this.mb = Number(this.p.blockSize) || 16;
    this.encoder = null;
    this.reset();
  }

  ensure() {
    if (this.encoder) return;
    const { pw, ph } = this.ctx;
    this.encoder = new Encoder(pw, ph, this.mb);
    this.dec = new Planes(pw, ph);
    this.pred = new Planes(pw, ph);
    this.lost = new Uint8Array(this.encoder.n);
  }

  reset() {
    this.started = false;
  }

  observe() {}

  computeLoss(rng) {
    const lost = this.lost;
    lost.fill(0);
    const p = this.p.loss / 100;
    if (p <= 0) return;
    const n = lost.length;
    if (this.p.pattern === 'block') {
      for (let i = 0; i < n; i++) {
        if (rng() < p) {
          // small bursts look more natural than single blocks
          const len = 1 + Math.floor(rng() * rng() * 4);
          for (let k = 0; k < len && i + k < n; k++) lost[i + k] = 1;
        }
      }
    } else if (this.p.pattern === 'tail') {
      if (rng() < p) lost.fill(1, Math.floor(rng() * n));
    } else {
      const L = Math.max(1, Math.round(this.p.sliceLen));
      for (let s = -Math.floor(rng() * L); s < n; s += L) {
        if (rng() < p) lost.fill(1, Math.max(0, s), Math.min(n, s + L));
      }
    }
  }

  async process(cur, n) {
    this.ensure();
    const p = this.p;
    const enc = this.encoder;
    const mb = this.mb;
    const { cols, rows } = enc;
    const gop = Math.max(1, Math.round(p.gop));
    const key = !this.started || (n - this.start) % gop === 0;
    if (!this.started) this.dec.fill(128, 128, 128);
    const rng = mulberry32(hash32(Math.round(p.seed) | 0, n, 0x51ce));
    enc.encode(cur, { intraAll: key, intraT: 2.2, step: qualityToStep(p.quality) });
    this.computeLoss(rng);
    const lost = this.lost, dec = this.dec, pred = this.pred, mode = enc.mode;
    const conceal = p.conceal;
    // prediction pass (reads the previous decoded frame only)
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const i = by * cols + bx;
        const x0 = bx * mb, y0 = by * mb;
        if (lost[i]) {
          if (conceal === 'motion') {
            // use the neighbours' motion when this block has none (intra / key frame)
            let dx = enc.mvx[i], dy = enc.mvy[i];
            if (mode[i] === MODE_INTRA) {
              dx = enc.pmvxH[i] * 2;
              dy = enc.pmvyH[i] * 2;
            }
            mcBlock3(pred, dec, x0, y0, mb, mb, dx, dy);
          } else if (conceal === 'freeze') {
            copyBlock3(pred, dec, x0, y0, mb, mb);
          } else if (conceal === 'shift') {
            const r = hash32(Math.round(p.seed) | 0, n, i >> 3);
            const dx = ((r & 0xff) - 128) >> 1, dy = (((r >> 8) & 0x7f) - 64) >> 2;
            mcBlock3(pred, dec, x0, y0, mb, mb, dx, dy);
          }
        } else if (mode[i] === MODE_INTRA) {
          fillBlock3(pred, x0, y0, mb, mb, 128, 128, 128);
        } else {
          mcBlock3(pred, dec, x0, y0, mb, mb, enc.mvx[i], enc.mvy[i]);
        }
      }
    }
    // reconstruction pass
    const E = enc.enc;
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const i = by * cols + bx;
        const x0 = bx * mb, y0 = by * mb;
        if (!lost[i]) {
          if (p.propagate) addResBlock3(dec, pred, enc.res, x0, y0, mb, mb, 1);
          else copyBlock3(dec, E, x0, y0, mb, mb);
          continue;
        }
        switch (conceal) {
          case 'motion':
          case 'freeze':
            copyBlock3(dec, pred, x0, y0, mb, mb);
            break;
          case 'shift':
            addResBlock3(dec, pred, enc.res, x0, y0, mb, mb, 1);
            break;
          case 'green':
            fillBlock3(dec, x0, y0, mb, mb, 0, 0, 0);
            break;
          case 'gray':
            fillBlock3(dec, x0, y0, mb, mb, 128, 128, 128);
            break;
          case 'noise': {
            const pw = dec.pw;
            for (let y = 0; y < mb; y += 8) {
              for (let x = 0; x < mb; x += 8) {
                garbageBlock(dec.Y, pw, x0 + x, y0 + y, rng, 90, 128);
                garbageBlock(dec.U, pw, x0 + x, y0 + y, rng, 60, 128);
                garbageBlock(dec.V, pw, x0 + x, y0 + y, rng, 60, 128);
              }
            }
            break;
          }
        }
      }
    }
    this.started = true;
    return dec;
  }

  snapshot() {
    if (!this.started) return { started: false };
    return { started: true, enc: this.encoder.snapshot(), dec: this.dec.snapshot() };
  }

  restore(s) {
    this.reset();
    if (!s || !s.started) return;
    this.ensure();
    this.started = true;
    this.encoder.restore(s.enc);
    this.dec.restore(s.dec);
  }

  stateBytes() {
    return this.started ? this.ctx.pw * this.ctx.ph * 6 : 0;
  }
}

const IMPL = { datamosh: Datamosh, macroblock: Macroblock };

export function createFx(layer, ctx) {
  const Impl = IMPL[layer.type];
  if (!Impl || !EFFECTS[layer.type]) throw new Error('unknown effect ' + layer.type);
  return new Impl(layer, ctx);
}

export function isStateful() {
  return true; // every current effect keeps inter-frame state
}
