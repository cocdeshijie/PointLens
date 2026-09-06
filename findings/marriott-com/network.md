# Network / APIs — marriott-com

Source: extension source code (`pointlens/hotels/marriott/`), reviewed
2026-06-14. Live HAR captures not yet taken.

## Auth flow

- **Browser-bound session cookies.** The extension rides the live page session
  — it does not hold or manage tokens directly. The replay in
  `marriott-fetch-hook.js` sends `credentials: "include"` and forwards the
  original request headers (minus `content-length` and `host`), plus adds
  `x-av-replay: 1` as a sentinel to prevent the `webRequest` listener from
  re-intercepting the replayed request.

## API base(s)

- `https://www.marriott.com/mi/query/` (GraphQL over HTTP POST; not WS)

## Endpoints

| Method | URL / operationName | Auth | Purpose | Notes |
|---|---|---|---|---|
| POST | `phoenixShopDatedSearchByGeoQuery` | session cookies + request headers | Dated search by geo — cash + award rates | The single known pricing endpoint. Extension intercepts + replays. |

## `phoenixShopDatedSearchByGeoQuery` — request shape

- **operationName:** `"phoenixShopDatedSearchByGeoQuery"`
- **variables.search.options.rateRequestTypes** — native page shape has
  DRIFTED over time (see history below). The extension no longer relies on
  matching a specific incoming shape.

### Native page shape — history

| Period | Shape sent by the live page |
|---|---|
| Before 2026-06 | `[{STANDARD,""}, {CLUSTER,"E0P"}]` — two entries |
| 2026-06 onward | `[{STANDARD,""}]` — single entry only (E0P cluster dropped) |

The drift broke the old guard in `patchBodyForClusters` which gated injection
on detecting the old two-entry pattern. When the page began sending
STANDARD-only, the guard never matched, so the replay re-sent STANDARD-only
and the response carried no `MRW`/`P17` reward clusters — every hotel showed
"Reward Nights Unavailable".

### Extension rewrite (fix applied 2026-06-14)

`patchBodyForClusters` now **unconditionally forces**:

```json
[
  { "type": "CLUSTER",  "value": "MRW" },
  { "type": "STANDARD", "value": "" },
  { "type": "CLUSTER",  "value": "P17" }
]
```

The patch is idempotent — it skips re-patching only if `rateRequestTypes` is
already exactly this three-entry array. This guarantees the replay always
returns both reward points (MRW/P17) and STANDARD cash rates regardless of
what shape the page happens to send.

## `phoenixShopDatedSearchByGeoQuery` — response shape

Top-level path to hotel edges:

```
data.search.lowestAvailableRates.searchByGeolocation.edges[]
  .node
    .property   — hotel identity (see "property fields" below)
    .rates      — array; see "rate parsing" below
```

### `property` fields (known from extension code + live inspection 2026-06-14)

The extension's `buildRatesFromStorage` probes these paths in priority order
for the hotel identifier (MARSHA code):

| Path | Notes |
|---|---|
| `property.id` | Primary probe — confirmed to be MARSHA code (e.g. "NYCOF") |
| `property.marshaCode` | Alternate casing |
| `property.marshacode` | Alternate casing |
| `property.propertyCode` | Fallback |
| `property.code` | Fallback |

**Confirmed from live inspection — coordinate fields are present:**

| Path | Type | Notes |
|---|---|---|
| `property.basicInformation.latitude` | number | Hotel latitude |
| `property.basicInformation.longitude` | number | Hotel longitude |
| `property.basicInformation.name` | string | Display name |
| `property.basicInformation.brand.id` | string | Brand code (e.g. "OX" = Moxy) |

These fields are already present in every edge returned by the existing replayed
`phoenixShopDatedSearchByGeoQuery`. No separate geo endpoint or additional API
call is needed for map overlay work — coordinates flow through the existing
pipeline at zero extra cost. This is simpler than Hilton, which required a
separate `shopMultiPropAvail` / `hotelSummaryOptions` fetch for coordinates.

### Rate parsing — cash candidates

`buildRatesFromStorage` in `content.ts` tries these paths (array or object,
first finite value wins):

