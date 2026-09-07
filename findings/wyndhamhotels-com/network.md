# Wyndham — pricing integration

Verified in real Chrome on September 6, 2026 using Chicago, September 18–20,
2026, one adult and one room. Sources: native page requests, Wyndham's public
`srp-components.js` and `all-js.js`, and public JSON responses. No login was
required for the tested awards. No booking requests are made.

## Endpoints and units

GET `/BWSServices/services/hotels/property-availability` accepts a hotel batch
in `properties` (e.g. `LQ52843,TL10073`). Native `rateTypeFilter=price` or `loyalty`
omits the companion side. Removing that filter and using `useWRPoints=true`
returns both. `displayRate` and `totalAfterTax` are NIGHTLY amounts, despite the
latter's name. `displayRateProcessed` may include local fees and is not the base.
`totalFnsPoints` covers the entire stay. Award-only results can omit currency;
retain those awards and use the matching cash hotel's currency. Ignore `pacRate`
for full-award comparisons.

GET `/BWSServices/services/hotels/availability/getRoomsAndRates` uses `propertyId`,
`roomTypeCode` and `ratePlanId`. Native requests normally contain both payment
sides with `useWRPoints=true`. `totalBeforeTax` and `totalAfterTax` are FULL-STAY
amounts. `fnsRatePlan=true` identifies full awards; `pacRatePlan=true` is mixed
payment and is excluded. Public awards may have `qualified=false`; do not filter
on that flag. Zero award cash totals are valid, but missing totals are unknown.
Pair exact room codes; never borrow another room's award.

La Quinta Chicago Downtown NK1 SWR1: $880.24 base, $1,081.82 total for two nights;
SRB: 60,000 points. CPP is 1.803033... cents, displayed as 1.80¢/pt. Nightly
companions are 30,000 points / $540.91; full-stay dialog companions are 60,000
points / $1,081.82. Nine cash room types existed, but only four had full awards.
The other five show Points unavailable.

## Requests and freshness

Reuse native fetch/XHR JSON without delaying its response. Request at most one
companion per batch/context, preserving native selected prices. Opposite prices
are reused for five minutes on mode toggles. Dates, guests, hotels and discount
parameters separate contexts; later overlapping native batches win.

Supplemental calls share the existing per-brand budget across tabs and worker
restarts: one inflight, 2.5-second spacing, four per minute. 403/429/503 pauses
supplemental calls for at least 15 minutes, honoring longer Retry-After values.
Fetch timeout is 15 seconds. Failure is shown as a loading error, never false
award unavailability. No room-by-room requests, map-preview requests, polling,
or retries of failed supplemental requests. Chrome manages session cookies.

Cached overview prices can appear without new native requests. After 1.8
seconds, make one budgeted lookup only if the DOM provides an unambiguous hotel
image ID and native price and the URL has explicit stay dates. The visible cash
or points mode takes precedence over a stale URL mode flag.

## Coverage

Brand code and popup are isolated in `pointlens/hotels/wyndham/`, with a thin
content entry and static MAIN registration. Thresholds and tax basis use the
existing settings UI. Compact badges and keyboard-accessible tooltips reuse the
shared renderer. Cards use nightly units; stay-total dialogs use full-stay units.
Map pins remain native hotel icons; the selected hotel preview displays CPP.

Live checks: cash and points search; direct cash and points room pages; cached
hotel overview; map preview; award stay-total dialog. Automated coverage includes
parsing, mixed-rate exclusion, exact-room unavailability, changed dates, loading,
settings, missing currency, deduplication, 429 cooldown, overview bootstrap,
map previews, full-stay dialogs and MAIN registration. Existing hotel regression
suites pass. No exhaustive claim is made for all countries or Wyndham properties.
