const { test, expect, chromium } = require("@playwright/test")
const path = require("node:path")
const bwCash = require("../fixtures/bestwestern-rooms-cash.json")
const bwPoints = require("../fixtures/bestwestern-rooms-points.json")
const searchCash = require("../fixtures/bestwestern-search-cash.json")
const searchPoints = require("../fixtures/bestwestern-search-points.json")
const sonesta = require("../fixtures/sonesta-rooms.json")
const origin = "https://www.bestwestern.com"
const endpoint = (scope, rate) =>
  `${origin}/bin/bestwestern/proxy?gwServiceURL=${scope}&checkinDate=2026-09-18&checkoutDate=2026-09-20&hotelid=15108&numAdult=1&numChild=0&numberOfRooms=1&occupant=numAdults:1,numChild:0${rate}`
const roomUrl =
  origin + "/en_US/book/valparaiso/hotel-rooms/hotel/propertyCode.15108.html"
const shell = (body) => `<html><head></head><body>${body}</body></html>`
const dates =
  '<input id="checkin" value="Fri Sep 18 2026"><input id="checkout" value="Sun Sep 20 2026"><span id="currency-code-hv">USD</span>'
const roomRow = (room, rate = "2UB") =>
  `<div class="roomDetailsRates" id="room-details-rates-${room}"><div class="rateBox" data-rate-code="${rate}" data-amount-code="${rate === "FX" ? "points" : "USD"}"><div class="ratePriceWrapper">${rate === "FX" ? "36,000 points" : "$197"}</div></div></div>`
const bwSearch = (points) =>
  `<div class="ctaContainer"><div class="priceSection"><div class="currencyCode">${points ? "Points" : "USD"}</div></div><a href="${roomUrl}">View rooms</a></div><style>.markerCollapsed .markerText{display:none}.markerCollapsed .markerSelected .markerText{display:block}.mapMarker{position:relative;width:35px;height:73px;margin:40px}.markerBadge{height:34px}</style><div class="markerWrapper markerCollapsed"><div class="mapMarker" role="button" tabindex="0"><div class="placeId" hidden>15108</div><div class="markerBadge"><div class="markerText">Hotel</div></div></div></div>`
const sonestaDates =
  '<input id="checkin-date" value="Sep 18"><input id="checkout-date" value="Sep 20">'
const sonestaCard = (code) =>
  `<div id="room-card-${code}"><div class="PriceWrapper">$563</div><button data-room="${code}" data-roomprice="562.5">Select room</button></div>`
const sonestaBody = (changes) =>
  JSON.stringify({
    operationName: "getHotelAvailability",
    variables: {
      input: {
        crsHotelCode: "10054",
        start: "2026-09-18",
        end: "2026-09-20",
        adults: 1,
        children: 0,
        childrenAges: [],
        quantity: 1,
        ratePlanCode: "",
        promotionCode: "",
        ratePlanFilterCode: "Retail",
        ...changes
      }
    }
  })
