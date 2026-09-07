const { test, expect, chromium } = require("@playwright/test")
const path = require("node:path")
const search = require("../fixtures/choice-search.json")
const rooms = require("../fixtures/choice-rooms.json")
const lowest = require("../fixtures/choice-lowest.json")
const origin = "https://www.choicehotels.com"
const query = "?checkInDate=2026-09-18&checkOutDate=2026-09-20"
const hotelPath = "/illinois/chicago/cambria-hotels/il514"
const vars = {
  adults: 1,
  minors: 0,
  rooms: 1,
  checkInDate: "2026-09-18",
  checkOutDate: "2026-09-20",
  hotelId: "IL514",
  ratePlanCodes: ["RACK", "SRD"]
}
const pricing = (points) =>
  `<div aria-label="Pricing and Fees"><div class="pricing-display-${points ? "points" : "cash"}"><span class="main-price">${points ? "40,000" : "$450"}</span></div></div>`
const card = (room, points = false) =>
  `<div data-track-id="${room} roomCard"><h3>${room}</h3>${pricing(points)}</div>`
const searchCard = (points) =>
  `<li class="search-result-list-view-card"><a href="${hotelPath}">Cambria</a>${pricing(points)}</li>`
const shell = (body) => `<html><head></head><body>${body}</body></html>`
let context, worker
const request = (p, op = "GetRoomRates", variables = vars) =>
  p.evaluate(
    ({ op, variables }) =>
      fetch("/dxapi/graphql?q=" + op, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationName: op,
          query: "query Fixture { pricing }",
          variables
        })
      }),
    { op, variables }
  )
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
for (const points of [false, true])
  test(`Choice direct ${points ? "points" : "cash"} rooms reuse native prices and exact room availability`, async () => {
    const p = await context.newPage()
    let calls = 0
    const data = structuredClone(rooms)
    const missing = data.data.getHotelAvailabilityRoomRates.roomRates.find(
      (r) => r.key === "NQQ1"
    )
    missing.value = missing.value.filter((r) => r.key !== "SRD")
    await p.route(origin + "/**", (r) =>
      r.request().url().includes("/dxapi/")
        ? (calls++, r.fulfill({ json: data }))
        : r.fulfill({
            contentType: "text/html",
            body: shell(card("NK", points) + card("NQQ1"))
          })
    )
    await p.goto(
      origin + hotelPath + query + (points ? "&ratePlanCode=SRD" : "")
    )
    await expect(
      p.locator(".pointlens-choice-status[aria-busy=true]").first()
    ).toBeVisible()
    await request(p)
    await expect(
      p.locator('[data-track-id="NK roomCard"] .pointlens-room-pill')
    ).toHaveText(points ? "1.35¢/pt · $540.92" : "1.35¢/pt · 40,000 pts")
    await expect(
      p.locator('[data-track-id="NQQ1 roomCard"] .pointlens-choice-status')
    ).toHaveText("Points unavailable")
    expect(calls).toBe(1)
    await p.locator(".pointlens-room-comparison button").focus()
    await expect(p.locator("#pointlens-value-details")).toContainText("$540.92")
    await p.evaluate(() => {
      history.pushState(
        {},
        "",
        location.href.replace("2026-09-20", "2026-09-21")
      )
      document.dispatchEvent(new Event("change"))
    })
    await expect(p.locator(".pointlens-room-pill")).toHaveCount(0)
    await p.close()
  })
