# Choice Hotels pricing integration

Validated in real Chrome on September 6, 2026: Chicago September 18–20, one
adult/room; city list, points search, map list, Cambria IL514 property overview,
cash and award room cards, and `/rates?roomCode=NK1` cash/award plans.

## Sources

Native POST `/dxapi/graphql?q=…` operations:

- `GetSearchResultsRatesWithRoomPolicy` and `GetHotelLowestRates`:
  `data.getHotelAvailabilityLowestRate`, with discounted default/member cash
  rates and `requestedRates` containing RACK and full-award SRD prices.
- `GetLowestRoomRates`: exact room codes and cheapest/requested room prices.
- `GetRoomRates`: room/rate plan pairs, including selected cancellation policies,
  member prices, packages, and SRD.
- Direct search hydration: JSON literal `window.PRELOADED_STATE`, specifically
  `searchResults.searchForm` and `hotels[].startingRates`. The top-level `search`
  object can contain stale dates on city search pages; do not use it there.

`amountBeforeTaxFees`, `amountAfterTaxFees`, and `points` are full-stay values.
`avgNightlyAmount` is the site's rounded-display basis, often including fees but
excluding taxes. CPP uses exact full-stay amounts, never the rounded DOM price.
SRD uses currency `XLY`; use the same hotel's cash currency, never treat XLY as
money. Cash packages that earn bonus points are cash rates, not redemptions.
Non-SRD mixed redemptions are excluded from full-award comparisons.

## Fee handling

SRD can return zero-dollar totals while the property still charges fixed fees.
Radisson Blu Aqua IL715 listed a $26 per-room/night urban fee. Subtract the
known $52 for this two-night award; indicate an estimate when fee tax is unknown.
Percentage fees are not applied to the retail cash room price of a redemption.
Cambria IL514 explicitly states that reward stays are exempt from its 1.5% CTID
charge. Unknown fee currency/frequency remains an estimate, with a short tooltip
note. Confirm final property charges when broadening fee handling.

## DOM and behavior

- List: `.search-result-list-view-card`, linked hotel code.
- Map: `#MapListItem-HOTELCODE`.
- Property/room summaries: `[aria-label="Pricing and Fees"]`.
- Exact room: `[data-track-id="ROOMCODE roomCard"]`.
- Rate rows: `.rate-card-price-box`, nested
  `#rates-room-card-book-room-ROOMCODE-RATECODE`.
- Room dialog: `.room-card-info-modal .room-details-container` and room title.
- Rate description: `.react-rate-full-description-modal-content`, originating
  room/rate selection.

Native price mode takes precedence over URL mode. Cash displays companion
points; award displays companion cash. Exact room codes never fall back to
another room. Hotel summaries compare lowest available cash/award prices.
Loading is a compact skeleton; absent awards and failed requests are distinct.
Sold-out cards have no PointLens comparison. Amount breakdowns use the shared
compact tooltip and selected tax-basis/CPP thresholds.

## Request policy

Reuse native combined cash/award responses. Supplement a missing side once per
fresh batch, after a 1.6-second grace period, using one batched search request or
one room request. Keep native prices; supplement only the missing side. Cache
complementary data for five minutes in the current context. Dates, guests and
qualified rate codes separate contexts; map/points/room-view changes reuse them.
A brand-wide budget serializes tabs, caps supplements at four per minute, spaces
them by 2.5 seconds, and backs off at least 15 minutes on 403/429/503, honoring
longer Retry-After. Native site traffic is not modified or retried.

Sanitized regression fixtures contain only public room/rate metadata and
prices. HARs, request headers, cookies and account state are not committed.

## Map pin follow-up

Price markers now show the native cash/points label plus a compact, value-colored
CPP/companion line. Choice uses Google Maps image markers with a separate
transparent button target; the overlay lives inside that target and follows
native pan, zoom, clustering and visibility. Pointer events remain on Choice's
marker, and its accessible name is preserved with a CPP description added.

Join the native marker's full hotel-name label to the uniquely named sidebar
card, not by price or result order. Duplicate names, sold-out markers, and
cluster counts are not annotated. Handle abbreviated award labels (`40K`) and
independent marker/sidebar updates during payment toggles. Reuse the already
rendered sidebar value, thresholds, FX and fee calculation; no map requests are
added. The `.map-flyout` selected-hotel preview also has a compact comparison.

Verified live in cash and points map modes and with selected hotel flyouts.
Browser regression checks cover pin clicks, loading, cash/points transitions,
settings changes, sold-out cleanup, and zero additional map pricing calls.

Map cards have an absolute full-card selection button that intercepts pointer
events over static content. Position the PointLens info button above that layer;
leave the rest of the card selectable. Cash and points browser regressions cover
real pointer hover, dismissal, click isolation, keyboard focus and Escape. Live
Chrome checks confirmed Cambria, Radisson and Sleep Inn show their own breakdowns.
