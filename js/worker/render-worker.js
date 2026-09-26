import { Engine } from './engine.js';

const engine = new Engine((msg, transfer) => self.postMessage(msg, transfer || []));

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      engine.init(m);
      self.postMessage({ type: 'ready' });
      break;
    case 'layers':
      engine.setLayers(m.layers);
      break;
    case 'render':
      engine.request({ id: m.id, n: m.n, noCache: !!m.noCache });
      break;
    case 'ahead':
      engine.ahead = !!m.enabled;
      if (engine.ahead) engine.pump();
      break;
    case 'clearCache':
      engine.clearAll();
      break;
  }
};
