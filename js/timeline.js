// Zoomable seek bar.
//  - drag left/right: move the playhead
//  - while dragging, move the pointer up to zoom in / down to zoom out
//    (the frame under the finger stays under the finger)
//  - pinch / wheel: zoom, horizontal wheel / shift+wheel: pan
//  - double click / double tap: fit whole clip
//  - top overview strip: tap to jump anywhere

const OV = 12; // overview strip height
const RU = 16; // ruler height
const LB = 14; // layer band height
const DEAD = 12; // vertical dead zone (px) before zooming starts
const ZOOM_PX = 34; // px of vertical travel per 2x zoom
const EDGE = 28; // auto-pan zone at the edges while dragging
const MAX_PPF = 110;

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 9000, 18000, 36000];

export class Timeline {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} host callbacks: count(), fps(), thumb(i), thumbAspect(), layers(), cacheRanges(),
   *                  onScrub(frame), onScrubEnd(), onViewChange()
   */
  constructor(canvas, host) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.host = host;
    this.current = 0;
    this.ghost = null;
    this.viewStart = 0;
    this.ppf = 1;
    this.fitted = true;
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.hoverX = null;
    this.W = 300;
    this.H = 90;
    this.raf = 0;
    this.lastTap = 0;
    this.dirty = true;

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.requestDraw();
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => this.fit());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.resize();
  }

  get count() {
    return Math.max(1, this.host.count());
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(50, r.width);
    this.H = Math.max(40, r.height);
    this.c.width = Math.round(this.W * dpr);
    this.c.height = Math.round(this.H * dpr);
    this.dpr = dpr;
    if (this.fitted) this.fit(true);
    else this.clampView();
    this.draw();
  }

  minPpf() {
    return this.W / this.count;
  }
  maxPpf() {
    return Math.max(this.minPpf(), MAX_PPF);
  }

  clampView() {
    const span = this.W / this.ppf;
    if (span >= this.count) this.viewStart = 0;
    else this.viewStart = Math.max(0, Math.min(this.count - span, this.viewStart));
  }

  frameAt(x) {
    return this.viewStart + x / this.ppf;
  }
  xOf(f) {
    return (f - this.viewStart) * this.ppf;
  }

  fit(silent) {
    this.ppf = this.minPpf();
    this.viewStart = 0;
    this.fitted = true;
    if (!silent) {
      this.host.onViewChange?.();
      this.requestDraw();
    }
  }

  zoomAt(newPpf, anchorX, anchorFrame = this.frameAt(anchorX)) {
    const minP = this.minPpf();
    this.ppf = Math.max(minP, Math.min(this.maxPpf(), newPpf));
    this.fitted = this.ppf <= minP * 1.0001;
    this.viewStart = anchorFrame - anchorX / this.ppf;
    this.clampView();
    this.host.onViewChange?.();
    this.requestDraw();
  }

  /** zoom around the playhead (buttons / keys) */
  zoomBy(factor) {
    const x = Math.max(0, Math.min(this.W, this.xOf(this.current + 0.5)));
    this.zoomAt(this.ppf * factor, x, this.current + 0.5);
  }

  zoomLabel() {
    const span = this.W / this.ppf;
    if (this.fitted) return '全体';
    if (span < 1000) return `${Math.round(span)}f 表示`;
    return `${(span / (this.host.fps() || 30)).toFixed(0)}s 表示`;
  }

  setCurrent(n, follow = true) {
    this.current = n;
    if (follow) this.ensureVisible(n);
    this.requestDraw();
  }

  setGhost(n) {
    this.ghost = n;
    if (n != null) this.ensureVisible(n);
    this.requestDraw();
  }

  ensureVisible(n) {
    if (this.fitted || this.drag) return;
    const m = Math.min(40, this.W * 0.12);
    const x = this.xOf(n + 0.5);
    if (x < m) this.viewStart = n + 0.5 - m / this.ppf;
    else if (x > this.W - m) this.viewStart = n + 0.5 - (this.W - m) / this.ppf;
    else return;
    this.clampView();
    this.host.onViewChange?.();
  }

  // ------------------------------------------------------------ input

  localXY(e) {
    const r = this.c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    this.c.setPointerCapture(e.pointerId);
    const p = this.localXY(e);
    this.pointers.set(e.pointerId, p);
    this.host.onInteract?.();
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = (a.x + b.x) / 2;
      this.pinch = { dist: Math.max(10, Math.abs(a.x - b.x)), ppf: this.ppf, frame: this.frameAt(mid) };
      if (this.drag) this.endDrag();
      return;
    }
    if (this.pointers.size > 2) return;
    // double tap (touch) -> fit
    const now = performance.now();
    if (e.pointerType !== 'mouse' && now - this.lastTap < 280 && Math.abs(p.x - this.lastTapX) < 24) {
      this.lastTap = 0;
      this.fit();
      return;
    }
    this.lastTap = now;
    this.lastTapX = p.x;

    if (p.y < OV) {
      // overview: jump
      const f = Math.floor((p.x / this.W) * this.count);
      this.overviewDrag = { id: e.pointerId };
      this.jumpOverview(f);
      return;
    }
    this.drag = { id: e.pointerId, startY: p.y, startPpf: this.ppf, lastX: p.x, pos: this.frameAt(p.x), zooming: false, t: performance.now() };
    this.scrubTo(p.x);
    this.startAutoPan();
  }

  jumpOverview(f) {
    f = Math.max(0, Math.min(this.count - 1, f));
    if (!this.fitted) {
      const span = this.W / this.ppf;
      this.viewStart = f + 0.5 - span / 2;
      this.clampView();
      this.host.onViewChange?.();
    }
    if (f !== this.current) {
      this.current = f;
      this.host.onScrub(f);
    }
    this.requestDraw();
  }

  onMove(e) {
    const p = this.localXY(e);
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') {
        this.hoverX = p.x;
        this.hoverY = p.y;
        this.requestDraw();
      }
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.max(10, Math.abs(a.x - b.x));
      const mid = (a.x + b.x) / 2;
      this.zoomAt(this.pinch.ppf * (dist / this.pinch.dist), mid, this.pinch.frame);
      return;
    }
    if (this.overviewDrag && this.overviewDrag.id === e.pointerId) {
      this.jumpOverview(Math.floor((p.x / this.W) * this.count));
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dy = d.startY - p.y;
    const eff = Math.abs(dy) < DEAD ? 0 : dy - Math.sign(dy) * DEAD;
    if (eff !== 0) d.zooming = true;
    const target = d.startPpf * Math.pow(2, eff / ZOOM_PX);
    if (Math.abs(target - this.ppf) > 1e-9) {
      // keep the frame under the finger fixed while zooming
      this.zoomAt(target, d.lastX, d.pos);
    }
    d.lastX = p.x;
    this.scrubTo(p.x);
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.overviewDrag && this.overviewDrag.id === e.pointerId) {
      this.overviewDrag = null;
      this.host.onScrubEnd?.();
    }
    if (this.drag && this.drag.id === e.pointerId) this.endDrag();
  }

  endDrag() {
    this.drag = null;
    cancelAnimationFrame(this.panRaf);
    this.host.onScrubEnd?.();
    this.requestDraw();
  }

  scrubTo(x) {
    const d = this.drag;
    const pos = this.frameAt(Math.max(0, Math.min(this.W - 0.01, x)));
    if (d) d.pos = pos;
    const n = Math.max(0, Math.min(this.count - 1, Math.floor(pos)));
    if (n !== this.current) {
      this.current = n;
      this.host.onScrub(n);
    }
    this.requestDraw();
  }

  startAutoPan() {
    let last = performance.now();
    const tick = (t) => {
      const d = this.drag;
      if (!d) return;
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      if (!this.fitted) {
        let v = 0;
        if (d.lastX < EDGE) v = -(EDGE - d.lastX) / EDGE;
        else if (d.lastX > this.W - EDGE) v = (d.lastX - (this.W - EDGE)) / EDGE;
        if (v !== 0) {
          v = Math.max(-1.5, Math.min(1.5, v));
          const span = this.W / this.ppf;
          const before = this.viewStart;
          this.viewStart += v * Math.max(4, span * 0.9) * dt;
          this.clampView();
          if (this.viewStart !== before) {
            this.host.onViewChange?.();
            this.scrubTo(d.lastX);
          }
        }
      }
      this.panRaf = requestAnimationFrame(tick);
    };
    this.panRaf = requestAnimationFrame(tick);
  }

  onWheel(e) {
    e.preventDefault();
    const { x } = this.localXY(e);
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    }
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    if (e.ctrlKey) {
      this.zoomAt(this.ppf * Math.exp(-dy * 0.012), x);
    } else if (Math.abs(dy) >= Math.abs(dx)) {
      this.zoomAt(this.ppf * Math.exp(-dy * 0.0025), x);
    } else {
      this.viewStart += dx / this.ppf;
      this.clampView();
      this.host.onViewChange?.();
      this.requestDraw();
    }
    this.host.onInteract?.();
  }

  // ------------------------------------------------------------ drawing

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  draw() {
    const g = this.g, W = this.W, H = this.H, dpr = this.dpr || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const count = this.count;
    const hasVideo = this.host.count() > 0;
    const filmTop = OV + RU;
    const filmH = H - OV - RU - LB;
    const layers = this.host.layers();
    const fps = this.host.fps() || 30;

    // background
    g.fillStyle = '#14141c';
    g.fillRect(0, 0, W, H);

    // ---------------- overview
    g.fillStyle = '#20202c';
    g.fillRect(0, 2, W, OV - 4);
    if (hasVideo) {
      const sx = W / count;
      for (const L of layers) {
        if (!L.visible) continue;
        const e = L.end == null ? count - 1 : L.end;
        g.fillStyle = L.color + '66';
        g.fillRect(L.start * sx, 2, (e - L.start + 1) * sx, OV - 4);
        g.fillStyle = L.color;
        g.fillRect(L.start * sx, 1, 2, OV - 2);
      }
      if (!this.fitted) {
        const vx = this.viewStart * sx, vw = Math.max(3, (W / this.ppf) * sx);
        g.strokeStyle = '#ecebf5';
        g.lineWidth = 1.5;
        g.strokeRect(vx + 0.75, 1.25, vw - 1.5, OV - 2.5);
      }
      g.fillStyle = '#fff';
      g.fillRect(Math.round((this.current + 0.5) * sx) - 1, 0, 2, OV);
      if (this.ghost != null) {
        g.fillStyle = '#ffd23d';
        g.fillRect(Math.round((this.ghost + 0.5) * sx) - 1, 0, 2, OV);
      }
    }

    if (!hasVideo) {
      g.fillStyle = '#6f6e86';
      g.font = '12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('動画を読み込むとここにシークバーが表示されます', W / 2, filmTop + filmH / 2 + 4);
      return;
    }

    const ppf = this.ppf;
    const f0 = Math.max(0, Math.floor(this.viewStart));
    const f1 = Math.min(count - 1, Math.ceil(this.viewStart + W / ppf));

    // ---------------- filmstrip
    const aspect = this.host.thumbAspect() || 16 / 9;
    const thumbW = filmH * aspect;
    g.save();
    g.beginPath();
    g.rect(0, filmTop, W, filmH);
    g.clip();
    g.fillStyle = '#0c0c11';
    g.fillRect(0, filmTop, W, filmH);
    if (ppf >= thumbW) {
      // one cell per frame: thumbnail centred in its cell
      for (let f = f0; f <= f1; f++) {
        const t = this.host.thumb(f);
        if (t) g.drawImage(t, this.xOf(f) + (ppf - thumbW) / 2, filmTop, thumbW, filmH);
      }
    } else {
      // continuous strip: each tile shows the frame at its left edge
      const worldLeft = this.viewStart * ppf;
      const i0 = Math.floor(worldLeft / thumbW), i1 = Math.ceil((worldLeft + W) / thumbW);
      for (let i = i0; i <= i1; i++) {
        const f = Math.min(count - 1, Math.floor((i * thumbW) / ppf));
        const t = this.host.thumb(f);
        if (t) g.drawImage(t, i * thumbW - worldLeft, filmTop, thumbW, filmH);
      }
    }
    // tint the frames covered by each effect
    for (const L of layers) {
      if (!L.visible) continue;
      const e = L.end == null ? count - 1 : L.end;
      const x0 = this.xOf(L.start), x1 = this.xOf(e + 1);
      if (x1 < 0 || x0 > W) continue;
      g.fillStyle = L.color + '1f';
      g.fillRect(x0, filmTop, x1 - x0, filmH);
    }
    // frame cells
    if (ppf >= 7) {
      g.fillStyle = 'rgba(0,0,0,.55)';
      for (let f = f0; f <= f1 + 1; f++) g.fillRect(Math.round(this.xOf(f)) - 0.5, filmTop, 1, filmH);
    }
    g.restore();

    // ---------------- ruler
    g.fillStyle = '#191922';
    g.fillRect(0, OV, W, RU);
    let major = TICK_STEPS.find((s) => s * ppf >= 56) || TICK_STEPS[TICK_STEPS.length - 1];
    let minor = TICK_STEPS.slice().reverse().find((s) => s < major && major % s === 0 && s * ppf >= 7) || null;
    g.fillStyle = '#4a4a60';
    if (minor) {
      for (let f = Math.floor(f0 / minor) * minor; f <= f1 + 1; f += minor) {
        if (f % major === 0) continue;
        g.fillRect(Math.round(this.xOf(f)), OV + RU - 4, 1, 4);
      }
    }
    g.font = '10px ui-monospace, Menlo, monospace';
    g.textAlign = 'left';
    for (let f = Math.floor(f0 / major) * major; f <= f1 + 1; f += major) {
      const x = Math.round(this.xOf(f));
      g.fillStyle = '#6f6e86';
      g.fillRect(x, OV + 3, 1, RU - 3);
      g.fillStyle = '#a9a8bd';
      const label = major >= fps * 2 && f % Math.round(fps) === 0 ? fmtTime(f / fps) : String(f);
      g.fillText(label, x + 3, OV + RU - 5);
    }

    // ---------------- layer band
    const lbTop = filmTop + filmH;
    g.fillStyle = '#101017';
    g.fillRect(0, lbTop, W, LB);
    const vis = layers.filter((l) => l.visible);
    const rowH = Math.min(4, (LB - 5) / Math.max(1, Math.min(3, vis.length)));
    vis.forEach((L, i) => {
      const e = L.end == null ? count - 1 : L.end;
      const x0 = Math.max(-2, this.xOf(L.start)), x1 = Math.min(W + 2, this.xOf(e + 1));
      if (x1 < 0 || x0 > W) return;
      const y = lbTop + 2 + (i % 3) * (rowH + 0.5);
      g.fillStyle = L.color;
      g.fillRect(x0, y, x1 - x0, rowH);
    });
    // cache bar
    g.fillStyle = 'rgba(77,255,166,.75)';
    for (const [a, b] of this.host.cacheRanges()) {
      const x0 = this.xOf(a), x1 = this.xOf(b + 1);
      if (x1 < 0 || x0 > W) continue;
      g.fillRect(x0, H - 2.5, Math.max(1, x1 - x0), 2);
    }

    // layer start markers
    for (const L of vis) {
      const x = Math.round(this.xOf(L.start));
      if (x < -2 || x > W + 2) continue;
      g.fillStyle = L.color;
      g.fillRect(x - 1, OV, 2, H - OV);
      g.beginPath();
      g.moveTo(x - 1, OV);
      g.lineTo(x + 7, OV + 5);
      g.lineTo(x - 1, OV + 10);
      g.fill();
    }

    // ---------------- hover
    if (this.hoverX != null && !this.drag && this.hoverY >= OV) {
      const f = Math.max(0, Math.min(count - 1, Math.floor(this.frameAt(this.hoverX))));
      const x = this.xOf(f + 0.5);
      g.fillStyle = 'rgba(255,255,255,.35)';
      g.fillRect(Math.round(x), OV, 1, H - OV);
      drawTag(g, x, OV + RU + 2, String(f), 'rgba(40,40,56,.95)', '#ecebf5', W);
    }

    // ---------------- ghost (trial playback)
    if (this.ghost != null) {
      const x = this.xOf(this.ghost + 0.5);
      if (x >= -2 && x <= W + 2) {
        g.fillStyle = '#ffd23d';
        g.fillRect(Math.round(x) - 1, OV, 2, H - OV);
        drawTag(g, x, H - LB - 16, String(this.ghost), '#ffd23d', '#1a1400', W);
      }
    }

    // ---------------- playhead
    {
      const n = this.current;
      const x0 = this.xOf(n), x1 = this.xOf(n + 1);
      if (x1 >= 0 && x0 <= W) {
        if (ppf >= 5) {
          g.fillStyle = 'rgba(255,61,139,.22)';
          g.fillRect(x0, filmTop, x1 - x0, filmH);
          g.strokeStyle = '#ff3d8b';
          g.lineWidth = 2;
          g.strokeRect(x0 + 1, filmTop + 1, x1 - x0 - 2, filmH - 2);
        }
        const x = Math.round((x0 + x1) / 2);
        g.fillStyle = '#ff3d8b';
        g.fillRect(x - 1, OV, 2, H - OV);
        g.beginPath();
        g.moveTo(x - 6, OV);
        g.lineTo(x + 6, OV);
        g.lineTo(x, OV + 7);
        g.fill();
        drawTag(g, x, OV + RU + 2, String(n), '#ff3d8b', '#fff', W);
      }
    }

    // zoom indicator while zooming
    if (this.drag && this.drag.zooming) {
      const label = this.zoomLabel();
      g.font = 'bold 11px system-ui, sans-serif';
      const tw = g.measureText(label).width + 14;
      g.fillStyle = 'rgba(0,0,0,.75)';
      roundRect(g, W - tw - 6, filmTop + 4, tw, 18, 9);
      g.fill();
      g.fillStyle = '#ffd23d';
      g.textAlign = 'left';
      g.fillText(label, W - tw + 1, filmTop + 17);
    }
  }
}

function drawTag(g, x, y, text, bg, fg, W) {
  g.font = 'bold 10px ui-monospace, Menlo, monospace';
  const tw = g.measureText(text).width + 8;
  let left = Math.round(x - tw / 2);
  left = Math.max(1, Math.min(W - tw - 1, left));
  g.fillStyle = bg;
  roundRect(g, left, y, tw, 14, 4);
  g.fill();
  g.fillStyle = fg;
  g.textAlign = 'left';
  g.fillText(text, left + 4, y + 10.5);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(0).padStart(2, '0')}`;
}
