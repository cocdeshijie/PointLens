# hyatt-com — Working notes

Freeform scratchpad. Promote anything durable into the topical files.

---

## Session started: 2026-06-16

Target: https://www.hyatt.com — World of Hyatt loyalty program award availability
and CPP overlay. This is the 4th hotel target; the extension already ships
working implementations for Hilton, IHG, and Marriott.

### Goal

Replicate the Marriott/IHG pattern:
1. Identify the search API endpoint and parameter that forces award rates.
2. Intercept in `background.ts`, replay from page context with award params forced.
3. Parse per-hotel cash + points from the response.
4. Display CPP badges on list cards and map pins via ISOLATED content script.

### Prior art to reference

- **Marriott** (`pointlens/hotels/marriott/`) — closest analog. GraphQL POST,
  unconditional `rateRequestTypes` patch, ISOLATED content script with `pin-N`
  index matching for map pins, `MutationObserver` for dynamic updates.
- **IHG** (`pointlens/hotels/ihg/`) — simpler: REST, no MAIN-world injection
  needed, ISOLATED content script only.
- **Hilton** (`pointlens/hotels/hilton/`) — most complex: separate geo fetch
  for coordinates, MAIN-world `AdvancedMarkerElement` overlay.

### Open questions / first probe targets

1. Navigate to `https://www.hyatt.com/search/...` with a dated search.
2. Capture network traffic — identify the search endpoint and response shape.
3. Check whether award rates appear in the default response or require params.
4. Evaluate `Object.keys(window)` for map library globals.
5. Inspect DOM for hotel card selectors and property-code attributes.
6. Check map view for pin DOM structure and identity scheme.
