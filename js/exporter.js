// Video export. Uses WebCodecs + Mediabunny (MP4 / WebM) when available,
// otherwise records the canvas in real time with MediaRecorder.

import * as MB from '../vendor/mediabunny.min.mjs';

// bits per pixel per frame (glitched footage is noisy, so be generous)
const BPP = { 'very-high': 0.3, high: 0.18, medium: 0.1, low: 0.05 };

export function canUseWebCodecs() {
  return typeof VideoEncoder !== 'undefined';
}

async function pickFormat(w, h) {
  const tries = [
    { make: () => new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), ext: 'mp4', codecs: ['avc', 'hevc'] },
    { make: () => new MB.WebMOutputFormat(), ext: 'webm', codecs: ['vp9', 'vp8', 'av1'] },
    { make: () => new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), ext: 'mp4', codecs: ['av1', 'vp9'] },
  ];
  for (const t of tries) {
    const format = t.make();
    const supported = format.getSupportedVideoCodecs();
    const list = t.codecs.filter((c) => supported.includes(c));
    const codec = await MB.getFirstEncodableVideoCodec(list, { width: w, height: h });
    if (codec) return { format, codec, ext: t.ext };
  }
  return null;
}

/**
 * @param o.getFrame  async (n) => ImageBitmap (rendered frame)
 * @param o.times     presentation time (s) of each frame
 */
export async function exportVideo(o) {
  if (canUseWebCodecs()) {
    const picked = await pickFormat(o.w, o.h);
    if (picked) return exportWithMediabunny(o, picked);
  }
  if (typeof MediaRecorder !== 'undefined' && HTMLCanvasElement.prototype.captureStream) return exportWithRecorder(o);
  throw new Error('このブラウザは動画の書き出しに対応していません');
}

async function exportWithMediabunny(o, { format, codec, ext }) {
  const { w, h, fps, range, times } = o;
  const [a, b] = range;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  const output = new MB.Output({ format, target: new MB.BufferTarget() });
  const bitrate = Math.max(300e3, Math.round(w * h * fps * (BPP[o.quality] || BPP.high)));
  const videoSource = new MB.CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });

  const t0 = times[a];
  const t1 = b + 1 < times.length ? times[b + 1] : times[b] + 1 / fps;

  // ---- audio
  let audio = null;
  if (o.audio && o.info.mbInput) {
    try {
      audio = await setupAudio(o.info, output, format, t0, t1);
    } catch (err) {
      console.warn('audio skipped', err);
      audio = null;
    }
  }

  await output.start();
  try {
    for (let n = a; n <= b; n++) {
      if (o.signal?.aborted) throw new DOMException('中止しました', 'AbortError');
      const bmp = await o.getFrame(n);
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      const ts = times[n] - t0;
      const next = n + 1 < times.length ? times[n + 1] - t0 : ts + 1 / fps;
      await videoSource.add(ts, Math.max(1 / 1000, next - ts));
      if (audio) await audio.pumpUntil(next + 0.25);
      o.onProgress?.(n - a + 1, b - a + 1);
    }
    if (audio) await audio.pumpUntil(Infinity);
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  const mime = await output.getMimeType().catch(() => (ext === 'mp4' ? 'video/mp4' : 'video/webm'));
  return { blob: new Blob([output.target.buffer], { type: mime.split(';')[0] }), ext, audio: !!audio };
}

async function setupAudio(info, output, format, t0, t1) {
  const track = await info.mbInput.getPrimaryAudioTrack();
  if (!track) return null;
  const codec = await track.getCodec();
  const start = info.start || 0;
  const absFrom = start + t0, absTo = start + t1;
  if (codec && format.getSupportedAudioCodecs().includes(codec)) {
    // pass the compressed packets through untouched
    const source = new MB.EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    const decoderConfig = await track.getDecoderConfig();
    const sink = new MB.EncodedPacketSink(track);
    const startPacket = (await sink.getPacket(absFrom)) || (await sink.getFirstPacket());
    const it = sink.packets(startPacket || undefined);
    let first = true, done = false, buffered = null;
    return {
      async pumpUntil(limit) {
        while (!done) {
          const next = buffered || (await it.next());
          buffered = null;
          if (next.done) {
            done = true;
            break;
          }
          const p = next.value;
          if (p.timestamp >= absTo) {
            done = true;
            break;
          }
          const ts = p.timestamp - absFrom;
          if (ts < 0) continue;
          if (ts > limit) {
            buffered = next;
            break;
          }
          await source.add(p.clone({ timestamp: ts }), first ? { decoderConfig } : undefined);
          first = false;
        }
      },
    };
  }
  // otherwise decode and re-encode
  if (!(await track.canDecode())) return null;
  const outCodec = await MB.getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), {
    numberOfChannels: await track.getNumberOfChannels(),
    sampleRate: await track.getSampleRate(),
  });
  if (!outCodec) return null;
  const source = new MB.AudioSampleSource({ codec: outCodec, bitrate: MB.QUALITY_HIGH });
  output.addAudioTrack(source);
  const sink = new MB.AudioSampleSink(track);
  const it = sink.samples(absFrom, absTo);
  let done = false, buffered = null;
  return {
    async pumpUntil(limit) {
      while (!done) {
        const next = buffered || (await it.next());
        buffered = null;
        if (next.done) {
          done = true;
          break;
        }
        const s = next.value;
        const ts = s.timestamp - absFrom;
        if (ts < 0) {
          s.close();
          continue;
        }
        if (ts > limit) {
          buffered = next;
          break;
        }
        s.setTimestamp(ts);
        await source.add(s);
        s.close();
      }
    },
  };
}

async function exportWithRecorder(o) {
  const { w, h, fps, range } = o;
  const [a, b] = range;
  const total = b - a + 1;
  // 1) render everything first so the realtime recording never stalls
  const frames = [];
  for (let n = a; n <= b; n++) {
    if (o.signal?.aborted) throw new DOMException('中止しました', 'AbortError');
    const bmp = await o.getFrame(n);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    frames.push(await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95)));
    o.onProgress?.(n - a + 1, total * 2, 'render');
  }
  // 2) play them into a MediaRecorder
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(fps);
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.max(300e3, Math.round(w * h * fps * (BPP[o.quality] || BPP.high))) });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => (rec.onstop = res));
  const first = await createImageBitmap(frames[0]);
  ctx.drawImage(first, 0, 0);
  rec.start(250);
  const t0 = performance.now();
  for (let i = 0; i < frames.length; i++) {
    if (o.signal?.aborted) {
      rec.stop();
      throw new DOMException('中止しました', 'AbortError');
    }
    const bmp = await createImageBitmap(frames[i]);
    const due = t0 + (i * 1000) / fps;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    o.onProgress?.(total + i + 1, total * 2, 'record');
  }
  await new Promise((r) => setTimeout(r, 1000 / fps + 50));
  rec.stop();
  await stopped;
  const type = (rec.mimeType || mimeType || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm', audio: false };
}
