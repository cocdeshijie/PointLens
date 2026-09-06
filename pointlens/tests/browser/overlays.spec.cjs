const { test, expect, chromium } = require("@playwright/test")
const path = require("node:path")
let context
let worker
const rate = {
  spiritCode: "chi",
  rate: 200,
  rateAfterTax: 240,
  points: 12000,
  currencyCode: "USD",
  status: "AVAILABLE"
}
const html = `<!doctype html><html><head><style>body{font:16px Arial;padding:30px}article{border:1px solid #ddd;padding:20px;width:350px}.rate_with_text{display:block}</style></head><body><h1>PointLens controlled regression fixture</h1><button role="switch" aria-label="Points" aria-checked="false">Points</button><div data-spirit-code="chi"><div class="rate_with_text"><strong>$200/night</strong><div data-testid="all-in-pricing-label">Includes fees before taxes</div></div></div><gmp-advanced-marker data-locator="map-pin-chi"><div data-testid="map-marker">$200</div><div class="map-marker__popover--visible">Hotel preview</div></gmp-advanced-marker></body></html>`
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
  // Fixture tests never reach real hotel or FX servers.
  await context.route("https://**/*", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: html })
  )
})
test.afterAll(async () => {
  await context?.close()
})

test("IHG room cards and detail dialogs show matching stay values with no additional pricing calls", async () => {
  const fixture = require("../fixtures/ihg-rooms.json")
  const p = await context.newPage()
  await p.route("**/*", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<html><head></head><body><h1>Select your room</h1><button data-testid="btnMoney" aria-pressed="true">Money</button><button data-testid="btnPoints" aria-pressed="false">Points</button><section><div class="room-rate-card"><div class="roomInfoPrice"><h3 id="room-card-title-KSUG">1 King Premium Executive Tower</h3><button id="details">Room Details</button></div></div><div class="room-rate-card"><div class="roomInfoPrice"><h3 id="room-card-title-KABN">1 King Premium City View Executive Tower</h3></div></div></section></body></html>`
    })
  )
  await p.goto(
    "https://www.ihg.com/hotels/us/en/find-hotels/select-roomrate?qPt=POINTS&qSlH=ORDHA&qCiD=12&qCoD=16&qCiMy=092026&qCoMy=092026&qRms=1&qAdlt=1"
  )
  let extraRequests = 0
  p.on("request", () => extraRequests++)
  await p.evaluate(
    (f) =>
      window.postMessage(
        {
          __AWARD_VIEWER_IHG__: true,
          url: "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=rateDetails",
          bodyText: JSON.stringify(f.request),
          responseBodyText: JSON.stringify(f.response),
          responseStatus: 200
        },
        location.origin
      ),
    fixture
  )
  const badge = p.locator(
    '.room-rate-card .pointlens-ihg-room-value[data-room-code="KSUG"]'
  )
  await expect(badge).toContainText("≈0.54¢/pt")
  await expect(badge.locator(".pointlens-room-value-context")).toHaveText(
    "· 113,250 pts"
  )
  await expect(p.locator(".pointlens-ihg-room-overview")).toHaveCount(0)
  await badge.locator(".pointlens-room-value-info").focus()
  await expect(p.locator("#pointlens-value-details")).toContainText("$140.00")
  await expect(p.locator("#pointlens-value-details")).toContainText(
    "nonrefundable"
  )
  await p.locator("#details").click()
  await p.evaluate(() => {
    const d = document.createElement("div")
    d.setAttribute("role", "dialog")
    d.setAttribute("aria-modal", "true")
    d.innerHTML =
      '<h2 id="dialog-header-title">1 King Premium Executive Tower</h2><div class="p-dialog-content">Room amenities</div>'
    document.body.append(d)
  })
  await expect(
    p.locator("[role=dialog] .pointlens-ihg-room-value")
  ).toContainText("≈0.54¢/pt")
  // Native mode changes without a URL change must update both card and dialog.
  await p.evaluate(() => {
    document
      .querySelector('[data-testid="btnMoney"]')
      .setAttribute("aria-pressed", "false")
    document
      .querySelector('[data-testid="btnPoints"]')
      .setAttribute("aria-pressed", "true")
  })
  await expect(badge.locator(".pointlens-room-value-context")).toHaveText(
    "· $643.27"
  )
  await expect(
    p.locator("[role=dialog] .pointlens-room-value-context")
  ).toHaveText("· $643.27")
  await p.evaluate(() => {
    document
      .querySelector('[data-testid="btnPoints"]')
      .setAttribute("aria-pressed", "false")
    document
      .querySelector('[data-testid="btnMoney"]')
      .setAttribute("aria-pressed", "true")
  })
  await expect(badge.locator(".pointlens-room-value-context")).toHaveText(
    "· 113,250 pts"
  )
  await expect(
    p.locator("[role=dialog] .pointlens-room-value-context")
  ).toHaveText("· 113,250 pts")
  // Missing counterparts must not repeat the native amount or fabricate CPP.
  await p.evaluate((f) => {
    f.response.hotels[0].rateDetails.offers =
      f.response.hotels[0].rateDetails.offers.filter((o) => !o.rewardNights)
    window.postMessage(
      {
        __AWARD_VIEWER_IHG__: true,
        url: "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=rateDetails",
        bodyText: JSON.stringify(f.request),
        responseBodyText: JSON.stringify(f.response),
        responseStatus: 200
      },
      location.origin
    )
  }, fixture)
  await expect(badge.locator(".pointlens-room-value-text")).toHaveText(
    "Reward night unavailable"
  )
  await expect(badge.locator(".pointlens-room-value-context")).toHaveText("")
  await p.evaluate((f) => {
    document
      .querySelector('[data-testid="btnMoney"]')
      .setAttribute("aria-pressed", "false")
    document
      .querySelector('[data-testid="btnPoints"]')
      .setAttribute("aria-pressed", "true")
    f.response.hotels[0].rateDetails.offers =
      f.response.hotels[0].rateDetails.offers.filter((o) => o.rewardNights)
    window.postMessage(
      {
        __AWARD_VIEWER_IHG__: true,
        url: "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=rateDetails",
        bodyText: JSON.stringify(f.request),
        responseBodyText: JSON.stringify(f.response),
        responseStatus: 200
      },
      location.origin
    )
  }, fixture)
  await expect(badge.locator(".pointlens-room-value-text")).toHaveText(
    "Cash rate unavailable"
  )
  await expect(badge.locator(".pointlens-room-value-context")).toHaveText("")
  expect(extraRequests).toBe(0)
  await p.evaluate(() => {
    history.pushState({}, "", location.href.replace("qCoD=16", "qCoD=17"))
    document.body.append(document.createElement("span"))
  })
  await expect(p.locator(".pointlens-ihg-room-value")).toHaveCount(0)
  await p.close()
})
test("IHG expanded cash plans and their dialogs compare the exact selected rate", async () => {
  const fixture = require("../fixtures/ihg-rooms.json")
  const p = await context.newPage()
  await p.route("**/*", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<body><button data-testid="btnMoney" aria-pressed="true">Money</button><div class="room-rate-card"><div class="roomInfo"><h3 id="room-card-title-KSUG">1 King Premium Executive Tower</h3></div></div>${["IGCOR", "IKME6"].map((code) => `<div class="rate-card-wrapper" id="${code}"><div class="rate-info-wrapper"><button class="rate-name">${code} details</button></div><button data-slnm-ihg="roomRateKSUG${code}">Select</button></div>`).join("")}</body>`
    })
  )
  await p.goto(
    "https://www.ihg.com/hotels/us/en/find-hotels/select-roomrate?qSlH=ORDHA&qCiD=12&qCoD=16&qCiMy=092026&qCoMy=092026&qRms=1&qAdlt=1"
  )
  let extraRequests = 0
  p.on("request", () => extraRequests++)
  await p.evaluate(
    (f) =>
      window.postMessage(
        {
          __AWARD_VIEWER_IHG__: true,
          url: "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=rateDetails",
          bodyText: JSON.stringify(f.request),
          responseBodyText: JSON.stringify(f.response),
          responseStatus: 200
        },
        location.origin
      ),
    fixture
  )
  await expect(
    p.locator(".room-rate-card .pointlens-room-value-text")
  ).toHaveText("≈0.54¢/pt")
  await expect(p.locator("#IGCOR .pointlens-room-value-text")).toHaveText(
    "≈0.64¢/pt"
  )
  await expect(p.locator("#IGCOR .pointlens-room-value-context")).toHaveText(
    "· 113,250 pts"
  )
  await expect(p.locator("#IKME6 .pointlens-room-value-text")).toHaveText(
    "≈0.63¢/pt"
  )
  await expect(p.locator("#IKME6 .pointlens-room-value-context")).toHaveText(
    "· 113,250 pts"
  )
  await p.locator("#IGCOR .rate-name").click()
  await p.evaluate(() => {
    const dialog = document.createElement("div")
    dialog.className = "ihg-ui-rate-details-modal-v2"
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("aria-modal", "true")
    dialog.innerHTML =
      '<h2 id="dialog-header-title">Rate details</h2><div class="p-dialog-content">Best Flexible Rate</div>'
    document.body.append(dialog)
  })
  await expect(
    p.locator("[role=dialog] .pointlens-room-value-text")
  ).toHaveText("≈0.64¢/pt")
  await p.locator("[role=dialog] .pointlens-room-value-info").focus()
  await expect(p.locator("#pointlens-value-details")).toContainText("$3,030.47")
  await expect(p.locator("#pointlens-value-details")).toContainText(
    "4-night total"
  )
  await expect(p.locator("#pointlens-value-details")).toContainText("≈0.64¢/pt")
  await p.locator("#IKME6 .rate-name").click()
  await p.evaluate(() =>
    document
      .querySelector("[role=dialog]")
      .append(document.createElement("span"))
  )
  await expect(
    p.locator("[role=dialog] .pointlens-room-value-text")
  ).toHaveText("≈0.63¢/pt")
  expect(extraRequests).toBe(0)
  await p.close()
})

