# marriott-com

- **URL:** https://www.marriott.com
- **Started:** 2026-06-14
- **Status:** active

## TL;DR

Marriott.com is a hotel booking site whose search results page fires a GraphQL
POST to a Phoenix endpoint (`phoenixShopDatedSearchByGeoQuery`). The extension
intercepts that request via `chrome.webRequest`, replays it from the page with
`rateRequestTypes` rewritten to include MRW and P17 clusters (forcing
reward/points rates into the response), and parses per-hotel cash + points from
the GraphQL edges to compute CPP.

Search-list CPP cards are shipped and working. The next goal is a map-view CPP
overlay, analogous to the completed Hilton one.

## Entry points

- Search results (list + map): `https://www.marriott.com/search/...`
- GraphQL endpoint: `https://www.marriott.com/mi/query/phoenixShopDatedSearchByGeoQuery`

## Map

- [Recon](recon.md)
- [Network / APIs](network.md)
- [DOM / Frontend](dom.md)
- [Client JS](js.md)
- [Working notes](notes.md)

## Open questions

- Does the `property` object in the `searchByGeolocation` response carry
  `latitude`/`longitude` coordinates?
- What map technology does Marriott use (Google Maps / Mapbox GL / custom)?
  Are map pins DOM elements or WebGL/canvas?
- Is the map fed by the same `phoenixShopDatedSearchByGeoQuery` or a separate
  endpoint?
