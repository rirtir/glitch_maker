import { Timeline } from './timeline.js';
import { probe, extract, targetSize, disposeInfo } from './loader.js';
import { exportVideo } from './exporter.js';
import { Renderer } from './renderer.js';
import { LayerPanel } from './layers-ui.js';
import { EFFECTS, defaultParams } from './effects/defs.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;
const PALETTE = ['#ff3d8b', '#3dd6ff', '#ffd23d', '#4dffa6', '#b77dff', '#ff8a3d', '#7dffea', '#ff6bd5'];

// ------------------------------------------------------------ state

const state = {
  info: null,
  video: null, // { w, h, fps, frames, times, thumbs, name }
  current: 0,
  layers: [],
  selectedId: null,
  playing: null, // 'play' | 'trial'
  trialOrigin: 0,
  cacheRanges: [],
  exporting: false,
};

const count = () => (state.video ? state.video.frames.length : 0);
const fps = () => (state.video ? state.video.fps : 30);

// ------------------------------------------------------------ renderer

let busyReq = null;
const renderer = new Renderer({
  onProgress: (m) => {
    if (!busyReq || m.id < busyReq) return;
    setBusy(true, `計算中 ${m.done}/${m.total}`);
  },
  onCache: (ranges) => {
    state.cacheRanges = ranges;
    timeline.requestDraw();
  },
});

// ------------------------------------------------------------ display

const view = $('view');
const vctx = view.getContext('2d');
const srcCache = new Map();

async function sourceBitmap(n) {
  let p = srcCache.get(n);
  if (!p) {
    p = createImageBitmap(state.video.frames[n]);
    srcCache.set(n, p);
    if (srcCache.size > 16) {
      const [k, old] = srcCache.entries().next().value;
      srcCache.delete(k);
      old.then((b) => b.close());
    }
  } else {
    srcCache.delete(n);
    srcCache.set(n, p);
  }
  return p;
}

function affected(n) {
  return state.layers.some((L) => L.visible && n >= L.start && (L.end == null || n <= L.end));
}

function drawBitmap(bmp, dim) {
  if (!bmp || !bmp.width) return; // closed bitmap
  if (view.width !== bmp.width || view.height !== bmp.height) {
    view.width = bmp.width;
    view.height = bmp.height;
  }
  vctx.globalAlpha = 1;
  vctx.drawImage(bmp, 0, 0);
  if (dim) {
    vctx.fillStyle = 'rgba(12,12,17,.45)';
    vctx.fillRect(0, 0, view.width, view.height);
  }
}

let displayToken = 0;
function setBusy(on, text) {
  $('busy').hidden = !on;
  if (text) $('busyText').textContent = text;
}

/** shows frame n (with effects). resolves true if it was drawn */
async function showFrame(n) {
  if (!state.video || state.exporting) return false;
  const token = ++displayToken;
  if (!affected(n)) {
    const bmp = await sourceBitmap(n);
    if (token !== displayToken) return false;
    drawBitmap(bmp);
    setBusy(false);
    busyReq = null;
    return true;
  }
  let drew = false;
  const slow = setTimeout(async () => {
    if (token !== displayToken || drew) return;
    setBusy(true, '計算中');
    const b = await sourceBitmap(n);
    if (token === displayToken && !drew) drawBitmap(b, true);
  }, 90);
  busyReq = renderer.nextId;
  let bmp;
  try {
    bmp = await renderer.render(n);
  } catch (err) {
    clearTimeout(slow);
    toast('レンダリングに失敗しました: ' + err.message, true);
    return false;
  }
  clearTimeout(slow);
  if (!bmp) return false;
  if (token !== displayToken) {
    bmp.close();
    return false;
  }
  drew = true;
  drawBitmap(bmp);
  bmp.close();
  setBusy(false);
  busyReq = null;
  return true;
}

// ------------------------------------------------------------ current frame

function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function frameTime(n) {
  const v = state.video;
  if (!v) return 0;
  return v.times[n] ?? n / v.fps;
}

