# Working notes — marriott-com

Freeform scratchpad. Promote anything durable into the topical files.

---

## Map overlay — SHIPPED (2026-06-14)

### Investigation resolved prior to implementation

1. **Coords in existing capture** — `searchByGeolocation.edges[].node.property.basicInformation`
   carries `latitude` and `longitude`. Coords were noted but turned out not to be
   needed for the shipped approach (index matching via `pin-N` is used instead).

2. **Google Maps JS API v3.64.14a, pins are DOM** — `window.google.maps` present;
   `AdvancedMarkerElement` and `OverlayView` available but also not used by the
   shipped approach. Pins are DOM `<div class="m-map-pin">` elements inside
   `.gm-style`, NOT canvas-painted.

3. **Same `phoenixShopDatedSearchByGeoQuery`, no separate map endpoint** — map
   view and list view share the same GraphQL operation; no additional intercept needed.

### Why the MAIN-world overlay approach was abandoned

Initial plan mirrored Hilton: inject `marriott-map-overlay.js` into MAIN world,
capture the `google.maps.Map` instance, bridge data via `postMessage`, draw
`AdvancedMarkerElement` CPP badges. This was built. The blocker was that native
Marriott pins had no hotel-identifying attributes, requiring geometric
lat/lng-to-pixel projection — substantial complexity. During implementation it
was discovered that each `.m-map-pin` carries a `pin-N` class whose index N
directly matches the edge order from the `searchByGeolocation` response. This
made the whole MAIN-world machinery unnecessary. The injected file was deleted
and the feature was re-implemented entirely in the ISOLATED content script
`content.ts`.

`marriott-map-overlay.js` no longer exists in the codebase or in
`web_accessible_resources`. Do not recreate it.

### Shipped design summary

See [dom.md](dom.md) "Extension approach for map CPP overlay — SHIPPED" for the
full detail. Short version: `updateMapPins()` in `content.ts` queries
`.m-map-pin` elements, reads `pin-N`, looks up `order[N]` (MARSHA from edge
list), appends a CPP badge div. Re-runs on every body mutation via rAF debounce
to survive Google Maps pin re-creation on pan/zoom.

---

## rateRequestTypes drift incident (2026-06-14) — RESOLVED, promoted to network.md

The live page stopped sending `{CLUSTER,"E0P"}` alongside `{STANDARD,""}` and
now sends STANDARD-only. The old `patchBodyForClusters` guard in
`marriott-fetch-hook.js` matched on the old two-entry shape, so it silently
stopped patching — reward clusters were never injected, responses came back
without MRW/P17, and every hotel showed "Reward Nights Unavailable".

Fix: guard removed; patch is now unconditional and idempotent. Full durable
detail (shape history, idempotency logic, confirmed response structure, currency
caveat) is in [network.md](network.md) under the request shape section.

If this breaks again: the symptom is "Reward Nights Unavailable" on all hotels.
First check `rateRequestTypes` in the outgoing replay body in DevTools Network.

---

## Status of shipped features (2026-06-14)

- Search-list CPP cards: DONE and shipping.
  - MARSHA code from `data-marsha` on `.property-card`.
  - CPP placeholder inserted after `.rate-container`'s `<a>` parent.
  - Rates from `phoenixShopDatedSearchByGeoQuery` replay with MRW + P17 clusters.
- Map CPP overlay: DONE and shipping (2026-06-14).
  - Implemented in ISOLATED content script `content.ts` only — no MAIN-world
    injected file.
  - Hotel identity via `pin-N` class index matched to `searchByGeolocation` edge
    order; no geometry or coordinate projection needed.
  - CPP badge `<div class="award-viewer-marriott-pin-cpp">` appended inside each
    `.m-map-pin`; value-color-tiered; re-applied on body mutation / pan / zoom.
- Map click-states: DONE and shipping (verified 2026-06-14).
  - **1st click (selected preview card):** `.property-card-container.map-view-selected`
    wraps a real `.property-card[data-marsha]` — list-card placeholder logic
    annotates it automatically, no extra code needed. Confirmed badge visible.
  - **2nd click (HQV modal):** Opened by `.hqv-modal-opener`. Modal has NO
    `data-marsha`; hotel identity resolved via `marshaFromModal()` which parses
    `propertyCode=` from `availabilityCalendar.mi` links, falling back to
    `/hotels/travel/<marsha>-` path segments. Rate anchor is
    `.hqv-rate-container.rate-container` (cash only). Extension injects
    `div.award-viewer-marriott-detail-cpp` after that container; re-applied on
    body `MutationObserver`. Full structural detail in [dom.md](dom.md).
