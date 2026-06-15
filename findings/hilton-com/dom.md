# DOM / Frontend — hilton-com

## Framework / meta-framework

- Next.js (SSR + client hydration). `__NEXT_DATA__` present on search/map pages.

## Routing

- Standard Next.js page routing; map and list are the same search page with
  different view-mode query params.

## Hydration data

### `__NEXT_DATA__` (script#__NEXT_DATA__)

Contains SSR search results at a deep path (~depth 9):

```
props.pageProps.dehydratedState.queries[N].state.data
  .geocode.hotelSummaryOptions.hotels[]
```

Each hotel entry carries `ctyhocn`, `name`, coordinates, and `leadRate`
(~20 hotels for the initial viewport). Used by the extension's map overlay to
seed initial CPP badges before any fetch-hook replay fires.

**`leadRate` shape in `__NEXT_DATA__` differs from live fetch:**
- NO `lowest` key — cash is at `leadRate.hhonors.min.rateAmount` /
  `.max.rateAmount`.
- Points: `leadRate.hhonors.lead.dailyRmPointsRate` (same as live).

A tree-walk must go at least 9 levels deep to reach this data; shallow walks
miss it. See [network.md](network.md) for the two-shape `leadRate` detail and
CPP formula.

## Important selectors

- `script#__NEXT_DATA__` — SSR payload (parse as JSON).
- `.gm-style` — Google Maps container elements (~8 on page; the large search
  map is the first one with `offsetWidth > 250`).
- Extension badge elements are `google.maps.marker.AdvancedMarkerElement`
  content divs injected into the map's overlay pane — no stable CSS selector;
  owned entirely by the extension.

## Component structure

- Search result list cards — extension annotates with `¢/pt ($NNN)` strings
  appended to the rate display.
- Map pins — Hilton's own cash pins are WebGL/canvas; extension overlays its
  own pill badges via AdvancedMarkerElement (see [js.md](js.md)).

## Open questions

- Exact DOM path for the rate card element the extension annotates in the
  search list (selector not captured yet — rely on text/node insertion logic
  in content.ts).