function updateFrameUI(n, ghost) {
  const input = $('frameInput');
  if (document.activeElement !== input) input.value = n;
  $('timeText').textContent = fmtClock(frameTime(ghost ?? n)) + (ghost != null ? ' ▶' : '');
}

function setCurrent(n, { fromTimeline = false, show = true } = {}) {
  if (!state.video) return;
  n = Math.max(0, Math.min(count() - 1, Math.round(n)));
  state.current = n;
  updateFrameUI(n);
  if (!fromTimeline) timeline.setCurrent(n);
  panel.refreshActive();
  if (show) showFrame(n);
}

function step(d) {
  if (!state.video) return;
  if (state.playing) stopPlayback();
  setCurrent(state.current + d);
}

// ------------------------------------------------------------ playback

let playSession = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startPlayback(mode) {
  if (!state.video) return;
  stopPlayback(true);
  const session = ++playSession;
  let n = state.current;
  if (mode === 'play' && n >= count() - 1) n = 0;
  state.playing = mode;
  state.trialOrigin = state.current;
  updatePlayUI();
  const frameMs = 1000 / fps();
  let due = performance.now();
  while (state.playing === mode && session === playSession && n < count()) {
    await showFrame(n);
    if (session !== playSession) return;
    if (mode === 'play') {
      state.current = n;
      updateFrameUI(n);
      timeline.setCurrent(n);
    } else {
      timeline.setGhost(n);
      updateFrameUI(state.current, n);
    }
    due += frameMs;
    const now = performance.now();
    if (due < now - frameMs * 2) due = now; // fell behind (heavy effect): don't try to catch up
    if (due > now) await sleep(due - now);
    n++;
  }
  if (session === playSession) stopPlayback();
}

function stopPlayback(silent) {
  const mode = state.playing;
  if (!mode) return;
  state.playing = null;
  playSession++;
  if (mode === 'trial') {
    timeline.setGhost(null);
    updateFrameUI(state.current);
    if (!silent) showFrame(state.current);
  } else {
    panel.refreshActive();
  }
  updatePlayUI();
}

function togglePlay(mode) {
  if (state.playing === mode) stopPlayback();
  else startPlayback(mode);
}

function updatePlayUI() {
  const p = state.playing;
  const playBtn = $('btnPlay'), trialBtn = $('btnTrial');
  playBtn.querySelector('use').setAttribute('href', p === 'play' ? '#i-pause' : '#i-play');
  playBtn.querySelector('small').textContent = p === 'play' ? '停止' : '再生';
  trialBtn.querySelector('use').setAttribute('href', p === 'trial' ? '#i-stop' : '#i-trial');
  trialBtn.querySelector('small').textContent = p === 'trial' ? '戻る' : 'お試し';
  trialBtn.classList.toggle('on', p === 'trial');
  $('trialBadge').hidden = p !== 'trial';
  $('trialReturn').textContent = 'F' + state.trialOrigin;
}

// ------------------------------------------------------------ layers

