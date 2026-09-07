import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  awardFees,
  choiceContext,
  parseChoice
} from "../hotels/choice/pricing.ts"

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/choice-${name}.json`, import.meta.url))
  )
const search = await load("search"),
  rooms = await load("rooms"),
  lowest = await load("lowest")
const page =
  "https://www.choicehotels.com/illinois/chicago/cambria-hotels/il514?checkInDate=2026-09-18&checkOutDate=2026-09-20"
const vars = { ratePlanCodes: ["RACK", "SRD"] }
test("Choice full-stay cash/award values retain exact cents and subtract fixed property fees", () => {
  const s = parseChoice(search, page.replace("cambria-hotels/il514", "hotels"), vars)
  const cash = s.offers.find((o) => o.hotel === "IL715" && o.rate === "SMFLXM"),
    points = s.offers.find((o) => o.hotel === "IL715" && o.points)
  assert.equal(cash.total, 1215.22)
  assert.equal(points.points, 100000)
  assert.equal(points.copay, 52)
  assert.equal(points.currency, "USD")
  assert.equal(
    (((cash.total - points.copay) / points.points) * 100).toFixed(2),
    "1.16"
  )
  assert.equal(s.hotels.IL715.points, "ready")
})
test("Choice room codes, discounted rates and different award tiers remain distinct", () => {
  const s = parseChoice(lowest, page, vars)
  assert.equal(
    s.offers.find((o) => o.room === "NQQ1" && o.points).points,
    96000
  )
  assert.equal(s.offers.find((o) => o.room === "NK" && o.points).points, 80000)
  assert.equal(
    s.offers.find((o) => o.room === "NQQ1" && o.rate === "S10M2M").total,
    1055.23
  )
  const detailed = parseChoice(rooms, page, vars)
  assert.equal(
    detailed.offers.find((o) => o.room === "NK" && o.rate === "SCPM").total,
    1081.83
  )
  assert.ok(detailed.offers.find((o) => o.rate === "PKPR1" && !o.points))
})
test("Choice distinguishes missing awards from pending, excludes mixed and sold-out rates", () => {
  const d = structuredClone(rooms),
    item = d.data.getHotelAvailabilityRoomRates
  for (const row of item.roomRates)
    row.value = row.value.filter((r) => r.key !== "SRD")
  assert.equal(
    parseChoice(d, page, { ratePlanCodes: ["RACK"] }).hotels.IL514.points,
    "pending"
  )
  const s = parseChoice(d, page, vars)
  assert.equal(s.hotels.IL514.points, "ready")
  assert.ok(!s.offers.some((o) => o.points))
  const rate = item.roomRates[0].value[0].value.defaultRate
  rate.ratePlanCode = "PPC"
  rate.points = 16000
  rate.amountAfterTaxFees = 100
  assert.ok(!parseChoice(d, page, vars).offers.some((o) => o.rate === "PPC"))
  rate.ratePlanCode = "RACK"
  rate.points = 0
  rate.availabilityStatus = "UNAVAILABLE"
  assert.ok(
    !parseChoice(d, page, vars).offers.some((o) => o.id === "IL514:NK:RACK")
  )
})
test("Choice rejects stale dates and reuses view toggles without mixing guests or discounts", () => {
  assert.equal(
    parseChoice(rooms, page.replace("2026-09-20", "2026-09-21"), vars),
    undefined
  )
  assert.equal(
    choiceContext(page),
    choiceContext(page + "&ratePlanCode=SRD&roomCode=NK&view=Map")
  )
  assert.notEqual(choiceContext(page), choiceContext(page + "&adults=2"))
  assert.notEqual(
    choiceContext(page),
    choiceContext(page + "&ratePlanCode=AAA")
  )
  assert.equal(
    awardFees(
      {
        startDate: "2026-09-18",
        endDate: "2026-09-20",
        fees: [
          {
            amount: 10,
            currencyCode: "USD",
            frequency: "PER_ROOM_PER_NIGHT",
            startDate: "2026-09-19",
            endDate: "2026-09-20"
          }
        ]
      },
      "USD"
    ).total,
    10
  )
})
