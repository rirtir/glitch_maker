// Main-thread client of the render worker.

export class Renderer {
  constructor({ onProgress, onCache } = {}) {
    this.worker = new Worker(new URL('./worker/render-worker.js', import.meta.url), { type: 'module' });
    this.nextId = 1;
    this.waiting = new Map();
    this.onProgress = onProgress;
    this.onCache = onCache;
    this.readyP = null;
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      console.error('render worker error', e.message || e);
      this.readyReject?.(new Error('描画処理（Worker）を起動できませんでした。ブラウザを最新版に更新してください。'));
      for (const [, v] of this.waiting) v.reject(new Error('描画処理でエラーが発生しました'));
      this.waiting.clear();
    };
  }

  onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.readyResolve?.();
        break;
      case 'frame': {
        const w = this.waiting.get(m.id);
        if (w) {
          this.waiting.delete(m.id);
          w.resolve(m.bitmap);
        } else m.bitmap.close();
        break;
      }
      case 'aborted': {
        const w = this.waiting.get(m.id);
        if (w) {
          this.waiting.delete(m.id);
          w.resolve(null);
        }
        break;
      }
      case 'error': {
        const w = this.waiting.get(m.id);
        if (w) {
          this.waiting.delete(m.id);
          w.reject(new Error(m.message));
        }
        break;
      }
      case 'progress':
        this.onProgress?.(m);
        break;
      case 'cache':
        this.onCache?.(m.ranges);
        break;
    }
  }

  init(w, h, frames) {
    for (const [, v] of this.waiting) v.resolve(null);
    this.waiting.clear();
    this.readyP = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.worker.postMessage({ type: 'init', w, h, frames });
    return this.readyP;
  }

  setLayers(layers) {
    this.worker.postMessage({
      type: 'layers',
      layers: layers.map((l) => ({
        id: l.id, type: l.type, visible: l.visible, start: l.start, end: l.end, opacity: l.opacity, params: { ...l.params },
      })),
    });
  }

  /** resolves to an ImageBitmap, or null if superseded by a newer request */
  render(n, opts = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'render', id, n, noCache: !!opts.noCache });
    });
  }

  setAhead(enabled) {
    this.worker.postMessage({ type: 'ahead', enabled });
  }
}
