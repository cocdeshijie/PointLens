# hyatt-com — Client JS

## Build tool / bundler

_Not yet determined from live inspection._

## Source maps available?

_Not yet checked._

## Interesting globals

_Not yet explored. Candidates to probe via `page.evaluate(() => Object.keys(window))`:_

- _`window.google` — Google Maps presence_
- _`window.mapboxgl` — Mapbox GL presence_
- _Any loyalty/session globals (member tier, points balance)_
- _Any hotel data store globals_

## Map rendering architecture

_Not yet determined. See [dom.md](dom.md) open questions — the key unknown for
the map overlay is which map library Hyatt loads and whether pins are DOM or
canvas._

## Extension JS files (planned)

_Architecture TBD pending network and DOM findings. Expected structure mirrors
the existing hotels:_

### `injected/hyatt-fetch-hook.js` (MAIN world) — if needed

_Only needed if award rates require a request parameter to be patched (like
Marriott's MRW/P17 injection). If award rates are included in the standard
response, this file may be omitted and the ISOLATED content script can handle
everything (like IHG)._

### `content.ts` (ISOLATED world)

- Injects fetch hook if needed.
- Bridges messages between MAIN world and background service worker.
- Reads storage; annotates list cards and map pins with CPP badges.
- Runs `MutationObserver` on `document.body` for dynamic updates.

### `background.ts` (service worker, Hyatt slice)

- `registerHyattListeners()` — wires `webRequest` intercept on the search endpoint.
- Assembles request body + headers; sends replay message to tab.
- Saves capture payloads to `chrome.storage.local`.

## API path constants (TBD)

_To be filled in once the search endpoint is identified._

## Feature flags

_None identified._

## Open questions

- What map library does Hyatt load — `window.google.maps` (Google Maps),
  `window.mapboxgl` (Mapbox), or other?
- Does Hyatt's JS expose any useful globals (hotel data stores, rate caches,
  member session data)?
- Are there client-side feature flags gating rate display, map behavior, or
  award availability?
- What does `window.__NEXT_DATA__` (or equivalent SSR payload) contain on the
  search results page?
