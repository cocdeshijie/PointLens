# hyatt-com — DOM / Frontend

## Framework / meta-framework

Next.js App Router SPA. React. Search results live at `www.hyatt.com/search/hotels/`.

Class naming: Hyatt uses a `be-*` design-system token set (e.g. `be-text-section-1`, `be-text-caption`) plus CSS-module classes with hashed suffixes (`HotelCard_rate_with_text__<hash>`). **Always match on the stable prefix substring, never on the full hashed class name.**

## Routing

SPA via Next.js App Router. Search results page: `/search/hotels/`. Hotel room shop: `/shop/rooms/<spiritCode>`.

## Hydration data

The search payload (hotel summaries, rates) is fetched via API (see `network.md`). The `hotelSummaries[].spiritCode` field in the response is the stable property identifier and is reflected directly in the live DOM — no index-matching needed.

## Important selectors

| Selector | Purpose | Notes |
|---|---|---|
| `div[data-spirit-code="<code>"]` | Hotel card on search-results list | spiritCode = stable property id, e.g. `cmhxo` |
| `[data-spirit-code]` | All hotel cards (enumerate) | 6 cards observed in test search |
| `div.HotelCard_rate_with_text` (substring match) | Price block inside a list card | Contains cash rate + fee notice; full class has hash suffix |
| `div.cash-rate.rate > div.be-text-section-1` | Cash price text inside price block | e.g. `"$185"` |
| `div[data-testid="all-in-pricing-label"]` | Fee notice inside price block | `"Includes fees before taxes"` |
| `gmp-advanced-marker[data-locator="map-pin-<code>"]` | Map marker element | Strip `map-pin-` prefix to get spiritCode |
| `.MapMarker_map-marker` (substring match) | Inner pill element inside each map marker | Has `data-testid="map-marker"` and `data-locator="map-pin-<code>"` |
| `div.be-text-section-3` inside `.MapMarker_map-marker` | Price text on map pin | e.g. `"$185"`; empty for SOLD_OUT pins |
| `[data-testid="google-map"]` | Map container | — |
| `[data-testid="search-this-area-cta"]` | "Search this area" soft button | Triggers re-query on map pan |
| `[data-testid="quickbook-summary-*"]` | Search/date/guests summary bar | Wildcard suffix |

## Map DOM structure

Map library: **Google Maps JS API with Advanced Markers** — pins are `<gmp-advanced-marker>` web components, not legacy DOM `div` pins and not canvas-rendered. They are injectable.

Pin identity is direct via `data-locator`:

```
gmp-advanced-marker[data-locator="map-pin-cmhxo"]
  └── .MapMarker_map-marker-host
        └── .MapMarker_map-marker[data-testid="map-marker"][data-locator="map-pin-cmhxo"]
              ├── div > div.be-text-section-3   ← price text ("$185")
              └── .MapMarker_map-marker__caret
```

Additional attributes on `<gmp-advanced-marker>`: `data-map-marker-index`, `data-map-selected`, `position="<lat>,<lng>"`.

SOLD_OUT pins render with empty price text — skip badge injection for those.

## Extension injection points (verified live, 2026-06-16)

### List card badge (CPP)

1. Find `div[data-spirit-code]` cards.
2. Skip cards where `leadingRate.status === "SOLD_OUT"` (no price text rendered).
3. Within each card locate `[class*="rate_with_text"]` (substring class match on the hashed module name).
4. Insert CPP badge directly **below** `[data-testid="all-in-pricing-label"]` ("Includes fees before taxes") inside that block. This matches the "below fee notice" placement used for Hilton/IHG/Marriott.
5. Badge format: `{cpp}¢/pt · {pts}k pts`, colored by tier via shared info-icon hover tooltip (singleton, same as Marriott).

### Map marker badge (CPP)

1. Enumerate `gmp-advanced-marker[data-locator^="map-pin-"]`; strip `map-pin-` prefix to get spiritCode.
2. Skip SOLD_OUT markers (empty price text in `.be-text-section-3`).
3. Match the inner pill via `[data-testid="map-marker"]` or `.MapMarker_map-marker` (the full hashed class is unstable).
4. Add class `pointlens-hyatt-pin-annotated` to flip the pill to `flex-direction:column`, then append a CPP line under the price. Text colors for contrast on Hyatt blue: good `#6ee7b7` / mid `#fcd34d` / bad `#fca5a5`.

### 1st-click selection popover (CPP)

Clicking a pin adds `MapMarker_map-marker__bookable--selected` on the pill and reveals `[class*="map-marker__popover--visible"]` inside the same `<gmp-advanced-marker>`. The popover shows only name/rating/distance — no price. We append a CPP chip there, keyed by the marker's `data-locator`.

There is **no 2nd-click price modal** on the search page. Clicking the popover/hotel name navigates to `/shop/rooms/<spiritCode>` (room-selection page, out of current scope).

### Re-application strategy

`MutationObserver` on `document.body` (subtree, childList), rAF-coalesced, re-runs badge injection after SPA navigation and after map pan/zoom re-creates pin elements.

## CSS overrides

Map pin pill: `flex-direction:column` applied via `pointlens-hyatt-pin-annotated` class on `.MapMarker_map-marker`. No `overflow: visible` override was needed (unlike Marriott).

## Open questions

- Room-selection page (`/shop/rooms/<spiritCode>`): DOM structure and injection points not yet explored.
- Anonymous visitor access: whether award `points` appear in `__next_f` without login has not been tested.

### Resolved

- **Map click states** (was: TBD): 1st click reveals a popover (`[class*="map-marker__popover--visible"]`) inside the marker — name/rating/distance only, no price. No 2nd-click modal exists on the search page; the popover navigates to `/shop/rooms/<spirit>`. Badge injected into the popover. Resolved 2026-06-16.
- **Points-mode toggle**: the `rate=Standard` search returns both cash (`leadingRate.rate`) and award (`leadingRate.points`) in the same payload simultaneously — no toggle needed; points data is always present alongside cash. Resolved 2026-06-16.