const app = {
  get layers() {
    return state.layers;
  },
  get selectedId() {
    return state.selectedId;
  },
  get current() {
    return state.current;
  },
  get count() {
    return count();
  },
  get hasVideo() {
    return !!state.video;
  },
  get videoName() {
    return state.video ? `${state.video.name}  ${state.video.w}×${state.video.h}` : '';
  },
  select(id) {
    state.selectedId = id;
    panel.render();
  },
  update(L, patch, { live = false } = {}) {
    Object.assign(L, patch);
    if ('start' in patch && L.end != null && L.end < L.start) L.end = L.start;
    if ('end' in patch && L.end != null && L.end < L.start) L.start = L.end;
    commit(live);
    if (!live) panel.render();
  },
  add(type) {
    if (!state.video) return;
    stopPlayback();
    const used = new Set(state.layers.map((l) => l.color));
    const def = EFFECTS[type];
    const color = !used.has(def.color) ? def.color : PALETTE.find((c) => !used.has(c)) || def.color;
    const sameType = state.layers.filter((l) => l.type === type).length;
    const L = {
      id: Math.random().toString(36).slice(2, 10),
      type,
      name: def.label + (sameType ? ` ${sameType + 1}` : ''),
      color,
      visible: true,
      start: state.current,
      end: null,
      opacity: 1,
      params: defaultParams(type),
    };
    state.layers.push(L);
    state.selectedId = L.id;
    commit();
    panel.render();
    toast(`F${L.start} から「${def.label}」を開始します`);
  },
  remove(id) {
    const i = state.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    state.layers.splice(i, 1);
    if (state.selectedId === id) state.selectedId = state.layers[Math.min(i, state.layers.length - 1)]?.id ?? null;
    commit();
    panel.render();
  },
  move(id, dir) {
    const i = state.layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= state.layers.length) return;
    [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
    commit();
    panel.render();
  },
  duplicate(id) {
    const L = state.layers.find((l) => l.id === id);
    if (!L) return;
    const used = new Set(state.layers.map((l) => l.color));
    const copy = { ...L, params: { ...L.params }, id: Math.random().toString(36).slice(2, 10), name: L.name + ' のコピー', color: PALETTE.find((c) => !used.has(c)) || L.color };
    state.layers.splice(state.layers.indexOf(L) + 1, 0, copy);
    state.selectedId = copy.id;
    commit();
    panel.render();
  },
  seek(n) {
    stopPlayback();
    setCurrent(n);
  },
};

let commitTimer = 0;
function commit(live) {
  timeline.requestDraw();
  clearTimeout(commitTimer);
  const run = () => {
    renderer.setLayers(state.layers);
    if (!state.playing) showFrame(state.current);
  };
  if (live) commitTimer = setTimeout(run, 70);
  else run();
}

const panel = new LayerPanel(app, { list: $('layerList'), props: $('props'), addBtn: $('btnAddLayer'), addMenu: $('addMenu') });

// ------------------------------------------------------------ timeline

const timeline = new Timeline($('timeline'), {
  count,
  fps,
  thumb: (i) => state.video?.thumbs[i],
  thumbAspect: () => (state.video ? state.video.w / state.video.h : 16 / 9),
  layers: () => state.layers,
  cacheRanges: () => state.cacheRanges,
  onScrub: (n) => {
    if (state.playing) stopPlayback(true);
    setCurrent(n, { fromTimeline: true });
  },
  onViewChange: () => updateZoomText(),
  onInteract: () => hideHint(),
});

function updateZoomText() {
  $('zoomText').textContent = state.video ? timeline.zoomLabel() : '';
}
let hintTimer = 0;
function hideHint() {
  const el = $('tlHint');
  if (el.classList.contains('fade')) return;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.add('fade'), 1800);
}

// ------------------------------------------------------------ transport buttons

function holdRepeat(btn, fn) {
  let timer = 0, delay = 0;
  const stop = () => {
    clearTimeout(timer);
    timer = 0;
  };
  btn.addEventListener('pointerdown', (e) => {
    if (btn.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    fn();
    delay = 380;
    const rep = () => {
      fn();
      delay = Math.max(40, delay * 0.8);
      timer = setTimeout(rep, delay);
    };
    timer = setTimeout(rep, delay);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('lostpointercapture', stop);
  btn.addEventListener('click', (e) => {
    if (e.detail === 0) fn(); // keyboard activation
  });
}

document.querySelectorAll('.tp.step').forEach((b) => holdRepeat(b, () => step(+b.dataset.step)));
$('btnPlay').addEventListener('click', () => togglePlay('play'));
$('btnTrial').addEventListener('click', () => togglePlay('trial'));
$('btnFirst').addEventListener('click', () => step(-Infinity));
$('btnLast').addEventListener('click', () => step(Infinity));
$('btnZoomIn').addEventListener('click', () => timeline.zoomBy(2));
$('btnZoomOut').addEventListener('click', () => timeline.zoomBy(0.5));
$('btnZoomFit').addEventListener('click', () => timeline.fit());

const frameInput = $('frameInput');
frameInput.addEventListener('change', () => {
  const v = parseInt(frameInput.value, 10);
  if (Number.isFinite(v)) app.seek(v);
});
frameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') frameInput.blur();
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    step(e.key === 'ArrowUp' ? 1 : -1);
    frameInput.value = state.current;
  }
});
frameInput.addEventListener('focus', () => frameInput.select());