test("Choice direct cash SSR search uses one batch, supports maps and ignores sold-out cards", async () => {
  const p = await context.newPage()
  let calls = 0
  const native = structuredClone(search.data.getHotelAvailabilityLowestRate)
  for (const item of native)
    item.requestedRates = item.requestedRates.filter(
      (r) => r.defaultRate.ratePlanCode !== "SRD"
    )
  const state = {
    searchResults: {
      searchForm: { ...vars, ratePlanCode: "RACK" },
      hotels: native.map((r) => ({ code: r.hotelCode, startingRates: r }))
    }
  }
  await p.route(origin + "/**", (r) => {
    if (r.request().url().includes("/dxapi/")) {
      calls++
      expect(r.request().postDataJSON().variables.ratePlanCodes).toEqual([
        "RACK",
        "SRD"
      ])
      return r.fulfill({ json: search })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(
        searchCard(false) +
          `<script>window.PRELOADED_STATE = ${JSON.stringify(state)};</script>`
      )
    })
  })
  await p.goto(origin + "/illinois/chicago/hotels" + query)
  await expect(p.locator(".pointlens-room-pill")).toHaveText(
    "1.32¢/pt · 40,000 pts"
  )
  expect(calls).toBe(1)
  const errors = []
  p.on("pageerror", (error) => errors.push(error.message))
  await p.evaluate(() => {
    customElements.define(
      "choice-numeric-id",
      class extends HTMLElement {
        get id() {
          return 514
        }
      }
    )
    document.body.append(document.createElement("choice-numeric-id"))
  })
  await p.waitForTimeout(150)
  expect(errors).toEqual([])
  await p.evaluate(
    (markup) => document.body.insertAdjacentHTML("beforeend", markup),
    `<div id="MapListItem-IL514">${pricing(true)}</div>`
  )
  await expect(p.locator("#MapListItem-IL514 .pointlens-room-pill")).toHaveText(
    "1.32¢/pt · $527.62"
  )
  await p.evaluate(
    () =>
      (document.querySelector(
        ".search-result-list-view-card .main-price"
      ).textContent = "Sold out")
  )
  await expect(
    p.locator(".search-result-list-view-card .pointlens-room-pill")
  ).toHaveCount(0)
  await expect(
    p.locator(".search-result-list-view-card .pointlens-choice-status")
  ).toHaveCount(0)
  expect(calls).toBe(1)
  await p.close()
})
test("Choice missing awards get one supplement; 429 is an error with persistent cooldown", async () => {
  const p = await context.newPage()
  let calls = 0
  const data = structuredClone(rooms)
  for (const r of data.data.getHotelAvailabilityRoomRates.roomRates)
    r.value = r.value.filter((v) => v.key !== "SRD")
  await p.route(origin + "/**", (r) => {
    if (r.request().url().includes("/dxapi/"))
      return ++calls === 1
        ? r.fulfill({ json: data })
        : r.fulfill({
            status: 429,
            headers: { "Retry-After": "3600" },
            body: ""
          })
    return r.fulfill({ contentType: "text/html", body: shell(card("NK")) })
  })
  await p.goto(origin + hotelPath + query)
  await request(p, "GetRoomRates", { ...vars, ratePlanCodes: ["RACK"] })
  await expect(p.locator(".pointlens-choice-status")).toHaveText(
    "Couldn’t load points"
  )
  expect(calls).toBe(2)
  const budget = await worker.evaluate(
    async () =>
      (await chrome.storage.session.get("pointlens:choice:pricing-budget"))[
        "pointlens:choice:pricing-budget"
      ]
  )
  expect(budget.until).toBeGreaterThan(Date.now() + 3500000)
  const other = await context.newPage()
  let supplements = 0
  await other.route(origin + "/**", (route) => {
    if (route.request().url().includes("/dxapi/")) {
      supplements++
      return route.fulfill({ json: data })
    }
    return route.fulfill({ contentType: "text/html", body: shell(card("NK")) })
  })
  await other.goto(origin + hotelPath + query)
  await request(other, "GetRoomRates", { ...vars, ratePlanCodes: ["RACK"] })
  await expect(other.locator(".pointlens-choice-status")).toHaveText(
    "Couldn’t load points"
  )
  expect(supplements).toBe(1)
  await other.close()
  await p.close()
})
test("Choice exact rate plans and room dialogs reuse captured rates", async () => {
  const p = await context.newPage()
  await p.route(origin + "/**", (r) =>
    r.request().url().includes("/dxapi/")
      ? r.fulfill({ json: rooms })
      : r.fulfill({
          contentType: "text/html",
          body: shell(
            '<div class="rate-card-price-box"><button class="price-total">$462</button><span id="rates-room-card-book-room-NK-SCPM"></span></div><div class="room-card-info-modal"><div class="room-details-container"><h3>1 King Bed, Nonsmoking</h3></div></div>'
          )
        })
  )
  await p.goto(origin + hotelPath + "/rates" + query + "&roomCode=NK")
  await request(p)
  await expect(
    p.locator(".rate-card-price-box .pointlens-room-pill")
  ).toHaveText("1.35¢/pt · 40,000 pts")
  await expect(
    p.locator(".room-card-info-modal .pointlens-room-pill")
  ).toHaveText("1.35¢/pt · 40,000 pts")
  await worker.evaluate(() =>
    chrome.storage.local.set({
      "pointlens:choice-value-settings": { taxBasis: "pretax" }
    })
  )
  await expect(
    p.locator(".rate-card-price-box .pointlens-room-pill")
  ).toHaveText("1.14¢/pt · 40,000 pts")
  await worker.evaluate(() =>
    chrome.storage.local.remove("pointlens:choice-value-settings")
  )
  await p.close()
})

