// Mutation telemetry for localStorage / sessionStorage / document.cookie.
// Forwards every write/delete to console as a tagged JSON line that the keep
// loop's console listener picks up and writes to console.log. Subsequent
// analysis can grep `__ddx_storage__` to see exactly what the page mutated.
(() => {
  const log = (kind, payload) => {
    try {
      console.log('__ddx_storage__ ' + JSON.stringify({ kind, ts: Date.now(), ...payload }));
    } catch (_) {}
  };

  const wrapStorage = (name) => {
    try {
      const s = window[name];
      const origSet = s.setItem.bind(s);
      const origRm = s.removeItem.bind(s);
      const origClear = s.clear.bind(s);
      s.setItem = (k, v) => {
        log(name + '.setItem', { key: String(k), value: String(v).slice(0, 4000) });
        return origSet(k, v);
      };
      s.removeItem = (k) => {
        log(name + '.removeItem', { key: String(k) });
        return origRm(k);
      };
      s.clear = () => {
        log(name + '.clear', {});
        return origClear();
      };
    } catch (_) {}
  };
  wrapStorage('localStorage');
  wrapStorage('sessionStorage');

  // document.cookie writes (only same-origin; HttpOnly cookies stay invisible).
  try {
    const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookieDesc && cookieDesc.set) {
      const origSet = cookieDesc.set.bind(document);
      Object.defineProperty(document, 'cookie', {
        get: cookieDesc.get.bind(document),
        set: (v) => {
          log('document.cookie.set', { value: String(v).slice(0, 800) });
          return origSet(v);
        },
        configurable: true,
      });
    }
  } catch (_) {}

  // IndexedDB open — surface DB names being used.
  try {
    const origOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      log('indexedDB.open', { name: String(args[0] || ''), version: args[1] || null });
      return origOpen(...args);
    };
  } catch (_) {}
})();