let context, worker
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
const native = (p, url) => p.evaluate((url) => fetch(url), url)
const sonestaRequest = (p, changes) =>
  p.evaluate(
    (body) =>
      fetch("https://gapi.sonesta.com/guest/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      }),
    sonestaBody(changes)
  )

test("Best Western direct cash rooms load one award companion, match exact rooms, and expose hover/focus details", async () => {
  const p = await context.newPage(),
    points = structuredClone(bwPoints)
  points.roomDetailsList = points.roomDetailsList.slice(0, 1)
  const calls = []
  await p.route(origin + "/**", (r) => {
    const url = new URL(r.request().url())
    if (url.pathname.includes("/proxy")) {
      calls.push(url.searchParams.get("rateplan"))
      return r.fulfill({
        json: url.searchParams.get("rateplan") === "FX" ? points : bwCash
      })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(dates + roomRow("2345271") + roomRow("2345447"))
    })
  })
  await p.goto(roomUrl)
  await expect(
    p.locator(".pointlens-bestwestern-status[aria-busy=true]").first()
  ).toBeVisible()
  await native(p, endpoint("ROOM_RATE_PLAN", "&rateplan=2UB"))
  await expect(
    p.locator("#room-details-rates-2345271 .pointlens-room-pill")
  ).toHaveText("0.55¢/pt · 36,000 pts")
  await expect(
    p.locator("#room-details-rates-2345447 .pointlens-bestwestern-status")
  ).toHaveText("Points unavailable")
  expect(calls).toEqual(["2UB", "FX"])
  const icon = p.getByRole("button", {
    name: "PointLens: cash, points and value details"
  })
  await icon.hover()
  await expect(p.locator("#pointlens-value-details")).toContainText(
    "Tax unavailable"
  )
  await p.mouse.move(0, 0)
  await icon.focus()
  await expect(p.locator("#pointlens-value-details")).toContainText(
    "36,000 pts"
  )
  await p.close()
})
for (const points of [false, true])
  test(`Best Western ${points ? "points" : "cash"} search and map share one companion request`, async () => {
    const p = await context.newPage(),
      calls = []
    await p.route(origin + "/**", (r) => {
      const url = new URL(r.request().url())
      if (url.pathname.includes("/proxy")) {
        calls.push(url.searchParams.get("ratePlan"))
        return r.fulfill({
          json:
            url.searchParams.get("ratePlan") === "BWR"
              ? searchPoints
              : searchCash
        })
      }
      return r.fulfill({
        contentType: "text/html",
        body: shell(dates + bwSearch(points))
      })
    })
    await p.goto(origin + "/en_US/book/hotel-search.html")
    await native(p, endpoint("HOTEL_SEARCH", points ? "&ratePlan=BWR" : ""))
    await expect(p.locator(".ctaContainer .pointlens-room-pill")).toHaveText(
      points ? "0.55¢/pt · $197.00" : "0.55¢/pt · 36,000 pts"
    )
    await expect(p.locator(".markerText .pointlens-room-pill")).toHaveText(
      points ? "0.55¢/pt · $197.00" : "0.55¢/pt · 36,000 pts"
    )
    const compact = p.locator(
      ".pointlens-bestwestern-map-host .pointlens-room-pill"
    )
    await expect(compact).toBeVisible()
    await expect(compact).toHaveText("0.55¢/pt")
    await expect(p.locator(".markerText")).toBeHidden()
    await p.locator(".mapMarker").evaluate((el) => {
      el.addEventListener("click", () => el.classList.add("markerSelected"))
    })
    await compact.click()
    await expect(p.locator(".markerText .pointlens-room-pill")).toBeVisible()
    await expect(compact).toBeHidden()
    await p
      .locator(".mapMarker")
      .evaluate((el) => el.classList.remove("markerSelected"))
    await p
      .locator(".markerWrapper")
      .evaluate((el) => el.classList.remove("markerCollapsed"))
    await expect(p.locator(".markerText .pointlens-room-pill")).toBeVisible()
    await expect(compact).toBeHidden()
    expect(calls.length).toBe(2)
    await p.locator("#checkin").fill("Sat Sep 19 2026")
    await p.locator("#checkin").press("Tab")
    await expect(p.locator(".pointlens-room-pill")).toHaveCount(0)
    await p.close()
  })
