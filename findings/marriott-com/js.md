# Client JS — marriott-com

Source: extension source code reviewed 2026-06-14. Live bundle analysis not
yet done.

## Build tool / bundler

_Not yet determined from live inspection._

## Source maps available?

_Not yet checked._

## Interesting globals

_Not yet explored._

## Map rendering architecture

_Not yet determined._ See [dom.md](dom.md) open questions — the key unknown
for the map overlay is whether Marriott uses Google Maps (DOM-injectable
AdvancedMarkerElement, same as Hilton), Mapbox GL (similar marker API), or
a fully custom canvas renderer.

## Extension JS files

### `injected/marriott-fetch-hook.js` (MAIN world)

Injected by `content.ts` via a `<script src>` tag at `document_start`.

Key responsibilities:
- Listens for `window.postMessage({ __AV_MARRIOTT_DO_REPLAY__: true })`.
- Calls `patchBodyForClusters(bodyText)` — detects the default
  `rateRequestTypes` pattern (STANDARD + CLUSTER/E0P, exactly two entries)
  and replaces with `[MRW, STANDARD, P17]`.
- Issues `fetch(url, { method:"POST", credentials:"include", headers:... })`
  with `x-av-replay: 1` sentinel header to prevent looping.
- Parses `data.search.lowestAvailableRates.searchByGeolocation.edges[]`,
  extracts `{ property, rates }` per node.
- Posts `window.postMessage({ __AV_MARRIOTT_SAVE__: true, payload:{ hotels } })`.

### `content.ts` (ISOLATED world)

- Injects `marriott-fetch-hook.js`.
- Bridges `MARRIOTT_PAGE_REPLAY` chrome message → `window.postMessage` into
  MAIN world.
- Bridges `__AV_MARRIOTT_SAVE__` postMessage → `chrome.runtime.sendMessage`
  → background storage.
- Reads `chrome.storage.local["award-viewer:marriott-last-capture"]` and calls
  `buildRatesFromStorage` to populate the hotel rate map.
- Runs a `MutationObserver` on `document.body` to catch dynamically added
  `.property-card` elements and inject CPP placeholders.

### `background.ts` (service worker, Marriott slice)

- `registerMarriottListeners()` wires `webRequest.onBeforeRequest` +
  `onBeforeSendHeaders` for `phoenixShopDatedSearchByGeoQuery`.
- Assembles `Pending` records (body + headers) and sends
  `MARRIOTT_PAGE_REPLAY` to the tab once both are available.
- Saves `MARRIOTT_SAVE_CAPTURE` payloads to `chrome.storage.local`.

## API path constants (from extension code)

- `https://www.marriott.com/mi/query/phoenixShopDatedSearchByGeoQuery`

## Feature flags

_None identified._

## Open questions

- What map library does Marriott load (google.maps / mapboxgl / other)?
  A `page.evaluate(() => Object.keys(window))` on the live search page would
  reveal this.
- Does Marriott's JS expose any useful globals (hotel data stores, rate caches)?
- Are there client-side feature flags gating rate display or map behavior?
