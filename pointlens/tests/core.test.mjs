import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"

import { extractSearchSignature } from "../hotels/ihg/search.ts"
import { hasHostMutation } from "../shared/dom.ts"
import { fetchUsdRate } from "../shared/fx.ts"

const base = {
  startDate: "2026-10-12",
  endDate: "2026-10-16",
  geoLocation: null,
  hotelMnemonics: ["ORDHA"],
  products: [{ quantity: 1, guestCounts: [{ count: 2, type: "ADULT" }] }]
}
test("IHG search identity supports current hotel lists and separates dates and guests", () => {
  const key = extractSearchSignature(base)
  assert.ok(key)
  assert.equal(
    key,
    extractSearchSignature({
      ...base,
      rates: { ratePlanCodes: [{ internal: "IVANI" }] },
      radius: 50
    })
  )
  assert.notEqual(
    key,
    extractSearchSignature({ ...base, endDate: "2026-10-17" })
  )
  assert.notEqual(
    key,
    extractSearchSignature({ ...base, products: [{ quantity: 2 }] })
  )
  assert.notEqual(
    key,
    extractSearchSignature({ ...base, hotelMnemonics: ["CHIMM"] })
  )
  assert.equal(null, extractSearchSignature("{bad"))
})

test("observers ignore badge writes but notice host card changes and badge removals", async () => {
  const dom = new JSDOM(
    '<body><article><span class="pointlens-hyatt-price-placeholder">old</span></article><div class="pointlens-pin-annotated"></div></body>'
  )
  const { document, MutationObserver } = dom.window
  const records = []
  const observer = new MutationObserver((ms) => records.push(...ms))
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true
  })
  document.querySelector("span").textContent = "new"
  await Promise.resolve()
  assert.equal(hasHostMutation(records.splice(0)), false)
  document.querySelector("article").setAttribute("data-spirit-code", "CHIPH")
  await Promise.resolve()
  assert.equal(hasHostMutation(records.splice(0)), true)
  document
    .querySelector(".pointlens-pin-annotated")
    .appendChild(document.createElement("b"))
  await Promise.resolve()
  assert.equal(hasHostMutation(records.splice(0)), true)
  document.querySelector("span").remove()
  await Promise.resolve()
  assert.equal(hasHostMutation(records), true)
  dom.window.close()
})

test("FX requests deduplicate, cache valid rates, validate inputs and back off on failure", async () => {
  const storage = {}
  let calls = 0
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (value) => Object.assign(storage, value)
      }
    }
  }
  globalThis.fetch = async () => {
    calls++
    return { ok: true, json: async () => ({ rates: { USD: 1.2 } }) }
  }
  assert.deepEqual(
    await Promise.all([fetchUsdRate("EUR"), fetchUsdRate("eur")]),
    [1.2, 1.2]
  )
  assert.equal(calls, 1)
  assert.equal(await fetchUsdRate("EUR"), 1.2)
  assert.equal(calls, 1)
  assert.equal(await fetchUsdRate("../EUR"), null)
  assert.equal(await fetchUsdRate("USD"), 1)
  storage["pointlens:fx-usd:GBP"] = { rate: -1, ts: Date.now() }
  assert.equal(await fetchUsdRate("GBP"), 1.2)
  globalThis.fetch = async () => {
    calls++
    throw Error("offline")
  }
  assert.equal(await fetchUsdRate("JPY"), null)
  const before = calls
  assert.equal(await fetchUsdRate("JPY"), null)
  assert.equal(calls, before)
})

test("mixed payment CPP subtracts the cash copay on the same nightly basis", async () => {
  const { calculateCpp } = await import("../shared/value.ts")
  assert.equal(calculateCpp(621.33, 33250, 519).toFixed(2), "0.31")
  assert.equal(calculateCpp(621.33, 113250).toFixed(2), "0.55")
  assert.equal(calculateCpp(250, 0), undefined)
  assert.equal(calculateCpp(undefined, 50000), undefined)
  assert.equal(calculateCpp(250, 50000, -1), undefined)
  assert.equal(calculateCpp(200, 10000, 250), -0.5)
})
