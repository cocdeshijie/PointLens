# Best Western pricing integration

Live Chrome audit: September 6, 2026. Chicago / Valparaiso, September 18–20,
one room, one adult. Checked points search, list/map switching, native markers,
direct hotel room entry, and simultaneous cash/award rate rows.

## Native sources

`GET /bin/bestwestern/proxy?gwServiceURL=HOTEL_SEARCH` returns a hotel array.
Cash uses `resortSearchRate`; `ratePlan=BWR` supplies `resortSearchPoint`.
Despite their names, `totalAmount` and `totalPoints` are nightly averages.
Multiply by the requested stay length. Currency and cash tax inclusion come
from `resortSummary`, not from a currency symbol.

`ROOM_RATE_PLAN` returns exact `roomCategoryCode` and `dailyPriceMap` values.
Sum every requested date, and require inventory and no restriction. The observed
full-points plan is `FX`; `FX2` is a cash plan. Cash room rates can arrive before
the native DOM publishes the original hotel currency in `#currency-code-hv`.
Keep those responses pending rather than discarding the first flexible rate.

At property 15108, native 2UB cash was $195 + $199 = $394 before tax; FX was
36,000 + 36,000 = 72,000 points. Both search and room pages therefore show
0.55¢/pt with the appropriate cash/points companion. RACK $493 is valued
separately at 0.68¢/pt. Taxes absent from the source remain unknown in the tooltip.

## Requests and UI

Prefer native responses. After native calls settle, fill one missing search
side with a batch, or one missing room award plan with `FX`. Do not fan out
cash room-plan lookups. Extra calls use the shared four-per-minute, serialized
cross-tab budget, 2.5-second spacing, 15-second timeout, and at least 15-minute
403/429/503 cooldown, respecting longer Retry-After values. Failed supplements
are not retried on DOM mutations. HTTP-200 error envelopes do not establish
award unavailability.

Search identity comes from the hotel link; map identity from `.placeId`. Room
and rate identity come from `.roomDetailsRates` and `.rateBox`. Room-specific
rows never fall back to a different room. Search and map values may use the
lowest available room and disclose that in the tooltip.

Fixtures cover cash-first companion lookup, points-first search, native-both
responses, delayed currency, missing room inventory, currency isolation,
multi-night amounts, hover/focus tooltips, date changes, and rate-limit backoff.
Non-US properties and localized layouts have not received a live audit.
