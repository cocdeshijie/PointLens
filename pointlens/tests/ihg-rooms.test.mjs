import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { createIhgRequestBudget } from "../hotels/ihg/request-budget.ts"
import { compareIhgRoom } from "../hotels/ihg/room-comparison.ts"
import { matchesRoomStay, parseRoomRates } from "../hotels/ihg/room-rates.ts"

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/ihg-rooms.json", import.meta.url))
)
const parse = (f) =>
  parseRoomRates(JSON.stringify(f.request), JSON.stringify(f.response))
test("direct IHG points rooms retain a labeled package fallback when no room-only cash exists", () => {
  const direct = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/ihg-direct-points.json", import.meta.url)
    )
  )
  const result = parse(direct)
  const classic = result.rooms.find((r) => r.code === "KAJN")
  assert.equal(classic.points, 60000)
  assert.equal(classic.cash, 487.1)
  assert.equal(classic.packageComparison, true)
  assert.equal(classic.awardFees, 35)
  const premium = result.rooms.find((r) => r.code === "CDXG")
  assert.equal(premium.packageComparison, false)
  assert.equal(premium.cash, 340.87)
  const comparison = compareIhgRoom(classic, result, true, "aftertax")
  assert.equal(comparison.cash, 340.87)
  assert.equal(comparison.points, 60000)
  assert.equal(comparison.awardFees, 35)
  assert.equal(comparison.cashRoom, premium.name)
  assert.equal(comparison.awardRoom, classic.name)
  assert.equal(comparison.hotelFallback, true)
  assert.equal(comparison.packageComparison, false)
  assert.equal(classic.cash, 487.1) // never mutate captured inventory
  assert.equal(
    matchesRoomStay(
      result,
      "https://www.ihg.com/hotels/us/en/find-hotels/select-roomrate?qPt=POINTS&qSlH=ORDHA&qCiD=9&qCoD=10&qCiMy=082026&qCoMy=082026&qAdlt=1&qChld=0&qRms=1"
    ),
    true
  )
})
test("IHG fallback preserves the displayed cash and uses the cheapest award's fees", () => {
  const result = parse(fixture)
  const [cashRoom, awardRoom] = result.rooms
  const unavailable = { ...cashRoom, points: undefined, awardFees: 999 }
  const comparison = compareIhgRoom(unavailable, result, false, "aftertax")
  assert.equal(comparison.cash, cashRoom.cash)
  assert.equal(comparison.points, awardRoom.points)
  assert.equal(comparison.awardFees, awardRoom.awardFees)
  assert.equal(comparison.awardRoom, awardRoom.name)
  assert.equal(comparison.hotelFallback, true)
  assert.equal(compareIhgRoom(cashRoom, result, false, "aftertax"), cashRoom)
  const incompatible = { ...result, rooms: [{ ...awardRoom, currency: "EUR" }] }
  assert.equal(
    compareIhgRoom(unavailable, incompatible, false, "aftertax"),
    unavailable
  )
})
test("IHG cash fallback respects tax basis, room-only preference and hotel-wide unavailability", () => {
  const result = parse(fixture)
  const room = {
    ...result.rooms[0],
    cash: undefined,
    cashPretax: undefined,
    cashRates: []
  }
  const alternative = {
    ...result.rooms[1],
    cashRates: [
      { cash: 300, cashPretax: 220, cashPlan: "A" },
      { cash: 310, cashPretax: 200, cashPlan: "B" },
      {
        cash: 100,
        cashPretax: 80,
        cashPlan: "Package",
        packageComparison: true
      }
    ]
  }
  const hotel = { ...result, rooms: [room, alternative] }
  assert.equal(compareIhgRoom(room, hotel, true, "aftertax").cashPlan, "A")
  assert.equal(compareIhgRoom(room, hotel, true, "pretax").cashPlan, "B")
  alternative.cashRates = alternative.cashRates.filter(
    (r) => r.packageComparison
  )
  assert.equal(compareIhgRoom(room, hotel, true, "aftertax").cash, 100)
  alternative.cashRates = []
  assert.equal(compareIhgRoom(room, hotel, true, "aftertax"), room)
})
test("IHG rooms match inventory, use stay points, and exclude reimbursement and package prices", () => {
  const result = parse(fixture)
  const room = result.rooms.find((r) => r.code === "KSUG")
  assert.equal(room.points, 453000)
  assert.equal(room.cash, 2573.06)
  assert.equal(room.cashPlan, "IHG1R STAY LONGER & SAVE")
  assert.equal(room.refundable, false)
  assert.equal(room.awardFees, 140)
  assert.equal(room.awardFeesPretax, 119.24)
  assert.equal(room.nights, 4)
  assert.equal(result.adults, 1)
  assert.equal(result.children, 0)
  const f = structuredClone(fixture)
  f.response.hotels[0].rateDetails.offers.find(
    (o) => o.ratePlanCode === "IKME6"
  ).totalRate.amountAfterTax = "1"
  assert.equal(parse(f).rooms.find((r) => r.code === "KSUG").cash, 2573.06)
  const award = f.response.hotels[0].rateDetails.offers.find(
    (o) =>
      o.ratePlanCode === "IVANI" &&
      o.productUses[0].inventoryTypeCode === "KSUG"
  )
  award.rewardNights.pointsOnly.totalPoints = 340000
  assert.equal(parse(f).rooms.find((r) => r.code === "KSUG").points, 340000)
  f.request.products[0].quantity = 2
  assert.equal(parse(f), null)
})

