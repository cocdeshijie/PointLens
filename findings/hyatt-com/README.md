# hyatt-com

- **URL:** https://www.hyatt.com
- **Started:** 2026-06-16
- **Status:** implemented

## TL;DR

Next.js App Router SPA; hotel + rate data (cash AND points) arrives together in
an RSC Flight payload (`self.__next_f`) on the standard `rate=Standard` search —
no separate reward-rate replay needed. A MAIN-world script extracts `hotelData`
from `__next_f` on load and intercepts Server Action POSTs for refinements.
CPP = `(leadingRate.rate / leadingRate.points) * 100`. Map is Google Maps JS
(same key as Marriott). Per-property id is `spiritCode`.

## Entry points

- Search results: `https://www.hyatt.com/search/hotels/en-US/<Location>?checkinDate=YYYY-MM-DD&checkoutDate=YYYY-MM-DD&rooms=1&adults=1&kids=0&rate=Standard&accessibilityCheck=false`
- Location typeahead: `GET https://www.hyatt.com/quickbook/autocomplete?query=<q>&locale=en-US&includeGoogleSuggestions=true`
- Server Action (refinement): POST to same search URL with `next-action` header

## Map

- [Recon](recon.md)
- [Network / APIs](network.md)
- [DOM / Frontend](dom.md)
- [Client JS](js.md)
- [Working notes](notes.md)

## Implementation (shipped) — 2026-06-16

CPP overlay verified live on `https://www.hyatt.com/search/hotels/` (list + map, mixed view).

### Files created in `pointlens/`

| File | World | Purpose |
|---|---|---|
| `hotels/hyatt/settings.ts` | — | `HYATT_VALUE_SETTINGS_KEY`; default thresholds 1.7 ¢/pt (good) / 1.2 ¢/pt (bad) |
| `hotels/hyatt/content-main.ts` | MAIN | Unified extractor: wraps `__next_f.push` + defineProperty setter for RSC streaming; `window.fetch` wrapper for Server Action POST responses; merges into `{spiritCode -> {rate,rateAfterTax,points,currency,status}}`; posts via `window.postMessage({__AV_HYATT_RATES__:true, rates})` |
| `hotels/hyatt/content.ts` | ISOLATED | Receives rates; CPP = `toUsd(rate,currency)/points*100` (FX via background, 24h cache); persists to `pointlens:hyatt-rates` storage; renders badges via rAF-coalesced MutationObserver loop |
| `hotels/hyatt/background.ts` | — | `registerHyattListeners` + `HYATT_FETCH_FX` (open.er-api.com, 24h cache; same pattern as Marriott) |
| `hotels/hyatt/Popup.tsx` | — | Threshold settings UI (Hyatt variant of Marriott's) |
| `contents/hyatt.ts` | ISOLATED | Literal `config` with `matches: ["https://www.hyatt.com/*"]`, run_at document_start |
| `contents/hyatt-main.ts` | MAIN | Same matches, world:"MAIN", document_start |

Wired into root `background.ts` (`registerHyattListeners`) and `popup.tsx` (`SUPPORTED_SITES` + `HyattPopup`, icon "Y").

### Overlay surfaces (all verified live)

1. **List card** — selector `div[data-spirit-code]`; badge inserted directly below `[data-testid="all-in-pricing-label"]` inside `[class*="rate_with_text"]`. Shows `{cpp}¢/pt · {pts}k pts`, colored by tier. SOLD_OUT cards carry no rate block and are skipped.
2. **Map pin** — `gmp-advanced-marker[data-locator="map-pin-<spirit>"]`; inner pill matched via `[data-testid="map-marker"]` / `.MapMarker_map-marker`; pill flipped to `flex-direction:column` (class `pointlens-hyatt-pin-annotated`); CPP line appended under the price. Text colors for contrast on Hyatt blue: good `#6ee7b7` / mid `#fcd34d` / bad `#fca5a5`.
3. **1st-click selection popover** — clicking a pin adds `MapMarker_map-marker__bookable--selected` and reveals `[class*="map-marker__popover--visible"]` inside the marker; CPP chip appended there, keyed by the marker's `data-locator`.

There is NO 2nd-click price modal on the search page — the popover/hotel name navigates to `/shop/rooms/<spiritCode>`, which is out of current scope.

## Prior art — sibling implementations

| Hotel | Slug | Pattern | Notes |
|---|---|---|---|
| Hilton | `hilton-com` | `shopMultiPropAvail` SOAP/JSON intercept; `hotelSummaryOptions` for map coords; Google Maps `AdvancedMarkerElement` overlay (MAIN world) | Reference impl; most complex |
| IHG | `ihg-com` | REST intercept; ISOLATED content script; pin-index identity matching | Simple — no MAIN-world injection |
| Marriott | `marriott-com` | GraphQL `phoenixShopDatedSearchByGeoQuery`; unconditional `rateRequestTypes` patch; ISOLATED content script; `pin-N` index matching | Closest analog for Hyatt map view |

## Open questions

- Are non-USD `currencyCode` values common enough to warrant broader v1 testing? (FX handled via open.er-api.com; basic coverage exists.)
- Does Hyatt require login to see award `points` in the response, or are they visible to anonymous visitors? (Not yet tested anonymously.)
- Room-selection page (`/shop/rooms/<spiritCode>`) — CPP overlay not yet scoped.
