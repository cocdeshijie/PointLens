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
- Per-site folder: `pointlens/hotels/hyatt/`.

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

## 2026-09-06 Chrome audit (in progress)

- Chicago, Oct 12–14, one adult/room: 34 search results. Park Hyatt Chicago shows $710 average/night and an existing 2.81¢/pt / 30,000-point badge while signed out. The earlier assertion that login is required for search points does not hold for this visit.
- `/shop/rooms/chiph` uses a separate booking application, not the search Flight renderer. Existing PointLens has no room badges. Cash mode lists nine rooms/seven suites; points mode shows `1VWD` (2 Queen Beds Water Tower View) at 30,000 points/night. This room's cash card was $974/night; the hotel's cheapest cash room was $710. Room-level pairing must distinguish these.
- Observed room anchors: `[data-locator="room-title"]` with ID `<roomCode>-room-title`, `[data-locator="rate-content"]`, `[data-locator="points-rate"]`, `.room-card-divider`, and button `<roomCode>-view-details`. Room detail and Select & Book flows need separate coverage.
- Temporary QA-only fetch/XHR schema diagnostics are built; awaiting manual extension reload to inspect native room response fields. No speculative pricing requests were made. A terminal request for the public application JS returned 403 and was stopped; continue native Chrome browsing.

### Room capture implementation, pending live badge validation

- The updated MAIN-world registration is now confirmed active in real Chrome. Passive capture found `GET /en-US/shop/service/rooms/roomrates/chiph`; the response is `roomRates[roomCode].ratePlans[]`.
- Cash fields are `rate`, `rateAfterTax`, `totalBeforeTax`, `totalAfterTax`; points fields include `points`, `avgPoints`, `totalPoints`. On the two-night visit, `1VWD` award has 30,000 points/night and 60,000 total. Its cheapest cash plan is $973.15 base/$1,157.07 after tax per night; CKNG is $709.02/$843.03. Native display rounds cash upward to whole dollars.
- New code normalizes full-stay offers, pairs room codes, falls back to the cheapest opposite-side room, and renders compact per-night badges in cash/points rows, rate selectors, and the active room-detail carousel slide. Modal input values identify exact rate-plan IDs. Inactive carousel slides must not be used for the displayed room.
- Controlled browser regressions pass for pairing, fees, cash/points switching, context invalidation, and a single opposite lookup. The exact native request query still needs confirmation: automatic lookup only changes an existing `rateFilter=woh|standard` parameter and otherwise makes no speculative request.

### Reload error and live query correction

- Reproduced `Duplicate script ID 'contentsHyattMain'` in a clean isolated Chromium profile: Plasmo's generated registrar competed with PointLens reconciliation. MAIN entries now bundle from each brand folder, with one background registrar and the existing persistent IDs. A real Chromium regression checks initial registration and correction of a deliberately stale registration after restarting the profile.
- Native cash room requests omit `rateFilter`; points requests add `rateFilter=woh`. Opposite lookup now follows that exact behavior, preserving the rest of the query.
- Native `STEXLP` plans say `Point Award + Suite Upgrade`; these require an extra upgrade award and are excluded from standalone points comparisons. The remaining 1VWD award is 60,000 points for two nights. Live cash total is $2,314.15, so the room comparison is 3.86¢/pt and displays $1,157.08 per night on points mode.

### Static registration migration supersedes the earlier registrar fix

- The second user error included a byte-for-byte match of the latest compiled background bundle, ruling out an outdated build. Removing the generated registrar alone did not fix the user's Chrome state. The earlier restart test was insufficient; the precise remaining Chrome registration failure was not reproduced in the separate Chromium version.
- Removed dynamic registration/reconciliation entirely. Hyatt, IHG, and Marriott page scripts now use Chrome's static manifest `world: MAIN` and `document_start`. Startup unregisters legacy dynamic scripts; PointLens has no other dynamic registrations to preserve.
- Plasmo 0.90's manifest validator rejects the supported `world` key, so a build/dev post-build hook sets it on the three bundled manifest entries, validates each entry, and fails if any is missing. See https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts.
- Browser regression seeds all three old IDs, deletes their obsolete script file, restarts, verifies zero dynamic registrations, and confirms exactly one Hyatt native capture. All 17 unit and 20 browser tests pass. User's real Chrome still needs manual reload to load this migration.