for (const points of [false, true])
  test(`Choice ${points ? "points" : "cash"} map info icons receive hover above the hotel selection overlay`, async () => {
    const p = await context.newPage()
    let calls = 0
    await p.route(origin + "/**", (r) => {
      if (r.request().url().includes("/dxapi/")) {
        calls++
        return r.fulfill({ json: search })
      }
      return r.fulfill({
        contentType: "text/html",
        body: shell(`<style>
          .search-results-map-card{position:relative;padding:24px;overflow:hidden;width:450px}
          .button-overlay{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent}
        </style><div id="MapListItem-IL514" class="search-results-map-card">
          <button class="button-overlay" aria-label="Locate property in map"></button>
          <h3>Cambria Hotel Chicago Loop - Theatre District</h3>${pricing(points)}
        </div><div id="SearchPageMap"></div><button id="outside">Outside card</button>`)
      })
    })
    await p.goto(origin + "/illinois/chicago/hotels" + query + "&view=Map" + (points ? "&ratePlanCode=SRD" : ""))
    await request(p, "GetSearchResultsRatesWithRoomPolicy", vars)
    const icon = p.locator(".pointlens-room-comparison button")
    const tooltip = p.locator("#pointlens-value-details")
    await expect(icon).toBeVisible()
    await p.locator(".button-overlay").evaluate((e) =>
      e.addEventListener("click", () => document.body.dataset.selected = "yes")
    )
    await icon.hover({ timeout: 2000 })
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toHaveCSS("opacity", "1")
    await expect(tooltip).toContainText("$527.62")
    await expect(tooltip).toContainText("40,000 pts (1.32¢/pt)")
    await p.locator("#outside").hover()
    await expect(tooltip).toBeHidden()
    await icon.click()
    await expect(tooltip).toBeVisible()
    await expect(p.locator("body")).not.toHaveAttribute("data-selected")
    await icon.press("Escape")
    await expect(tooltip).toBeHidden()
    await icon.focus()
    await expect(tooltip).toBeVisible()
    await p.locator(".button-overlay").click({ position: { x: 10, y: 10 } })
    await expect(p.locator("body")).toHaveAttribute("data-selected", "yes")
    await expect(tooltip).toBeHidden()
    expect(calls).toBe(1)
    await p.close()
  })

test("Choice map pins and flyouts reuse sidebar values, preserve clicks, and follow mode changes", async () => {
  const p = await context.newPage()
  let calls = 0
  const name = "Cambria Hotel Chicago Loop - Theatre District"
  const pin = (label) =>
    `<div role="button" aria-label="${label}" title="${label}" tabindex="0" style="position:absolute;width:68px;height:40px;overflow:hidden"><img src="https://maps.gstatic.com/mapfiles/transparent.png"></div>`
  await p.route(origin + "/**", (r) => {
    if (r.request().url().includes("/dxapi/")) {
      calls++
      return r.fulfill({ json: search })
    }
    return r.fulfill({
      contentType: "text/html",
      body: shell(
        `<div id="MapListItem-IL514"><h3>${name}</h3>${pricing(false)}</div><div id="SearchPageMap">${pin(name + ". $450.")}<button class="marker-cluster">3</button><div class="map-flyout"><a href="${hotelPath}">${name}</a>${pricing(false)}</div></div>`
      )
    })
  })
  await p.goto(origin + "/illinois/chicago/hotels" + query + "&view=Map")
  const marker = p.locator("#SearchPageMap > [role=button]")
  await expect(
    marker.locator(".pointlens-choice-map-value[aria-busy=true]")
  ).toBeVisible()
  await request(p, "GetSearchResultsRatesWithRoomPolicy", vars)
  await expect(marker.locator(".pointlens-choice-map-caption")).toHaveText(
    "1.32¢/pt · 40K pts"
  )
  await expect(p.locator(".map-flyout .pointlens-room-pill")).toHaveText(
    "1.32¢/pt · 40,000 pts"
  )
  await expect(marker).toHaveAttribute("aria-label", name + ". $450.")
  await p.evaluate(() =>
    document
      .querySelector("#SearchPageMap [role=button]")
      .addEventListener(
        "click",
        () => (document.body.dataset.pinClicked = "yes")
      )
  )
  await marker.click()
  await expect(p.locator("body")).toHaveAttribute("data-pin-clicked", "yes")
  await expect(
    p.locator(".marker-cluster .pointlens-choice-map-value")
  ).toHaveCount(0)
  // Marker updates first: never show the cash-mode companion under an award pin.
  await marker.evaluate((e) =>
    e.setAttribute(
      "aria-label",
      "Cambria Hotel Chicago Loop - Theatre District. 40K."
    )
  )
  await expect(marker.locator(".pointlens-choice-map-value")).toHaveCount(0)
  await p.evaluate(() => {
    const card = document.querySelector("#MapListItem-IL514")
    card.querySelector(".main-price").textContent = "40,000"
    card.querySelector(".pricing-display-cash").className =
      "pricing-display-points"
  })
  await expect(marker.locator(".pointlens-choice-map-caption")).toHaveText(
    "1.32¢/pt · $527.62"
  )
  await worker.evaluate(() =>
    chrome.storage.local.set({
      "pointlens:choice-value-settings": { taxBasis: "pretax" }
    })
  )
  await expect(marker.locator(".pointlens-choice-map-caption")).toHaveText(
    "1.11¢/pt · $443.75"
  )
  await worker.evaluate(() =>
    chrome.storage.local.remove("pointlens:choice-value-settings")
  )
  await marker.evaluate((e) =>
    e.setAttribute(
      "aria-label",
      "Cambria Hotel Chicago Loop - Theatre District. SOLD OUT."
    )
  )
  await expect(marker.locator(".pointlens-choice-map-value")).toHaveCount(0)
  await expect(marker).not.toHaveClass(/pointlens-choice-map-pin/)
  await expect(marker).not.toHaveAttribute("aria-describedby", /pointlens/)
  expect(calls).toBe(1)
  await p.close()
})
