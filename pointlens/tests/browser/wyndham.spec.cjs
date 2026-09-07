const { test, expect, chromium } = require("@playwright/test")
const path = require("node:path")
const rooms = require("../fixtures/wyndham-rooms.json")
const search = require("../fixtures/wyndham-search.json")
const origin = "https://www.wyndhamhotels.com"
const dates =
  "checkin_date=09-18-2026&checkout_date=09-20-2026&adults=1&children=0&rooms=1"
const roomRequest =
  "/BWSServices/services/hotels/availability/getRoomsAndRates?" +
  dates +
  "&propertyId=52843&useWRPoints=true"
const searchRequest =
  "/BWSServices/services/hotels/property-availability?" +
  dates +
  "&properties=LQ52843,TL10073"
const pageQuery =
  "?checkInDate=9%2F18%2F2026&checkOutDate=9%2F20%2F2026&adults=1&rooms=1"
let context, worker
const shell = (body) => `<html><head></head><body>${body}</body></html>`
const card = (room, rate, points = false) =>
  `<div class="room" room="${room}"><div class="room-detail-text"><h2>${room}</h2></div><div class="from-rate"></div><ul><li class="rate ${points ? "points-rate" : "cash-rate"}" rate="${rate}"><div class="room-rate">${points ? "30,000 points" : "$440/night"}</div></li></ul></div>`
const hotel = (id) =>
  `<div class="prop-summary-wrapper" id="${id}"><div class="hotel-rate"><div class="average-rate">Hotel ${id}</div></div></div>`
