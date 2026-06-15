# Network — ihg-com

Captured 2026-06-12 (`sessions/ihg-com/20260612T043049Z`, ~11.5k requests, LA
area search). Session was **anonymous** (`members/v2/status` → `ANONYMOUS`,
no `X-IHG-SSO-TOKEN`).

**VALIDATED: logged-out points work.** Replaying an anonymous offers POST with
`rates.ratePlanCodes:[{internal:"IVANI"}]` (credentials:include, in-page) →
HTTP 200 with full award pricing: `rewardNightAvailable:true`,
`lowestPointsOnlyCost:62000`, `highestPointsOnlyCost:382000`,
`lowestPointsAndCashCost:{points:12000,cash:299}`, plus cash + fee/tax. So IHG
returns points to anonymous users; **`IVANI` alone is sufficient** (no need for
the extension's `IVAN1/3/5/6/7` — those are redundant/likely deprecated).
(The native captured responses lacked points only because their large bodies
weren't re-fetched by the monitor, not because points were absent.)

## Logged-in pricing = member discount (PROVEN 2026-06-12)

`sessions/ihg-com/20260612T143454Z` (logged in mid-session). Login state:
**`members/v2/status` → `EXPLICIT`** (was `ANONYMOUS`). Requests gain
`X-IHG-SSO-TOKEN`.

Controlled replay (same offers request, same hotels, with vs without the SSO
token, no cookies):

| Hotel | logged-in `points` | anon `points` | `originalPoints` |
|---|--:|--:|--:|
| NYCHC | 50,500 | 62,250 | 62,250 |
| NYCEA | 39,000 | 48,750 | 48,750 |
| NYCXV | 28,000 | 30,387 | 35,750 |
| NYCDD | 27,750 | 30,812 | 36,250 |

- **The `X-IHG-SSO-TOKEN` alone drives the discount** (header-authed gateway;
  cookies not needed). ~15–20% cheaper award nights for the member.
- `originalPoints`/`originalCash` = rack baseline (identical both ways);
  `points`/`cash` = the member's actual price. Same pattern on
  `lowestPointsAndCashCost` (`cash 147.51 < originalCash 149.0`).
- Member-exclusive rate plans appear logged-in (`IDMA2`, `IDME0` =
  "Exclusive savings for our IHG One Rewards members").
- "4th-night-free": NOT visible in search results. The `offers?fieldset=summary`
  response returns **per-night rate RANGES, not stay totals** — e.g. NYCHC over a
  4-night search returns `lowestPointsOnlyCost: 50,750` (a per-night figure,
  *lower* than the 1-night 58,000 because it's the cheapest night in the window).
  A 4th-night-free benefit is a full-STAY discount, so it can only appear in the
  per-rate-plan stay total — i.e. the `fieldset=rateDetails` call (fired when you
  open a specific hotel) or the booking flow. This session had **0 rateDetails
  calls** (no hotel was opened), so no stay totals were generated. To capture it:
  open an InterContinental's rate page for a 4-night points stay.
  Implication: the extension reads only `summary` (per-night), so it structurally
  cannot show 4th-night-free without adding a per-hotel `rateDetails` call.

### 4th-night-free — CONFIRMED (points only), lives in `rateDetails`

`POST offers?fieldset=rateDetails,rateDetails.policies,rateDetails.bonusRates,rateDetails.upsells,alternatePayments`
with a single `hotelMnemonics:["NYCHC"]`, `IVANI`, 4-night window, logged-in SSO.
Path: `hotels[].rateDetails.offers[ratePlanCode="IVANI"].rewardNights.pointsOnly`:

```
totalPoints:         203000   # member pays
originalTotalPoints: 267000   # without benefit  -> 64,000 saved
averageDailyPoints:  66750    # benefitAverageDailyPoints: 50750
daily: [ 58000, 73000, 72000, 0 ]   # 4th night = 0 pts (originalPoints 64000)
displayBenefitReason: "Every fourth Reward Night is free! This exclusive IHG
  One Rewards Credit Cardmember benefit has been applied to your stay."
```

- **Points-only** (matches user). The free night is the cheapest of the 4
  (here night 4 = 0). `rewardNights.pointsCash.options[]` holds the points+cash
  buy-up ladder (PCVR10…PCVR60) with per-night `daily` points.
- This data exists ONLY in `rateDetails` (per hotel, full stay) — NOT in the
  `summary` search results the extension currently reads.

### Extension implication (4th-night-free)

To surface it the extension must, per hotel of interest, issue a `rateDetails`
offers call and read `rewardNights.pointsOnly.{totalPoints, originalTotalPoints,
daily, displayBenefitReason}`. The riding-the-page model still works (the live
SSO token applies the cardmember benefit); it's a new call + parse, not a tweak.

### Extension impact

- The in-page replay (`content-main.ts`) preserves the live request headers
  incl. `X-IHG-SSO-TOKEN` and uses `credentials:"include"`, so **logged-in it
  already gets member pricing**. And `getPointsCostByPath` reads `points`
  first → it shows the discounted member price. ✓
- Gap: it ignores `originalPoints`/`originalCash`, so the **member savings are
  invisible**. Surfacing "28,000 (was 35,750)" is the concrete win.

## Fields the extension does NOT surface but the API returns

- `lowestPointsAndCashCost` / `highestPointsAndCashCost` — **points+cash
  hybrids** (e.g. 12,000 pts + $299). Extension reads only points-only and
  cash-only. Highest-value gap.
- `rewardNightAvailable` (bool) — explicit award-available marker; unused.
- `lowestCashOnlyCost.feeTaxSubTotals[]` — resort-fee/tax itemization for true
  all-in cash cost; extension uses `amountAfterTax` only.

## Auth (anonymous capture)

- `apis.ihg.com` calls use header auth: `x-ihg-api-key:
  <site-provided IHG application key>` + per-session `IHG-SessionId` (UUID).
  `X-CDC-API-KEY` / `X-IHG-SSO-TOKEN` only appear once logged in (Gigya).
- `identity.ihg.com` = Gigya/SAP CDC SDK (`gigya.js`, `sdk.config.get`) — login
  + token mint live here (not captured; anonymous).

## API surface (apis.ihg.com) — what the site actually calls

| Method | Path | In extension? | Purpose |
|---|---|---|---|
| POST | `graphql/v1/hotels` (`GetHotelDetails`) | **NO** | Destination → hotel list (search). The modern search API. |
| POST | `graphql/v1/hotels` (`getCallCenter`) | NO | Call-center number lookup (noise). |
| POST | `availability/v3/hotels/offers` | **partial** | Price hotels (cash + points). Extension uses this BUT only the `geoLocation`+radius body; site now also posts a **`hotelMnemonics:[...]` list** variant (prices the GraphQL search results). 9/15 bodies included `IVAN*` points rate plans. |
| GET | `availability/v3/hotels/offers/guestTypes/{code}` | NO | Guest types per hotel. |
| GET | `members/v2/status` | NO | Login/tier status (`ANONYMOUS` here; tier+balance when logged in). |
| GET | `rates/v2/categories` | NO | Rate-category definitions (map rate codes → names). |
| GET | `locations/v2/destinations` | NO | Destination autocomplete / geocode. |
| GET | `hotels/v3/profiles/{code}/details` | NO | Single-hotel profile. |
| GET | `finance/v1/currencies` | drift | Extension references `finance/conversions/v2/currencies` (different path). |
| GET | `domain/dc/marketingIndicators/v1/messages`, `channels/direct/*`, `cro/v1/callcenter`, `locations/v1/countries/US` | NO | Misc context. |

## The real flow (anonymous)

1. `GetHotelDetails` (GraphQL) — search a destination → list of `hotelMnemonic`s.
2. `availability/v3/hotels/offers` POST `{hotelMnemonics:[...], products, rates}` → cash + points per hotel. Points come from the **REST offers** call, NOT GraphQL (no points/reward signal in any GraphQL body).

## Offers response — richer than previously modeled

`lowestCashOnlyCost` now carries a full `feeTaxSubTotals[] → feeTaxGroups[] →
feeTaxDefIds[]` breakdown (resort fees vs taxes itemized). Points fields
(`lowestPointsOnlyCost` etc.) require login.

## Extension impact — does the new flow break it? NO

The extension is auth-agnostic (hooks the page's own `offers` call, swaps in
`IVAN*` rate plans, replays with `credentials:"include"`) so logged-out is a
fully supported mode, not a gap. The 2026-06 capture confirms it still works:

- The results call still uses `offers?fieldset=summary,summary.rateRanges` —
  exactly the URL `runBackgroundRequest` gates on (`background.ts:471`). ✓
- The page now sends a `hotelMnemonics:[...]` body instead of `geoLocation`,
  but `buildPointsBodyFromText` spreads `...parsed` and only overrides
  `rates.ratePlanCodes`, so the new shape passes through untouched. ✓

New, NOT yet used (optional enrichment, none required for in/out parity):

- A **second offers variant** `offers?fieldset=rateDetails,rateDetails.policies,
  rateDetails.bonusRates,rateDetails.upsells,alternatePayments` — detailed
  room-level rates (hit when you open a hotel). Extension's strict URL gate
  ignores it; would need its own handler if we want per-room award detail.
- GraphQL `GetHotelDetails` search + `members/v2/status` / `rates/v2/categories`
  — the extension piggybacks on the page's offers call, so it doesn't need the
  search API; these are only useful if we want the extension to *initiate*
  searches or label rate codes / show tier.

## Anti-bot stack (new awareness)

Forter (`cdn0/cdn3.forter.com`), Akamai bot-manager beacons
(`www.ihg.com/cdxtdd/...` 201 POSTs), AppDynamics RUM (`eum-appdynamics.com`),
Gigya bot path (`identity.ihg.com/JYtupz.../...`). The extension rides the live
page session so this mostly doesn't bite it, but out-of-band replay would.
