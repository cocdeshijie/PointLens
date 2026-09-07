# Sonesta pricing integration

Live Chrome audit: September 6, 2026. Chicago, September 18–20, one room,
one adult. Checked search, Leaflet map pins, hotel cards, direct room entry,
room selection, cash rate cards, rate details, and stay-total breakdown.

## Native source

`POST https://gapi.sonesta.com/guest/graphql`, operation
`getHotelAvailability`, returns `data.hotelAvailablity.queryHotel` (the spelling
is native). `variables.input` supplies dates, guests, room quantity, property,
and rate filters. The site already requests each search hotel's availability;
PointLens adds **zero pricing requests**.

`rooms[].roomRates[]` supplies room/rate codes, unrounded full-stay `subTotal`,
`total`, taxes, fees, currency and `isRedemptionRate`. Native award inventory
is present even while signed out. Require that exact room's redemption rate
and its hotel `redemptionItem.currencyRequired` before displaying points.
Multiply the latter by nights; a tier by itself never establishes availability.
The native redemption UI restricts booking to one room.

An award's `roomRate`/`subTotal` is an internal USD rate, **not points and not a
cash copay**. Its separate taxes and fees are conservatively deducted as
estimated award cash charges, with an approximation marker and tooltip row.
The response's reward-rate description excludes taxes and fees from redemption;
[Travel Pass terms §6.6](https://www.sonesta.com/travel-pass/terms-conditions)
also places applicable taxes on the member. A signed-in award checkout has not
yet been verified live, so these charges remain explicitly estimated.

Royal Sonesta Chicago Downtown (10054): D2QNC had the reward rate; the other
six displayed non-accessible cash rooms did not. Native TPMEMAP total $1,337.63,
60,000 stay points and estimated award taxes/fees $111.28 produce ≈2.04¢/pt.
Other cash plans compare their own full totals, not the cheapest plan's total.

## UI and validation

Property rooms use native `data-room`; rate cards use `rate-total-<code>-offer-*`.
The checkout summary identifies the selected room by its unique exact name.
Search cards and pins use the native hotel name and require a unique match;
unknown or ambiguous identities are never assigned another hotel's prices.
Leaflet pin labels preserve the native cash price and logo, adding compact CPP.
The full comparison remains in hotel cards and previews with the shared tooltip.

Sonesta creates a new Leaflet `divIcon` from rendered HTML during rate loads and
selection, replacing injected marker children. The normal 100 ms content-update
delay left blank frames and briefly shrank the boxes. Map mutations now restore
the comparison before paint; logo space and selection borders keep dimensions
stable. Browser coverage samples frames across repeated native-style marker
rebuilds and checks that a reused marker cannot retain another hotel's CPP.

Fixtures cover reward and cash rate rows, zero extra calls, missing award rooms,
tier-only inventory rejection, multi-room restrictions, full-stay totals, map
identity, and tooltips. Signed-in award checkout and non-US properties remain
live-verification limits. No account credentials or auth responses are stored.