// ------------------------------------------------------------ keyboard

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') && t.type !== 'range' && t.type !== 'checkbox') return;
  if (document.querySelector('dialog[open]')) return;
  if (!state.video) return;
  const big = e.altKey || e.ctrlKey || e.metaKey;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay('play');
      break;
    case 'Enter':
      if (t && t.tagName === 'BUTTON') return;
      e.preventDefault();
      togglePlay('trial');
      break;
    case 'Escape':
      stopPlayback();
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (t && t.type === 'range') return;
      e.preventDefault();
      step((e.key === 'ArrowLeft' ? -1 : 1) * (big ? 30 : e.shiftKey ? 10 : 1));
      break;
    case 'Home':
      e.preventDefault();
      step(-Infinity);
      break;
    case 'End':
      e.preventDefault();
      step(Infinity);
      break;
    case '+':
    case '=':
      timeline.zoomBy(2);
      break;
    case '-':
    case '_':
      timeline.zoomBy(0.5);
      break;
    case '0':
      timeline.fit();
      break;
    case '[':
    case ']': {
      const L = state.layers.find((l) => l.id === state.selectedId);
      if (!L) return;
      app.update(L, e.key === '[' ? { start: state.current } : { end: state.current });
      break;
    }
  }
});

// ------------------------------------------------------------ opening files

const fileInput = $('fileInput');
$('btnOpen').addEventListener('click', () => fileInput.click());
$('btnOpen2').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  fileInput.value = '';
  if (f) openFile(f);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('dropOverlay').hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropOverlay').hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
  if (f) openFile(f);
  else if (e.dataTransfer?.files?.length) toast('動画ファイルをドロップしてください', true);
});

const loadDlg = $('loadDlg');
let loadAbort = null;

async function openFile(file) {
  if (state.exporting) return;
  stopPlayback();
  toast('動画を解析しています…');
  let info;
  try {
    info = await probe(file);
  } catch (err) {
    toast(err.message || '読み込めませんでした', true);
    return;
  }
  hideToast();
  showLoadDialog(info);
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e7) return (b / 1e6).toFixed(0) + ' MB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1e3)) + ' KB';
}

function showLoadDialog(info) {
  const grid = $('loadInfo');
  const rows = [
    ['ファイル', info.name],
    ['解像度', `${info.width} × ${info.height}`],
    ['長さ', `${info.duration.toFixed(2)} 秒`],
    ['フレームレート', `${+info.fps.toFixed(3)} fps${info.fpsGuessed ? '（推定）' : ''}`],
    ['読み込み方式', info.kind === 'mb' ? 'WebCodecs（フレーム正確）' : '互換モード（シーク）'],
  ];
  grid.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    grid.append(dt, dd);
  }
  const res = $('loadRes');
  res.innerHTML = '';
  const long = Math.max(info.width, info.height);
  const opts = [640, 960, 1280, 1920].filter((v) => v < long);
  for (const v of opts) res.append(new Option(`${v}px`, v));
  res.append(new Option(`原寸（${long}px）`, 0));
  const pref = isTouch ? 960 : 1280;
  res.value = opts.includes(pref) ? pref : opts.length && long > pref ? opts[opts.length - 1] : 0;
  $('loadStart').value = 0;
  $('loadStart').max = info.duration;
  $('loadEnd').max = info.duration;
  const maxFrames = isTouch ? 1800 : 3600;
  const endDefault = info.duration * info.fps > maxFrames ? Math.min(info.duration, 60) : info.duration;
  $('loadEnd').value = +endDefault.toFixed(2);
  $('loadFpsField').hidden = info.kind === 'mb';
  $('loadFps').value = +info.fps.toFixed(3);
  $('loadProgress').hidden = true;
  $('loadGo').textContent = '読み込む';
  $('loadGo').disabled = false;
  $('loadCancel').textContent = 'キャンセル';
  loadDlg._info = info;
  updateEstimate();
  loadDlg.showModal();
}