test("Best Western stops on rate limiting and does not retry on DOM activity", async () => {
  const p = await context.newPage()
  let calls = 0
  await p.route(origin + "/**", (r) => {
    const url = new URL(r.request().url())
    if (url.pathname.includes("/proxy")) {
      calls++
      return url.searchParams.get("ratePlan") === "BWR"
        ? r.fulfill({
            status: 429,
            headers: { "Retry-After": "600" },
            body: "{}"
          })
        : r.fulfill({ json: searchCash })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(dates + bwSearch(false))
    })
  })
  await p.goto(origin + "/en_US/book/hotel-search.html")
  await native(p, endpoint("HOTEL_SEARCH", ""))
  await expect.poll(() => calls).toBe(2)
  await p.evaluate(() => {
    for (let i = 0; i < 20; i++)
      document.body.append(document.createElement("div"))
  })
  await p.waitForTimeout(2600)
  expect(calls).toBe(2)
  const budget = await worker.evaluate(
    async () =>
      (
        await chrome.storage.session.get("pointlens:bestwestern:pricing-budget")
      )["pointlens:bestwestern:pricing-budget"]
  )
  expect(budget.until).toBeGreaterThan(Date.now() + 14 * 60000)
  await p.close()
})
test("Best Western retains early cash responses until native currency appears and avoids replaying native awards", async () => {
  const p = await context.newPage()
  let calls = 0
  await p.route(origin + "/**", (r) => {
    const url = new URL(r.request().url())
    if (url.pathname.includes("/proxy")) {
      calls++
      return r.fulfill({
        json: url.searchParams.get("rateplan") === "FX" ? bwPoints : bwCash
      })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(
        dates.replace('<span id="currency-code-hv">USD</span>', "") +
          roomRow("2345271") +
          roomRow("2345271", "FX")
      )
    })
  })
  await p.goto(roomUrl)
  await native(p, endpoint("ROOM_RATE_PLAN", "&rateplan=2UB"))
  await native(p, endpoint("ROOM_RATE_PLAN", "&rateplan=FX"))
  await p.waitForTimeout(1000)
  await p.evaluate(() => {
    const el = document.createElement("span")
    el.id = "currency-code-hv"
    el.textContent = "USD"
    document.body.append(el)
  })
  await expect(p.locator(".pointlens-room-pill")).toHaveCount(2)
  await expect(p.locator(".pointlens-room-pill").nth(0)).toHaveText(
    "0.55¢/pt · 36,000 pts"
  )
  await expect(p.locator(".pointlens-room-pill").nth(1)).toHaveText(
    "0.55¢/pt · $197.00"
  )
  await p.waitForTimeout(2500)
  expect(calls).toBe(2)
  await p.close()
})
test("Sonesta direct rooms use native rewards, show exact-room unavailable, and make zero extra calls", async () => {
  const p = await context.newPage()
  let calls = 0
  await p.route("https://gapi.sonesta.com/**", (r) => {
    calls++
    return r.fulfill({ json: sonesta })
  })
  await p.route("https://www.sonesta.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: shell(
        sonestaDates +
          '<h1 id="hotel-name">The Royal Sonesta Chicago Downtown</h1>' +
          sonestaCard("D2QNC") +
          sonestaCard("P2QNC")
      )
    })
  )
  await p.goto("https://www.sonesta.com/royal-sonesta/il/chicago/hotel#rooms")
  await expect(
    p.locator(".pointlens-sonesta-status[aria-busy=true]").first()
  ).toBeVisible()
  await sonestaRequest(p)
  await expect(p.locator("#room-card-D2QNC .pointlens-room-pill")).toHaveText(
    "≈2.04¢/pt · 30,000 pts"
  )
  await expect(
    p.locator("#room-card-P2QNC .pointlens-sonesta-status")
  ).toHaveText("Points unavailable")
  await p
    .getByRole("button", { name: "PointLens: cash, points and value details" })
    .hover()
  await expect(p.locator("#pointlens-value-details")).toContainText("$55.64")
  expect(calls).toBe(1)
  await p.close()
})
test("Sonesta rewards and cash rate cards retain each selected rate and opposite companion", async () => {
  const p = await context.newPage()
  const rate = (code, price) =>
    `<div class="rate-card-list-group-item"><div class="rate-fees-coloumn"><div class="rate-fees">${price}</div><button id="rate-total-${code}-offer-1">Total</button></div></div>`
  await p.route("https://gapi.sonesta.com/**", (r) =>
    r.fulfill({ json: sonesta })
  )
  await p.route("https://www.sonesta.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: shell(
        sonestaDates +
          `<main>crsCode=10054<svg data-icon="bed"></svg><div>Two Queens - City View</div>${rate("TPRNR1", "30,000 pts")}${rate("DBAR", "$661")}</main>`
      )
    })
  )
  await p.goto("https://www.sonesta.com/checkout")
  await sonestaRequest(p)
  await expect(p.locator(".pointlens-room-pill").nth(0)).toHaveText(
    "≈2.04¢/pt · $668.82"
  )
  await expect(p.locator(".pointlens-room-pill").nth(1)).toHaveText(
    "≈2.43¢/pt · 30,000 pts"
  )
  await p.evaluate(() => {
    const modal = document.createElement("div")
    modal.className = "modal show"
    modal.innerHTML =
      '<div><div id="rate-card-modal-title">Rewards Points</div></div>'
    document.body.append(modal)
  })
  await expect(p.locator(".modal .pointlens-room-pill")).toHaveText(
    "≈2.04¢/pt · $668.82"
  )
  await p.evaluate(() => {
    document.getElementById("rate-card-modal-title").id =
      "total-stay-summary-modal-title"
  })
  await expect(p.locator(".modal .pointlens-room-pill")).toHaveText(
    "≈2.04¢/pt · $1,337.63"
  )
  await p.close()
})
test("Sonesta map and preview use native hotel identity and preserve pin labels", async () => {
  const p = await context.newPage()
  await p.route("https://gapi.sonesta.com/**", (r) =>
    r.fulfill({ json: sonesta })
  )
  await p.route("https://www.sonesta.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: shell(
        sonestaDates +
          `<div id="hotel-room-price"><div class="price-div">$563<button aria-label="Select for The Royal Sonesta Chicago Downtown">Select</button></div></div><style>.hotel-icon{display:flex;flex-direction:column;width:70px!important;height:auto!important;padding:4px;border:2px solid white;box-sizing:border-box;background:#eee}.hotel-icon>div{width:100%}.hotel-icon img{width:100%}</style><div class="leaflet-marker-icon hotel-icon" role="button" tabindex="0" style="width:12px;height:12px"><span class="price">$563</span><div><img width="180" height="100" alt="The Royal Sonesta Chicago Downtown" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='100'/%3E"></div></div>`
      )
    })
  )
  await p.goto("https://www.sonesta.com/locations/us/illinois/chicago")
  await sonestaRequest(p)
  await expect(p.locator("#hotel-room-price .pointlens-room-pill")).toHaveText(
    "≈2.04¢/pt · 30,000 pts"
  )
  await expect(p.locator(".hotel-icon .pointlens-room-pill")).toHaveAttribute(
    "data-map-value",
    "≈2.04¢/pt"
  )
  await expect(p.locator(".hotel-icon > .price")).toHaveText("$563")
  await expect(p.locator(".hotel-icon .pointlens-room-pill")).toHaveText(
    "≈2.04¢/pt"
  )
  // Leaflet replaces the entire icon HTML on rate loads and selection.
  // Sample the next painted frame, not eventual visibility after a timeout.
  const redraws = await p.locator(".hotel-icon").evaluate(async (marker) => {
    const nativeHtml = Array.from(marker.children)
      .filter((el) => !el.classList.contains("pointlens-sonesta-host"))
      .map((el) => el.outerHTML)
      .join("")
    const initial = marker.getBoundingClientRect()
    const frames = []
    for (let i = 0; i < 4; i++) {
      marker.innerHTML = nativeHtml
      marker.classList.toggle("active", i % 2 === 0)
      await new Promise(requestAnimationFrame)
      const box = marker.getBoundingClientRect()
      frames.push({
        text: marker.querySelector(".pointlens-room-pill")?.textContent ?? "",
        width: box.width,
        height: box.height
      })
    }
    return { frames, width: initial.width, height: initial.height }
  })
  for (const frame of redraws.frames) {
    expect(frame.text).toBe("≈2.04¢/pt")
    expect(frame.width).toBe(redraws.width)
    expect(frame.height).toBe(redraws.height)
  }
  const recycled = await p.locator(".hotel-icon").evaluate(async (marker) => {
    const logo = marker.querySelector("img")
    const original = logo.alt
    logo.alt = "Another hotel"
    await new Promise(requestAnimationFrame)
    const stale = !!marker.querySelector(".pointlens-room-pill")
    logo.alt = original
    await new Promise(requestAnimationFrame)
    return {
      stale,
      restored: marker.querySelector(".pointlens-room-pill")?.textContent
    }
  })
  expect(recycled).toEqual({ stale: false, restored: "≈2.04¢/pt" })
  const fits = () =>
    p.locator(".hotel-icon").evaluate((marker) => {
      const outer = marker.getBoundingClientRect()
      const pill = marker
        .querySelector(".pointlens-room-pill")
        .getBoundingClientRect()
      return (
        pill.left >= outer.left &&
        pill.right <= outer.right &&
        pill.top >= outer.top &&
        pill.bottom <= outer.bottom &&
        outer.width <= 100
      )
    })
  expect(await fits()).toBe(true)
  // Larger values must size the marker instead of spilling outside its border.
  await p
    .locator(".hotel-icon .pointlens-room-pill")
    .evaluate((el) => (el.textContent = "≈123.45¢/pt"))
  expect(await fits()).toBe(true)
  await p.setViewportSize({ width: 390, height: 844 })
  expect(await fits()).toBe(true)
  await p
    .locator(".hotel-icon")
    .evaluate((el) =>
      el.addEventListener("click", () => el.classList.add("active"))
    )
  await p.locator(".hotel-icon").click()
  await expect(p.locator(".hotel-icon")).toHaveClass(/active/)
  await p.close()
})