async function openHyatt() {
  const p = await context.newPage()
  await p.goto(
    "https://www.hyatt.com/search/hotels/en-US/Fixture?checkinDate=2026-10-12"
  )
  return p
}

test("IHG direct points entry captures native pricing, labels packages, and restores a previous stay without refetching", async () => {
  const fixture = require("../fixtures/ihg-direct-points.json")
  const p = await context.newPage()
  const api =
    "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=rateDetails,rateDetails.policies"
  let response = fixture.response,
    calls = 0
  await p.route("**/*", (r) => {
    if (r.request().url() === api) {
      calls++
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(response)
      })
    }
    return r.fulfill({
      contentType: "text/html",
      body: '<html><head></head><body><h1>Points rooms</h1><section><div class="room-rate-card"><div class="roomInfo"><h3 id="room-card-title-CDXG">Premium Room</h3><button>Room Details</button></div></div><div class="room-rate-card"><div class="roomInfo"><h3 id="room-card-title-KAJN">1 King Classic City View Grand Tower</h3></div></div></section></body></html>'
    })
  })
  const url =
    "https://www.ihg.com/hotels/us/en/find-hotels/select-roomrate?qPt=POINTS&qSlH=ORDHA&qCiD=9&qCoD=10&qCiMy=082026&qCoMy=082026&qAdlt=1&qChld=0&qRms=1"
  await p.goto(url)
  await p.evaluate(
    ({ api, body }) =>
      fetch(api, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        r.json()
      ),
    { api, body: fixture.request }
  )
  const badge = p.locator(
    '.room-rate-card .pointlens-ihg-room-value[data-room-code="CDXG"]'
  )
  const packageBadge = p.locator(
    '.room-rate-card .pointlens-ihg-room-value[data-room-code="KAJN"]'
  )
  await expect(badge).toContainText("≈0.44¢/pt")
  await expect(badge.locator(".pointlens-room-value-context")).toHaveText(
    "· $340.87"
  )
  await expect(packageBadge.locator(".pointlens-room-value-text")).toHaveText(
    "≈0.51¢/pt"
  )
  await expect(
    packageBadge.locator(".pointlens-room-value-context")
  ).toHaveText("· $340.87")
  await expect(packageBadge).toHaveAttribute("data-tier", "mid")
  await expect(packageBadge.locator(".pointlens-room-value-pill")).toHaveText(
    "≈0.51¢/pt· $340.87"
  )
  await expect(p.locator(".pointlens-ihg-room-overview")).toHaveCount(0)
  await packageBadge.locator(".pointlens-room-value-info").focus()
  await expect(p.locator("#pointlens-value-details")).toContainText(
    "Cash alternative: Premium Room"
  )
  await expect(p.locator("#pointlens-value-details table thead")).toHaveText(
    "CashPoints"
  )
  await expect(p.locator("#pointlens-value-details table")).toContainText(
    "60,000 pts"
  )
  await expect(p.locator("#pointlens-value-details")).toContainText(
    "Cash alternative: Premium Room"
  )
  await p.setViewportSize({ width: 390, height: 844 })
  await packageBadge.locator(".pointlens-room-value-info").blur()
  await packageBadge.locator(".pointlens-room-value-info").focus()
  expect(
    await p
      .locator("#pointlens-value-details")
      .evaluate((el) => el.scrollWidth <= el.clientWidth)
  ).toBe(true)
  await expect(
    p.locator("#pointlens-value-details .pointlens-room-notes > div")
  ).toHaveCount(2)
  await expect(
    p.locator("#pointlens-value-details table tbody tr")
  ).toHaveCount(4)
  const next = structuredClone(fixture)
  next.request.startDate = "2026-09-16"
  next.request.endDate = "2026-09-17"
  for (const o of next.response.hotels[0].rateDetails.offers) {
    for (const product of o.productUses)
      product.period = { start: "2026-09-16", end: "2026-09-17" }
    if (o.rewardNights) o.rewardNights.pointsOnly.totalPoints = 100000
  }
  response = next.response
  await p.evaluate((url) => {
    history.pushState(
      {},
      "",
      url.replace("qCiD=9", "qCiD=16").replace("qCoD=10", "qCoD=17")
    )
    window.dispatchEvent(new PopStateEvent("popstate"))
  }, url)
  await expect(badge).toHaveCount(0)
  await p.evaluate(
    ({ api, body }) =>
      fetch(api, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        r.json()
      ),
    { api, body: next.request }
  )
  await expect(badge).toContainText("≈0.31¢/pt")
  await p.evaluate((url) => {
    history.replaceState({}, "", url)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }, url)
  await expect(badge).toContainText("≈0.44¢/pt")
  expect(calls).toBe(2)
  await p.evaluate(() => {
    document.querySelector('[id^="room-card-title-"]').id =
      "room-card-title-UNKNOWN"
  })
  await expect(badge).toHaveCount(0)
  await p.close()
})

