import assert from "node:assert/strict"
import test from "node:test"

import {
  compareHilton,
  nightsBetween,
  number,
  parseHiltonHotel,
  parseHiltonSearch
} from "../hotels/hilton/pricing.ts"

const cash = (key, amount, total, extra = {}) => ({
  ratePlanCode: key,
  rateAmount: amount,
  fullAmountAfterTax: `$${total}`,
  ratePlan: { ratePlanName: key },
  ...extra
})
const award = (points, extra = {}) => ({
  ratePlanCode: "REWARD",
  totalCostPoints: points,
  ratePlan: { ratePlanName: "Premium Room Reward" },
  ...extra
})
const hotel = {
  ctyhocn: "CHITDHX",
  shopAvail: {
    currencyCode: "USD",
    roomTypes: [
      {
        roomTypeCode: "KING",
        roomTypeName: "King",
        roomOnlyRates: [
          cash("FLEX", 379, 901.26),
          cash("AP", 330, 784.74, {
            hhonorsDiscountRate: cash("MEMBER", 316.595, 752.86)
          })
        ],
        redemptionRoomRates: [award(140000)]
      },
      {
        roomTypeCode: "SUITE",
        roomTypeName: "Suite",
        packageRates: [cash("PACKAGE", 500, 1189)],
        redemptionRoomRates: []
      },
      {
        roomTypeCode: "AWARDONLY",
        roomTypeName: "Award only",
        redemptionRoomRates: [award(160000)]
      }
    ]
  }
}
test("Hilton uses unrounded stay totals, including member discounts and premium rewards", () => {
  const h = parseHiltonHotel(hotel, 2)
  const p = compareHilton(h, { room: "KING", mode: "points" })
  assert.equal(p.cashRate.key, "MEMBER")
  assert.equal(p.cashRate.base, 633.19)
  assert.equal(p.cash, 376.43)
  assert.equal(p.points, 70000)
  assert.ok(Math.abs(p.cpp - 0.537757142857) < 1e-10)
  assert.equal(
    compareHilton(h, { room: "KING", cashKey: "FLEX", mode: "cash" }).cash,
    450.63
  )
  assert.ok(
    Math.abs(
      compareHilton(h, { room: "KING", mode: "points", taxBasis: "pretax" })
        .cpp - 0.452278571429
    ) < 1e-10
  )
})
test("Hilton falls back to cheapest hotel cash or full-points room; package stays use same-room cash", () => {
  const h = parseHiltonHotel(hotel, 2)
  const a = compareHilton(h, { room: "AWARDONLY", mode: "points" })
  assert.equal(a.cashRate.key, "MEMBER")
  assert.equal(a.fallback, "Cash alternative: King")
  const s = compareHilton(h, {
    room: "SUITE",
    cashKey: "PACKAGE",
    mode: "cash"
  })
  assert.equal(s.awardRate.room, "KING")
  assert.equal(s.fallback, "Points alternative: King")
})
test("Hilton full-stay points override per-night averages and currencies require conversion", () => {
  const x = structuredClone(hotel)
  x.shopAvail.currencyCode = "EUR"
  x.shopAvail.roomTypes[0].redemptionRoomRates[0].pointDetails = [
    { pointsRate: 70000 }
  ]
  x.shopAvail.roomTypes[0].redemptionRoomRates[0].totalCostPoints = 280000
  const h = parseHiltonHotel(x, 5)
  assert.equal(compareHilton(h, { room: "KING" }).cpp, undefined)
  const c = compareHilton(h, { room: "KING", usdRate: 1.1 })
  assert.equal(c.awardRate.points, 280000)
  assert.ok(Math.abs(c.cpp - ((752.86 * 1.1) / 280000) * 100) < 1e-10)
  assert.equal(number("1.234,56 €", "de"), 1234.56)
  assert.equal(nightsBetween("bad", "date"), 0)
})
test("Hilton search retains native cash when points response has no cash anchor", () => {
  let h = parseHiltonSearch(
    {
      currencyCode: "USD",
      summary: { lowest: { rateAmount: 200, amountAfterTax: 1000 } }
    },
    4,
    false
  )
  h = parseHiltonSearch(
    {
      currencyCode: "USD",
      summary: { lowest: null, hhonors: { dailyRmPointsRate: 50000 } }
    },
    4,
    true,
    h
  )
  const c = compareHilton(h, { mode: "points" })
  assert.equal(c.cash, 250)
  assert.equal(c.cpp, 0.5)
  h = parseHiltonSearch(
    { currencyCode: "USD", summary: { lowest: null, hhonors: null } },
    4,
    true,
    h
  )
  assert.equal(compareHilton(h).cpp, undefined)
  assert.equal(compareHilton(h).points, undefined)
})

test("Hilton sums each night's actual award price instead of multiplying the first night", () => {
  const h = parseHiltonHotel(
    {
      shopAvail: {
        currencyCode: "USD",
        roomTypes: [
          {
            roomTypeCode: "K1T",
            roomTypeName: "Premium Room - 1 King Bed",
            moreRatesFromRate: {
              ratePlanCode: "HPPRP1",
              rateAmount: 520.39,
              fullAmountAfterTax: "$1,237.49"
            },
            redemptionRoomRates: [
              { pointDetails: [{ pointsRate: 161000 }, { pointsRate: 173000 }] }
            ]
          }
        ]
      }
    },
    2
  )
  const c = compareHilton(h, { room: "K1T", mode: "points" })
  assert.equal(c.awardRate.points, 334000)
  assert.equal(c.points, 167000)
  assert.equal(c.cpp.toFixed(2), "0.37")
  const search = parseHiltonSearch(
    {
      currencyCode: "USD",
      summary: {
        lowest: { rateAmount: 520.39, amountAfterTax: 1237.49 },
        hhonors: { dailyRmPointsRate: 161000, rateChangeIndicator: true }
      }
    },
    2,
    true
  )
  assert.equal(compareHilton(search).awardRate.pointsEstimated, true)
  assert.equal(compareHilton(h).awardRate.pointsEstimated, undefined)
})
