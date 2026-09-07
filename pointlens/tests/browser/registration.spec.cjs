const { test, expect, chromium } = require("@playwright/test")
const { mkdtemp, rm, cp, writeFile, readFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const path = require("node:path")

test("static MAIN scripts load once and replace legacy registrations with missing bundles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pointlens-registration-"))
  const extension = path.join(root, "extension")
  const profile = path.join(root, "profile")
  let context
  const errors = []
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`
      ]
    })
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"))
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    await expect
      .poll(() =>
        worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())
      )
      .toEqual([])
    return worker
  }
  try {
    await cp(path.resolve("build/chrome-mv3-prod"), extension, {
      recursive: true
    })
    const manifest = JSON.parse(
      await readFile(path.join(extension, "manifest.json"), "utf8")
    )
    const main = manifest.content_scripts.filter((s) => s.world === "MAIN")
    expect(main.map((s) => s.matches[0]).sort()).toEqual([
      "https://www.choicehotels.com/*",
      "https://www.hyatt.com/*",
      "https://www.ihg.com/*",
      "https://www.marriott.com/*",
      "https://www.wyndhamhotels.com/*"
    ])
    expect(main.every((s) => s.run_at === "document_start")).toBe(true)
    for (const entry of main) {
      for (const file of entry.js)
        expect(
          (await readFile(path.join(extension, file))).length
        ).toBeGreaterThan(0)
    }
    const worker = await launch()
    await writeFile(
      path.join(extension, "legacy-main.js"),
      "/* obsolete bundle */"
    )
    // Seed the exact IDs used by old releases, then remove their hashed file.
    await worker.evaluate(async () => {
      await chrome.scripting.registerContentScripts(
        ["Hyatt", "Ihg", "Marriott"].map((brand) => ({
          id: `contents${brand}Main`,
          js: ["legacy-main.js"],
          matches: [`https://www.${brand.toLowerCase()}.com/*`],
          world: "MAIN",
          runAt: "document_start"
        }))
      )
    })
    await context.close()
    await rm(path.join(extension, "legacy-main.js"))
    await launch()
    const page = await context.newPage()
    await context.route("https://**/*", (route) =>
      route.fulfill({
        contentType: route.request().url().includes("/roomrates/")
          ? "application/json"
          : "text/html",
        body: route.request().url().includes("/roomrates/")
          ? '{"roomRates":{}}'
          : "<html><body>Static script fixture</body></html>"
      })
    )
    await page.goto(
      "https://www.hyatt.com/shop/rooms/test?checkinDate=2026-10-12&checkoutDate=2026-10-14"
    )
    // The native request is visible to a MAIN-world observer, once, after migration.
    const messages = await page.evaluate(async () => {
      const captured = []
      const listener = (e) => {
        if (e.data?.__POINTLENS_HYATT_ROOMS__) captured.push(e.data)
      }
      window.addEventListener("message", listener)
      await fetch("/en-US/shop/service/rooms/roomrates/test?rateFilter=fixture")
      await new Promise((resolve) => setTimeout(resolve, 150))
      window.removeEventListener("message", listener)
      return captured.filter((m) => m.context.includes("/shop/rooms/test"))
    })
    expect(messages).toHaveLength(1)
    expect(errors).toEqual([])
  } finally {
    await context?.close()
    await rm(root, { recursive: true, force: true })
  }
})
