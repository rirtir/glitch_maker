// Render engine: runs the layer stack frame by frame. Glitch effects depend on
// every previous frame, so the engine keeps a "cursor" (the last processed
// frame whose effect states are held in memory), periodic checkpoints of those
// states and a JPEG cache of finished frames.

import { Planes, padSize, rgbaToPlanes, planesToRgba } from './codec.js';
import { createFx } from './fx.js';

const CHECKPOINT_EVERY = 12;
const CHECKPOINT_BUDGET = 160 * 1024 * 1024;
const CACHE_BUDGET = 320 * 1024 * 1024;
const AHEAD = 120;

export class Engine {
  constructor(post) {
    this.post = post;
    this.frames = [];
    this.layers = [];
    this.instances = new Map(); // layer id -> { sig, inst, blend }
    this.checkpoints = new Map(); // frame -> { frame, lineStart, states: Map, bytes }
    this.cpBytes = 0;
    this.cache = new Map(); // frame -> Blob
    this.cacheBytes = 0;
    this.cursor = -1;
    this.cursorValid = false;
    this.lineStart = 0;
    this.pending = null;
    this.busy = false;
    this.lastReq = 0;
    this.gen = 0;
    this.ahead = true;
    this.lastCacheReport = 0;
    this.cacheReportTimer = null;
  }

  init({ w, h, frames }) {
    this.w = w;
    this.h = h;
    this.pw = padSize(w);
    this.ph = padSize(h);
    this.frames = frames;
    this.srcCanvas = new OffscreenCanvas(w, h);
    this.srcCtx = this.srcCanvas.getContext('2d', { willReadFrequently: true });
    this.outCanvas = new OffscreenCanvas(w, h);
    this.outCtx = this.outCanvas.getContext('2d');
    this.outImage = new ImageData(w, h);
    this.srcPlanes = new Planes(this.pw, this.ph);
    this.ctx = {
      pw: this.pw,
      ph: this.ph,
      w,
      h,
      loadSource: async (n) => {
        const p = new Planes(this.pw, this.ph);
        await this.decodeSource(Math.max(0, Math.min(this.frames.length - 1, n)), p);
        return p;
      },
    };
    this.instances.clear();
    this.clearAll();
  }

  clearAll() {
    this.gen++;
    this.checkpoints.clear();
    this.cpBytes = 0;
    this.cache.clear();
    this.cacheBytes = 0;
    this.cursorValid = false;
    this.cursor = -1;
    this.reportCache();
  }

  get count() {
    return this.frames.length;
  }

  endOf(L) {
    return L.end == null ? this.count - 1 : Math.min(L.end, this.count - 1);
  }

  // ------------------------------------------------------------ layers

  setLayers(layers) {
    const oldById = new Map(this.layers.map((l, i) => [l.id, { l, i }]));
    const visible = layers.filter((l) => l.visible);
    let F = Infinity;
    const newIds = new Set();
    const sigOf = (l, idx) => JSON.stringify([l.type, l.params, l.start, l.visible, idx]);
    const oldVisible = this.layers.filter((l) => l.visible);
    const oldIdx = new Map(oldVisible.map((l, i) => [l.id, i]));
    layers.forEach((l) => {
      newIds.add(l.id);
      const o = oldById.get(l.id);
      const idx = l.visible ? visible.indexOf(l) : -1;
      if (!o) {
        if (l.visible) F = Math.min(F, l.start);
        return;
      }
      const ol = o.l;
      const oIdx = ol.visible ? oldIdx.get(l.id) : -1;
      const sigChanged = sigOf(l, idx) !== sigOf(ol, oIdx);
      const endChanged = this.endOf(l) !== this.endOf(ol);
      const opChanged = l.opacity !== ol.opacity;
      if (sigChanged) {
        if (l.visible || ol.visible) F = Math.min(F, l.visible ? l.start : Infinity, ol.visible ? ol.start : Infinity);
        this.instances.delete(l.id);
      } else if (l.visible) {
        if (opChanged) F = Math.min(F, l.start);
        if (endChanged) F = Math.min(F, Math.min(this.endOf(l), this.endOf(ol)) + 1);
      }
    });
    for (const [id, { l }] of oldById) {
      if (!newIds.has(id)) {
        if (l.visible) F = Math.min(F, l.start);
        this.instances.delete(id);
      }
    }
    this.layers = layers.map((l) => ({ ...l, params: { ...l.params } }));
    if (F !== Infinity) this.invalidateFrom(Math.max(0, F));
  }

  invalidateFrom(F) {
    for (const [n, b] of this.cache) {
      if (n >= F) {
        this.cacheBytes -= b.size;
        this.cache.delete(n);
      }
    }
    for (const [n, cp] of this.checkpoints) {
      if (n >= F - 1) {
        this.cpBytes -= cp.bytes;
        this.checkpoints.delete(n);
      }
    }
    if (this.cursor >= F - 1) this.cursorValid = false;
    this.gen++;
    this.reportCache();
  }