test("IHG standalone hotel overview uses native dates and ignores package-only responses", async () => {
  const fixture = require("../fixtures/ihg-rooms.json")
  const p = await context.newPage()
  await p.route("**/*", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html><head></head><body><div id="HERO"><div class="title"><h1>InterContinental Chicago</h1></div></div><button>View prices</button></body></html>'
    })
  )
  await p.goto(
    "https://www.ihg.com/intercontinental/hotels/us/en/chicago/ordha/hoteldetail"
  )
  async function captured(packages = false) {
    const responseFixture = structuredClone(fixture)
    if (packages) {
      for (const offer of responseFixture.response.hotels[0].rateDetails
        .offers) {
        if (offer.rewardNights) offer.rewardNights.pointsOnly.totalPoints = 1
      }
    }
    await p.evaluate(
      ({ f, packages }) =>
        window.postMessage(
          {
            __AWARD_VIEWER_IHG__: true,
            url:
              "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=rateDetails" +
              (packages ? ",rateDetails.packagesAdditionalInfo" : ""),
            bodyText: JSON.stringify(f.request),
            responseBodyText: JSON.stringify(f.response),
            responseStatus: 200
          },
          location.origin
        ),
      { f: responseFixture, packages }
    )
  }
  await captured()
  await expect(p.locator(".pointlens-ihg-room-overview")).not.toContainText(
    "best"
  )
  await expect(p.locator(".pointlens-ihg-room-overview")).toContainText(
    "≈0.53¢/pt"
  )
  await p
    .getByRole("combobox", { name: "Room for cash and points comparison" })
    .selectOption("KSUG")
  await expect(p.locator(".pointlens-ihg-room-overview")).toContainText(
    "≈0.54¢/pt"
  )
  await expect(p.locator(".pointlens-ihg-room-overview")).toContainText(
    "2026-10-12 – 2026-10-16"
  )
  await captured(true)
  await p.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  )
  await expect(p.locator(".pointlens-ihg-room-overview")).toContainText(
    "≈0.54¢/pt"
  )
  await p.close()
})
async function push(p, r = rate) {
  await p.evaluate((r) => {
    window.__next_f ??= []
    window.__next_f.push([1, JSON.stringify({ leadingRate: r })])
  }, r)
}
test("Hyatt list, map and preview agree; own rendering settles; keyboard tooltip works", async () => {
  const p = await openHyatt()
  await push(p)
  await expect(p.locator(".pointlens-hyatt-cpp-value")).toHaveText(
    "2.00¢/pt · 12,000 pts"
  )
  await expect(p.locator(".pointlens-hyatt-pin-cpp")).toContainText("2.00¢")
  await expect(p.locator(".pointlens-hyatt-popover-cpp")).toContainText(
    "2.00¢/pt"
  )
  await p.locator(".pointlens-hyatt-cpp-icon").focus()
  await expect(p.locator(".pointlens-shared-tooltip")).toHaveCSS("opacity", "1")
  await p.keyboard.press("Escape")
  await expect(p.locator(".pointlens-shared-tooltip")).toHaveCSS("opacity", "0")
  const mutations = await p.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0
        const o = new MutationObserver((ms) => (n += ms.length))
        o.observe(document.body, { childList: true, subtree: true })
        setTimeout(() => {
          o.disconnect()
          resolve(n)
        }, 250)
      })
  )
  expect(mutations).toBe(0)
  await p.close()
})
test("Hyatt switches complementary value, removes sold-out pins, and rejects old search messages", async () => {
  const p = await openHyatt()
  await push(p)
  await expect(p.locator(".pointlens-hyatt-cpp-value")).toContainText(
    "2.00¢/pt"
  )
  await p.evaluate(() => {
    const url = new URL(location.href)
    url.searchParams.set("rateFilter", "woh")
    history.replaceState({}, "", url.href)
    document.querySelector("[role=switch]").setAttribute("aria-checked", "true")
  })
  await expect(p.locator(".pointlens-hyatt-cpp-value")).toHaveText(
    "2.00¢/pt · $240.00"
  )
  await push(p, { ...rate, status: "SOLD_OUT", points: 0 })
  await expect(p.locator(".pointlens-hyatt-cpp-value")).toHaveText(
    "Reward night unavailable"
  )
  await expect(p.locator(".pointlens-hyatt-pin-cpp")).toHaveCount(0)
  await p.evaluate(() =>
    window.postMessage(
      {
        __AV_HYATT_RATES__: true,
        context: "https://www.hyatt.com/old",
        rates: { chi: { rate: 999, points: 1 } }
      },
      location.origin
    )
  )
  await expect(p.locator(".pointlens-hyatt-cpp-value")).toHaveText(
    "Reward night unavailable"
  )
  await p.close()
})
test("Hyatt does not seed old rates from another search and tolerates split Flight chunks", async () => {
  await worker.evaluate(() =>
    chrome.storage.local.set({
      "pointlens:hyatt-rates": {
        chi: { rate: 99999, points: 1, status: "AVAILABLE" }
      }
    })
  )
  const p = await openHyatt()
  await expect(p.locator(".pointlens-hyatt-cpp-value")).toHaveText("")
  await p.evaluate((r) => {
    const s = JSON.stringify({ leadingRate: r })
    window.__next_f ??= []
    window.__next_f.push([1, s.slice(0, 50)])
    window.__next_f.push([1, s.slice(50)])
  }, rate)
  await expect(p.locator(".pointlens-hyatt-cpp-value")).toContainText(
    "2.00¢/pt"
  )
  await p.close()
})
test("unavailable FX never presents a foreign amount as USD cents", async () => {
  const p = await openHyatt()
  await push(p, {
    ...rate,
    currencyCode: "JPY",
    rate: 30000,
    rateAfterTax: 36000
  })
  await expect(p.locator(".pointlens-hyatt-cpp-value")).toHaveText(
    "USD conversion unavailable · 12,000 pts"
  )
  await expect(p.locator(".pointlens-hyatt-cpp-value")).not.toHaveClass(
    /is-good/
  )
  await p.close()
})
test("IHG quick-view footer shows CPP and a keyboard-accessible tooltip", async () => {
  const p = await context.newPage()
  await p.route("https://www.ihg.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body><div role="combobox" aria-label="Pay with">Money</div><app-hotel-card-list-view id="ORDHA"><div><app-hotel-price>200 USD</app-hotel-price></div></app-hotel-card-list-view><div class="map-marker-container"><div class="item-text"><span class="amount">200 USD</span></div></div><div class="ihg-ui-hotel-quick-view" role="dialog"><a href="/intercontinental/hotels/us/en/chicago/ordha/hoteldetail">Hotel website</a><div><div data-testid="rate-details">Rooms from 200 USD / night</div><button>Select a room</button></div></div></body>`
    })
  )
  await p.goto("https://www.ihg.com/hotels/us/en/find-hotels/hotel-search")
  await worker.evaluate(() =>
    chrome.storage.local.set({
      "pointlens:ihg-last-request": {
        bodyText: JSON.stringify({
          startDate: "2026-10-12",
          endDate: "2026-10-13",
          hotelMnemonics: ["ORDHA"],
          geoLocation: null,
          products: [{ quantity: 1 }],
          rates: { ratePlanCodes: [{ internal: "IVANI" }] }
        }),
        responseBodyText: JSON.stringify({
          hotels: [
            {
              hotelMnemonic: "ORDHA",
              propertyCurrency: "USD",
              lowestCashOnlyCost: { baseAmount: "200", amountAfterTax: "250" },
              lowestPointsOnlyCost: { points: 50000 },
              rewardNightAvailable: true
            }
          ]
        })
      }
    })
  )
  await expect(
    p.getByRole("dialog").locator(".pointlens-cpp-value")
  ).toContainText("0.50¢/pt")
  await expect(p.locator(".pointlens-cpp-value")).toHaveText([
    "0.50¢/pt · 50,000 pts",
    "0.50¢/pt · 50,000 pts"
  ])
  await expect(p.locator(".pointlens-map-cpp")).toHaveText("50K pts0.50¢/pt")
  await p.evaluate(() => {
    document.querySelector('[aria-label="Pay with"]').textContent = "Points"
    document.querySelector("app-hotel-price").textContent = "50,000 PTS"
    document.querySelector(".amount").textContent = "50K PTS"
    document.querySelector('[data-testid="rate-details"]').textContent =
      "Rooms from 50,000 PTS / night"
  })
  await expect(p.locator(".pointlens-cpp-value")).toHaveText([
    "0.50¢/pt · $250.00",
    "0.50¢/pt · $250.00"
  ])
  await expect(p.locator(".pointlens-map-cpp")).toHaveText("$250.000.50¢/pt")
  await p.locator(".pointlens-cpp-icon").first().focus()
  await expect(p.locator("#pointlens-value-details")).toHaveCSS("opacity", "1")
  await p.close()
})
test("Marriott tooltip refreshes even when changed cash/points keep the same CPP", async () => {
  const p = await context.newPage()
  await p.route("https://www.marriott.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body><article class="property-card" data-marsha="CHI"><a href="/reservation"><div class="rate-container">$250</div></a></article><div class="gm-style-iw"><a href="/hotels/travel/chi-test/">Hotel</a><div class="hotel-card-text-section"></div></div></body>'
    })
  )
  await p.goto("https://www.marriott.com/search/findHotels.mi")
  const capture = (cash, points) => ({
    hotels: [
      {
        property: { id: "CHI" },
        rates: [
          {
            rateCategory: { code: "StandardRates" },
            lengthOfStay: 1,
            rateModes: {
              lowestAverageRate: {
                amount: {
                  amount: cash * 100,
                  decimalPoint: 2,
                  currency: "USD"
                },
                totalAmount: {
                  amount: cash * 100,
                  decimalPoint: 2,
                  currency: "USD"
                }
              }
            }
          },
          { rateModes: { pointsPerUnit: { points } } }
        ]
      }
    ]
  })
  await p.evaluate(
    (v) =>
      window.postMessage(
        {
          __AV_MARRIOTT_SAVE__: true,
          payload: { ...v, context: location.href }
        },
        location.origin
      ),
    capture(250, 50000)
  )
  await expect(p.locator(".pointlens-marriott-cpp-value")).toContainText(
    "0.50¢/pt"
  )
  await expect(p.locator(".gm-style-iw .av-sub")).toHaveText("50k pts/night")
  await p.evaluate(
    (v) =>
      window.postMessage(
        {
          __AV_MARRIOTT_SAVE__: true,
          payload: { ...v, context: location.href }
        },
        location.origin
      ),
    capture(300, 60000)
  )
  await expect(p.locator(".gm-style-iw .av-sub")).toHaveText("60k pts/night")
  await p.close()
})
test("Hilton list uses multi-night totals and responds to tax-basis settings", async () => {
  const p = await context.newPage()
  await p.route("https://www.hilton.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body><article data-testid="hotel-card-CHI"><div data-testid="priceInfo"><a href="/book/reservation/rooms/">View Rates</a></div></article></body>'
    })
  )
  await p.goto(
    "https://www.hilton.com/en/search/?arrivalDate=2026-10-12&departureDate=2026-10-16"
  )
  await p.evaluate(() =>
    window.postMessage(
      {
        __AV_HILTON_PRICING__: true,
        payload: {
          meta: {
            context: 1,
            arrivalDate: "2026-10-12",
            departureDate: "2026-10-16",
            points: true
          },
          hotels: [
            {
              ctyhocn: "CHI",
              currencyCode: "USD",
              summary: {
                lowest: { rateAmount: 200, amountAfterTax: 1000 },
                hhonors: {
                  dailyRmPointsRate: 50000,
                  ratePlan: { ratePlanName: "Standard Room Reward" }
                }
              }
            }
          ]
        }
      },
      location.origin
    )
  )
  await expect(p.locator(".pointlens-hilton-cpp-value")).toContainText(
    "0.50¢/pt"
  )
  // Storage key is defined by the site's settings module.
  await worker.evaluate(() =>
    chrome.storage.local.set({
      "pointlens:hilton-value-settings": { taxBasis: "pretax" }
    })
  )
  await expect(p.locator(".pointlens-hilton-cpp-value")).toContainText(
    "0.40¢/pt"
  )
  await p.close()
})
test("IHG mixed payment subtracts copay consistently on list and map after mode changes", async () => {
  const p = await context.newPage()
  await p.route("https://www.ihg.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body><app-hotel-card-list-view id="ORDHA"><div><app-hotel-price>33,250 PTS + 519 USD</app-hotel-price></div></app-hotel-card-list-view><div class="map-marker-container"><div class="item-text"><span class="amount">33.25K PTS+519 USD</span></div></div></body>'
    })
  )
  await p.goto(
    "https://www.ihg.com/hotels/us/en/find-hotels/hotel-search?qPt=POINTS_CASH"
  )
  await worker.evaluate(() =>
    chrome.storage.local.set({
      "pointlens:ihg-last-request": {
        bodyText: JSON.stringify({
          startDate: "2026-10-12",
          endDate: "2026-10-13",
          hotelMnemonics: ["ORDHA"],
          geoLocation: null,
          products: [{ quantity: 1 }],
          rates: { ratePlanCodes: [{ internal: "IVANI" }] }
        }),
        responseBodyText: JSON.stringify({
          hotels: [
            {
              hotelMnemonic: "ORDHA",
              propertyCurrency: "USD",
              lowestCashOnlyCost: {
                baseAmount: "493.13",
                amountAfterTax: "621.33"
              },
              lowestPointsOnlyCost: { points: 113250 },
              lowestPointsAndCashCost: { points: 33250, cash: 519 },
              rewardNightAvailable: true
            }
          ]
        })
      }
    })
  )
  await expect(p.locator(".pointlens-cpp-value")).toContainText(
    "0.31¢/pt · Points + Cash"
  )
  await expect(p.locator(".pointlens-map-cpp")).toHaveText("0.31¢/pt")
  await p.evaluate(() => {
    history.pushState({}, "", "?qPt=POINTS")
    document.querySelector("app-hotel-price").textContent = "113,250 PTS"
    document.querySelector(".amount").textContent = "113.25K PTS"
  })
  await expect(p.locator(".pointlens-cpp-value")).toContainText("0.55¢/pt")
  await expect(p.locator(".pointlens-map-cpp")).toHaveText("$621.330.55¢/pt")
  await p.close()
})
test("IHG failed detail requests do not loop when the dialog refreshes", async () => {
  const p = await context.newPage()
  await p.route("https://www.ihg.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body><div class="ihg-ui-hotel-quick-view" role="dialog"><a href="/hotels/us/en/chicago/retry/hoteldetail">Hotel</a><div><div data-testid="rate-details">Points</div></div></div></body>'
    })
  )
  await worker.evaluate(() => {
    globalThis.__qaFetch = fetch
    globalThis.__qaCalls = 0
    globalThis.fetch = async () => {
      globalThis.__qaCalls++
      return new Response("{}", { status: 503 })
    }
  })
  try {
    await p.goto("https://www.ihg.com/hotels/us/en/find-hotels/hotel-search")
    await worker.evaluate(() =>
      chrome.storage.local.set({
        "pointlens:ihg-last-request": {
          bodyText: JSON.stringify({
            startDate: "2026-11-12",
            endDate: "2026-11-16",
            hotelMnemonics: ["RETRY"],
            geoLocation: null,
            products: [{ quantity: 1 }],
            rates: { ratePlanCodes: [{ internal: "IVANI" }] }
          }),
          responseBodyText: JSON.stringify({
            hotels: [
              {
                hotelMnemonic: "RETRY",
                propertyCurrency: "USD",
                lowestCashOnlyCost: { baseAmount: 200, amountAfterTax: 250 },
                lowestPointsOnlyCost: { points: 50000 }
              }
            ]
          })
        }
      })
    )
    await expect(p.locator(".pointlens-cpp-value")).toContainText("0.50¢/pt")
    await expect.poll(() => worker.evaluate(() => globalThis.__qaCalls)).toBe(1)
    await p.locator(".pointlens-cpp-icon").focus()
    await p.evaluate(() => new Promise((r) => setTimeout(r, 150)))
    expect(await worker.evaluate(() => globalThis.__qaCalls)).toBe(1)
  } finally {
    await worker.evaluate(() => {
      globalThis.fetch = globalThis.__qaFetch
    })
    await p.close()
  }
})

