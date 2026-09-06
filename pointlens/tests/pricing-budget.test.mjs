import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = ts.transpileModule(
  await readFile(
    new URL("../shared/pricing-budget.ts", import.meta.url),
    "utf8"
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }
).outputText

test("pricing budgets serialize tabs, release only the matching lease, and retain Retry-After across workers", async () => {
  let now = 1000000
  const records = {}
  const startWorker = () => {
    const exports = {}
    let listener
    vm.runInNewContext(source, {
      exports,
      Date: { now: () => now, parse: Date.parse },
      chrome: {
        runtime: {
          onMessage: {
            addListener: (fn) => {
              listener = fn
            }
          }
        },
        storage: {
          session: {
            get: async (key) => ({ [key]: records[key] }),
            set: async (values) => Object.assign(records, values)
          }
        }
      }
    })
    exports.registerPricingBudget("hyatt")
    return (details = {}) =>
      new Promise((resolve) =>
        listener(
          { type: "POINTLENS_hyatt_BUDGET", ...details },
          { url: "https://www.hyatt.com/shop/rooms/test" },
          resolve
        )
      )
  }
  let send = startWorker()
  const concurrent = await Promise.all([
    send({ lease: "a" }),
    send({ lease: "b" })
  ])
  assert.deepEqual(
    concurrent.map((r) => r.allowed),
    [true, false]
  )
  assert.equal(concurrent[1].retryAt, now + 2500)
  now += 3000
  assert.equal((await send({ lease: "b" })).allowed, false)
  await send({ release: "wrong" })
  assert.equal((await send({ lease: "b" })).allowed, false)
  await send({ release: "a" })
  assert.equal((await send({ lease: "b" })).allowed, true)
  await send({ status: 429, retryAfter: "3600", release: "b" })
  assert.equal((await send({ lease: "blocked" })).retryAt, now + 3600000)
  now += 16 * 60000
  send = startWorker()
  assert.equal((await send({ lease: "c" })).allowed, false)
  now += 45 * 60000
  assert.equal((await send({ lease: "c" })).allowed, true)
  // A lost tab cannot hold the brand's budget indefinitely.
  now += 21000
  assert.equal((await send({ lease: "d" })).allowed, true)
})