  visibleLayers() {
    return this.layers.filter((l) => l.visible);
  }

  instance(L) {
    let e = this.instances.get(L.id);
    if (!e) {
      e = { inst: createFx(L, this.ctx), blend: null };
      this.instances.set(L.id, e);
    }
    return e;
  }

  isActive(L, n) {
    return n >= L.start && n <= this.endOf(L);
  }

  /** first frame that must be processed to render frame n, or null if n is unaffected */
  chainStart(n) {
    const vis = this.visibleLayers();
    let lo = null;
    for (const L of vis) if (this.isActive(L, n)) lo = lo == null ? L.start - 1 : Math.min(lo, L.start - 1);
    if (lo == null) return null;
    let changed = true;
    while (changed) {
      changed = false;
      for (const L of vis) {
        if (L.start <= n && this.endOf(L) >= lo && L.start - 1 < lo) {
          lo = L.start - 1;
          changed = true;
        }
      }
    }
    return Math.max(0, lo);
  }

  // ------------------------------------------------------------ frames

  async decodeSource(n, planes) {
    const bmp = await createImageBitmap(this.frames[n]);
    this.srcCtx.drawImage(bmp, 0, 0, this.w, this.h);
    bmp.close();
    const data = this.srcCtx.getImageData(0, 0, this.w, this.h).data;
    rgbaToPlanes(data, this.w, this.h, planes);
  }

  async step(f, sequential) {
    await this.decodeSource(f, this.srcPlanes);
    let cur = this.srcPlanes;
    for (const L of this.visibleLayers()) {
      const e = this.instance(L);
      if (this.isActive(L, f)) {
        if (!sequential) continue; // (all current effects are stateful)
        let out = await e.inst.process(cur, f);
        const a = L.opacity == null ? 1 : L.opacity;
        if (a < 1) {
          if (!e.blend) e.blend = new Planes(this.pw, this.ph);
          blendPlanes(e.blend, cur, out, a);
          out = e.blend;
        }
        cur = out;
      } else if (sequential) {
        if (f === L.start - 1) e.inst.observe(cur, f);
        else if (f > this.endOf(L)) e.inst.reset();
      }
    }
    return cur;
  }

  resetAll() {
    for (const L of this.layers) {
      const e = this.instances.get(L.id);
      if (e) e.inst.reset();
    }
  }

  saveCheckpoint(f) {
    if (this.checkpoints.has(f)) return;
    const states = new Map();
    let bytes = 0;
    for (const L of this.visibleLayers()) {
      const e = this.instances.get(L.id);
      if (!e) continue;
      const s = e.inst.snapshot();
      bytes += e.inst.stateBytes();
      states.set(L.id, s);
    }
    this.checkpoints.set(f, { frame: f, lineStart: this.lineStart, states, bytes });
    this.cpBytes += bytes;
    while (this.cpBytes > CHECKPOINT_BUDGET && this.checkpoints.size > 1) {
      // drop the checkpoint farthest from where the user is working
      let worst = null, wd = -1;
      for (const [n] of this.checkpoints) {
        const d = Math.abs(n - this.lastReq) + (n > this.lastReq ? 0 : 1);
        if (d > wd) {
          wd = d;
          worst = n;
        }
      }
      this.cpBytes -= this.checkpoints.get(worst).bytes;
      this.checkpoints.delete(worst);
    }
  }

  restoreCheckpoint(cp) {
    for (const L of this.layers) {
      const e = this.instance(L);
      e.inst.restore(cp.states.get(L.id) || null);
    }
    this.cursor = cp.frame;
    this.lineStart = cp.lineStart;
    this.cursorValid = true;
  }

  prepareCursor(chain, n) {
    const cursorOk = this.cursorValid && this.lineStart <= chain && this.cursor >= chain - 1 && this.cursor < n;
    let best = null;
    for (const cp of this.checkpoints.values()) {
      if (cp.lineStart <= chain && cp.frame >= chain - 1 && cp.frame < n && (!best || cp.frame > best.frame)) best = cp;
    }
    if (cursorOk && (!best || this.cursor >= best.frame)) return;
    if (best) {
      this.restoreCheckpoint(best);
      return;
    }
    this.resetAll();
    this.lineStart = chain;
    this.cursor = chain - 1;
    this.cursorValid = true;
  }

  // ------------------------------------------------------------ output

  writeOut(planes) {
    planesToRgba(planes, this.w, this.h, this.outImage.data);
    this.outCtx.putImageData(this.outImage, 0, 0);
  }