test("Hilton native pricing drives rooms, cash plans and points details without duplicate replays", async () => {
  await worker.evaluate(() =>
    chrome.storage.session.remove("pointlens:hilton:budget")
  )
  await worker.evaluate(() =>
    chrome.storage.local.remove("pointlens:hilton-value-settings")
  )
  const p = await context.newPage()
  const room = {
    roomTypeCode: "KXLX",
    roomTypeName: "King",
    roomOnlyRates: [
      {
        ratePlanCode: "FLEX",
        rateAmount: 379,
        fullAmountAfterTax: "$901.26",
        ratePlan: { ratePlanName: "Flexible Rate" }
      },
      {
        ratePlanCode: "MEMBER",
        rateAmount: 316.595,
        fullAmountAfterTax: "$752.86",
        ratePlan: { ratePlanName: "Honors Discount Non-refundable" }
      }
    ]
  }
  let requests = 0
  await p.route("https://www.hilton.com/**", (r) => {
    if (r.request().url().includes("/graphql/customer")) {
      requests++
      const points = r.request().postDataJSON().variables.specialRates?.hhonors
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            hotel: {
              ctyhocn: "CHITDHX",
              shopAvail: {
                currencyCode: "USD",
                roomTypes: [
                  {
                    ...room,
                    redemptionRoomRates: points
                      ? [
                          {
                            ratePlanCode: "SR",
                            totalCostPoints: 140000,
                            pointDetails: [{ pointsRate: 70000 }],
                            ratePlan: { ratePlanName: "Standard Room Reward" }
                          }
                        ]
                      : []
                  }
                ]
              }
            }
          }
        })
      })
    }
    return r.fulfill({
      contentType: "text/html",
      body: `<html><head></head><body><label><input id="usePoints" type="checkbox">Use Points & Money</label><section data-roomtypecode="KXLX"><h2>King</h2><button data-testid="moreRatesButton">More Rates From $317</button></section><div data-testid="standardRateBlock"><div data-testid="ratePrice"><p>$379</p><button>Rate details for Flexible Rate<span aria-hidden="true">Rate details</span></button></div></div><div data-testid="pamRatesBlock"><div><span data-testid="allPointsTotalCost">70,000</span></div></div></body></html>`
    })
  })
  await p.goto(
    "https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=CHITDHX&arrivalDate=2026-10-12&departureDate=2026-10-14&room1NumAdults=1&roomTypeCode=KXLX"
  )
  const native = async () =>
    p.evaluate(() =>
      fetch(
        "/graphql/customer?originalOpName=hotel_shopAvailOptions_shopPropAvail",
        {
          method: "POST",
          body: JSON.stringify({
            operationName: "hotel_shopAvailOptions_shopPropAvail",
            query:
              "query roomPricing { hotel { shopAvail { roomTypes { roomOnlyRates { rateAmount } redemptionRoomRates { totalCostPoints } } } } }",
            variables: {
              ctyhocn: "CHITDHX",
              arrivalDate: "2026-10-12",
              departureDate: "2026-10-14",
              numAdults: 1,
              specialRates: { hhonors: false }
            }
          })
        }
      )
    )
  await native()
  const roomBadge = p.locator("[data-roomtypecode] .pointlens-hilton-cpp-value")
  await expect(roomBadge).toHaveText("≈0.54¢/pt · 70,000 pts")
  await expect(
    p.locator('[data-testid="standardRateBlock"] .pointlens-hilton-cpp-value')
  ).toHaveText("≈0.64¢/pt · 70,000 pts")
  await expect(
    p.locator('[data-testid="pamRatesBlock"] .pointlens-hilton-cpp-value')
  ).toHaveText("≈0.54¢/pt · $376.43")
  expect(requests).toBe(2)
  await p.evaluate(() => {
    history.pushState({}, "", "/en/book/reservation/rates/")
    const selected = document.createElement("button")
    selected.dataset.testid = "roomSelectedLabel"
    selected.innerHTML = '<span class="sr-only">King</span>'
    document.body.append(selected)
  })
  await expect(
    p.locator('[data-testid="pamRatesBlock"] .pointlens-hilton-cpp-value')
  ).toHaveText("≈0.54¢/pt · $376.43")
  await native()
  await expect(roomBadge).toHaveText("≈0.54¢/pt · 70,000 pts")
  expect(requests).toBe(3)
  // Hilton uses separate button IDs for accessible rooms. Exercise that native
  // layout without requiring another pricing request or losing the room badge.
  await p.evaluate(() => {
    const card = document.querySelector('[data-roomtypecode="KXLX"]')
    card.dataset.testid = "accessibleRoomCard"
    card.querySelector('[data-testid="moreRatesButton"]').dataset.testid =
      "accessibleMoreRatesButton"
  })
  await p.locator("#usePoints").check()
  await expect(roomBadge).toHaveText("≈0.54¢/pt · $376.43")
  await p.evaluate(() => {
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("aria-label", "Honors Discount Non-refundable")
    dialog.innerHTML =
      '<div data-testid="quickLookRoomTypeName">King</div><div data-testid="priceDetailsExpandedSection"><div data-testid="currencyText">Price in $USD</div><span data-testid="totalRoomChargeAmount">$633.19</span><span data-testid="totalForStayAmount">$752.86</span></div>'
    document.body.append(dialog)
    document.querySelector('[data-testid="standardRateBlock"]').style.width =
      "150px"
    dispatchEvent(new Event("resize"))
  })
  await expect(
    p.locator('[data-testid="standardRateBlock"] .pointlens-hilton-cpp-value')
  ).toHaveText("≈0.64¢/pt · 70k")
  const bounds = await p
    .locator(
      '[data-testid="standardRateBlock"] .pointlens-hilton-price-placeholder'
    )
    .evaluate((e) => ({
      width: e.getBoundingClientRect().width,
      scroll: e.scrollWidth,
      height: e.getBoundingClientRect().height
    }))
  expect(bounds.scroll).toBeLessThanOrEqual(150)
  expect(bounds.height).toBeLessThan(30)
  await p.locator("[data-roomtypecode] .pointlens-hilton-cpp-icon").focus()
  await expect(p.locator("#pointlens-value-details")).toContainText("$633.19")
  await expect(p.locator("#pointlens-value-details")).toContainText("$119.67")
  await expect(p.locator("#pointlens-value-details")).toContainText(
    "140,000 pts"
  )
  await p.evaluate(() =>
    history.pushState(
      {},
      "",
      "/en/book/reservation/rooms/?ctyhocn=CHITDHX&arrivalDate=2026-10-12&departureDate=2026-10-15&room1NumAdults=1"
    )
  )
  await expect(p.locator(".pointlens-hilton-cpp-value")).toHaveCount(0)
  expect(requests).toBe(3)
  await p.close()
})

