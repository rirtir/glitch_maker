// Effect definitions shared by the UI (to build the parameter editor) and the
// render worker (to know defaults). To add a new effect: add an entry here and
// an implementation in js/worker/fx.js.

export const EFFECTS = {
  datamosh: {
    label: 'データモッシュ',
    short: 'MOSH',
    icon: 'i-fx-mosh',
    color: '#ff3d8b',
    description:
      'Iフレームが欠落した状態を再現します。開始フレームで映像の更新が止まり、それ以降は「動き」と「差分」だけが古い映像の上に積み重なります。',
    params: [
      {
        key: 'mode', label: 'モード', type: 'select', default: 'iframe',
        options: [
          ['iframe', 'Iフレーム欠落（シーンが混ざる）'],
          ['bloom', 'Pフレーム複製（ブルーム／溶ける）'],
        ],
      },
      {
        key: 'ref', label: '参照フレーム', type: 'frame', default: null,
        help: '空欄＝開始直前のフレーム。別の場面を指定すると、その絵の上に動きが乗ります（元動画から取得）。',
        showIf: (p) => p.mode === 'iframe',
      },
      {
        key: 'blockSize', label: 'マクロブロック', type: 'select', default: 16,
        options: [[8, '8 px'], [16, '16 px（標準）'], [32, '32 px']],
      },
      {
        key: 'residual', label: '差分（残差）の強さ', type: 'range', min: 0, max: 2, step: 0.05, default: 1,
        help: '新しい映像の輪郭がどれだけ上書きされるか。0で動きだけ。',
      },
      {
        key: 'motion', label: '動きベクトル倍率', type: 'range', min: -2, max: 4, step: 0.05, default: 1,
        help: '1より大きいと動きが誇張され、引き伸ばされます。',
      },
      {
        key: 'intra', label: 'イントラ復帰', type: 'range', min: 0, max: 100, step: 1, default: 30,
        help: '大きいほど、大きく動いた部分が本来の映像に戻ります（写真のカニのように）。0で完全に崩れたまま。',
        showIf: (p) => p.mode === 'iframe',
      },
      {
        key: 'quality', label: '画質（量子化）', type: 'range', min: 0, max: 100, step: 1, default: 55,
        help: '低いほど差分がブロック状に粗くなります。',
      },
    ],
  },

  macroblock: {
    label: 'マクロブロック／パケットロス',
    short: 'BLOCK',
    icon: 'i-fx-block',
    color: '#3dd6ff',
    description:
      '低ビットレートの圧縮ノイズと、パケットロスによるブロック欠け・崩れの伝搬を再現します。',
    params: [
      {
        key: 'quality', label: 'ビットレート（画質）', type: 'range', min: 0, max: 100, step: 1, default: 40,
        help: '低いほどブロックノイズが強くなります。高くしてパケットロスだけ起こすことも可能。',
      },
      {
        key: 'loss', label: 'パケットロス率', type: 'range', min: 0, max: 100, step: 0.5, default: 6, unit: '%',
      },
      {
        key: 'pattern', label: '欠け方', type: 'select', default: 'slice',
        options: [
          ['slice', 'スライス（横に連続）'],
          ['block', 'ブロック単位（点在）'],
          ['tail', 'フレーム末尾まで（下半分が崩れる）'],
        ],
      },
      {
        key: 'sliceLen', label: 'スライス長（ブロック数）', type: 'range', min: 1, max: 120, step: 1, default: 20,
        showIf: (p) => p.pattern === 'slice',
      },
      {
        key: 'conceal', label: '欠けた部分', type: 'select', default: 'motion',
        options: [
          ['motion', '動きで引きずる（スミア）'],
          ['freeze', '前フレームのまま'],
          ['shift', 'ずれて貼り付く'],
          ['noise', 'ブロックノイズ'],
          ['green', '緑（YUV=0）'],
          ['gray', 'グレー'],
        ],
      },
      {
        key: 'propagate', label: 'エラー伝搬', type: 'bool', default: true,
        help: 'ONにすると次のキーフレームまで崩れが残り、動きに合わせて広がります。',
      },
      {
        key: 'gop', label: 'キーフレーム間隔', type: 'range', min: 1, max: 600, step: 1, default: 90, unit: 'f',
        help: 'この間隔で映像がリフレッシュされます。',
      },
      {
        key: 'blockSize', label: 'マクロブロック', type: 'select', default: 16,
        options: [[8, '8 px'], [16, '16 px（標準）'], [32, '32 px']],
      },
      { key: 'seed', label: 'シード', type: 'seed', default: 1 },
    ],
  },
};

export const EFFECT_ORDER = ['datamosh', 'macroblock'];

export function defaultParams(type) {
  const p = {};
  for (const d of EFFECTS[type].params) p[d.key] = d.default;
  return p;
}

/** normalises a layer's end frame (null = until the end) */
export function layerEnd(layer, frameCount) {
  return layer.end == null ? frameCount - 1 : Math.min(layer.end, frameCount - 1);
}
