// Supplementary stealth patches applied as an init script on every page.
// Runs BEFORE any page script. Layered on top of playwright-stealth / patchright,
// not a replacement. Focus: fingerprint surfaces those two don't touch.
//
// Targets:
//   - Canvas fingerprint (toDataURL / getImageData) — inject per-context deterministic noise
//   - AudioContext fingerprint (getChannelData / getFloatFrequencyData) — inject noise
//   - WebGL renderer/vendor — realistic Intel + Intel UHD (matches many real Linux Chrome installs)
//   - Battery API — realistic charging state
//   - navigator.connection — realistic 4g values
//   - navigator.hardwareConcurrency, navigator.deviceMemory — realistic
//   - navigator.plugins realistic length guarantee
//   - Permissions API: Notification permission returns 'default' rather than the
//     telltale 'denied' headless Chrome returns
//   - chrome.app.InstallState / chrome.app.RunningState — shim
//   - Notification.permission — 'default'

(() => {
  // Derive a stable per-session seed from the user agent + screen — same within
  // a session, different across sessions. Avoids breaking legitimate usage that
  // expects consistent fingerprint within a visit.
  const seedStr = (navigator.userAgent || '') + '|' + screen.width + 'x' + screen.height;
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = ((seed << 5) - seed + seedStr.charCodeAt(i)) | 0;
  const mulberry32 = (a) => () => {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = mulberry32(seed);

  // -- Canvas noise ---------------------------------------------------------
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const perturb = (ctx) => {
      try {
        const w = ctx.canvas.width, h = ctx.canvas.height;
        if (w === 0 || h === 0) return;
        // Only perturb one pixel. Bigger changes trip sanity checks.
        const x = Math.floor(rand() * w);
        const y = Math.floor(rand() * h);
        const img = origGetImageData.call(ctx, x, y, 1, 1);
        img.data[0] ^= 1;
        ctx.putImageData(img, x, y);
      } catch (_) {}
    };
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      try { perturb(this.getContext('2d')); } catch (_) {}
      return origToDataURL.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const data = origGetImageData.apply(this, args);
      // Subtle noise on last pixel only
      if (data && data.data && data.data.length >= 4) {
        data.data[data.data.length - 4] ^= 1;
      }
      return data;
    };
  } catch (_) {}

  // -- AudioContext noise ---------------------------------------------------
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function (...args) {
        const arr = origGetChannelData.apply(this, args);
        if (arr && arr.length) {
          const idx = Math.floor(rand() * arr.length);
          arr[idx] = arr[idx] + (rand() - 0.5) * 1e-7;
        }
        return arr;
      };
    }
  } catch (_) {}

  // -- WebGL vendor/renderer -----------------------------------------------
  try {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    const UNMASKED_VENDOR = 37445;
    const UNMASKED_RENDERER = 37446;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === UNMASKED_VENDOR) return 'Intel Inc.';
      if (param === UNMASKED_RENDERER) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return origGetParameter.apply(this, arguments);
    };
    if (window.WebGL2RenderingContext) {
      const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (param) {
        if (param === UNMASKED_VENDOR) return 'Intel Inc.';
        if (param === UNMASKED_RENDERER) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return origGetParameter2.apply(this, arguments);
      };
    }
  } catch (_) {}

  // -- Battery API ---------------------------------------------------------
  try {
    const fakeBattery = {
      charging: true,
      chargingTime: 0,
      dischargingTime: Infinity,
      level: 0.87,
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
    navigator.getBattery = () => Promise.resolve(fakeBattery);
  } catch (_) {}

  // -- Hardware concurrency / device memory --------------------------------
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  } catch (_) {}
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  } catch (_) {}

  // -- navigator.connection -------------------------------------------------
  try {
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({ effectiveType: '4g', rtt: 100, downlink: 10, saveData: false, type: 'wifi' }),
      });
    }
  } catch (_) {}

  // -- Permissions: Notification returns 'default' --------------------------
  try {
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: 'default', onchange: null, addEventListener: () => {}, removeEventListener: () => {} })
          : origQuery.call(navigator.permissions, p);
    }
    if (window.Notification) {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    }
  } catch (_) {}

  // -- chrome.app shim (patchright handles chrome.runtime) ------------------
  try {
    if (window.chrome) {
      if (!window.chrome.app) {
        window.chrome.app = {
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: () => null,
          getIsInstalled: () => false,
          isInstalled: false,
        };
      }
    }
  } catch (_) {}

  // -- Plugin length: ensure >= 3 ------------------------------------------
  try {
    if (navigator.plugins && navigator.plugins.length < 3) {
      const mkPlugin = (name, filename, desc) => ({
        name, filename, description: desc, length: 1, 0: { type: 'application/x-ppapi', suffixes: '', description: desc, enabledPlugin: null },
      });
      const list = [
        mkPlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        mkPlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        mkPlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      ];
      const proxy = Object.create(Array.prototype);
      list.forEach((p, i) => (proxy[i] = p));
      proxy.length = list.length;
      proxy.item = (i) => list[i];
      proxy.namedItem = (n) => list.find((p) => p.name === n) || null;
      proxy.refresh = () => {};
      Object.defineProperty(navigator, 'plugins', { get: () => proxy });
    }
  } catch (_) {}
})();