test("Hilton throttling survives across tabs and honors a server cooldown", async () => {
  await worker.evaluate(() =>
    chrome.storage.session.remove("pointlens:hilton:budget")
  )
  const p = await context.newPage()
  await p.goto(
    "https://www.hilton.com/en/search/?arrivalDate=2026-10-12&departureDate=2026-10-14"
  )
  // Exercise the real content bridge; tab scripts never receive credentials.
  const ask = (tab = p) =>
    tab.evaluate(
      () =>
        new Promise((resolve) => {
          const id = Math.random()
          const listener = (e) => {
            if (e.data?.__AV_HILTON_BUDGET_REPLY__ && e.data.id === id) {
              removeEventListener("message", listener)
              resolve(e.data.allowed)
            }
          }
          addEventListener("message", listener)
          postMessage({ __AV_HILTON_BUDGET__: true, id }, location.origin)
        })
    )
  expect(await ask()).toBe(true)
  expect(await ask()).toBe(false)
  await p.evaluate(() =>
    postMessage(
      { __AV_HILTON_FINISHED__: true, status: 429, retryMs: 1800000 },
      location.origin
    )
  )
  await expect
    .poll(() =>
      worker.evaluate(
        async () =>
          Number(
            (await chrome.storage.session.get("pointlens:hilton:budget"))[
              "pointlens:hilton:budget"
            ]?.until
          ) || 0
      )
    )
    .toBeGreaterThan(Date.now() + 1700000)
  const p2 = await context.newPage()
  await p2.goto("https://www.hilton.com/en/")
  expect(await ask(p2)).toBe(false)
  await p.close()
  await p2.close()
})