test.beforeAll(async () => {
  const extension = path.resolve("build/chrome-mv3-prod")
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`
    ]
  })
  worker =
    context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"))
  await context.route("https://**/*", (r) =>
    r.fulfill({ contentType: "text/html", body: shell("Fixture") })
  )
})
test.beforeEach(async () =>
  worker.evaluate(() => chrome.storage.session.clear())
)
test.afterAll(async () => context?.close())

test("Wyndham direct cash rooms show loading, exact awards, and unavailable rooms without extra calls", async () => {
  const p = await context.newPage()
  const errors = []
  p.on("pageerror", (error) => errors.push(error.message))
  let calls = 0
  await p.route(origin + "/**", (r) => {
    if (r.request().url().includes("getRoomsAndRates")) {
      calls++
      return r.fulfill({ json: rooms })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(card("NK1", "SWR1") + card("NK2", "SWR1"))
    })
  })
  await p.goto(origin + "/laquinta/test/rooms-rates" + pageQuery)
  await expect(
    p.locator(".pointlens-wyndham-status[aria-busy=true]").first()
  ).toBeVisible()
  await p.evaluate((url) => fetch(url), roomRequest)
  await expect(p.locator("[room=NK1] li .pointlens-room-pill")).toHaveText(
    "1.80¢/pt · 30,000 pts"
  )
  await expect(p.locator("[room=NK2] li .pointlens-wyndham-status")).toHaveText(
    "Points unavailable"
  )
  await p.locator("[room=NK1] li .pointlens-room-comparison button").focus()
  await expect(p.locator("#pointlens-value-details")).toContainText("$540.91")
  expect(calls).toBe(1)
  // Wyndham custom elements can expose a numeric id property. Observe the
  // actual attribute instead, including when such nodes are inserted/removed.
  await p.evaluate(() => {
    customElements.define(
      "numeric-property",
      class extends HTMLElement {
        get id() {
          return 52843
        }
      }
    )
    document.body.append(document.createElement("numeric-property"))
  })
  await p.waitForTimeout(150)
  expect(errors).toEqual([])
  // Changing dates clears every stale price immediately.
  await p.evaluate(() => {
    history.pushState({}, "", location.href.replace("9%2F20", "9%2F21"))
    document.dispatchEvent(new Event("change"))
  })
  await expect(p.locator(".pointlens-room-pill")).toHaveCount(0)
  await p.close()
})

test("Wyndham direct points rooms show same-room cash and settings update without network calls", async () => {
  const p = await context.newPage()
  let calls = 0
  await p.route(origin + "/**", (r) => {
    if (r.request().url().includes("getRoomsAndRates")) {
      calls++
      return r.fulfill({ json: rooms })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(card("NK1", "SRB", true) + card("NK2", "SRB7", true))
    })
  })
  await p.goto(
    origin + "/laquinta/test/rooms-rates" + pageQuery + "&useWRPoints=true"
  )
  await p.evaluate((url) => fetch(url), roomRequest)
  await expect(p.locator("[room=NK1] li .pointlens-room-pill")).toHaveText(
    "1.80¢/pt · $540.91"
  )
  await expect(
    p.locator("[room=NK2] .room-detail-text .pointlens-wyndham-status")
  ).toHaveText("Points unavailable")
  await worker.evaluate(() =>
    chrome.storage.local.set({
      "pointlens:wyndham-value-settings": { taxBasis: "pretax" }
    })
  )
  await expect(p.locator("[room=NK1] li .pointlens-room-pill")).toHaveText(
    "1.47¢/pt · $440.12"
  )
  expect(calls).toBe(1)
  await worker.evaluate(() =>
    chrome.storage.local.remove("pointlens:wyndham-value-settings")
  )
  await p.close()
})

for (const points of [false, true])
  test(`Wyndham direct ${points ? "points" : "cash"} search batches its companion lookup and covers inserted cards`, async () => {
    const p = await context.newPage()
    let calls = 0
    await p.route(origin + "/**", async (r) => {
      if (r.request().url().includes("property-availability")) {
        calls++
        if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 150))
        const data = structuredClone(search)
        if (
          new URL(r.request().url()).searchParams.get("rateTypeFilter") ===
          "loyalty"
        )
          for (const group of Object.values(data.availability))
            for (const hotel of group.availability) hotel.rate.currencyCode = ""
        return r.fulfill({ json: data })
      }
      return r.fulfill({
        contentType: "text/html",
        body: shell(hotel("52843"))
      })
    })
    await p.goto(
      origin + "/hotels/chicago" + pageQuery + "&useWRPoints=" + points
    )
    const nativeUrl =
      searchRequest +
      "&useWRPoints=" +
      points +
      "&rateTypeFilter=" +
      (points ? "loyalty" : "price")
    await p.evaluate((url) => fetch(url), nativeUrl)
    await expect(p.locator(".pointlens-room-pill")).toHaveText(
      points ? "1.84¢/pt · $551.58" : "1.84¢/pt · 30,000 pts"
    )
    expect(calls).toBe(2)
    await p.evaluate(
      (markup) => document.body.insertAdjacentHTML("beforeend", markup),
      hotel("10073")
    )
    await expect(p.locator('[id="10073"] .pointlens-room-pill')).toHaveText(
      points ? "1.56¢/pt · $468.43" : "1.56¢/pt · 30,000 pts"
    )
    await p.evaluate((url) => fetch(url), nativeUrl)
    await expect.poll(() => calls).toBe(3)
    await p.waitForTimeout(250)
    expect(calls).toBe(3)
    await p.close()
  })

test("Wyndham 429 retains a cross-tab cooldown and shows an error rather than unavailable awards", async () => {
  const p = await context.newPage()
  let calls = 0
  await p.route(origin + "/**", (r) => {
    if (r.request().url().includes("property-availability")) {
      calls++
      return calls === 1
        ? r.fulfill({ json: search })
        : r.fulfill({
            status: 429,
            headers: { "Retry-After": "3600" },
            body: ""
          })
    }
    return r.fulfill({ contentType: "text/html", body: shell(hotel("52843")) })
  })
  await p.goto(origin + "/hotels/chicago" + pageQuery)
  await p.evaluate(
    (url) => fetch(url),
    searchRequest + "&useWRPoints=false&rateTypeFilter=price"
  )
  await expect(p.locator(".pointlens-wyndham-status")).toHaveText(
    "Couldn’t load points"
  )
  const budget = await worker.evaluate(
    async () =>
      (await chrome.storage.session.get("pointlens:wyndham:pricing-budget"))[
        "pointlens:wyndham:pricing-budget"
      ]
  )
  expect(budget.until).toBeGreaterThan(Date.now() + 3500000)
  expect(calls).toBe(2)
  await p.close()
})

test("Wyndham cached overview uses one lookup and the displayed cash mode", async () => {
  const p = await context.newPage()
  let calls = 0
  await p.route(origin + "/**", (r) => {
    if (r.request().url().includes("property-availability")) {
      calls++
      const q = new URL(r.request().url()).searchParams
      expect(q.get("properties")).toBe("LQ52843")
      expect(q.get("checkin_date")).toBe("09-18-2026")
      expect(q.get("useWRPoints")).toBe("true")
      expect(q.get("corporate_id")).toBe("TEST")
      return r.fulfill({ json: search })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(
        '<img src="/content/dam/property-images/en-us/lq/us/il/chicago/52843/52843_exterior.jpg">' +
          '<div class="room-pricing-container"><div class="pricing"><span class="price">$466</span><span class="units">USD/ Night</span></div></div>'
      )
    })
  })
  await p.goto(
    origin +
      "/laquinta/test/overview" +
      pageQuery +
      "&useWRPoints=true&corporate_id=TEST"
  )
  await expect(
    p.locator(".pointlens-wyndham-status[aria-busy=true]")
  ).toBeVisible()
  await expect(p.locator(".pointlens-room-pill")).toHaveText(
    "1.84¢/pt · 30,000 pts"
  )
  await p.waitForTimeout(2100)
  expect(calls).toBe(1)
  await p.close()
})

test("Wyndham map preview and full-stay dialog reuse captured prices", async () => {
  const p = await context.newPage()
  let calls = 0
  const name = Object.values(search.availability)
    .flatMap((g) => g.availability)
    .find((h) => String(h.hotelCode) === "52843").hotelName
  await p.route(origin + "/**", (r) => {
    const url = r.request().url()
    if (
      url.includes("property-availability") ||
      url.includes("getRoomsAndRates")
    ) {
      calls++
      return r.fulfill({
        json: url.includes("getRoomsAndRates") ? rooms : search
      })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(
        '<div id="mapRateView"><div id="map-name">' +
          name +
          '</div><div class="average-rate">$551.58</div></div>' +
          card("NK1", "SWR1").replace(
            '<div class="room-rate">',
            '<a class="stay-total" href="#">Total for Stay</a><div class="room-rate">'
          ) +
          '<div id="rateSummaryDetail"><div class="room-info">Stay total</div></div>'
      )
    })
  })
  await p.goto(origin + "/laquinta/test/rooms-rates" + pageQuery)
  await p.evaluate((url) => fetch(url), searchRequest + "&useWRPoints=true")
  await expect(p.locator("#mapRateView .pointlens-room-pill")).toHaveText(
    "1.84¢/pt · 30,000 pts"
  )
  await p.evaluate((url) => fetch(url), roomRequest)
  await p.locator(".stay-total").click()
  await p.evaluate(() =>
    document.querySelector("#rateSummaryDetail").classList.add("in")
  )
  await expect(p.locator("#rateSummaryDetail .pointlens-room-pill")).toHaveText(
    "1.80¢/pt · 60,000 pts"
  )
  await p
    .locator("#rateSummaryDetail .pointlens-room-comparison button")
    .focus()
  await expect(p.locator("#pointlens-value-details")).toContainText("$1,081.82")
  expect(calls).toBe(2)
  await p.close()
})