### Completed live checks, 2026-09-06

- Took control of the user's Chrome with authorization, confirmed the unpacked build directory, cleared the historical duplicate-script error, and reloaded PointLens. No new registration error appeared. The final architecture is static MAIN-world scripts plus legacy dynamic-script cleanup, as above.
- An omitted `rateFilter` can use Hyatt's saved **points** mode. Missing-side room lookup now detects the response's actual offers and explicitly requests `standard` or `woh`; it does not infer cash from a missing filter.
- Verified signed-out search list and map, points mode, map preview, cash room cards, direct points room URL, room details, expanded rate choices, and selected-rate footer. Park Hyatt's hotel-lowest value is 2.81¢/pt; the available 1VWD award room matches its own cash at 3.86¢/pt. These are intentionally different comparisons. Tooltips identify fallback to the hotel's cheapest opposite room when necessary.
- Search context ignores presentation-only `rateFilter` / tracking changes so switching cash/points retains valid paired data; dates and guests still invalidate the comparison.
- Added a shared per-brand budget across tabs: one in-flight lookup, at least 2.5 seconds between starts, at most four per minute, 15-second timeout, and a minimum 15-minute cooldown after 403/429/503 while respecting longer Retry-After values. Native successful responses are reused.
- Removed temporary schema and pricing diagnostics from the final production build.

- Final tooltip rounding check: exact two-night base $1,418.05 and total $1,686.06 display as Base $709.03, Fees $134.00, Total $843.03 per night. Displayed fees reconcile the rounded amounts; CPP still uses exact stay totals. Both saved cash/points fixture variants cover this fractional-cent case.

### Direct room link and delayed lookup, 2026-09-06

- User reported that direct `chixl` Sep 18–19 cash entry showed no CPP until points were toggled on and off. The exact link showed 14 badges in a fresh Chrome tab during this audit, indicating state-dependent behavior rather than an unsupported property layout.
- Found a reproducible defect in the missing-side path: a refused cross-tab budget allowance was added to `attempted` before any hotel request, permanently suppressing that lookup. Added browser cases that seed another tab's active lease and verify that direct cash and saved-points loads resume automatically with exactly one opposite request.
- Budget replies now supply the next permitted check time, accounting for spacing, active leases, the rolling limit, and server cooldown. Hyatt queues the missing side until permitted, marks attempts only when issuing the actual request, drops work when the stay changes/native data supplies both sides, and preserves native headers/credentials. Actual failed hotel requests still do not loop.
- Reloaded the production extension and both the fresh and original user room tabs. Verified the untouched cash view at the exact link: Den King starts at 3.32¢/pt · 20,000 pts, with no points toggle. All 18 unit + 26 browser tests and type checking pass.

### Room availability and loading, 2026-09-06

- User clarified that Hyatt room-specific views must compare only the same room. This supersedes the earlier cheapest-opposite-room fallback for Hyatt room cards, expanded rate plans, selected-rate footers, and room details. Hotel search/map/preview comparisons retain their existing behavior; other brands retain their own fallback policies.
- Added a compact animated skeleton in the badge position while native rates or the budgeted opposite lookup are pending, with an accessible loading label and reduced-motion support. A successful lookup without a matching room shows `Points unavailable` (or `Cash unavailable` in points mode). Failed lookups show a short loading-error label instead of implying the room is unavailable.
- Authoritative responses replace offers for their payment side, including empty results, so removed award availability cannot leave stale CPP behind. Completed empty results do not trigger another opposite lookup. Pending lookups are canceled when native data supplies that side.
- Reloaded the final production build in the user's Chrome and verified direct cash entry at the exact chixl Sep 18–19 link. Hyatt currently lists seven cash rooms and five native points rooms in this session; both high-floor room types show `Points unavailable`, while the five matching room types show their own CPP. Verified the unavailable label in expanded rates, the selected footer, and room details as well.
- Type checking, production build, all 18 unit tests, and all 28 browser tests pass. Browser coverage includes pending budget/loading states, direct cash and saved-points entry, strict room matching, excluded upgrade awards, empty awards versus 429 failure, availability removal, and no redundant lookup. Fractional-cent tooltip fees reconcile the independently formatted base and total; CPP uses exact stay totals.