test("IHG room snapshots cannot leak to another hotel or dates", () => {
  const result = parse(fixture)
  const url =
    "https://www.ihg.com/hotels/us/en/find-hotels/select-roomrate?qSlH=ORDHA&qCiD=12&qCoD=16&qCiMy=092026&qCoMy=092026"
  assert.equal(matchesRoomStay(result, url), true)
  assert.equal(matchesRoomStay(result, url + "&qAdlt=2"), false)
  assert.equal(matchesRoomStay(result, url + "&qRms=2"), false)
  assert.equal(matchesRoomStay(result, url.replace("ORDHA", "CHIMM")), false)
  assert.equal(
    matchesRoomStay(result, url.replace("qCoD=16", "qCoD=17")),
    false
  )
  assert.equal(
    matchesRoomStay(
      result,
      "https://www.ihg.com/hotels/us/en/chicago/ordha/hoteldetail"
    ),
    false
  )
})

test("IHG request budget deduplicates and caches; 429 stops requests across keys and honors Retry-After", async () => {
  let time = 1_000_000,
    calls = 0,
    limited = false,
    saved = 0
  const budget = createIhgRequestBudget({
    now: () => time,
    saveCooldown: async (v) => {
      saved = v
    },
    fetch: async () => {
      calls++
      return limited
        ? new Response("slow down", {
            status: 429,
            headers: { "retry-after": "3600" }
          })
        : new Response('{"ok":true}')
    }
  })
  const [a, b] = await Promise.all([
    budget.request("https://apis.ihg.com/a", { body: "one" }),
    budget.request("https://apis.ihg.com/a", { body: "one" })
  ])
  assert.equal(await a.text(), await b.text())
  await budget.request("https://apis.ihg.com/a", { body: "one" })
  assert.equal(calls, 1)
  limited = true
  assert.equal(
    (await budget.request("https://apis.ihg.com/a", { body: "two" })).status,
    429
  )
  await assert.rejects(budget.request("https://apis.ihg.com/b", {}), /paused/)
  assert.equal(calls, 2)
  assert.equal(saved, time + 3_600_000)
  time += 16 * 60_000
  await assert.rejects(budget.request("https://apis.ihg.com/b", {}), /paused/)
})
