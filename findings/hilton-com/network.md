# Network — hilton-com

Live capture: sessions/hilton-com/20260612T201811Z/ (Los Angeles search + map
drag, logged-in Honors session, 2026-06-12).

## Auth flow

- **Browser-bound, cookie + header based** (unlike IHG's header-token API).
  No clean bearer token — authenticates via the Honors cookie jar plus several
  `x-*` / `dx-*` request headers. The extension rides the page session.

## API base(s)

- `https://www.hilton.com/graphql/customer`

## Endpoints

| Method | Path / operationName | Auth | Purpose | Notes |
|---|---|---|---|---|
| POST | `shopMultiPropAvail` (`originalOpName=shopMultiPropAvail`) | cookies + headers | Search-list availability — cash only | GraphQL; `originalOpName` in querystring distinguishes cash vs points variant. Extension hooks this. |
| POST | `shopMultiPropAvail` (`originalOpName=shopMultiPropAvailPoints`) | cookies + headers | Search-list availability — points (+ cash) | Injected by extension via `patchBodyForPoints` + `setOriginalOpNameToPoints`. Adds `specialRates.hhonors:true` + `hhonors{...}` selection block. |
| POST | `hotelSummaryOptions` | cookies + headers | **Map-view** multi-hotel summary — coordinates + name + brandCode | Returns 100+ hotels per call. Input accepts ONLY `{quadrantId, guestLocationCountry}` — **date fields rejected**. `leadRate` is date-independent and must NOT be used as a real nightly price. See details below. |
| POST | `hotelQuadrants` | cookies + headers | Map clustering metadata | Returns cluster entries (id, amenityIds, brands[]). NO rates. |

## Request / response shapes

### `shopMultiPropAvail` — cash variant

- Request `variables.input`: `{arrivalDate, departureDate, numAdults}`,
  `ctyhocns: [<CTYHOCN codes>]`, `language`. No `specialRates`.
- **HARD LIMIT: ≤20 ctyhocns per request.** 21+ → the whole request fails with
  GraphQL error `"Constraint Violation"` and `data: null` (verified 2026-06-13).
  Batch map fetches in chunks of 20. (A malformed ctyhocn like `RLDV-DT` does NOT
  poison a batch — only the count matters.)
- Response `data.shopMultiPropAvail[]` per hotel:
  - `summary.lowest`: `{rateAmount, amountAfterTax, ratePlanCode, ratePlan}`
  - NO points fields.

### `shopMultiPropAvail` — points variant (`originalOpName=shopMultiPropAvailPoints`)

- Request: same body + `variables.input.specialRates.hhonors: true` and an
  `hhonors{...}` block injected into the `summary{}` selection.
- Response `data.shopMultiPropAvail[]` per hotel:
  - `summary.lowest`: same cash fields as above.
  - `summary.hhonors.dailyRmPointsRate`: standard reward points (single figure,
    e.g. 41 000). Only one points tier surfaced at summary level — no
    originalPoints, no min/max, no points+cash hybrid.

### `hotelSummaryOptions` — map view (coordinates source; prices are date-independent)

**IMPORTANT — verified 2026-06-13:** `HotelSummaryOptionsInput` accepts ONLY
`{ quadrantId, guestLocationCountry }`. Passing `arrivalDate`/`departureDate`
returns a GraphQL field error: `"Field \"arrivalDate\" is not defined by type
\"HotelSummaryOptionsInput\""`. Therefore `leadRate` is a generic, date-free
"from" rate and must NOT be shown as the real nightly price for the user's
search dates. Observed: DENCNPE returned `leadRate.lowest.rateAmount = 88.2`
regardless of dates; `leadRate.hhonors` was null.

**Use this operation only for:** hotel GPS coordinates, name, brandCode,
and ctyhocn identity. Use `shopMultiPropAvail` for actual date-specific pricing.

- Response: `data.hotelSummaryOptions.hotels[]` — 117 hotels in LA capture.
  `ctyhocn` is directly on each row.
- Each hotel's `leadRate` structure (when non-null):

| Field path | Example value | Meaning |
|---|---|---|
| `leadRate.lowest.rateAmount` | 88.2 | Generic "from" cash — NOT date-specific |
| `leadRate.lowest.rateAmountFmt` | — | Formatted cash string |
| `leadRate.lowest.ratePlanCode` | — | Cash rate plan |
| `leadRate.lowest.ratePlan` | — | Cash rate plan name |
| `leadRate.hhonors.lead.dailyRmPointsRate` | 41 000 | Standard reward points (often null) |
| `leadRate.hhonors.min.rateAmount` | — | Cash anchor for cheapest points tier |
| `leadRate.hhonors.min.dailyRmPointsRate` | 39 000 | Cheapest points tier |
| `leadRate.hhonors.min.dailyRmPointsRateRoundFmt` | "39k" | Formatted |
| `leadRate.hhonors.min.ratePlan` | — | Rate plan name |
| `leadRate.hhonors.max.rateAmount` | — | Cash anchor for premium points tier |
| `leadRate.hhonors.max.dailyRmPointsRate` | 118 000 | Premium points tier |
| `leadRate.hhonors.max.dailyRmPointsRateRoundFmt` | "118k" | Formatted |
| `leadRate.hhonors.max.ratePlanCode` | LHHRR2 | Premium rate plan code |

- `leadRate.hhonors` may be null (observed on hotels with no award inventory in
  the date-free "from" snapshot).
- Response bodies are large (~600 KB for LA).
- **`leadRate` has TWO shapes** depending on source:
  - Live quadrant fetch: `leadRate.lowest.rateAmount` holds cash.
  - SSR `__NEXT_DATA__` shape: NO `lowest` field — cash is at
    `leadRate.hhonors.min.rateAmount` / `.max.rateAmount`.

### `hotelQuadrants`

- Request: `variables: {}` — parameter-less.
- Response: ~225 cluster entries with `id` (e.g. `"root::sw::sw"`),
  `amenityIds`, `brands[]`, `countries`,
  `bounds: { northeast:{latitude,longitude}, southwest:{latitude,longitude} }`.
  No rates, no ctyhocn-level data. Map metadata only.
- Cell ids are quadtree paths (depth 3–10). A cell is a LEAF if none of its
  four children (`id+"::nw"/"::ne"/"::sw"/"::se"`) appear in the full set.
  Leaf cells are the correct `quadrantId` arguments for `hotelSummaryOptions`.

### `hotelSummaryOptions` (quadrant variant)

- Request: `variables: { language:"en", input:{ quadrantId, guestLocationCountry:"US" } }`.
- Response: `data.hotelSummaryOptions.hotels[]` — per hotel:
  `ctyhocn`, `name`, `localization.coordinate.{latitude,longitude}`, `leadRate`.
- This is the ONLY source of hotel GPS coordinates in the map flow. `shopMultiPropAvail` has no coordinates.

## How the extension handles it today

`pointlens/hotels/hilton/`:
- `injected/hilton-fetch-hook.js` — MAIN-world fetch hook: intercepts
  `shopMultiPropAvail`, applies `patchBodyForPoints` + `ensureHhonorsInQuery` +
  `setOriginalOpNameToPoints` to request, captures response.
- `content.ts` / `background.ts` — capture pipeline + search-list rate-card rendering.
- `Popup.tsx`, `settings.ts`.

**IMPLEMENTED:** `content.ts` injects `hilton-map-overlay.js` (MAIN world)
which renders CPP AdvancedMarkerElement badges on the map. See [js.md](js.md)
for full implementation detail.

**Map overlay pricing — two-pass `shopMultiPropAvail` (NOT `hotelSummaryOptions.leadRate`):**
The map overlay fetches actual date-specific prices via `shopMultiPropAvail`,
not `hotelSummaryOptions.leadRate` (which is date-independent and often has null
`hhonors`). Two passes are required to fully cover visible hotels:

| Pass | `specialRates.hhonors` | What comes back |
|---|---|---|
| Cash pass | `false` (omit) | Cash lowest for every hotel; `summary.hhonors` is null |
| Points pass | `true` | Award hotels: `summary.hhonors.dailyRmPointsRate` + cash anchor; hotels with NO award inventory return `statusCode 1740`, `lowest null`, `hhonors null` |

CPP basis = `summary.lowest.amountAfterTax` (after-tax) ÷ `summary.hhonors.dailyRmPointsRate`.
Cash "from" price for non-award hotels comes from the cash pass `summary.lowest.rateAmount`.

Do not regress to `hotelSummaryOptions.leadRate` for CPP or nightly price display.

## Member vs anonymous pricing — PROVEN: no member award discount

Diff of anon capture (body 38208.1820) vs logged-in Honors session (guestId
1667043040, body 38208.8188), same 2026-06-17 LA search, all ctyhocns present
in both responses:

| ctyhocn | Anon pts | Member pts | ptsDiff |
|---|---|---|---|
| BURGLES | 70 000 | 70 000 | 0 |
| BURHGHF | 52 000 | 52 000 | 0 |
| BURUCHF | 85 000 | 85 000 | 0 |
| LAXAVCI | 95 000 | 95 000 | 0 |

Cash differed slightly and non-systematically (BURUCHF 241.47→278.47,
LAXAVCI 757.72→796.12, BURHGHF 189.85→185.10) — rate-plan drift, not a
member pricing pattern.

**Conclusion:** member award points == anonymous award points, exactly. Unlike
IHG (which gave ~15–20% member discount via X-IHG-SSO-TOKEN), **Hilton has no
member award discount**. Extension implication: no `originalPoints` /
`originalCash` distinction needed for Hilton; the API returns only one figure
and there is no discount tier to surface.

## Logged-in-only operations (map-pin info-window, Honors session)

Opening a map-pin hotel info-window fired two additional operations beyond the
core search/map set:

| operationName | Content | Pricing? |
|---|---|---|
| `hotel` (single ctyhocn, e.g. LAXBKHX) | Static hotel METADATA only — no `hhonors`/`dailyRmPointsRate`/`reward`/`rateAmount`/room fields in selection | **None** |
| `shopMultiPropAvail` (single ctyhocn, e.g. WCVCAHX) | Same thin summary block (`hhonors.dailyRmPointsRate`, `rateChangeIndicator`, `ratePlan.ratePlanName`) + lowest cash | Thin — no min/max, no points+cash, no premium tier |

Profile/noise ops (logged-in only): `guest` (returned `{favoriteHotels:[]}`)
`guest_hotel`, `callbackProfile`,
`dx-customer/auth/applications/token`.

**Conclusion:** there is no room-level award API until the actual Rooms/booking
page (a full navigation not yet captured). Hilton's "Points & Money" slider and
premium room rewards, if exposed via API, live on that Rooms page — still
uncaptured.

## Hilton award surface summary (for extension CPP purposes)

| Source | Points richness | Date-specific? | Notes |
|---|---|---|---|
| `shopMultiPropAvail` cash pass | Single lowest cash | YES | Covers all hotels; no points |
| `shopMultiPropAvail` points pass | `dailyRmPointsRate` + after-tax cash anchor | YES | Award hotels only; `statusCode 1740` = no inventory |
| `hotelSummaryOptions` (map view) | lead + min + max range (when non-null) | **NO** | Date-free "from" rate — use only for coordinates/identity, NOT pricing |
| Map-pin info-window (`shopMultiPropAvail` single) | Same thin single figure | YES | No additional richness |
| Rooms/booking page | Unknown — not yet captured | YES | Likely richer (premium tiers, points+cash) |

No member discount, no points+cash hybrid, no premium tier anywhere in the
captured search/map/pin surface.

## Two price sources on the map — verified 2026-06-13

The Hilton search map has two distinct GraphQL operations that return price-like
data. They are NOT interchangeable.

### `hotelSummaryOptions.leadRate` — date-independent "from" rate

- Input type `HotelSummaryOptionsInput` accepts only `{quadrantId, guestLocationCountry}`.
  Passing date fields returns a schema error.
- `leadRate` reflects a generic "starting from" rate, not the user's search
  dates. `leadRate.hhonors` is frequently null for properties with award availability.
- Concrete observation (DENCNPE / Spark by Hilton Lakewood, Denver):
  `leadRate.lowest.rateAmount = 88.2` ("$89"), `leadRate.hhonors = null` —
  independent of any dates supplied to the page.
- **Correct use:** hotel GPS coordinates, name, brandCode, ctyhocn identity only.

### `shopMultiPropAvail` — date-specific, bookable pricing

- Input `ShopMultiPropAvailQueryInput` takes full date/guest/rate context;
  batch up to ~25 ctyhocns per call.
- Two passes needed to cover a full map viewport:

**Cash pass** (`specialRates.hhonors` omitted/false):
- Returns `summary.lowest.{rateAmount, amountAfterTax, ratePlanCode, ratePlan}` for every hotel.
- `summary.hhonors` is null.
- Denver observation: DENCNPE 2026-07-06→07-07 → `rateAmount 126.13`,
  `amountAfterTax 139.37`, ratePlan "Honors Discount Non-refundable".

**Points pass** (`specialRates.hhonors: true`):
- Hotels WITH award inventory: `summary.hhonors.dailyRmPointsRate` populated +
  `summary.lowest` reflects the award room's cash anchor.
- Hotels WITHOUT award inventory: `statusCode 1740`, `summary.lowest null`,
  `summary.hhonors null` — hotel is excluded from the response entirely for
  CPP purposes.
- Denver observation: DENRTQQ 2026-07-06→07-07 → `amountAfterTax 236.27`,
  `hhonors.dailyRmPointsRate 65 000`, ratePlan "Standard Room Reward".
  DENCNPE → `statusCode 1740`, both null.

**CPP formula:** `amountAfterTax (points pass) ÷ dailyRmPointsRate × 100`.

## Rate limiting / anti-bot

- Header set hints at bot defenses (Dynatrace `x-dtpc`, `traceparent`,
  `visitorid`). The extension rides the live session so it isn't gated.

## 2026-09-06 regular Chrome audit

- Chicago, Oct 12–14 2026, one adult/room loaded normally in the regular Chrome profile. Visited search, hotel preview, room list, room quick-look, cash plans, cash rate details, and the points toggle.
- Hampton Inn Majestic Chicago Theatre District (`CHITDHX`), King (`KXLX`): native member nonrefundable card rounds to $317/night. The native detail dialog shows $633.19 room charge + $119.67 taxes = $752.86 for two nights. Standard reward is 70,000 points/night. Expected after-tax comparison: approximately 0.54¢/pt; opposite nightly cash $376.43.
- Room quick-look uses `quickLookHeaderBar`, `modalMoreRatesButton`, and `modalQuickBookButton`; rate details use `quickLookRoomTypeName` and `priceDetailsExpandedSection`. These differ from list-card controls.
- Hilton strips query parameters on SPA navigation to `/en/book/reservation/rates/`. Dates/hotel/guests must follow the native pricing context, with invalidation when that context changes.
- The public reservation application bundle declares `hotel_shopAvailOptions_shopPropAvail`. Room responses include `quickBookRate`, `moreRatesFromRate`, `redemptionRoomRates`; rate responses include `roomOnlyRates`, nested `hhonorsDiscountRate`, `packageRates`, and redemption `totalCostPoints`. `pointDetails(perNight: true)` is an array. `fullAmountAfterTax` aliases formatted stay `amountAfterTaxFmt`.
- Implementation now observes native responses; removes map quadrant and pricing fan-out; deduplicates missing-side attempts for five minutes; applies a shared budget of four added requests/minute, one in flight, and at least two seconds between starts. 403/429/503 pause added lookups for at least 15 minutes, honoring longer Retry-After.
- After the first manual reload, live badges matched Hampton's $752.86 cash total / 140,000 points on search, previews, and the rate page. Cash plans show their own comparison, while the reward uses the cheapest eligible same-room cash rate.
- Palmer House (`CHIPHHH`), premium King (`K1T`), exposed different nightly points: 161,000 + 173,000 = 334,000. Cash total is $1,237.49; corrected CPP is approximately 0.37. Room `pointDetails` must be summed across all nights, not multiplied from the first element.
- Search's first-night-only points are explicitly marked as an estimate in the tooltip; no invented stay-points total is shown. Native room totals replace that estimate on room/rate pages. Cash base/fees derived from rounded nightly averages are marked approximate until the already-open native detail dialog supplies exact totals.
- Live cash search emitted overlapping 20/15/20-hotel batches. The revision coalesces missing hotel IDs, waits for an occupied budget slot, and never prices the same hotel twice in overlapping batches. Maps make no inventory requests.
- Layout fixes keep narrow rate badges on one line and position preview badges without enlarging Hilton's fixed action footer. Current-page rates no longer disappear after five minutes while Hilton still displays the same quote.
- After the second manual reload, verified 33 priced map hotels and every available list result across both pages (18 + 15). Cash search captured 20/15 cash batches and two corresponding points batches. Switching to points displayed complementary cash amounts; the preview badge left View Rates unobstructed. Narrow rate-column badges stayed on one line.
- Live Palmer premium King now shows approximately 0.37¢/pt and $618.75/night on points, or 167,000 average points/night on cash. The Hampton tooltip matches the exact native detail values: $633.19 base, $119.67 fees, $752.86 total, 140,000 points.
- Found two accessible room cards using `accessibleMoreRatesButton` / `accessibleQuickBookButton` instead of ordinary room button IDs. Added these observed selectors and extended the browser regression to exercise the accessible-card transition without another pricing request. The targeted room and split-batch tests pass; this last selector fix still needs an extension reload to appear in the user's already-open Chrome tabs.
- Typecheck, build, 17 unit checks, and 16 controlled browser checks pass. Browser automation policy rejects `chrome://extensions/`; extension reloads are performed manually by the user.
