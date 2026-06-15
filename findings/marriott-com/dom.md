# DOM / Frontend — marriott-com

Source: extension source code (`award-viewer/hotels/marriott/content.ts`),
reviewed 2026-06-14. Live DOM inspection not yet done.

## Framework / meta-framework

_Not yet confirmed from live inspection. Site behavior suggests a React-based
SPA or SSR framework; framework identity (Next.js / Remix / custom) is an open
question._

## Routing

_Not yet explored._

## Hydration data

_Not yet explored. Whether a `__NEXT_DATA__` or equivalent SSR payload is
present has not been confirmed._

## Important selectors

| Selector | Purpose | Confidence |
|---|---|---|
| `.property-card` | Individual hotel card on the search-results list | High — used in production `content.ts` |
| `[data-marsha]` on `.property-card` | Hotel MARSHA code (identity key) | High — `getHotelIdFromCard` reads this attribute |
| `.rate-container` inside `.property-card` | Rate price element; extension finds the nearest `<a>` ancestor | High — used in `getRateLink` |
| `a` closest ancestor of `.rate-container` | Rate link; extension inserts its CPP placeholder as `nextSibling` of this element | High |
| `.gm-style .m-map-pin` | Marriott search-map price pill (dark charcoal, white text, 4px radius, 14px Roboto) | High — confirmed live 2026-06-14; shipped in `content.ts` |
| `.m-map-pin.pin-N` | The Nth hotel pin (0-indexed, edge order) — identity key for map view | High — confirmed live; used by `updateMapPins()` in `content.ts` |
| `.m-map-pin.marker-label-grey` | Variant style class present on some pins | Observed — purpose unknown |
| `div.award-viewer-marriott-pin-cpp` | Extension-injected CPP badge inside each `.m-map-pin` | Extension-owned |
| `.property-card-container.map-view-selected` | Wrapper element that appears when a map pin is clicked (first click = "selected preview card"); wraps a real `.property-card[data-marsha]` | High — confirmed live 2026-06-14 |
| `.hqv-modal-opener` | Hotel-name button inside the selected preview card; clicking it (second click) opens the large HQV hotel detail modal | High — confirmed live 2026-06-14 |
| `.hqv-rate-container.rate-container` | Rate price container inside the HQV modal; contains `span.price-value.currency-value.amount-display` showing cash rate (e.g. "426 USD / Night"); **cash only — no points shown** | High — confirmed live 2026-06-14 |
| `div.award-viewer-marriott-detail-cpp` | Extension-injected CPP badge inserted immediately after `.hqv-rate-container`; shows "{cpp}¢/pt + {pts} pts / night", value-color-tiered; "Reward nights unavailable" for cash-only hotels | Extension-owned |

## Extension injection points

The extension inserts a `<div class="award-viewer-marriott-price-placeholder">`
immediately after the rate link `<a>` element inside each `.property-card`.
The placeholder contains:
- A `<span class="award-viewer-marriott-cpp-icon">` wrapping a React-rendered
  `CiCircleInfo` icon and a hover tooltip.
- A `<span class="award-viewer-marriott-cpp-value">` showing the CPP badge
  (e.g. `0.45¢/pt`), color-coded good/mid/bad.

The placeholder `data-hotel-id` attribute stores the normalized MARSHA code
used to look up the rate map.

## CSS overrides

`content.ts` injects a `<style id="award-viewer-marriott-placeholder-style">`
that sets `overflow: visible !important` on `.price-container`,
`.price-sub-section`, `.property-card-price-component`, and `.la-dUdY .price-sub-section`
to prevent the tooltip from clipping.

## Map DOM structure

Confirmed via live win_chrome inspection, 2026-06-14 (New York search, view=map).

**Map library:** Google Maps JS API v3.64.14a. `window.google.maps` is present.
Both `google.maps.marker.AdvancedMarkerElement` and `google.maps.OverlayView`
are available — same API surface as the Hilton overlay.

**Map container:** Standard `.gm-style` div, same as Hilton.

**Canvas vs DOM pins:**
- There is 1 `<canvas>` element in the map pane — this renders the WebGL base
  tile layer only.
- The price markers are **DOM elements**, not painted onto canvas. Each hotel is
  represented by a pair of absolutely-positioned `<div>`s inside a `.gm-style`
  pane child:
  1. A transparent hit-box `<div>` (contains a `transparent.png` `<img>`) for
     pointer events.
  2. A label `<div>` whose visible text is the cash price (e.g. `"426 USD"`).
- Approximately 60–140 such label divs are present depending on result count.

**Identity key — `pin-N` class (confirmed 2026-06-14):**
Each `.m-map-pin` element carries a `pin-N` class (`pin-0`, `pin-1`, …,
`pin-{count-1}`). The index N maps exactly to the Nth hotel in the
`searchByGeolocation` edges array (edge order). This gives a direct, stable
link from pin to hotel without any geometry or coordinate projection.

