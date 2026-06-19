# Client JS — hilton-com

## Build tool / bundler

- Next.js (SSR). `__NEXT_DATA__` present on all search/map pages.

## Source maps available?

- Not observed in captures to date.

## Interesting globals

- `google.maps` — full Maps JS API loaded by Hilton; mapId `44a4e78785e759276d55a15d` (WebGL/vector).
- `__NEXT_DATA__` — SSR payload (see [dom.md](dom.md)).

## Map rendering architecture

Hilton's map is **Google Maps WebGL/vector** (mapId present). Price pins are
drawn on a WebGL canvas — there are NO per-pin DOM elements to annotate.
The extension therefore renders its OWN `google.maps.marker.AdvancedMarkerElement`
overlays on top.

## Extension map overlay — `injected/hilton-map-overlay.js`

File: `pointlens/hotels/hilton/injected/hilton-map-overlay.js`
World: MAIN (injected by `content.ts` alongside `hilton-fetch-hook.js`;
registered in `web_accessible_resources` in `package.json`).

### Map instance capture

Hilton builds ~8 `gm-style` map DOM elements (widget maps, etc.). The overlay
must lock onto the one large search map. Strategy used:

- Patch `google.maps.Map.prototype` methods (`setCenter`, `panTo`, `panBy`,
  `fitBounds`, `setZoom`, `moveCamera`) **on the shared prototype**, not the
  constructor. This survives the async `importLibrary("maps")` race that a
  constructor patch loses — by the time the patch fires the real instances
  already exist.
- On each patched call, evaluate candidate maps: accept the first one whose
  host element is `>250px` in both dimensions and `display != none`.
- Once locked, attach a debounced (~250ms) `idle` listener to drive
  quadrant replay (see below).

### AdvancedMarkerElement loading

Loaded via `google.maps.importLibrary("marker")`. A poll retries until the
library resolves. **Do NOT use a sticky in-flight guard** — it can wedge if
the library promise rejects transiently. Each poll attempt re-calls
`importLibrary` fresh.

### Coverage strategy — robust quadrant replay

Earlier approach (zoom "wobble" nudging) was abandoned: quadrant caching +
abort-on-zoom-back caused incomplete coverage and visible map flicker.

Final approach:

1. Capture any `graphql/customer` URL that fires on page load; store as
   `graphqlBaseUrl` (swap `operationName` param to build replay URLs).
2. Fetch `hotelQuadrants` directly using a hardcoded minimal query
   (`id`, `bounds` only). Build a `quadrantCells` map from the response.
3. Derive LEAF cells: a cell is a leaf if none of its four children
   (`id+"::nw"`, `"::ne"`, `"::sw"`, `"::se"`) appear in the cell set.
4. On map `idle` (debounced) and once on initial capture:
   - Compute current map bounds.
   - Find all leaf cells whose `bounds` intersect the viewport.
   - For each not-yet-fetched leaf, replay `hotelSummaryOptions(quadrantId)`
     using a hardcoded minimal query via `origFetch` with
     `credentials: "include"` + `Content-Type` header only (cookie auth
     suffices on `graphql/customer`, same as the existing fetch-hook replay).
   - Cap 24 concurrent fetches per pass.
   - Track `fetchedQuadrants` set; on fetch error, remove from set to allow retry.
5. Ingest responses → create/update AdvancedMarkers.

Verified result: static page load covers full visible viewport (~202 hotels
for an LA search); panning into new areas loads incrementally (→304 total),
no map movement or flicker.

### Settings bridge

Settings (`goodCpp`, `badCpp`, etc.) originate in `content.ts` (ISOLATED world)
and are passed to the MAIN-world overlay via `window.postMessage` with type
`__AV_HILTON_MAP_SETTINGS__`. The overlay listens and applies on receipt.

### Badge style

Each hotel gets a `google.maps.marker.AdvancedMarkerElement` whose `content`
is a pill element:

| Property | Value |
|---|---|
| Background | Hilton blue `#3678c6` (sampled from Hilton's own pins) |
| Border | White, 1px |
| Top line | White, 13px — cash rate formatted as `$NNN` |
| Middle line | White — points (e.g. `41k pts`) |
| Bottom line | `¢/pt` value — TEXT COLOR encodes value quality |
| ¢/pt good | `#6ee7b7` (green) |
| ¢/pt mid | `#fcd34d` (yellow) |
| ¢/pt bad | `#fca5a5` (red) |
| No rewards | Grey pill, "No rewards" label |

Thresholds (`goodCpp`, `badCpp`) come from Hilton settings, same values used
for the search-list cards.

### Search list card update

`content.ts` was also extended to show after-tax/fees total in parens next
to the ¢/pt value on search-list cards — e.g. `"0.33¢/pt ($246)"`.
Field used: `summary.lowest.amountAfterTax` from `shopMultiPropAvail`.

## API path constants

- `https://www.hilton.com/graphql/customer` — all GraphQL ops (see [network.md](network.md)).

## Feature flags

- None identified in JS captures to date.

## Open questions

- Are there any client-side feature flags that gate the map or award rate display?
- What does the Rooms/booking page JS expose for premium/points+cash tiers?
