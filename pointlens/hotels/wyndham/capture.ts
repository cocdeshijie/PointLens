import { observeNativeJson } from "../../shared/native-json"
import {
  requestPricingBudget,
  requestPricingBudgetDecision
} from "../../shared/pricing-budget"
import { overviewPricing } from "./overview"
import {
  complementUrl,
  parseWyndham,
  pricingScope,
  wyndhamContext,
  type WyndhamSnapshot
} from "./pricing"

export function installWyndhamCapture() {
  const nativeFetch = window.fetch
  let context = ""
  const batches = new Map<
    string,
    { snapshot: WyndhamSnapshot; revision: number; captured: number }
  >()
  const jobs = new Map<
    string,
    { url: string; page: string; request?: Request; revision: number }
  >()
  const attempted = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  const publish = () => {
    for (const { snapshot } of batches.values())
      if (snapshot.scope === "search") {
        for (const award of snapshot.offers.filter((o) => o.points)) {
          const cash = snapshot.offers.find(
            (o) => !o.points && o.hotel === award.hotel
          )
          if (cash) award.currency = cash.currency
        }
      }
    window.postMessage(
      {
        __POINTLENS_WYNDHAM__: true,
        context,
        snapshots: [...batches.values()].map((b) => b.snapshot)
      },
      location.origin
    )
  }
  const reset = (next: string) => {
    context = next
    batches.clear()
    jobs.clear()
    attempted.clear()
    clearTimeout(timer)
  }
  const current = (page: string) =>
    wyndhamContext(page) === wyndhamContext(location.href) &&
    context === wyndhamContext(page)
  const run = async () => {
    if (running || !jobs.size) return
    const [key, job] = jobs.entries().next().value!
    if (!current(job.page)) {
      jobs.delete(key)
      void run()
      return
    }
    running = true
    const lease = crypto.randomUUID()
    let acquired = false
    let delayed = false
    try {
      const decision = await requestPricingBudgetDecision(
        "wyndham",
        undefined,
        { lease }
      )
      acquired = decision.allowed
      if (!current(job.page) || jobs.get(key) !== job) return
      if (!acquired) {
        delayed = true
        timer = setTimeout(
          () => void run(),
          Math.max(500, (decision.retryAt ?? Date.now() + 2000) - Date.now())
        )
        return
      }
      attempted.add(key)
      const response = await nativeFetch(job.url, {
        credentials: job.request?.credentials ?? "include",
        headers: job.request?.headers,
        signal: AbortSignal.timeout(15000)
      })
      if (!response.ok) {
        void requestPricingBudget("wyndham", response.status, {
          retryAfter: response.headers.get("retry-after") ?? undefined
        })
        throw Error("Pricing unavailable")
      }
      const parsed = parseWyndham(await response.json(), job.url, job.page)
      if (!parsed) throw Error("Invalid pricing response")
      const batch = batches.get(key)
      if (!current(job.page) || !batch || batch.revision !== job.revision)
        return
      const prior = batch.snapshot
      // Keep the user's native price; supplement only the missing side.
      for (const offer of parsed.offers) {
        const side = offer.points ? "points" : "cash"
        if (prior.hotels[offer.hotel]?.[side] === "pending")
          prior.offers.push(offer)
      }
      for (const [hotel, state] of Object.entries(prior.hotels))
        for (const side of ["cash", "points"] as const)
          if (state[side] === "pending")
            state[side] = parsed.hotels[hotel]?.[side] ?? "error"
    } catch {
      const batch = batches.get(key)
      if (current(job.page) && batch?.revision === job.revision)
        for (const state of Object.values(batch.snapshot.hotels))
          for (const side of ["cash", "points"] as const)
            if (state[side] === "pending") state[side] = "error"
    } finally {
      if (acquired)
        void requestPricingBudget("wyndham", undefined, { release: lease })
      if (!delayed && jobs.get(key) === job) jobs.delete(key)
      running = false
      publish()
      if (!delayed && jobs.size) void run()
    }
  }
  observeNativeJson(
    (url) => !!pricingScope(url),
    (data, url, page, _body, request, revision = 0) => {
      if (wyndhamContext(page) !== wyndhamContext(location.href)) return
      const next = wyndhamContext(page)
      if (context !== next) reset(next)
      const parsed = parseWyndham(data, new URL(url, location.href).href, page)
      if (!parsed) return
      const key = complementUrl(url)!
      const old = batches.get(key)
      if (old && old.revision > revision) return
      // Preserve already captured opposite rates when a user switches modes.
      if (old && Date.now() - old.captured < 300000)
        for (const [hotel, state] of Object.entries(parsed.hotels))
          for (const side of ["cash", "points"] as const)
            if (
              state[side] === "pending" &&
              old.snapshot.hotels[hotel]?.[side] === "ready"
            ) {
              state[side] = "ready"
              parsed.offers.push(
                ...old.snapshot.offers.filter(
                  (o) => o.hotel === hotel && !!o.points === (side === "points")
                )
              )
            }
      if (old && Date.now() - old.captured >= 300000) attempted.delete(key)
      // Later overlapping batches supersede earlier prices for the same hotel.
      for (const [otherKey, other] of batches)
        if (otherKey !== key && other.snapshot.scope === parsed.scope)
          for (const hotel of Object.keys(parsed.hotels)) {
            delete other.snapshot.hotels[hotel]
            other.snapshot.offers = other.snapshot.offers.filter(
              (o) => o.hotel !== hotel
            )
          }
      for (const [otherKey, other] of batches)
        if (!Object.keys(other.snapshot.hotels).length) {
          batches.delete(otherKey)
          jobs.delete(otherKey)
        }
      batches.set(key, { snapshot: parsed, revision, captured: Date.now() })
      jobs.delete(key)
      const missing = Object.values(parsed.hotels).some(
        (s) => s.cash === "pending" || s.points === "pending"
      )
      if (missing && !attempted.has(key))
        jobs.set(key, { url: key, page, request, revision })
      else if (missing)
        for (const s of Object.values(parsed.hotels))
          for (const side of ["cash", "points"] as const)
            if (s[side] === "pending") s[side] = "error"
      publish()
      void run()
    },
    (status, retryAfter) => {
      void requestPricingBudget("wyndham", status, {
        retryAfter: retryAfter ?? undefined
      })
    }
  )
  let bootstrapTimer: ReturnType<typeof setTimeout> | undefined
  const bootstrap = () => {
    if (bootstrapTimer) return
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = undefined
      const overview = overviewPricing(document, location.href)
      if (!overview) return
      const page = location.href
      const next = wyndhamContext(page)
      if (context !== next) reset(next)
      if ([...batches.values()].some((b) => b.snapshot.hotels[overview.hotel]))
        return
      const key = complementUrl(overview.url)!
      if (attempted.has(key)) return
      batches.set(key, {
        captured: Date.now(),
        revision: -1,
        snapshot: {
          context,
          scope: "search",
          offers: [],
          hotels: {
            [overview.hotel]: { cash: "pending", points: "pending" }
          }
        }
      })
      jobs.set(key, { url: key, page, revision: -1 })
      publish()
      void run()
    }, 1800)
  }
  new MutationObserver(bootstrap).observe(document.documentElement, {
    childList: true,
    subtree: true
  })
  window.addEventListener("popstate", bootstrap)
  bootstrap()
  window.addEventListener("message", (e) => {
    if (
      e.source === window &&
      e.origin === location.origin &&
      e.data?.__POINTLENS_WYNDHAM_READY__
    )
      publish()
  })
}
