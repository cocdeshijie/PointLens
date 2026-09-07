import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  complementUrl,
  parseWyndham,
  ROOMS_ENDPOINT,
  SEARCH_ENDPOINT,
  stayNights,
  wyndhamContext
} from "../hotels/wyndham/pricing.ts"

const search = JSON.parse(
  await readFile(new URL("./fixtures/wyndham-search.json", import.meta.url))
)
const rooms = JSON.parse(
  await readFile(new URL("./fixtures/wyndham-rooms.json", import.meta.url))
)
const query =
  "?checkin_date=09-18-2026&checkout_date=09-20-2026&adults=1&children=0&rooms=1&useWRPoints=true"
const page =
  "https://www.wyndhamhotels.com/hotels/chicago?checkInDate=9%2F18%2F2026&checkOutDate=9%2F20%2F2026&adults=1&rooms=1"
const url = (path) => "https://www.wyndhamhotels.com" + path + query

test("Wyndham search uses nightly cash and full-stay award totals, excluding mixed rates", () => {
  const s = parseWyndham(search, url(SEARCH_ENDPOINT), page)
  assert.equal(s.offers.length, 4)
  const cash = s.offers.find((o) => o.id === "52843:cash")
  const award = s.offers.find((o) => o.id === "52843:points")
  assert.equal(cash.base, 898.2)
  assert.equal(cash.total, 1103.16)
  assert.equal(award.points, 60000)
  assert.equal((cash.total / award.points) * 100, 1.8386000000000002)
  assert.deepEqual(s.hotels["52843"], { cash: "ready", points: "ready" })
  const pointsOnly = parseWyndham(
    search,
    url(SEARCH_ENDPOINT) + "&rateTypeFilter=loyalty",
    page
  )
  assert.ok(pointsOnly.offers.every((o) => o.points))
  assert.equal(pointsOnly.hotels["52843"].cash, "pending")
})

test("Wyndham rooms retain exact room/rate codes, full totals and unavailable award rooms", () => {
  const s = parseWyndham(rooms, url(ROOMS_ENDPOINT) + "&propertyId=52843", page)
  const king = s.offers.filter((o) => o.room === "NK1")
  assert.equal(king.find((o) => o.rate === "SRB").points, 60000)
  assert.equal(king.find((o) => o.rate === "SWR1").total, 1081.82)
  assert.equal(
    s.offers.some((o) => o.room === "NK2" && o.points),
    false
  )
  assert.ok(s.offers.some((o) => o.room === "NK2" && o.base))
  assert.equal(
    s.offers.some((o) => /SRB[78]/.test(o.rate)),
    false
  )
  assert.equal(s.hotels["52843"].points, "ready")
  const empty = parseWyndham(
    { status: "OK", roomsAndRates: { rooms: [] } },
    url(ROOMS_ENDPOINT) + "&propertyId=52843",
    page
  )
  assert.equal(empty.offers.length, 0)
  assert.equal(empty.hotels["52843"].points, "ready")
})

test("Wyndham missing and malformed amounts never become false zero-priced awards", () => {
  const bad = structuredClone(rooms)
  bad.roomsAndRates.rooms[0].rates = [
    {
      ratePlanId: "SRB",
      currencyCode: "USD",
      fnsRatePlan: true,
      totalFnsPoints: 60000,
      totalAfterTax: null
    },
    {
      ratePlanId: "RROD",
      currencyCode: "USD",
      totalBeforeTax: -1,
      totalAfterTax: -1
    }
  ]
  bad.roomsAndRates.rooms = bad.roomsAndRates.rooms.slice(0, 1)
  assert.equal(parseWyndham(bad, url(ROOMS_ENDPOINT), page).offers.length, 0)
  assert.equal(
    parseWyndham({ status: "ERROR" }, url(SEARCH_ENDPOINT), page),
    undefined
  )
  assert.equal(
    parseWyndham({ status: "OK" }, url(SEARCH_ENDPOINT), page),
    undefined
  )
})

test("Wyndham separates date/guest contexts while reusing cash and points toggles", () => {
  assert.equal(stayNights(url(SEARCH_ENDPOINT)), 2)
  assert.equal(
    wyndhamContext(page),
    wyndhamContext(page + "&useWRPoints=true&sessionId=1")
  )
  assert.notEqual(
    wyndhamContext(page),
    wyndhamContext(page.replace("adults=1", "adults=2"))
  )
  assert.notEqual(
    wyndhamContext(page),
    wyndhamContext(page.replace("9%2F20", "9%2F21"))
  )
  const opposite = new URL(
    complementUrl(
      url(SEARCH_ENDPOINT) + "&rateTypeFilter=price&corporate_id=TEST"
    )
  )
  assert.equal(opposite.searchParams.get("corporate_id"), "TEST")
  assert.equal(opposite.searchParams.get("useWRPoints"), "true")
  assert.equal(opposite.searchParams.has("rateTypeFilter"), false)
})
