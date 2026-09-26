// Layer list + property editor.

import { EFFECTS, EFFECT_ORDER } from './effects/defs.js';

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
const icon = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
};

function fmtNum(v, step) {
  const d = step < 1 ? Math.min(3, String(step).split('.')[1]?.length || 2) : 0;
  return Number(v).toFixed(d);
}

export class LayerPanel {
  /**
   * app: { layers, selectedId, current, count, hasVideo, select(id), update(layer, patch, {live}) — re-renders unless live,
   *        add(type), remove(id), move(id, dir), duplicate(id), seek(n) }
   */
  constructor(app, { list, props, addBtn, addMenu }) {
    this.app = app;
    this.list = list;
    this.props = props;
    this.addBtn = addBtn;
    this.addMenu = addMenu;
    this.propsFor = null;
    this.buildAddMenu();
  }

  buildAddMenu() {
    this.addMenu.innerHTML = '';
    for (const type of EFFECT_ORDER) {
      const def = EFFECTS[type];
      this.addMenu.append(
        h('button', {
          class: 'add-item', type: 'button',
          onclick: () => {
            this.closeMenu();
            this.app.add(type);
          },
        },
        h('span', { class: 'sw', style: `--c:${def.color}` }, icon(def.icon)),
        h('div', {}, h('b', {}, def.label), h('span', {}, def.description))),
      );
    }
    this.addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.addMenu.hidden) this.openMenu();
      else this.closeMenu();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.addMenu.hidden && !this.addMenu.contains(e.target) && e.target !== this.addBtn && !this.addBtn.contains(e.target)) this.closeMenu();
    });
  }
  openMenu() {
    this.addMenu.hidden = false;
  }
  closeMenu() {
    this.addMenu.hidden = true;
  }

  rangeText(L) {
    const end = L.end == null ? '最後まで' : `F${L.end}`;
    return `F${L.start} → ${end}`;
  }

  render() {
    const { app } = this;
    this.addBtn.disabled = !app.hasVideo;
    this.list.innerHTML = '';
    const layers = app.layers;
    if (!layers.length) {
      this.list.append(h('li', { class: 'empty-layers' }, app.hasVideo ? '「エフェクト追加」でグリッチを重ねられます' : '動画を読み込むとエフェクトを追加できます'));
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const def = EFFECTS[L.type];
      const active = app.current >= L.start && (L.end == null || app.current <= L.end);
      const li = h('li', {
        class: `layer${L.id === app.selectedId ? ' sel' : ''}${L.visible ? '' : ' off'}${active ? '' : ' inactive-now'}`,
        style: `--c:${L.color}`,
        onclick: () => app.select(L.id),
      },
      h('button', {
        class: 'mini', type: 'button', title: L.visible ? '非表示にする' : '表示する',
        onclick: (e) => { e.stopPropagation(); app.update(L, { visible: !L.visible }); },
      }, icon(L.visible ? 'i-eye' : 'i-eye-off')),
      h('span', { class: 'sw' }, icon(def.icon)),
      h('div', { class: 'layer-main' },
        h('div', { class: 'layer-name' }, L.name),
        h('div', { class: 'layer-range' }, this.rangeText(L))),
      h('button', { class: 'mini', type: 'button', title: '上へ（後から適用）', disabled: i === layers.length - 1, onclick: (e) => { e.stopPropagation(); app.move(L.id, 1); } }, icon('i-up')),
      h('button', { class: 'mini', type: 'button', title: '下へ（先に適用）', disabled: i === 0, onclick: (e) => { e.stopPropagation(); app.move(L.id, -1); } }, icon('i-down')),
      h('button', { class: 'mini', type: 'button', title: '複製', onclick: (e) => { e.stopPropagation(); app.duplicate(L.id); } }, icon('i-copy')),
      h('button', { class: 'mini', type: 'button', title: '削除', onclick: (e) => { e.stopPropagation(); app.remove(L.id); } }, icon('i-trash')),
      );
      this.list.append(li);
    }
    if (app.hasVideo) {
      this.list.append(h('li', { class: 'layer source' },
        h('span', { class: 'sw' }, icon('i-source')),
        h('div', { class: 'layer-main' }, h('div', { class: 'layer-name' }, '元動画'), h('div', { class: 'layer-range' }, app.videoName || ''))));
    }
    this.renderProps();
  }

  /** light refresh (current frame moved) without rebuilding inputs */
  refreshActive() {
    const { app } = this;
    const items = this.list.querySelectorAll('li.layer:not(.source)');
    const layers = app.layers;
    items.forEach((li, k) => {
      const L = layers[layers.length - 1 - k];
      if (!L) return;
      const active = app.current >= L.start && (L.end == null || app.current <= L.end);
      li.classList.toggle('inactive-now', !active);
    });
    if (this.pinButtons) for (const b of this.pinButtons) b.title = `現在位置（F${app.current}）に設定`;
  }

  renderProps() {
    const { app } = this;
    const L = app.layers.find((l) => l.id === app.selectedId);
    this.props.innerHTML = '';
    this.pinButtons = [];
    if (!L) return;
    const def = EFFECTS[L.type];
    const card = h('div', { class: 'props-card', style: `--c:${L.color}` });
    card.append(
      h('h3', { class: 'props-title' }, icon(def.icon), L.name),
      h('p', { class: 'props-desc' }, def.description),
    );

    // ---- range
    card.append(this.frameRow('開始フレーム', L.start, {
      onSet: (v) => app.update(L, { start: Math.max(0, Math.min(app.count - 1, v)) }),
      help: 'この位置からグリッチが始まります',
    }));
    card.append(this.frameRow('終了フレーム', L.end, {
      nullable: true,
      nullLabel: '最後まで',
      onSet: (v) => app.update(L, { end: v == null ? null : Math.max(0, Math.min(app.count - 1, v)) }),
    }));
    card.append(h('hr', { class: 'range-sep' }));

    // ---- params
    for (const pd of def.params) {
      if (pd.showIf && !pd.showIf(L.params)) continue;
      card.append(this.paramRow(L, pd));
    }
    // ---- opacity
    card.append(this.paramRow(L, { key: '__opacity', label: '不透明度', type: 'range', min: 0, max: 1, step: 0.01 }, {
      get: () => L.opacity,
      set: (v, live) => app.update(L, { opacity: v }, { live }),
    }));
    this.props.append(card);
  }

  frameRow(label, value, { onSet, nullable, nullLabel, help }) {
    const { app } = this;
    const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: Math.max(0, app.count - 1), step: 1, value: value == null ? '' : value, placeholder: nullLabel || '' });
    input.addEventListener('change', () => {
      const t = input.value.trim();
      if (t === '' && nullable) onSet(null);
      else if (Number.isFinite(+t)) onSet(Math.round(+t));
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    const pin = h('button', { class: 'fbtn pin', type: 'button', title: `現在位置（F${app.current}）に設定`, onclick: () => onSet(app.current) }, icon('i-pin'), '現在位置');
    this.pinButtons.push(pin);
    const go = h('button', { class: 'fbtn', type: 'button', title: 'このフレームへ移動', disabled: value == null, onclick: () => value != null && app.seek(value) }, icon('i-goto'));
    const kids = [input, pin];
    if (nullable) kids.push(h('button', { class: `fbtn${value == null ? ' on' : ''}`, type: 'button', title: '最後まで', onclick: () => onSet(null) }, icon('i-infinity')));
    kids.push(go);
    return h('div', { class: 'prop' },
      h('div', { class: 'prop-label' }, h('span', {}, label)),
      h('div', { class: 'frame-field' }, ...kids),
      help ? h('div', { class: 'prop-help' }, help) : null);
  }

  paramRow(L, pd, acc) {
    const { app } = this;
    const get = acc ? acc.get : () => L.params[pd.key];
    const set = acc
      ? acc.set
      : (v, live) => app.update(L, { params: { ...L.params, [pd.key]: v } }, { live });
    const row = h('div', { class: 'prop' });
    const val = get();
    if (pd.type === 'range') {
      const out = h('output', {}, fmtNum(val, pd.step) + (pd.unit || ''));
      const range = h('input', { type: 'range', min: pd.min, max: pd.max, step: pd.step, value: val });
      const num = h('input', { type: 'number', min: pd.min, max: pd.max, step: pd.step, value: fmtNum(val, pd.step) });
      range.addEventListener('input', () => {
        const v = +range.value;
        out.textContent = fmtNum(v, pd.step) + (pd.unit || '');
        num.value = fmtNum(v, pd.step);
        set(v, true);
      });
      range.addEventListener('change', () => set(+range.value, false));
      num.addEventListener('change', () => {
        let v = +num.value;
        if (!Number.isFinite(v)) return;
        v = Math.max(pd.min, Math.min(pd.max, v));
        range.value = v;
        out.textContent = fmtNum(v, pd.step) + (pd.unit || '');
        set(v, false);
      });
      row.append(h('div', { class: 'prop-label' }, h('span', {}, pd.label), out), h('div', { class: 'range-row' }, range, num));
    } else if (pd.type === 'select') {
      const sel = h('select', {}, ...pd.options.map(([v, t]) => h('option', { value: String(v), selected: String(v) === String(val) }, t)));
      sel.addEventListener('change', () => {
        const opt = pd.options.find(([v]) => String(v) === sel.value);
        set(opt ? opt[0] : sel.value, false);
      });
      row.append(h('div', { class: 'prop-label' }, h('span', {}, pd.label)), sel);
    } else if (pd.type === 'bool') {
      const cb = h('input', { type: 'checkbox', checked: !!val });
      cb.addEventListener('change', () => set(cb.checked, false));
      row.append(h('label', { class: 'switch' }, h('span', { class: 'prop-label', style: 'margin:0' }, pd.label), cb));
    } else if (pd.type === 'frame') {
      row.append(this.frameRow(pd.label, val, {
        nullable: true,
        nullLabel: '自動（開始直前）',
        onSet: (v) => set(v == null ? null : Math.max(0, Math.min(app.count - 1, v)), false),
      }));
      row.firstChild.classList.remove('prop');
    } else if (pd.type === 'seed') {
      const num = h('input', { type: 'number', step: 1, value: val });
      num.addEventListener('change', () => set(Math.round(+num.value) || 0, false));
      const dice = h('button', {
        class: 'fbtn', type: 'button', title: 'ランダム',
        onclick: () => {
          const v = Math.floor(Math.random() * 100000);
          num.value = v;
          set(v, false);
        },
      }, icon('i-dice'), '変える');
      row.append(h('div', { class: 'prop-label' }, h('span', {}, pd.label)), h('div', { class: 'frame-field' }, num, dice));
    }
    if (pd.help) row.append(h('div', { class: 'prop-help' }, pd.help));
    return row;
  }
}
