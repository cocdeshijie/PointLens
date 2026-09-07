import type { HotelSnapshot } from "../../shared/hotel-quotes"
import { observeNativeJson } from "../../shared/native-json"
import { requestPricingBudgetDecision } from "../../shared/pricing-budget"
import { bestwesternRequest, parseBestwestern } from "./pricing"

export function installBestwesternCapture() {
  const nativeFetch = window.fetch.bind(window)
  const snapshots = new Map<string, HotelSnapshot>()
  const attempted = new Set<string>()
  const pending: (() => void)[] = []
  let context = "",
    revision = 0,
    timer: ReturnType<typeof setTimeout> | undefined
  const publish = () =>
    window.postMessage(
      { __POINTLENS_BESTWESTERN__: true, snapshots: [...snapshots.values()] },
      location.origin
    )
  const currency = () =>
    document.querySelector("#currency-code-hv")?.textContent?.trim()
  const store = (data: unknown, url: string, sequence: number) => {
    const s = parseBestwestern(data, url, currency())
    if (!s) return false
    if (s.context !== context) {
      if (sequence < revision) return false
      context = s.context
      snapshots.clear()
      if (timer) clearTimeout(timer)
    }
    revision = Math.max(revision, sequence)
    snapshots.set(s.key, s)
    publish()
    return true
  }
  const complement = async (source: Request, sequence: number) => {
    const req = bestwesternRequest(source.url)
    if (!req || req.context !== context) return
    const u = new URL(source.url)
    if (req.scope === "search") {
      if (snapshots.has(`search:${!req.points}`)) return
      if (req.points) u.searchParams.delete("ratePlan")
      else u.searchParams.set("ratePlan", "BWR")
    } else {
      // Native room pages usually supply both sides. Only fill a missing award
      // plan, never fan out cash requests for every room or rate plan.
      if (
        [...snapshots.values()].some((s) =>
          Object.values(s.hotels).some((h) => h.points)
        )
      )
        return
      u.searchParams.set("rateplan", "FX")
    }
    const key = `${context}:${u.searchParams.get("ratePlan") ?? u.searchParams.get("rateplan") ?? "cash"}`
    if (attempted.has(key)) return
    const lease = crypto.randomUUID()
    const decision = await requestPricingBudgetDecision(
      "bestwestern",
      undefined,
      { lease }
    )
    if (!decision.allowed) {
      // Respect cross-tab spacing; never spin on rate limits or denied access.
      if (
        decision.retryAt &&
        decision.retryAt - Date.now() < 20000 &&
        context === req.context
      )
        timer = setTimeout(
          () => void complement(source, sequence),
          Math.max(500, decision.retryAt - Date.now())
        )
      return
    }
    attempted.add(key)
    if (attempted.size > 100) attempted.delete(attempted.values().next().value!)
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 15000)
    try {
      if (context !== req.context) return
      const response = await nativeFetch(new Request(u, source), {
        signal: controller.signal
      })
      if (!response.ok) {
        await requestPricingBudgetDecision("bestwestern", response.status, {
          retryAfter: response.headers.get("retry-after") ?? undefined
        })
        return
      }
      const data = await response.json()
      if (context === req.context) store(data, u.href, sequence)
    } catch {
    } finally {
      clearTimeout(timeout)
      void requestPricingBudgetDecision("bestwestern", undefined, {
        release: lease
      })
    }
  }
  observeNativeJson(
    (url) => !!bestwesternRequest(url),
    (data, url, _page, _body, request, sequence = 0) => {
      const receive = () => {
        if (!store(data, url, sequence)) return
        if (request) {
          if (timer) clearTimeout(timer)
          // Give all native parallel room responses time to settle first.
          timer = setTimeout(() => void complement(request, sequence), 2200)
        }
      }
      if (!currency() && bestwesternRequest(url)?.scope === "rooms") {
        pending.push(receive)
        if (pending.length > 50) pending.shift()
      } else receive()
    },
    (status, retryAfter) => {
      void requestPricingBudgetDecision("bestwestern", status, {
        retryAfter: retryAfter ?? undefined
      })
    }
  )
  // RACK often arrives before the native page publishes the hotel's currency.
  // Retain that response until the DOM supplies the currency instead of losing
  // the first (flexible) rate or assuming every property uses USD.
  new MutationObserver(() => {
    if (pending.length && currency())
      for (const receive of pending.splice(0)) receive()
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  })
  window.addEventListener("message", (e) => {
    if (
      e.source === window &&
      e.origin === location.origin &&
      e.data?.__POINTLENS_BESTWESTERN_READY__
    )
      publish()
  })
}