  cacheCurrent(n) {
    if (this.cache.has(n)) return;
    const gen = this.gen;
    this.outCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }).then((blob) => {
      if (this.cache.has(n) || gen !== this.gen) return;
      this.cache.set(n, blob);
      this.cacheBytes += blob.size;
      this.evictCache();
      this.reportCache();
    });
  }

  dropCached(n) {
    const b = this.cache.get(n);
    if (!b) return;
    this.cacheBytes -= b.size;
    this.cache.delete(n);
  }

  evictCache() {
    while (this.cacheBytes > CACHE_BUDGET && this.cache.size > 1) {
      let worst = null, wd = -1;
      for (const n of this.cache.keys()) {
        const d = Math.abs(n - this.lastReq);
        if (d > wd) {
          wd = d;
          worst = n;
        }
      }
      this.cacheBytes -= this.cache.get(worst).size;
      this.cache.delete(worst);
    }
  }

  reportCache() {
    if (this.cacheReportTimer) return;
    this.cacheReportTimer = setTimeout(() => {
      this.cacheReportTimer = null;
      const keys = [...this.cache.keys()].sort((a, b) => a - b);
      const ranges = [];
      for (const k of keys) {
        const r = ranges[ranges.length - 1];
        if (r && r[1] === k - 1) r[1] = k;
        else ranges.push([k, k]);
      }
      this.post({ type: 'cache', ranges });
    }, 250);
  }

  // ------------------------------------------------------------ requests

  request(req) {
    if (this.pending) this.post({ type: 'aborted', id: this.pending.id });
    this.pending = req;
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        if (this.pending) {
          const req = this.pending;
          this.pending = null;
          try {
            await this.serve(req);
          } catch (err) {
            console.error(err);
            this.post({ type: 'error', id: req.id, message: String(err && err.message || err) });
          }
          continue;
        }
        if (this.ahead && (await this.aheadStep())) continue;
        break;
      }
    } finally {
      this.busy = false;
    }
  }

  async sendFrame(req, blobOrNull) {
    let bitmap;
    if (blobOrNull) bitmap = await createImageBitmap(blobOrNull);
    else bitmap = await createImageBitmap(this.outImage);
    this.post({ type: 'frame', id: req.id, n: req.n, bitmap }, [bitmap]);
  }

  async serve(req) {
    const n = Math.max(0, Math.min(this.count - 1, req.n));
    this.lastReq = n;
    const cached = req.noCache ? null : this.cache.get(n);
    if (cached) {
      await this.sendFrame(req, cached);
      return;
    }
    const chain = this.chainStart(n);
    if (chain == null) {
      await this.sendFrame(req, this.frames[n]);
      return;
    }
    this.prepareCursor(chain, n);
    const from = this.cursor;
    let lastProgress = 0;
    while (this.cursor < n) {
      const f = this.cursor + 1;
      const gen = this.gen;
      const out = await this.step(f, true);
      if (gen !== this.gen) {
        // layers changed while this frame was being computed: start over with the new setup
        if (!this.pending) this.pending = req;
        else this.post({ type: 'aborted', id: req.id });
        return;
      }
      this.cursor = f;
      if (f % CHECKPOINT_EVERY === 0) this.saveCheckpoint(f);
      const needImage = f === n || !this.cache.has(f);
      if (f === n && req.noCache) this.dropCached(f);
      if (needImage) {
        this.writeOut(out);
        this.cacheCurrent(f);
      }
      if (f === n) {
        await this.sendFrame(req, null);
        return;
      }
      const now = performance.now();
      if (now - lastProgress > 120) {
        lastProgress = now;
        this.post({ type: 'progress', id: req.id, done: f - from, total: n - from });
      }
      if (this.pending) {
        this.post({ type: 'aborted', id: req.id });
        return;
      }
    }
  }

  async aheadStep() {
    if (!this.cursorValid) return false;
    const f = this.cursor + 1;
    if (f >= this.count) return false;
    if (this.cursor < this.lastReq || f > this.lastReq + AHEAD) return false;
    const chain = this.chainStart(f);
    if (chain == null || this.lineStart > chain) return false;
    const gen = this.gen;
    const out = await this.step(f, true);
    if (gen !== this.gen) return true;
    this.cursor = f;
    if (f % CHECKPOINT_EVERY === 0) this.saveCheckpoint(f);
    if (!this.cache.has(f)) {
      this.writeOut(out);
      this.cacheCurrent(f);
    }
    return true;
  }
}

function blendPlanes(dst, a, b, t) {
  const n = dst.Y.length;
  const s = 1 - t;
  for (const k of ['Y', 'U', 'V']) {
    const D = dst[k], A = a[k], B = b[k];
    for (let i = 0; i < n; i++) D[i] = A[i] * s + B[i] * t;
  }
}