function loadParams() {
  const info = loadDlg._info;
  const from = Math.max(0, Math.min(info.duration, +$('loadStart').value || 0));
  let to = Math.max(0, Math.min(info.duration, +$('loadEnd').value || info.duration));
  if (to <= from) to = Math.min(info.duration, from + 1);
  if (info.kind !== 'mb') info.fps = Math.max(1, +$('loadFps').value || 30);
  const { w, h } = targetSize(info, +$('loadRes').value);
  return { info, from, to, w, h };
}

function updateEstimate() {
  if (!loadDlg._info) return;
  const { info, from, to, w, h } = loadParams();
  const frames = Math.round((to - from) * info.fps);
  const bytes = frames * w * h * 0.13;
  const el = $('loadEstimate');
  el.textContent = `約 ${frames} フレーム ／ ${w}×${h} ／ メモリ目安 ${fmtBytes(bytes)}`;
  const heavy = bytes > (isTouch ? 350e6 : 900e6);
  el.classList.toggle('warn', heavy);
  if (heavy) el.textContent += '（多すぎる場合は範囲を短くしてください）';
}
['loadRes', 'loadStart', 'loadEnd', 'loadFps'].forEach((id) => $(id).addEventListener('input', updateEstimate));

$('loadCancel').addEventListener('click', () => {
  if (loadAbort) {
    loadAbort.discard = true;
    loadAbort.abort();
  } else {
    disposeInfo(loadDlg._info);
    loadDlg._info = null;
    loadDlg.close();
  }
});
loadDlg.addEventListener('cancel', (e) => {
  e.preventDefault();
  $('loadCancel').click();
});

$('loadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (loadAbort) {
    // "use what we have" while extracting
    loadAbort.abort();
    return;
  }
  const { info, from, to, w, h } = loadParams();
  const ctrl = new AbortController();
  loadAbort = ctrl;
  $('loadProgress').hidden = false;
  $('loadGo').textContent = 'ここまでで使う';
  $('loadCancel').textContent = '中止';
  const expected = Math.max(1, Math.round((to - from) * info.fps));
  const t0 = performance.now();
  let result;
  try {
    result = await extract(info, {
      from, to, w, h, signal: ctrl.signal,
      onProgress: (n) => {
        const pct = Math.min(100, (n / expected) * 100);
        $('loadBar').style.width = pct + '%';
        const el = (performance.now() - t0) / 1000;
        const eta = n > 5 ? Math.max(0, (el / n) * (expected - n)) : 0;
        $('loadProgText').textContent = `${n} / ~${expected} フレーム` + (eta ? `（残り約 ${Math.ceil(eta)} 秒）` : '');
      },
    });
  } catch (err) {
    console.error(err);
    toast('フレームの取り出しに失敗しました: ' + err.message, true);
    loadAbort = null;
    loadDlg.close();
    return;
  }
  loadAbort = null;
  if (ctrl.discard || !result.frames.length) {
    result.thumbs.forEach((t) => t.close());
    $('loadProgress').hidden = true;
    $('loadGo').textContent = '読み込む';
    $('loadCancel').textContent = 'キャンセル';
    if (!ctrl.discard) toast('フレームを取り出せませんでした', true);
    return;
  }
  loadDlg.close();
  await setVideo(info, result, w, h);
});

