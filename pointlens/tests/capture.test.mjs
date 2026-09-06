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
