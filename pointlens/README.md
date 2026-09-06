This is a [Plasmo extension](https://docs.plasmo.com/) project bootstrapped with [`plasmo init`](https://www.npmjs.com/package/plasmo).

## Getting Started

First, run the development server:

```bash
pnpm dev
# or
npm run dev
```

Open your browser and load the appropriate development build. For example, if you are developing for the chrome browser, using manifest v3, use: `build/chrome-mv3-dev`.

You can start editing the popup by modifying `popup.tsx`. It should auto-update as you make changes. To add an options page, simply add a `options.tsx` file to the root of the project, with a react component default exported. Likewise to add a content page, add a `content.ts` file to the root of the project, importing some module and do some logic, then reload the extension on your browser.

For further guidance, [visit our Documentation](https://docs.plasmo.com/)

## Making production build

Run the following:

```bash
pnpm build
# or
npm run build
```

This should create a production bundle for your extension, ready to be zipped and published to the stores.

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

## Submit to the webstores

The easiest way to deploy your Plasmo extension is to use the built-in [bpp](https://bpp.browser.market) GitHub action. Prior to using this action however, make sure to build your extension and upload the first version to the store to establish the basic credentials. Then, simply follow [this setup instruction](https://docs.plasmo.com/framework/workflows/submit) and you should be on your way for automated submission!
