# hyatt-com — Network / APIs

## Auth flow

Requires a **World of Hyatt member session** (logged-in cookie) to see award
points in the search response. No separate auth endpoint has been probed; the
standard browser session cookies are sufficient. A `POST /search/hotels/api/cookies`
call is observed on load — this syncs cookies but is not an auth step.

## API base(s)

All observed traffic hits `www.hyatt.com` directly (no separate `api.hyatt.com`
subdomain observed for search). There is no GraphQL layer — data is delivered
as a **React Server Components (RSC / "Flight") payload**.

## Endpoints

| Method | URL pattern | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET (page load) | `https://www.hyatt.com/search/hotels/en-US/<Location>?checkinDate=YYYY-MM-DD&checkoutDate=YYYY-MM-DD&rooms=1&adults=1&kids=0&rate=Standard&accessibilityCheck=false` | WoH session cookie | Hotel search — initial load | RSC Flight stream; hotel+rate data in `self.__next_f` |
| POST (soft update) | Same URL as above with updated query params | WoH session cookie | "Search this area" / map-pan refinement | Next.js Server Action; `next-action` + `next-router-state-tree` headers; returns React Flight stream (~74 KB observed); page updates WITHOUT a full reload; contains `hotelSummaries[].leadingRate` but NOT the `"hotelData":` wrapper key — use unified extractor (see below). |
| POST (full SSR nav) | Same URL as above with updated query params | WoH session cookie | Date change / points-toggle (`rateFilter=woh`) | Full SSR navigation — any MAIN-world hooks installed via Runtime.evaluate are wiped; fresh `__next_f` carries new `"hotelData":` wrapper; parse exactly like initial load. |
| GET | `https://www.hyatt.com/quickbook/autocomplete?query=<q>&locale=en-US&includeGoogleSuggestions=true` | None observed | Location typeahead | Clean JSON; not a rate source |
| POST | `https://www.hyatt.com/search/hotels/api/cookies` | Session cookie | Cookie sync on load | Not an auth endpoint; safe to ignore |

## Search data delivery — RSC Flight

Hyatt's search page is a **Next.js App Router** SPA. Hotel and rate data are
**not** exposed via a clean REST or GraphQL API. Instead they arrive as a
server-side rendered React Flight payload:

### Initial load

The browser receives a series of inline script tags that push chunks into
`self.__next_f` (an array of `[type, string]` tuples). To extract hotel data:

1. Concatenate all `chunk[1]` strings → one large flight string.
2. Locate the key `"hotelData":` inside a flight row of the form
   `14:["$","$L1e",null,{"hotelData":{...}}]` (row index may vary).
3. Extract the value starting at the `{` after `"hotelData":` using a
   balanced-brace scan.
4. `JSON.parse` the extracted string.

A MAIN-world content script can do this on `DOMContentLoaded` (or after
`self.__next_f` finishes populating) without any network replay.

### Subsequent refinements — two distinct paths (CONFIRMED 2026-06-16)

**"Search this area" / map-pan (soft Server Action update):**
The page fires `POST` to the same search URL with updated params. Headers
include `next-action` and `next-router-state-tree`. The response is a React
Flight stream (~74 KB observed). The page updates in-place WITHOUT a full
reload — verified by a `fetch`-wrapping hook installed via `Runtime.evaluate`
surviving the action and capturing the response body.

Critical shape difference: the soft-update Flight stream contains
`hotelSummaries[]` with `leadingRate` objects, but does NOT include the
top-level `"hotelData":` wrapper key. The unified extractor below handles this
transparently.

**Date change / points-toggle (`rateFilter=woh`) (full SSR navigation):**
Any MAIN-world hooks (e.g. a `window.fetch` wrapper installed via
`Runtime.evaluate`) are wiped — the page fully reloads. The fresh `__next_f`
carries a new `"hotelData":` wrapper and should be parsed exactly like the
initial load.

**Key implication:** no reward-rate replay is needed. `rate=Standard` (cash)
search already returns **both** cash rate and award points in the same object.

### Unified rate extractor (works for ALL paths — CONFIRMED)

`leadingRate` carries its own `spiritCode`, so a single extractor handles
initial-load `__next_f`, full-nav `__next_f`, AND soft Server Action responses
without depending on the `"hotelData":` wrapper:

1. Concatenate the source text (for `__next_f`: join all `chunk[1]` strings;
   for a fetch response: the response text).
2. Scan for every occurrence of `"leadingRate":` and balanced-brace-extract
   the `{...}` that follows it; `JSON.parse` each.
3. Key by the parsed object's own `spiritCode`:
   `map[obj.spiritCode] = obj`.

Verified: this yields all 6 hotels from the live `__next_f` with correct
`{rate, points, currencyCode, status}`.

### Points-mode cash preservation

With `rateFilter=woh` (points filter on), `leadingRate` STILL has both `rate`
(cash, e.g. 332) and `points` (e.g. 12,000). The card DOM shows
"12,000 Points/Night" + "$332 Avg/Night" + "Includes fees before taxes". CPP
overlay reads `leadingRate` and computes `rate / points` regardless of which
display mode is active.

## Search response shape (verified 2026-06-16, Columbus OH, 1 night)

