import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { JSDOM } from "jsdom"
import ts from "typescript"

test("IHG observation returns fetch before body completion and preserves native Response methods", async () => {
  const dom = new JSDOM("<body></body>", {
    url: "https://www.ihg.com/",
    runScripts: "outside-only"
  })
  const w = dom.window
  let controller
  const body = new ReadableStream({
    start(c) {
      controller = c
    }
  })
  const response = new Response(body, {
    headers: { "content-type": "application/json" }
  })
  Object.assign(w, {
    Response,
    Request,
    Headers,
    TextDecoder,
    exports: {},
    fetch: async () => response
  })
  const methods = [
    Response.prototype.text,
    Response.prototype.json,
    Response.prototype.clone
  ]
  const source = await readFile(
    new URL("../hotels/ihg/content-main.ts", import.meta.url),
    "utf8"
  )
  w.eval(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS
      }
    }).outputText
  )
  const message = new Promise((resolve) =>
    w.addEventListener("message", (e) => {
      if (e.data.__AWARD_VIEWER_IHG__) resolve(e.data)
    })
  )
  const request = new Request(
    "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=summary",
    { method: "POST", body: '{"startDate":"2026-10-12"}' }
  )
  let timer
  try {
    const result = await Promise.race([
      w.fetch(request),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("page fetch was blocked on capture")),
          250
        )
      })
    ])
    assert.equal(result, response)
  } finally {
    clearTimeout(timer)
  }
  assert.deepEqual(
    [
      Response.prototype.text,
      Response.prototype.json,
      Response.prototype.clone
    ],
    methods
  )
  controller.enqueue(new TextEncoder().encode('{"hotels":[]}'))
  controller.close()
  assert.equal(await response.text(), '{"hotels":[]}')
  const captured = await message
  assert.equal(captured.bodyText, '{"startDate":"2026-10-12"}')
  assert.equal(captured.responseBodyText, '{"hotels":[]}')
  dom.window.close()
})

test("Hilton observes Request bodies without delaying fetch or leaking guest metadata", async () => {
  const dom = new JSDOM("<body></body>", {
    url: "https://www.hilton.com/en/search/",
    runScripts: "outside-only"
  })
  const w = dom.window
  let controller
  const response = new Response(
    new ReadableStream({
      start(c) {
        controller = c
      }
    }),
    { headers: { "content-type": "application/json" } }
  )
  let nativeCalls = 0
  Object.assign(w, {
    Request,
    Response,
    Headers,
    AbortSignal,
    fetch: async (request) => {
      nativeCalls++
      await request.text()
      return response
    }
  })
  w.eval(
    await readFile(
      new URL(
        "../hotels/hilton/injected/hilton-fetch-hook.js",
        import.meta.url
      ),
      "utf8"
    )
  )
  const captured = new Promise((resolve) =>
    w.addEventListener("message", (e) => {
      if (e.data?.__AV_HILTON_PRICING__) resolve(e.data.payload)
    })
  )
  const req = new Request(
    "https://www.hilton.com/graphql/customer?originalOpName=shopMultiPropAvailPoints",
    {
      method: "POST",
      body: JSON.stringify({
        operationName: "shopMultiPropAvail",
        variables: {
          ctyhocns: ["CHITDHX"],
          input: {
            arrivalDate: "2026-10-12",
            departureDate: "2026-10-14",
            guestId: "PRIVATE-GUEST",
            specialRates: { hhonors: true }
          }
        },
        query: "query search {}"
      })
    }
  )
  let timer
  try {
    assert.equal(
      await Promise.race([
        w.fetch(req),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("native response delayed")),
            250
          )
        })
      ]),
      response
    )
    const data = {
      data: {
        shopMultiPropAvail: [
          {
            ctyhocn: "CHITDHX",
            currencyCode: "USD",
            summary: {
              lowest: { rateAmount: 200, amountAfterTax: 480 },
              hhonors: { dailyRmPointsRate: 50000 }
            },
            personalInfo: { email: "PRIVATE-EMAIL" }
          }
        ]
      }
    }
    controller.enqueue(new TextEncoder().encode(JSON.stringify(data)))
    controller.close()
    assert.deepEqual(await response.json(), data)
    const payload = await captured
    assert.equal(payload.hotels[0].summary.hhonors.dailyRmPointsRate, 50000)
    assert.ok(!JSON.stringify(payload).includes("PRIVATE"))
    assert.equal(nativeCalls, 1)
  } finally {
    clearTimeout(timer)
    dom.window.close()
  }
})