test("Hilton queues split native search batches and reuses overlapping hotel results", async () => {
  await worker.evaluate(() =>
    chrome.storage.session.remove("pointlens:hilton:budget")
  )
  const p = await context.newPage(),
    lookups = []
  const hotelIds = Array.from(
    { length: 35 },
    (_, i) => `H${String(i).padStart(2, "0")}`
  )
  await p.route("https://www.hilton.com/**", (route) => {
    if (route.request().url().includes("/graphql/customer")) {
      const b = route.request().postDataJSON(),
        award = b.variables.input.specialRates.hhonors
      if (award) lookups.push({ ids: b.variables.ctyhocns, time: Date.now() })
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            shopMultiPropAvail: b.variables.ctyhocns.map((ctyhocn) => ({
              ctyhocn,
              currencyCode: "USD",
              summary: {
                lowest: { rateAmount: 200, amountAfterTax: 480 },
                ...(award
                  ? {
                      hhonors: {
                        dailyRmPointsRate: 50000,
                        rateChangeIndicator: false
                      }
                    }
                  : {})
              }
            }))
          }
        })
      })
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<body>${hotelIds.map((id) => `<article data-testid="hotel-card-${id}"><div data-testid="priceInfo"><a href="/book/reservation/rooms/">View Rates</a></div></article>`).join("")}</body>`
    })
  })
  await p.goto(
    "https://www.hilton.com/en/search/?arrivalDate=2026-10-12&departureDate=2026-10-14"
  )
  await p.evaluate(
    (hotelIds) =>
      Promise.all(
        [hotelIds.slice(0, 20), hotelIds.slice(20), hotelIds.slice(5, 25)].map(
          (ids) =>
            fetch("/graphql/customer?originalOpName=shopMultiPropAvail", {
              method: "POST",
              body: JSON.stringify({
                operationName: "shopMultiPropAvail",
                query:
                  "query shopMultiPropAvail { shopMultiPropAvail { summary { lowest { rateAmount amountAfterTax } } } }",
                variables: {
                  ctyhocns: ids,
                  input: {
                    arrivalDate: "2026-10-12",
                    departureDate: "2026-10-14",
                    specialRates: { hhonors: false }
                  }
                }
              })
            })
        )
      ),
    hotelIds
  )
  await expect(p.locator(".pointlens-hilton-cpp-value")).toHaveText(
    Array(35).fill("≈0.48¢/pt · 50,000 pts"),
    { timeout: 12000 }
  )
  expect(lookups).toHaveLength(2)
  expect(lookups.every((r) => r.ids.length <= 20)).toBe(true)
  expect(lookups.flatMap((r) => r.ids).sort()).toEqual(hotelIds)
  if (lookups.length > 1)
    expect(lookups[1].time - lookups[0].time).toBeGreaterThanOrEqual(1900)
  await p.close()
})

for (const savedPoints of [false, true])
  for (const delayedBudget of [false, true])
    test(`Hyatt room capture pairs plans and fetches one opposite rate (saved points: ${savedPoints}, delayed budget: ${delayedBudget})`, async () => {
      const p = await context.newPage()
      const cash = {
        roomRates: {
          KING: {
            currencyCode: "USD",
            roomType: { title: "King" },
            ratePlans: [
              {
                id: "MEM",
                name: "Member Rate",
                rate: 200,
                rateAfterTax: 240,
                totalBeforeTax: 400.05,
                totalAfterTax: 480.06
              }
            ]
          },
          QUEEN: {
            currencyCode: "USD",
            roomType: { title: "Queen" },
            ratePlans: [
              {
                id: "MEM",
                name: "Member Rate",
                rate: 300,
                rateAfterTax: 360,
                totalBeforeTax: 600.05,
                totalAfterTax: 720.06
              }
            ]
          }
        }
      }
      const award = {
        roomRates: {
          KING: {
            currencyCode: "USD",
            roomType: { title: "King" },
            ratePlans: [
              {
                id: "STEXLP",
                name: "Point Award + Suite Upgrade",
                totalPoints: 10000
              }
            ]
          },
          QUEEN: {
            currencyCode: "USD",
            roomType: { title: "Queen" },
            ratePlans: [
              {
                id: "AWARD",
                name: "Standard Room Free Night",
                points: 15000,
                totalPoints: 30000
              }
            ]
          }
        }
      }
      let requests = 0
      await worker.evaluate(() =>
        chrome.storage.session.remove("pointlens:hyatt:pricing-budget")
      )
      await p.route("https://www.hyatt.com/**", (r) => {
        if (r.request().url().includes("/service/rooms/roomrates/")) {
          requests++
          return r.fulfill({
            contentType: "application/json",
            body: JSON.stringify(
              r.request().url().includes("rateFilter=woh") ||
                (savedPoints && !r.request().url().includes("rateFilter="))
                ? award
                : cash
            )
          })
        }
        return r.fulfill({
          contentType: "text/html",
          body: `<html><body><div class="room-card-divider"><h3 data-locator="room-title" id="KING-room-title">King</h3><div class="room-rate-content" data-locator="cash-rate"><span>Member Rate</span><span>$200</span></div></div><div class="room-card-divider"><h3 data-locator="room-title" id="QUEEN-room-title">Queen</h3><div class="room-rate-content" data-locator="cash-rate"><span>Member Rate</span><span>$300</span></div></div></body></html>`
        })
      })
      await p.goto(
        "https://www.hyatt.com/shop/rooms/test?checkinDate=2026-10-12&checkoutDate=2026-10-14&rooms=1&adults=1&rateFilter=standard"
      )
      if (delayedBudget)
        await worker.evaluate(() =>
          chrome.storage.session.set({
            "pointlens:hyatt:pricing-budget": {
              calls: [],
              activeUntil: Date.now() + 800,
              lease: "another-tab",
              last: Date.now() - 3000
            }
          })
        )
      await p.evaluate(() =>
        fetch(
          "/en-US/shop/service/rooms/roomrates/test?checkinDate=2026-10-12&checkoutDate=2026-10-14&rate=Standard"
        )
      )
      const badges = p.locator(".pointlens-hyatt-room-value")
      if (delayedBudget) {
        expect(requests).toBe(1)
        await expect(badges).toHaveCount(0)
        await expect(
          p.locator('.pointlens-hyatt-room-status[aria-busy="true"]')
        ).toHaveCount(2)
      }
      await expect(badges).toHaveCount(1)
      await expect(badges).toContainText("2.40¢/pt · 15,000 pts")
      await expect(p.locator(".pointlens-hyatt-room-status")).toHaveText(
        "Points unavailable"
      )
      await expect(p.locator(".pointlens-hyatt-room-status")).toHaveAttribute(
        "aria-busy",
        "false"
      )
      await badges.getByRole("button").focus()
      await expect(p.locator("#pointlens-value-details")).not.toContainText(
        "Lowest available room"
      )
      await expect(p.locator("#pointlens-value-details")).toContainText(
        "$60.00"
      )
      await expect(p.locator("#pointlens-value-details")).toContainText(
        "$300.03"
      )
      await expect(p.locator("#pointlens-value-details")).toContainText(
        "$360.03"
      )
      await p.evaluate(() => {
        history.replaceState(
          {},
          "",
          location.href.replace("rateFilter=standard", "rateFilter=woh")
        )
        document.querySelectorAll(".room-card-divider")[0].remove()
        const row = document.querySelector(".room-rate-content")
        row.setAttribute("data-locator", "points-rate")
        row.innerHTML =
          "<span>Standard Room Free Night</span><span>15,000</span>"
      })
      await expect(badges).toContainText("2.40¢/pt · $360.03")
      expect(requests).toBe(2)
      // A later complete award response removes rooms that are no longer bookable.
      award.roomRates = {}
      await p.evaluate(() =>
        fetch("/en-US/shop/service/rooms/roomrates/test?rateFilter=woh")
      )
      await p.evaluate(() => {
        history.replaceState(
          {},
          "",
          location.href.replace("rateFilter=woh", "rateFilter=standard")
        )
        const row = document.querySelector(".room-rate-content")
        row.setAttribute("data-locator", "cash-rate")
        row.innerHTML = "<span>Member Rate</span>$300"
      })
      await expect(badges).toHaveCount(0)
      await expect(p.locator(".pointlens-hyatt-room-status")).toHaveText(
        "Points unavailable"
      )
      expect(requests).toBe(3)
      await p.evaluate(() => {
        history.replaceState(
          {},
          "",
          location.href.replace("2026-10-14", "2026-10-15")
        )
        document.body.append(document.createElement("div"))
      })
      await expect(badges).toHaveCount(0)
      await p.close()
    })

for (const transport of ["combined", "fetch", "xhr"])
  test(`Marriott room cards and dialogs preserve native IDs (${transport})`, async () => {
    const p = await context.newPage()
    await worker.evaluate(() =>
      chrome.storage.session.remove("pointlens:marriott:pricing-budget")
    )
    const id = (plan, room) =>
      Buffer.from(
        `CHIRL|${plan}|${room}|2026-10-12|2026-10-14|fixture`
      ).toString("base64")
    const cashId = id("MEM", "STDO"),
      awardId = id("MRW", "STDO"),
      suiteId = id("MEM", "SUIT")
    const money = (amount) => ({
      amount: Math.round(amount * 100),
      currency: "USD",
      decimalPoint: 2
    })
    const node = (id, base, total, points) => ({
      id,
      basicInformation: { name: "Studio" },
      rates: {
        name: points ? "Redemption" : "Flexible",
        rateModes: points ? { pointsPerUnit: { points } } : {}
      },
      totalPricing: {
        quantity: 1,
        rateModes: {
          subtotalPerQuantity: { amount: money(base) },
          grandTotal: { amount: money(total) }
        }
      }
    })
    const data = {
      data: {
        commerce: {
          product: {
            searchProductsByProperty: {
              edges: [
                node(cashId, 400, 480),
                node(awardId, 430, 511.27, 30000),
                node(suiteId, 600, 720),
                {
                  ...node(id("MIXED", "STDO"), 1, 1),
                  rates: {
                    rateModes: {
                      cashAndPointsPerUnit: {
                        points: 15000,
                        amount: money(100)
                      }
                    }
                  }
                }
              ].map((node) => ({ node }))
            }
          }
        }
      }
    }
    let requests = 0
    const bodies = []
    await p.route("https://www.marriott.com/**", (r) => {
      if (r.request().url().includes("/mi/query/")) {
        requests++
        const body = r.request().postDataJSON()
        bodies.push(body)
        expect(r.request().headers()["x-room-fixture"]).toBe("preserved")
        const result = structuredClone(data)
        const edges =
          result.data.commerce.product.searchProductsByProperty.edges
        const combined =
          transport === "combined" ||
          body.variables.search.options.rateRequestTypes.some(
            (r) => r.type === "REDEMPTION"
          )
        if (!combined)
          result.data.commerce.product.searchProductsByProperty.edges =
            edges.filter((e) => !e.node.rates.rateModes.pointsPerUnit)
        else if (transport !== "combined") {
          for (const edge of edges)
            if (!edge.node.rates.rateModes.pointsPerUnit)
              edge.node.id = edge.node.id + "replayed"
        }
        return r.fulfill({
          contentType: "application/json",
          body: JSON.stringify(result)
        })
      }
      return r.fulfill({
        contentType: "text/html",
        body: `<html><body><div data-testid="RateCardV2"><a class="room-detail-link" href="/reservation/ersViewRoomPool.mi?productId=${transport === "combined" ? awardId : cashId}">Room Details</a><div class="room-desc"><div class="rate-details">30,000 points</div></div></div><div data-testid="RateCardV2"><a class="room-detail-link" href="/reservation/ersViewRoomPool.mi?productId=${suiteId}">Suite</a><div class="room-desc"><div class="rate-details">$300</div></div></div><div><a data-testid="rate-modal" href="/reservation/ersViewRateRules.mi?productId=${cashId}" onclick="event.preventDefault();document.querySelector('#rateDetailsContent').hidden=false">Rate Details</a></div><div id="rateDetailsContent" hidden><div><h1>Rate Details</h1></div></div></body></html>`
      })
    })
    await p.goto("https://www.marriott.com/reservation/rateListMenu.mi")
    await p.evaluate(async (transport) => {
      const url = "/mi/query/PhoenixBookDTTSearchProductsByProperty"
      const body = JSON.stringify({
        variables: {
          search: {
            propertyId: "CHIRL",
            options: {
              startDate: "2026-10-12",
              endDate: "2026-10-14",
              quantity: 1,
              rateRequestTypes: [
                { type: "STANDARD", value: "" },
                { type: "CLUSTER", value: "AAA" }
              ]
            }
          }
        }
      })
      if (transport === "xhr")
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest()
          xhr.open("POST", url)
          xhr.setRequestHeader("x-room-fixture", "preserved")
          xhr.onload = resolve
          xhr.send(body)
        })
      return fetch(
        new Request(new URL(url, location.href), {
          method: "POST",
          headers: { "x-room-fixture": "preserved" },
          body
        })
      )
    }, transport)
    await expect(p.locator(".pointlens-marriott-room-value")).toHaveCount(3)
    await expect(p.locator("[data-testid=RateCardV2]").first()).toContainText(
      transport === "combined" ? "1.60¢/pt · $480.00" : "1.60¢/pt · 30,000 pts"
    )
    await expect(p.locator("[data-testid=RateCardV2]").nth(1)).toContainText(
      "2.40¢/pt · 30,000 pts"
    )
    await p.locator("[data-testid=rate-modal]").click()
    await expect(p.locator("#rateDetailsContent")).toContainText(
      "1.60¢/pt · 30,000 pts"
    )
    expect(requests).toBe(transport === "combined" ? 1 : 2)
    if (transport !== "combined") {
      expect(
        bodies[1].variables.search.options.rateRequestTypes
      ).toContainEqual({ type: "CLUSTER", value: "AAA" })
      expect(
        bodies[1].variables.search.options.rateRequestTypes
      ).toContainEqual({ type: "REDEMPTION", value: "" })
      expect(bodies[1].variables.search.options.startDate).toBe("2026-10-12")
    }
    await p.close()
  })

for (const searchShape of ["searchByGeolocation", "searchByDestination"])
  test(`Marriott ${searchShape} preserves rates, map order and presentation changes`, async () => {
    const endpoint = `/mi/query/phoenixShopDatedSearchBy${searchShape === "searchByDestination" ? "Destination" : "Geo"}Query`
    const p = await context.newPage()
    await worker.evaluate(() =>
      chrome.storage.session.remove("pointlens:marriott:pricing-budget")
    )
    const amount = (n) => ({
      amount: n * 100,
      decimalPoint: 2,
      currency: "USD"
    })
    const hotel = (id, cash, points) => ({
      node: {
        property: { id },
        rates: [
          {
            rateCategory: { code: "StandardRates" },
            status: { code: "AvailableForSale" },
            lengthOfStay: 2,
            rateModes: {
              lowestAverageRate: {
                amount: amount(cash),
                totalAmount: amount(cash * 1.2),
                mandatoryFees: amount(id === "B" ? 30 : 0)
              }
            }
          },
          ...(points
            ? [
                {
                  rateCategory: { code: "Special", value: "MRW" },
                  status: { code: "AvailableForSale" },
                  lengthOfStay: 2,
                  rateModes: { pointsPerUnit: { points } }
                }
              ]
            : [])
        ]
      }
    })
    const requests = []
    await p.route("https://www.marriott.com/**", (r) => {
      if (r.request().url().includes("/mi/query/")) {
        const body = r.request().postDataJSON()
        requests.push(body)
        const combined = body.variables.search.options.rateRequestTypes.some(
          (x) => x.value === "MRW"
        )
        const edges = combined
          ? [hotel("B", 300, 40000), hotel("A", 200, 20000)]
          : [hotel("A", 200), hotel("B", 300)]
        return r.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              search: { lowestAvailableRates: { [searchShape]: { edges } } }
            }
          })
        })
      }
      return r.fulfill({
        contentType: "text/html",
        body: '<html><body><article class="property-card" data-marsha="A"><a href="/search/availabilityCalendar.mi"><div class="rate-container">$200</div></a></article><div class="gm-style"><div class="m-map-pin pin-0">$200</div><div class="m-map-pin pin-1">$300</div></div></body></html>'
      })
    })
    await p.goto(
      "https://www.marriott.com/search/findHotels.mi?fromDate=10/12/2026&toDate=10/14/2026"
    )
    await p.evaluate((endpoint) => {
      const request = fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          variables: {
            search: {
              options: {
                rateRequestTypes: [
                  { type: "STANDARD", value: "" },
                  { type: "CLUSTER", value: "AAA" }
                ]
              },
              startDate: "2026-10-12",
              endDate: "2026-10-14",
              rooms: 1
            }
          }
        })
      })
      history.replaceState(
        {},
        "",
        location.href + "&deviceType=desktop-web&view=map#/0/"
      )
      return request
    }, endpoint)
    await expect(p.locator(".pointlens-marriott-cpp-value")).toContainText(
      "2.40¢/pt · 10,000 pts"
    )
    await p.evaluate(() => {
      const points = document.createElement("input")
      points.type = "checkbox"
      points.name = "useRewardsPoints"
      points.checked = true
      document.body.append(points)
    })
    await expect(p.locator(".pointlens-marriott-cpp-value")).toContainText(
      "2.40¢/pt · $240.00"
    )
    expect(requests).toHaveLength(2)
    expect(
      requests[1].variables.search.options.rateRequestTypes
    ).toContainEqual({
      type: "CLUSTER",
      value: "AAA"
    })
    expect(requests[1].variables.search.startDate).toBe("2026-10-12")
    await expect(p.locator(".pin-0 .pointlens-marriott-pin-cpp")).toContainText(
      "2.40¢"
    )
    await p.evaluate(
      (endpoint) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            variables: {
              search: {
                options: {
                  rateRequestTypes: [
                    { type: "STANDARD", value: "" },
                    { type: "CLUSTER", value: "MRW" }
                  ]
                }
              }
            }
          })
        }),
      endpoint
    )
    await expect(p.locator(".pin-0 .pointlens-marriott-pin-cpp")).toContainText(
      "1.65¢"
    )
    await p.evaluate(() => {
      const layer = document.createElement("div")
      layer.className = "smart-info-window-portal-layer"
      layer.innerHTML =
        '<div class="HotelCard"><div class="hotel-card-text-section"><a href="/search/availabilityCalendar.mi?propertyCode=B">40,000 Points</a></div></div>'
      document.body.append(layer)
    })
    await expect(
      p.locator(".HotelCard .pointlens-marriott-detail-cpp")
    ).toContainText("1.65¢/pt")
    expect(requests).toHaveLength(3)
    await p.close()
  })

for (const status of [200, 429])
  test(`Hyatt room availability distinguishes empty awards from lookup failure (${status})`, async () => {
    const p = await context.newPage()
    await worker.evaluate(() =>
      chrome.storage.session.remove("pointlens:hyatt:pricing-budget")
    )
    let requests = 0
    await p.route("https://www.hyatt.com/**", (r) => {
      if (r.request().url().includes("/service/rooms/roomrates/")) {
        requests++
        const award = r.request().url().includes("rateFilter=woh")
        return r.fulfill({
          status: award ? status : 200,
          contentType: "application/json",
          body: JSON.stringify(
            award
              ? { roomRates: {} }
              : {
                  roomRates: {
                    KING: {
                      roomType: { title: "King" },
                      currencyCode: "USD",
                      ratePlans: [
                        {
                          id: "MEM",
                          name: "Member",
                          totalBeforeTax: 200,
                          totalAfterTax: 240
                        }
                      ]
                    }
                  }
                }
          )
        })
      }
      return r.fulfill({
        contentType: "text/html",
        body: '<html><body><div class="room-card-divider"><h3 data-locator="room-title" id="KING-room-title">King</h3><div class="room-rate-content" data-locator="cash-rate"><span>Member</span>$200</div></div></body></html>'
      })
    })
    await p.goto(
      "https://www.hyatt.com/shop/rooms/test?checkinDate=2026-09-18&checkoutDate=2026-09-19&rateFilter=standard"
    )
    await expect(
      p.locator('.pointlens-hyatt-room-status[aria-busy="true"]')
    ).toHaveCount(1)
    await p.evaluate(() =>
      fetch("/en-US/shop/service/rooms/roomrates/test?rateFilter=standard")
    )
    await expect(p.locator(".pointlens-hyatt-room-status")).toHaveText(
      status === 200 ? "Points unavailable" : "Couldn’t load points"
    )
    await expect(p.locator(".pointlens-hyatt-room-status")).toHaveAttribute(
      "aria-busy",
      "false"
    )
    await expect(p.locator(".pointlens-room-pill")).toHaveCount(0)
    expect(requests).toBe(2)
    await p.close()
  })
