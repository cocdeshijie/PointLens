# hilton-com

- **URL:** https://www.hilton.com
- **Started:** 2026-06-12
- **Status:** active

## TL;DR

Hilton.com is a Next.js SSR hotel booking site with a Google Maps WebGL/vector
search map. All pricing goes through a single GraphQL endpoint
(`/graphql/customer`). The extension intercepts `shopMultiPropAvail` for
search-list CPP cards and injects its own `AdvancedMarkerElement` overlays on
the map using data replayed from `hotelQuadrants` + `hotelSummaryOptions`.
Hilton has no member award discount (unlike IHG) — points are identical for
anonymous and logged-in sessions.

## Entry points

- Search + map: `https://www.hilton.com/en/hotels/?[search params]`
- GraphQL API: `https://www.hilton.com/graphql/customer`

## Map

- [Recon](recon.md)
- [Network / APIs](network.md)
- [DOM / Frontend](dom.md)
- [Client JS](js.md)
- [Working notes](notes.md)

## Open questions

- What award/rate data does the Rooms/booking page expose? (premium tiers,
  points+cash hybrid — not yet captured.)
- Exact DOM selector for search-list rate card element the extension annotates.