| Priority | Path |
|---|---|
| 1 | `cashRate.amount` |
| 2 | `cashRate.amountAfterTax` |
| 3 | `cash.amount` |
| 4 | `rateModes.lowestAverageRate.amount` |
| 5 | `rateModes.lowestAverageRate.amount.amount` (nested object) |
| 6 | `rateModes.lowestAverageRate.amountPlusMandatoryFees` |
| 7 | `rateModes.lowestAverageRate.amountPlusMandatoryFees.amount` |
| 8 | `rateModes.lowestAverageRate.totalAmount` |
| 9 | `rateModes.lowestAverageRate.totalAmount.amount` |
| 10 | `lowestCashRate.amount` / `.amountAfterTax` |
| 11 | `lowestAvailableRate.amount` / `.amountAfterTax` |
| 12 | `bestAvailableRate.amount` / `.amountAfterTax` |
| 13 | `lowestRate.amount` / `.amountAfterTax` |
| 14 | `total.amount` |
| 15 | `totalAmount` |

### Rate parsing — points candidates

| Priority | Path |
|---|---|
| 1 | `pointsRate.points` |
| 2 | `pointsRate.totalPoints` |
| 3 | `rateModes.pointsPerUnit.points` |
| 4 | `lowestPointsRate.points` |
| 5 | `lowestPointsRate.totalPoints` |
| 6 | `awardRate.points` |
| 7 | `points` |

### Confirmed `rates` array structure (verified live 2026-06-14)

`node.rates` is an **array** of rate entries. Each entry has:

| Field | Values / type | Notes |
|---|---|---|
| `rateCategory.code` | `"Special"` or `"StandardRates"` | Discriminates award vs cash entries |
| `rateCategory.value` | `"MRW"`, `"P17"`, or absent | Present on Special (award) entries |
| `status.code` | `"AvailableForSale"` or `"NotAvailable"` | Filter out NotAvailable before parsing rates |
| `rateModes.pointsPerUnit.points` | integer | Points per night — present on MRW/P17 entries |
| `rateModes.lowestAverageRate` | MonetaryAmount object | Present on StandardRates entry |
| `lengthOfStay` | integer | Nights covered by this result |

`MonetaryAmount` shape (confirmed on StandardRates entries):

```json
{
  "amount":       { "amount": 359.0, "currency": "USD", "decimalPoint": 2 },
  "fees":         { "amount": 12.0,  "currency": "USD", "decimalPoint": 2 },
  "taxes":        { "amount": 42.0,  "currency": "USD", "decimalPoint": 2 },
  "totalAmount":  { "amount": 413.0, "currency": "USD", "decimalPoint": 2 }
}
```

### StandardRates entry (cash breakdown source)

The entry where `rateCategory.code === "StandardRates"` provides the
authoritative cash breakdown via `rateModes.lowestAverageRate`:

| Field | Meaning |
|---|---|
| `.amount` | Base nightly rate (MonetaryAmount) |
| `.fees` | Fees (MonetaryAmount) |
| `.taxes` | Taxes (MonetaryAmount) |
| `.totalAmount` | Total = base + fees + taxes (MonetaryAmount) |
| `lengthOfStay` | Number of nights for this result |

Currency is probed from `standardLowestAverageRate.amount.currency`, then
`rates.currency`, then `property.currency`, `property.basicInformation.currency`,
`property.currencyCode`.

**Currency caveat:** `currency` has been observed as both `"USD"` and `"CNY"`
depending on account locale. The CPP display uses a `$` prefix and USD-
denominated thresholds. A non-USD account will mislabel the currency symbol
and produce a skewed CPP value. This is a known open caveat — no locale-aware
formatting has been implemented yet.

### CPP formula

```
cashForCpp  = cashTotal ?? cash ?? cashBase   (from StandardRates entry)
cppPoints   = (stayNights > 1) ? (points / stayNights) : points
CPP (¢/pt)  = (cashForCpp / cppPoints) * 100
```

Points are divided by `lengthOfStay` for multi-night searches so the CPP
reflects a per-night basis.

## How the extension handles it

