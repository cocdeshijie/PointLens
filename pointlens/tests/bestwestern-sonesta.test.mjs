import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  bestwesternRequest,
  parseBestwestern
} from "../hotels/bestwestern/pricing.ts"
import { parseSonesta, sonestaRequest } from "../hotels/sonesta/pricing.ts"

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/${name}.json`, import.meta.url))
  )
const cash = await load("bestwestern-rooms-cash"),
  award = await load("bestwestern-rooms-points"),
  sonesta = await load("sonesta-rooms")
const bwUrl = (op, rate = "") =>
  `https://www.bestwestern.com/bin/bestwestern/proxy?gwServiceURL=${op}&checkinDate=2026-09-18&checkoutDate=2026-09-20&hotelid=15108&numAdult=1&numChild=0&numberOfRooms=1&occupant=numAdults:1,numChild:0${rate}`
const input = {
  crsHotelCode: "10054",
  start: "2026-09-18",
  end: "2026-09-20",
  adults: 1,
  children: 0,
  childrenAges: [],
  quantity: 1,
  ratePlanCode: "",
  promotionCode: "",
  ratePlanFilterCode: "Retail"
}
const body = (changes = {}) =>
  JSON.stringify({
    operationName: "getHotelAvailability",
    variables: { input: { ...input, ...changes } }
  })

test("Best Western search averages and daily room prices agree for a multi-night stay", async () => {
  const searchCash = parseBestwestern(
    await load("bestwestern-search-cash"),
    bwUrl("HOTEL_SEARCH")
  )
  const searchPoints = parseBestwestern(
    await load("bestwestern-search-points"),
    bwUrl("HOTEL_SEARCH", "&ratePlan=BWR")
  )
  assert.equal(searchCash.offers.find((o) => o.hotel === "15108").base, 394)
  assert.equal(
    searchPoints.offers.find((o) => o.hotel === "15108").points,
    72000
  )
  const rates = parseBestwestern(
    cash,
    bwUrl("ROOM_RATE_PLAN", "&rateplan=2UB"),
    "USD"
  )
  assert.equal(rates.offers[0].base, 394)
  assert.equal(rates.offers[0].total, undefined)
  assert.equal(
    parseBestwestern(award, bwUrl("ROOM_RATE_PLAN", "&rateplan=FX"), "USD")
      .offers[0].points,
    72000
  )
})
test("Best Western rejects partial nights, unavailable rooms and ambiguous currencies", () => {
  const data = structuredClone(cash)
  delete data.roomDetailsList[0].dailyPriceMap["2026-09-19"]
  data.roomDetailsList[1].inventory = false
  assert.equal(
    parseBestwestern(data, bwUrl("ROOM_RATE_PLAN", "&rateplan=2UB"), "CAD")
      .offers.length,
    0
  )
  assert.equal(
    parseBestwestern(cash, bwUrl("ROOM_RATE_PLAN", "&rateplan=2UB")),
    undefined
  )
  assert.equal(
    parseBestwestern(cash, bwUrl("ROOM_RATE_PLAN", "&rateplan=FX2"), "CAD")
      .offers[0].points,
    undefined
  )
  assert.equal(
    parseBestwestern(cash, bwUrl("ROOM_RATE_PLAN", "&rateplan=2UB"), "CAD")
      .offers[0].currency,
    "CAD"
  )
  assert.equal(
    parseBestwestern(
      { errorCode: "ERR.001" },
      bwUrl("ROOM_RATE_PLAN", "&rateplan=FX"),
      "USD"
    ),
    undefined
  )
})
test("Best Western contexts isolate occupancy, dates and destinations", () => {
  const url = bwUrl("HOTEL_SEARCH")
  assert.equal(
    bestwesternRequest(url).context,
    bestwesternRequest(url + "&ratePlan=BWR").context
  )
  assert.notEqual(
    bestwesternRequest(url).context,
    bestwesternRequest(url.replace("numAdults:1", "numAdults:2")).context
  )
  assert.notEqual(
    bestwesternRequest(url).context,
    bestwesternRequest(url + "&latitude=20").context
  )
})
test("Sonesta uses exact reward inventory and tier points, never internal USD reimbursement", () => {
  const snapshot = parseSonesta(sonesta, body())
  const award = snapshot.offers.find((o) => o.points),
    cash = snapshot.offers.find(
      (o) => o.room === "D2QNC" && o.rate === "TPMEMAP"
    )
  assert.equal(award.points, 60000)
  assert.equal(award.copay, 111.28)
  assert.equal(cash.total, 1337.63)
  assert.equal(
    (((cash.total - award.copay) / award.points) * 100).toFixed(2),
    "2.04"
  )
  assert.ok(!snapshot.offers.some((o) => o.room === "P2QNC" && o.points))
  assert.equal(snapshot.hotels["10054"].points, true)
})
test("Sonesta never invents availability from a tier or multi-room cash inventory", () => {
  const data = structuredClone(sonesta)
  data.data.hotelAvailablity.queryHotel.rooms[0].roomRates =
    data.data.hotelAvailablity.queryHotel.rooms[0].roomRates.filter(
      (r) => !r.isRedemptionRate
    )
  assert.ok(!parseSonesta(data, body()).offers.some((o) => o.points))
  assert.ok(
    !parseSonesta(sonesta, body({ quantity: 2 })).offers.some((o) => o.points)
  )
  assert.equal(
    parseSonesta(sonesta, body({ crsHotelCode: "different" })),
    undefined
  )
  assert.notEqual(
    sonestaRequest(body()).context,
    sonestaRequest(body({ adults: 2 })).context
  )
})
