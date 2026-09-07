# PointLens development guide

For features, supported hotels, and installation from a release, see the
[main README](../README.md).

The extension source lives in this directory. Use **Node 24 or newer** and npm.

## Run locally

```bash
cd pointlens
npm ci
npm run dev
```

Load `build/chrome-mv3-dev` through Chrome's **Load unpacked** option for development.

## Build for use

From `pointlens/`:

```bash
npm run build
```

Load `build/chrome-mv3-prod` as an unpacked extension. The source uses Plasmo,
React, and TypeScript; each hotel adapter and its popup live under `hotels/<brand>/`.

## Verify PointLens changes

From this directory, use Node 24 or newer:

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm run build
npm test
```

Load `build/chrome-mv3-prod` as an unpacked extension. Rebuild and reload the
extension after changes. Browser regression tests use controlled hotel fixtures
and the built extension; they do not send searches to hotel sites. Run the build
before `npm test` so the browser tests exercise current code.

For manual live inspection in a separate Chromium profile, start a Node session
from the repository root:

```js
const { launchQa } = require('./scripts/extension-qa.cjs')
const qa = await launchQa({ runName: 'manual-check' })
const page = await qa.context.newPage()
await page.goto('https://www.ihg.com/')
// Browse a small number of searches and hotel details manually.
await qa.save()
await qa.context.close()
```

The helper saves selected pricing responses under ignored `sessions/live-qa/`.
It does not export cookies or request headers. Responses can still contain
personalized prices; keep captures local. Close and relaunch the dedicated
context after rebuilding. Do not retry blocked sites repeatedly.

IHG search results support list, map and hotel preview values. Hotel overview,
room selection, room-details and rate-details views use the page's native
room offers, with no additional pricing requests. Room comparisons currently
require one room and match the room inventory code, stay dates and guest count.
Tooltips identify the cash plan, full-stay points, listed fixed award charges,
and the chosen tax basis. Normal award tooltips omit Points + Cash.

Direct `qPt=POINTS` room-page links work without a prior search or cash-page
visit. Badges show the opposite payment amount per night: cash on points
pages, points on cash pages. The native selected payment control takes precedence
over URL parameters. Full-stay totals and rate terms remain in the tooltip.
When the same room lacks a comparable opposite payment option, use the cheapest
available alternative at this hotel for the same dates and guests. Points pages
prefer room-only cash; if the whole hotel only has cash packages, use its cheapest
package and identify the extras. Cash pages retain the displayed cash plan and
use the cheapest full-points alternative when needed. Compact badges show only CPP and the opposite nightly payment amount, with a
separate info icon. Room tooltips use Cash/Points columns for base, charges,
total, and points with CPP. A short stay/eligibility line and, only when needed,
one alternative-room line sit below the table. Search tooltips retain their Lowest/Highest columns. Expanded cash plans and their details retain the selected cash
price. Exact room comparisons remain preferred when available. Room-selection pages have no separate
hotel-wide best-value banner; standalone property pages identify the comparison
through an explicit room selector. Recent stay comparisons
are kept briefly in the current tab so back navigation can restore them without
another pricing request.

Extra IHG comparison calls share a six-per-minute budget, a five-minute response
cache, duplicate-request suppression and a 15-second timeout. HTTP 429 pauses
them for at least 15 minutes and honors longer `Retry-After` values. Native hotel
requests are not blocked or retried by this budget.

See [the September audit](../findings/_meta/2026-09-06-qa.md) for live coverage,
remaining limitations and request findings.

## Choice Hotels

Choice supports cash/points search, map pins, sidebar cards and hotel previews, property room lists, exact room
rate plans, and room/rate details. Badges use the same compact CPP and opposite
payment amount, with a loading state and explicit unavailable awards. Choice has
its own popup settings, including tax basis and value thresholds.

The adapter reuses native GraphQL responses and direct-page pricing hydration.
Missing comparison rates use a batched, rate-limited supplement; it does not
request each hotel separately. See [Choice request findings](../findings/choicehotels-com/network.md)
for sources, fee treatment and live coverage.

## Best Western and Sonesta

Both integrations use the compact CPP / opposite-payment badge and shared
keyboard, hover, and click tooltip. Search results and map previews can use the
lowest available room; individual room/rate cards require an exact room match.
Missing award rooms show an unavailable state. Each brand has its own popup
settings for thresholds and tax basis.

Best Western reuses native search and daily room-rate responses, retaining early
responses until the property currency appears. It fills a missing search side
with one batch, or a missing room award plan with one lookup, using the shared
cross-tab request budget and cooldown. Missing taxes remain explicitly unknown.
Sonesta reuses native GraphQL availability without extra pricing requests. A
hotel tier alone never counts as award availability; an actual reward rate must
exist for the selected room and stay. Estimated award taxes and fees are shown
in the tooltip and deducted from cash savings.

See [Best Western findings](../findings/bestwestern-com/network.md) and
[Sonesta findings](../findings/sonesta-com/network.md) for live coverage and limits.