1. **`background.ts`** registers `chrome.webRequest.onBeforeRequest` and
   `onBeforeSendHeaders` listeners scoped to `phoenixShopDatedSearchByGeoQuery`.
   - Reads the raw request body from `requestBody.raw[0].bytes`.
   - Checks `operationName === "phoenixShopDatedSearchByGeoQuery"`.
   - Ignores requests that already carry the `x-av-replay` header (to avoid
     looping on the extension's own replays).
   - When both body and headers are collected, sends a
     `MARRIOTT_PAGE_REPLAY` message to the tab.

2. **`content.ts`** forwards `MARRIOTT_PAGE_REPLAY` to the MAIN world via
   `window.postMessage({ __AV_MARRIOTT_DO_REPLAY__: true, payload })`.

3. **`injected/marriott-fetch-hook.js`** (MAIN world) receives the message,
   patches `rateRequestTypes`, issues a `fetch` with `credentials: "include"`,
   parses the `edges`, and posts
   `{ __AV_MARRIOTT_SAVE__: true, payload: { hotels } }` back.

4. **`content.ts`** catches `__AV_MARRIOTT_SAVE__` and relays via
   `chrome.runtime.sendMessage({ type: "MARRIOTT_SAVE_CAPTURE" })`.

5. **`background.ts`** persists to
   `chrome.storage.local["pointlens:marriott-last-capture"]`.

6. **`content.ts`** reads storage on change, rebuilds the hotel rate map via
   `buildRatesFromStorage`, and updates DOM placeholders.

## Open questions

- Are there other `operationName` values on `https://www.marriott.com/mi/query/`
  worth intercepting (e.g. single-property detail page, alternate search query
  for non-geo searches)?
- **Currency / locale correctness:** `rateRequestTypes` and response
  `MonetaryAmount.currency` are account-locale-dependent. Observed `"USD"` and
  `"CNY"`. The CPP display hardcodes `$` and USD thresholds — needs locale-aware
  formatting for non-USD accounts. (See confirmed `rates` structure above.)

## 2026-09-06 Chrome audit (in progress)

- Chicago, Oct 12–14, one adult/room: 140 search results, 40 per page. Existing PointLens placeholders remain loading; no legacy Marriott Replay logs were observed. The current endpoint/operation must be captured before changing replay behavior.
- Residence Inn Chicago Downtown/Loop (`CHIRL`) room and rate pages show no PointLens badges. Native Studio King card: $738 average/night, $1,477 rounded stay total before taxes. Expanded rate carousel has Flexible member/non-member plus package rates. View Rates expands pricing; Select advances booking and was not clicked.
- Room Details links carry `marshaCode`, `roomPoolCode` (e.g. `stdo`), and `productId`. Room and rate overlays must preserve these identities and use exact amounts from native responses rather than rounded card prices.
- Temporary QA-only passive schema diagnostics are built; awaiting manual extension reload to inspect native search/room operations. Existing webRequest/header replay architecture should be replaced with passive native capture plus bounded missing-side lookups, preserving special-rate inputs and preventing stale cross-tab pricing.

### Native room/search capture implementation, pending live badge validation

- MAIN-world observer activation confirmed. Search still uses `phoenixShopDatedSearchByGeoQuery`. CHIRL's two-night search returns `pointsPerUnit.points=108000`; the visible site confirms **108,000 Points / Stay**. Earlier notes calling this field nightly were incorrect. Cash `lowestAverageRate.amount.amount=73850` with decimal scaling corresponds to $738.50/night; after-tax amount is $878.08/night.
- Room API is `/mi/query/PhoenixBookDTTSearchProductsByProperty`, at `data.commerce.product.searchProductsByProperty.edges[].node`. The points page returned 55 products including cash plans, so passive capture can cover both sides without another pricing request. Native expanded Studio shows Redemption 108,000 points/stay beside Flexible cash $738 average/$1,477 stay before tax.
- Product IDs decode to hotel|plan|room-pool|arrival|departure|opaque suffix; both room-detail and rate-detail links expose exact product IDs. Room cards use `[data-testid=RateCardV2]`; rate links use `[data-testid=rate-modal]`; dialogs use `#room-details-modal` and `#rateDetailsContent` (the latter has no dialog role).
- New code removes background header collection/replay and global cached rates as a UI source. Native search capture retains the current page/context, preserves special-rate inputs on missing-side replays, retains native result order for map pins, rejects superseded responses, and shares a conservative request budget/backoff across tabs.
- Room product cash normalization uses `totalPricing.rateModes.subtotalPerQuantity`/`grandTotal` and points from `rates.rateModes.pointsPerUnit`; currency, quantity semantics and full live product samples remain to be checked against the newly built diagnostics before finalizing.

### Live totals correction

- Native cash product confirms quantity=1 for a two-night, one-room stay. Studio member subtotal is $1,477.00, grand total $1,756.17, and nightly base $738.50; these are not rounded DOM-derived amounts.
- Points-only rate modes have `pointsPerUnit` without a cash rate field. Their `totalPricing` still contains internal cash amounts ($511.27 for Studio redemption; $47.56 for a points upgrade). Native cards, expanded rates, and redemption Rate Details show only points, so these amounts must not be treated as guest copays. Award comparisons now deduct the explicit mandatory fee field instead. Cash-and-points variants still need separate live validation.
- The updated regression uses a nonzero internal award cash total to ensure it cannot reduce CPP. Real Chrome validation of the corrected build remains pending manual reload.

### Completed live checks, 2026-09-06

- Live dated searches use both `/mi/query/phoenixShopDatedSearchByGeoQuery` and `/mi/query/phoenixShopDatedSearchByDestinationQuery`. Corresponding response collections are `searchByGeolocation` and `searchByDestination`; both are supported and covered by browser regressions.
- Canonical search context ignores view, deviceType, and hash changes. These presentation changes occurred while the native response was pending and previously discarded usable results. Cash/points mode uses the native checkbox, with URL fallback. Undated Continue links do not receive empty price placeholders.
- Verified the Oct 12–14 Chicago search in cash and points mode, list/map, current smart-info-window portal previews, and hotel quick-view modal. CHIRL search shows 1.63¢/pt, with 54,000 points/night on cash view and $878.08/night on points view. The room page uses exact stay totals ($1,756.17 / 108,000 points); the one-cent nightly rounding difference comes from Marriott's API.
- Verified CHIRL room cards, expanded redemption/member/non-member/package rates, room-detail dialog, and rate-detail dialog. Shared room and rate IDs retain the correct selected comparison and compact badge placement.
- Native points search explicitly charges destination fees (e.g. JW Marriott Chicago +$30 daily). Search CPP now subtracts `lowestAverageRate.mandatoryFees`, with a compact Award fees row in the tooltip. JW's value changes from 0.95 to 0.91¢/pt; the full cash amount remains $692.59/night.
- Map pins now stack the comparison on a second line despite Marriott's flex-row styling. Preview capture covers `.smart-info-window-portal-layer .HotelCard` as well as the old Google InfoWindow.
- Cash search made one bounded missing-award lookup. Combined native search responses and room responses need no duplicate request. The per-brand cross-tab budget, in-flight lease, timeout, Retry-After handling, and cooldown are tested.
- Removed temporary schema/pricing logs for the final production build. Cash-and-points products and other locales were not independently live-audited in this pass.

### Fresh cash-room load follow-up

- A final reload after changing the shared Marriott search session opened LaSalle (`CHIAD`) in cash mode. This native room response contained 54 cash products and **no award products**; the earlier combined-room-response observation applies to points mode, not every room load.
- Native points toggle adds `{type:"REDEMPTION", value:""}` to room `variables.search.options.rateRequestTypes`. Added one bounded missing-side room request with this exact selector, preserving the native query, headers, dates, guests, special rates and credentials. No replay when the native request already asked for that side.
- Native and replayed cash product IDs have different opaque suffixes. Retain original cash IDs and merge only missing award offers so room/rate links still identify their own cash price. Request revisions discard superseded responses and replays.
- Verified a fresh real-Chrome LaSalle cash page: Superior Queen/Queen shows 1.13¢/pt and 145,000 points/stay; Deluxe King shows 1.14¢/pt using the available award fallback. No user toggle is required.
- Mixed cash-and-points/points-plus-cash-upgrade modes are excluded from ordinary cash candidates; their internal subtotals must not contaminate minimum cash comparisons.
- Final production build has no temporary pricing logs. All 18 unit + 24 browser tests pass, including fetch/Request and XHR replay, preserved headers/special rates/native product IDs, static registration migration, and fractional-cent tooltip rounding. Type check and diff whitespace check pass.