Example confirmed (New York search): `pin-0` showed "426 USD" = Moxy NYCOF
(0.95¢/pt); `pin-1` showed "286 USD" = NYCAL. The displayed price on the pin
is a "lowest regular rate" that can differ from the parsed `cashBase`/`cashTotal`
fields, so matching by displayed price (the IHG strategy) is unreliable for
Marriott. Index matching via `pin-N` is the correct approach and is what shipped.

Some pins also carry the class `marker-label-grey`.

**Map view URL / SPA routing:**
- Map view is activated by `&view=map` on `https://www.marriott.com/search/findHotels.mi?...`
- The SPA also has a "Map" toggle button with class `.icon-map`.
- The internal hash flips from `#/0/` (list) to `#/1/` (map) on toggle.
- Both views are driven by the same `phoenixShopDatedSearchByGeoQuery` — no
  additional intercept needed for map data.

**Extension approach for map CPP overlay — SHIPPED (2026-06-14):**

Implemented entirely in the ISOLATED content script
`award-viewer/hotels/marriott/content.ts`. No MAIN-world injected script is
involved. The earlier `marriott-map-overlay.js` (AdvancedMarkerElement overlay
+ Map instance capture via `OverlayView.setMap` hook + resize nudge, modelled
on the Hilton overlay) was built and then deleted in favor of this simpler
approach. It is no longer in the codebase or `web_accessible_resources`.

Key implementation details:
- `buildRatesFromStorage` now returns `{map, order}` where `order` is the MARSHA
  list in edge order (position 0 = first edge, etc.).
- `updateMapPins()` queries `document.querySelectorAll('[class*="pin-"]')` inside
  `.gm-style`, extracts N from the `pin-N` class, looks up `order[N]`, then
  appends a `<div class="award-viewer-marriott-pin-cpp">` inside the
  `.m-map-pin` element showing `"{pts}k · {cpp}¢"`.
- Badge text is value-color-tiered (same thresholds as list view). Hotels with
  cash rates only show "No reward"; hotels with no data at all show nothing.
- `updateMapPins()` is re-invoked on a rAF-debounced schedule via the existing
  body `MutationObserver` (already present for list-view updates) because Google
  Maps re-creates pin DOM on every pan/zoom.

## Map click-states — selected preview card and HQV modal (confirmed 2026-06-14)

Marriott's map has two distinct click-states after the pin list is shown.

### First click — selected preview card

Clicking a map pin opens a `.property-card-container.map-view-selected` wrapper
that contains a real `.property-card[data-marsha]` element. The existing list-card
placeholder logic (which targets `.property-card`) therefore annotates it
automatically — the CPP value badge `.award-viewer-marriott-cpp-value` appears
without any extra code. Verified showing "0.95¢/pt" on a test hotel.

### Second click — HQV hotel detail modal

Clicking the hotel-name button (`.hqv-modal-opener`) inside the preview card
opens a large modal. Key structural facts:

**Container stability:** The outermost modal wrapper uses unstable
styled-component classes (e.g. `sc-555e7512-1 ...`) that will change on
recompilation. Inner content reliably uses `hqv-modal-*` prefixed classes.
Target inner classes only.

**No `data-marsha` on the modal.** Hotel identity must be extracted from links:
1. Primary: `a[href*='propertyCode=NYCOF']` — the `availabilityCalendar.mi` link
   whose query-string contains `propertyCode=<MARSHA>`.
2. Fallback: `a[href='/hotels/travel/<marsha>-...']` — the property page URL
   where the MARSHA is the first segment after `/hotels/travel/`.

The extension's `marshaFromModal()` function tries `propertyCode=` first, then
the `/hotels/travel/<marsha>-` pattern. This two-step is the durable identity
extraction approach for the modal.

**Rate display:** `.hqv-rate-container.rate-container` contains
`span.price-value.currency-value.amount-display` with cash rate text
("426 USD / Night"). The modal shows **cash only** — no points or reward-night
rate is rendered by the site here.

**Extension injection:** A `div.award-viewer-marriott-detail-cpp` badge is
inserted immediately after `.hqv-rate-container`. It shows "{cpp}¢/pt + {pts}
pts / night" (value-color-tiered), or "Reward nights unavailable" for hotels
that returned no points rate. Re-applied via the body `MutationObserver` on the
same rAF-debounced schedule as the map pins, so it survives modal re-mounts.

## Open questions

- What JS framework powers the page (Next.js / Remix / other)?
- Is there a hydration payload (`__NEXT_DATA__` or equivalent) and does it
  contain hotel coordinates?
- Map pin structure: is the four-level nesting
  `div[positioned] > div[display:table] > div[table-cell] > div.m-map-pin`
  stable across Marriott site updates, or does Google Maps regenerate with
  different wrapper attributes on version bumps?
