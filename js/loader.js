// Video probing and frame extraction.
// Primary path: Mediabunny (WebCodecs) — frame accurate and fast.
// Fallback: <video> element seeking, for browsers / codecs WebCodecs can't handle.

import * as MB from '../vendor/mediabunny.min.mjs';

export const THUMB_H = 64;
const JPEG_Q = 0.92;

export async function probe(file) {
  const info = { file, name: file.name, size: file.size };
  if (typeof VideoDecoder !== 'undefined') {
    try {
      const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
      info.mbInput = input;
      const track = await input.getPrimaryVideoTrack();
      if (track && (await track.canDecode())) {
        const first = await track.getFirstTimestamp();
        const end = await track.computeDuration();
        let fps = 0;
        try {
          const m = await track.computeFrameRateMetrics();
          fps = m.underlyingFrameRate || m.bestGuessFrameRate || 0;
        } catch {
          /* older API */
        }
        if (!fps) {
          const stats = await track.computePacketStats(300);
          fps = stats.averagePacketRate || 30;
        }
        Object.assign(info, {
          kind: 'mb',
          track,
          width: await track.getDisplayWidth(),
          height: await track.getDisplayHeight(),
          start: first,
          duration: Math.max(0, end - first),
          fps,
          hasAudio: !!(await input.getPrimaryAudioTrack()),
          codec: await track.getCodec(),
        });
        return info;
      }
    } catch (err) {
      console.warn('mediabunny probe failed, falling back to <video>', err);
    }
  }
  return probeElement(file, info);
}

async function probeElement(file, info) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  // keep it in the DOM (tiny) so that frame callbacks fire on every browser
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  document.body.appendChild(v);
  v.src = url;
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error('この動画形式はこのブラウザでは読み込めません'));
  });
  if (!v.videoWidth) throw new Error('映像トラックが見つかりません');
  let fps = await detectFps(v).catch(() => 0);
  Object.assign(info, {
    kind: 'element',
    video: v,
    url,
    width: v.videoWidth,
    height: v.videoHeight,
    start: 0,
    duration: v.duration,
    fps: fps || 30,
    fpsGuessed: !fps,
    hasAudio: !!info.mbInput && !!(await info.mbInput.getPrimaryAudioTrack().catch(() => null)),
  });
  return info;
}

function detectFps(v) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return Promise.resolve(0);
  return new Promise((resolve) => {
    const times = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.pause();
      v.currentTime = 0;
      const d = [];
      for (let i = 1; i < times.length; i++) {
        const dt = times[i] - times[i - 1];
        if (dt > 0.001) d.push(dt);
      }
      if (d.length < 3) return resolve(0);
      d.sort((a, b) => a - b);
      const frameDur = d[Math.floor(d.length * 0.25)];
      const fps = 1 / frameDur;
      // snap to common rates
      const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
      const near = common.find((c) => Math.abs(c - fps) / c < 0.02);
      resolve(near || Math.round(fps * 100) / 100);
    };
    const cb = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length > 24) finish();
      else if (!done) v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
    v.play().catch(() => finish());
    setTimeout(finish, 2500);
  });
}

export function targetSize(info, longSide) {
  let w = info.width, h = info.height;
  const s = longSide ? Math.min(1, longSide / Math.max(w, h)) : 1;
  w = Math.max(2, Math.round((w * s) / 2) * 2);
  h = Math.max(2, Math.round((h * s) / 2) * 2);
  return { w, h };
}

function toJpeg(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_Q });
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', JPEG_Q));
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Extract frames as JPEG blobs + small thumbnails.
 * @returns {Promise<{frames: Blob[], times: number[], thumbs: ImageBitmap[]}>}
 */
export async function extract(info, { from, to, w, h, onProgress, signal }) {
  const frames = [], times = [], thumbs = [];
  const tw = Math.max(2, Math.round((THUMB_H * w) / h));
  const thumbCanvas = makeCanvas(tw, THUMB_H);
  const tctx = thumbCanvas.getContext('2d');
  const pending = [];
  const push = async (source, t) => {
    const idx = frames.length;
    frames.push(null);
    times.push(t);
    const p = toJpeg(source).then((b) => (frames[idx] = b));
    pending.push(p);
    tctx.drawImage(source, 0, 0, tw, THUMB_H);
    thumbs.push(await createImageBitmap(thumbCanvas));
    if (pending.length > 4) await pending.shift();
    onProgress?.(frames.length, t);
  };

  if (info.kind === 'mb') {
    const sink = new MB.CanvasSink(info.track, { width: w, height: h, fit: 'fill', poolSize: 8 });
    for await (const wc of sink.canvases(info.start + from, info.start + to)) {
      if (signal?.aborted) break;
      await push(wc.canvas, wc.timestamp - info.start);
    }
  } else {
    const v = info.video;
    const fps = info.fps;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const n = Math.max(1, Math.floor((to - from) * fps + 1e-6));
    const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) break;
      const t = from + (i + 0.5) / fps;
      if (t >= info.duration) break;
      await seekTo(v, t, hasRVFC);
      ctx.drawImage(v, 0, 0, w, h);
      await push(canvas, from + i / fps);
    }
  }
  await Promise.all(pending);
  // drop frames whose encode failed (shouldn't happen)
  for (let i = frames.length - 1; i >= 0; i--) {
    if (!frames[i]) {
      frames.splice(i, 1);
      times.splice(i, 1);
      thumbs.splice(i, 1)[0]?.close?.();
    }
  }
  return { frames, times, thumbs };
}

function seekTo(v, t, hasRVFC) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const onSeeked = () => {
      v.removeEventListener('seeked', onSeeked);
      if (hasRVFC) {
        v.requestVideoFrameCallback(() => finish());
        setTimeout(finish, 150);
      } else finish();
    };
    v.addEventListener('seeked', onSeeked);
    v.currentTime = t;
    setTimeout(finish, 4000);
  });
}

export function disposeInfo(info) {
  if (!info) return;
  if (info.video) {
    info.video.pause();
    info.video.remove();
  }
  if (info.url) URL.revokeObjectURL(info.url);
}