```
hotelData = {
  responseInfo,
  totalResults,
  centerPoint: { id, latitude, longitude, name, addressText },
  hotelSummaries: [ ... ]
}
```

Each `hotelSummaries[]` item:

| Field | Type | Description |
|---|---|---|
| `spiritCode` | string | Per-property stable id (e.g. `"cmhxo"`) — use as the hotel key |
| `hotelDetail` | object | `name`, `brand`, `brandLabel`, `latitude`, `longitude`, `address1`, `city`, `province`, `country`, `countryCode`, `availableAwardTypes[]`, `memberBenefits`, … |
| `features` | object | Experiences / themes / TripAdvisor tags — not needed for CPP |
| `leadingRate` | object | **Primary rate object — see below** |
| `bookabilityStatus` | string | Top-level availability |
| `distance` | number | Distance from search center |
| `recommendedOrder` | number | Sort key |
| `hpesrId` | string | Internal id |

### `leadingRate` object

| Field | Type | Example | Notes |
|---|---|---|---|
| `status` | string | `"BOOKABLE"` / `"SOLD_OUT"` | Skip `SOLD_OUT` entries (rate=0, points=0) |
| `rate` | number | `185` | Cash nightly, member-discounted, **pre-tax** — **use as CPP cash basis** |
| `rateAfterTax` | number | `217.38` | Post-tax; do not use for CPP |
| `rateIncludingFeesBeforeTaxes` | number | — | Pre-tax but includes resort fees |
| `points` | number | `12000` | Award redemption points for 1 night — **use as CPP points basis** |
| `currencyCode` | string | `"USD"` | Non-USD for international; normalize via `toUsd()` / background FX |
| `ratePlanCode` | string | `"MYHI"` | Rate plan identifier |
| `roomTypeCode` | string | — | Room type |
| `rateFlags` | string[] | `["MEMBER_DISCOUNT"]` | Flags on the rate |

`SOLD_OUT` properties have `leadingRate = { status:"SOLD_OUT", rate:0, rateAfterTax:null, points:0, … }` — guard with `status === "BOOKABLE" && points > 0`.

## CPP formula (confirmed)

```
CPP (¢/pt) = (rate / points) * 100
```

where `rate` is `leadingRate.rate` (pre-tax member cash, normalized to USD).

### Verified examples (Columbus OH, 2026-06-16)

| `spiritCode` | Hotel | Cash (`rate`) | Points | CPP |
|---|---|---|---|---|
| `cmhxo` | Hyatt House Columbus/OSU | $185 | 12,000 | 1.54¢ |
| `cmhzp` | Hyatt Place Columbus/Polaris | $170 | 10,000 | 1.70¢ |
| `cmhzd` | Hyatt Place Dublin/Columbus | $166 | 7,500 | 2.21¢ |
| `cmhrc` | Hyatt Regency Columbus | SOLD_OUT | — | skip |

## Map

Map is rendered with **Google Maps JS** (`maps.googleapis.com`, key
`<site-provided Google Maps key>`) — the same key Marriott uses. Map
pin annotation will require index- or code-based identity matching (how pins map
to `spiritCode` is TBD — see open questions).

## Extension implementation notes

Hyatt is the simplest intercept target of the four hotels:

- **No separate reward-rate replay needed.** `rate=Standard` already includes
  `points` in the response. Unlike Marriott's `rateRequestTypes` patch, nothing
  needs to be injected into the outgoing request.
- **MAIN-world hook** (three parts):
  (a) On load, parse `__next_f` via the unified extractor — also hook
  `__next_f.push` or re-scan on `readystatechange` to handle progressive
  streaming.
  (b) Wrap `window.fetch` (and XHR) to run the unified extractor on every
  response body; soft Server Action updates are caught here.
  (c) On full SSR navigations (date/points-toggle), the hook is wiped — the
  new page load triggers (a) again automatically.
  postMessage `{spiritCode → {rate, points, currencyCode, status}}` to the
  ISOLATED content script after each extraction.
- **ISOLATED content script** reads the posted rates and annotates list cards
  and map pins with CPP badges — same pattern as IHG/Marriott.
- **No background webRequest interception and no authenticated replay needed**
  (unlike Marriott) — the page already fetches everything required; the hook
  just reads it.
- Per-site folder: `award-viewer/hotels/hyatt/`.

## Open questions

- ~~What is the exact row structure of the Server Action POST response Flight
  stream?~~ ANSWERED 2026-06-16: soft-update stream contains
  `hotelSummaries[].leadingRate` objects (each with its own `spiritCode`) but
  NOT the `"hotelData":` wrapper; unified extractor handles this. Full SSR
  navs (date/points-toggle) wipe hooks and deliver fresh `__next_f` with
  `"hotelData":` wrapper as in initial load.
- How do map pins map to `spiritCode`? Is there a DOM `data-` attribute, an
  index, or a lat/lon match?
- Does `self.__next_f` finish populating synchronously or does the extension
  need to observe it via a `MutationObserver` / polling?
- Are non-USD `currencyCode` values common enough in practice to require
  prominent handling in the initial implementation?
- Does the Google Maps key (`<site-provided Google Maps key>`) rotate
  or is it stable (same key observed on Marriott)?
- Is `spiritCode` stable across sessions / search refinements (safe to use as
  storage key)?