async function setVideo(info, result, w, h) {
  if (state.info && state.info !== info) disposeInfo(state.info);
  state.video?.thumbs.forEach((t) => t.close());
  for (const p of srcCache.values()) p.then((b) => b.close());
  srcCache.clear();
  state.info = info;
  state.video = { w, h, fps: info.fps, frames: result.frames, times: result.times, thumbs: result.thumbs, name: info.name };
  state.cacheRanges = [];
  const n = result.frames.length;
  for (const L of state.layers) {
    L.start = Math.min(L.start, n - 1);
    if (L.end != null) L.end = Math.min(L.end, n - 1);
  }
  try {
    await renderer.init(w, h, result.frames);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  renderer.setLayers(state.layers);
  $('viewer').classList.remove('no-video');
  $('empty').hidden = true;
  $('viewer').style.aspectRatio = `${w} / ${h}`;
  $('frameTotal').textContent = `/ ${n - 1}`;
  frameInput.max = n - 1;
  ['btnExport', 'btnStill'].forEach((id) => ($(id).disabled = false));
  document.querySelectorAll('.tp, .timebar .mini').forEach((b) => (b.disabled = false));
  timeline.fit(true);
  timeline.resize();
  state.current = 0;
  setCurrent(0);
  updateZoomText();
  panel.render();
  $('tlHint').classList.remove('fade');
  toast(`${n} フレームを読み込みました`);
}

// ------------------------------------------------------------ still image

$('btnStill').addEventListener('click', async () => {
  if (!state.video) return;
  const n = state.current;
  const bmp = affected(n) ? await renderer.render(n) : await createImageBitmap(state.video.frames[n]);
  if (!bmp) return;
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const name = `${baseName()}_f${n}.png`;
  if (isTouch && navigator.canShare?.({ files: [new File([blob], name, { type: 'image/png' })] })) {
    try {
      await navigator.share({ files: [new File([blob], name, { type: 'image/png' })] });
      return;
    } catch {
      /* fall back to download */
    }
  }
  download(blob, name);
});

function baseName() {
  return (state.video?.name || 'video').replace(/\.[^.]+$/, '') + '_glitch';
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ------------------------------------------------------------ export

const exportDlg = $('exportDlg');
let exportAbort = null;
let exportUrl = null;

$('btnExport').addEventListener('click', () => {
  if (!state.video) return;
  stopPlayback();
  const n = count();
  $('expStart').value = 0;
  $('expEnd').value = n - 1;
  $('expStart').max = $('expEnd').max = n - 1;
  $('expAudioWrap').hidden = !state.info?.hasAudio;
  $('expProgress').hidden = true;
  $('expResult').hidden = true;
  $('expResult').innerHTML = '';
  $('expGo').disabled = false;
  $('expCancel').textContent = '閉じる';
  updateExportInfo();
  exportDlg.showModal();
});
exportDlg.querySelectorAll('input[name=expRange]').forEach((r) =>
  r.addEventListener('change', () => {
    $('expCustom').hidden = exportDlg.querySelector('input[name=expRange]:checked').value !== 'custom';
    updateExportInfo();
  }),
);
['expStart', 'expEnd'].forEach((id) => $(id).addEventListener('input', updateExportInfo));
$('expStartPin').addEventListener('click', () => {
  $('expStart').value = state.current;
  updateExportInfo();
});
$('expEndPin').addEventListener('click', () => {
  $('expEnd').value = state.current;
  updateExportInfo();
});

function exportRange() {
  const n = count();
  if (exportDlg.querySelector('input[name=expRange]:checked').value === 'all') return [0, n - 1];
  let a = Math.max(0, Math.min(n - 1, parseInt($('expStart').value, 10) || 0));
  let b = Math.max(0, Math.min(n - 1, parseInt($('expEnd').value, 10)));
  if (!Number.isFinite(b)) b = n - 1;
  if (b < a) [a, b] = [b, a];
  return [a, b];
}

function updateExportInfo() {
  const [a, b] = exportRange();
  const v = state.video;
  const dur = frameTime(b) - frameTime(a) + 1 / v.fps;
  $('expInfo').textContent = `F${a}〜F${b}（${b - a + 1} フレーム・${dur.toFixed(2)} 秒）／ ${v.w}×${v.h} ／ ${+v.fps.toFixed(3)} fps`;
}

$('expCancel').addEventListener('click', () => {
  if (exportAbort) exportAbort.abort();
  else exportDlg.close();
});
exportDlg.addEventListener('cancel', (e) => {
  e.preventDefault();
  $('expCancel').click();
});

$('exportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (exportAbort) return;
  const range = exportRange();
  const v = state.video;
  exportAbort = new AbortController();
  state.exporting = true;
  renderer.setAhead(false);
  $('expGo').disabled = true;
  $('expCancel').textContent = '中止';
  $('expProgress').hidden = false;
  $('expResult').hidden = true;
  $('expBar').style.width = '0%';
  const t0 = performance.now();
  try {
    const res = await exportVideo({
      info: state.info,
      w: v.w,
      h: v.h,
      fps: v.fps,
      times: v.times,
      range,
      quality: $('expQuality').value,
      audio: $('expAudio').checked && !!state.info?.hasAudio,
      signal: exportAbort.signal,
      getFrame: async (n) => {
        const bmp = await renderer.render(n, { noCache: true });
        if (!bmp) throw new Error('レンダリングが中断されました');
        return bmp;
      },
      onProgress: (done, total, phase) => {
        $('expBar').style.width = (done / total) * 100 + '%';
        const el = (performance.now() - t0) / 1000;
        const eta = done > 3 ? (el / done) * (total - done) : 0;
        const label = phase === 'record' ? '録画中' : 'レンダリング中';
        $('expProgText').textContent = `${label} ${done}/${total}` + (eta ? `（残り約 ${Math.ceil(eta)} 秒）` : '');
      },
    });
    showExportResult(res);
  } catch (err) {
    if (err.name === 'AbortError') toast('書き出しを中止しました');
    else {
      console.error(err);
      toast('書き出しに失敗しました: ' + err.message, true);
    }
    $('expProgress').hidden = true;
  } finally {
    exportAbort = null;
    state.exporting = false;
    renderer.setAhead(true);
    $('expGo').disabled = false;
    $('expCancel').textContent = '閉じる';
    showFrame(state.current);
  }
});

function showExportResult({ blob, ext, audio }) {
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = URL.createObjectURL(blob);
  const name = `${baseName()}.${ext}`;
  const box = $('expResult');
  box.innerHTML = '';
  const video = document.createElement('video');
  video.src = exportUrl;
  video.controls = true;
  video.playsInline = true;
  video.loop = true;
  const row = document.createElement('div');
  row.className = 'row';
  const dl = document.createElement('a');
  dl.className = 'btn primary';
  dl.href = exportUrl;
  dl.download = name;
  dl.innerHTML = '<svg><use href="#i-export"/></svg>保存する';
  row.append(dl);
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    const sh = document.createElement('button');
    sh.type = 'button';
    sh.className = 'btn';
    sh.innerHTML = '<svg><use href="#i-share"/></svg>共有';
    sh.onclick = () => navigator.share({ files: [file] }).catch(() => {});
    row.append(sh);
  }
  const meta = document.createElement('small');
  meta.style.color = 'var(--fg2)';
  meta.textContent = `${name} ・ ${fmtBytes(blob.size)}${audio ? ' ・ 音声あり' : ''}`;
  box.append(video, row, meta);
  box.hidden = false;
  $('expProgress').hidden = true;
}

// ------------------------------------------------------------ help & toast

$('btnHelp').addEventListener('click', () => $('helpDlg').showModal());

let toastTimer = 0;
function toast(msg, error) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', !!error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, error ? 5000 : 2600);
}
function hideToast() {
  $('toast').hidden = true;
}

// ------------------------------------------------------------ init

function checkSupport() {
  const missing = [];
  if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
  if (typeof createImageBitmap === 'undefined') missing.push('createImageBitmap');
  if (missing.length) toast('このブラウザは一部機能に対応していません（' + missing.join(', ') + '）。最新の Chrome / Safari / Firefox をお使いください。', true);
}

$('viewer').classList.add('no-video');
document.querySelectorAll('.tp, .timebar .mini').forEach((b) => (b.disabled = true));
updatePlayUI();
panel.render();
checkSupport();

// debugging / automation hook
window.glitchMaker = { state, app, setCurrent, timeline, renderer, openFile };
