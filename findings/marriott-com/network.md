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
