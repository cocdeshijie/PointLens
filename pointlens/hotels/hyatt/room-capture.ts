import { observeNativeJson } from "../../shared/native-json"
import {
  requestPricingBudget,
  requestPricingBudgetDecision
} from "../../shared/pricing-budget"
import type { RoomOffer } from "../../shared/room-value"
import { hyattStayContext, parseHyattRooms } from "./room-pricing"

export function installHyattRoomCapture() {
  let context = ""
  const offers = new Map<string, RoomOffer>()
  const attempted = new Set<string>()
  type State = "pending" | "ready" | "error"
  let availability: { cash: State; points: State } = {
    cash: "pending",
    points: "pending"
  }
  const nativeFetch = window.fetch
  const clearSide = (side: "cash" | "points") => {
    for (const [id, offer] of offers)
      if (!!offer.points === (side === "points")) offers.delete(id)
  }
  const publish = () =>
    window.postMessage(
      {
        __POINTLENS_HYATT_ROOMS__: true,
        context,
        availability,
        offers: [...offers.values()]
      },
      location.origin
    )
  const eligible = (url: string) => {
    try {
      const u = new URL(url, location.href)
      return (
        u.origin === location.origin &&
        /\/shop\/service\/rooms\/roomrates\/[^/]+$/.test(u.pathname)
      )
    } catch {
      return false
    }
  }
  type Pending = {
    key: string
    page: string
    context: string
    request?: Request
    side: "cash" | "points"
  }
  let pending: Pending | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let checking = false
  const cancel = () => {
    pending = undefined
    clearTimeout(timer)
    timer = undefined
  }
  const current = (job: Pending) =>
    pending === job &&
    context === job.context &&
    hyattStayContext(location.href) === job.context
  const run = async () => {
    if (checking || !pending) return
    const job = pending
    if (!current(job)) {
      cancel()
      return
    }
    checking = true
    const lease = crypto.randomUUID()
    let acquired = false
    try {
      const decision = await requestPricingBudgetDecision("hyatt", undefined, {
        lease
      })
      acquired = decision.allowed
      if (!current(job)) return
      if (!acquired) {
        // A budget refusal delays the first request; it is not an attempt.
        const delay = Number.isFinite(decision.retryAt)
          ? Math.max(250, decision.retryAt! - Date.now())
          : 2000
        timer = setTimeout(() => {
          timer = undefined
          void run()
        }, delay)
        return
      }
      attempted.add(job.key)
      const response = await nativeFetch(job.key, {
        headers: job.request?.headers,
        credentials: job.request?.credentials ?? "include",
        signal: AbortSignal.timeout(15000)
      })
      if (!response.ok) {
        if (current(job)) availability[job.side] = "error"
        void requestPricingBudget("hyatt", response.status, {
          retryAfter: response.headers.get("retry-after") ?? undefined
        })
        return
      }
      const result = await response.json()
      if (!current(job)) return
      availability[job.side] =
        result?.roomRates && typeof result.roomRates === "object"
          ? "ready"
          : "error"
      if (availability[job.side] === "ready") clearSide(job.side)
      for (const offer of parseHyattRooms(result, job.page))
        offers.set(offer.id, offer)
      publish()
    } catch {
      if (current(job)) availability[job.side] = "error"
    } finally {
      if (acquired) {
        if (pending === job) {
          cancel()
          publish()
        }
        void requestPricingBudget("hyatt", undefined, { release: lease })
      }
      checking = false
      if (pending && pending !== job && !timer) void run()
    }
  }
  observeNativeJson(
    eligible,
    (data, url, page, _body, request) => {
      const next = hyattStayContext(page)
      if (next !== hyattStayContext(location.href)) return
      if (context !== next) {
        cancel()
        context = next
        offers.clear()
        availability = { cash: "pending", points: "pending" }
      }
      const parsed = parseHyattRooms(data, page)
      const nativeMode =
        new URL(url, location.href).searchParams.get("rateFilter") ??
        new URL(page).searchParams.get("rateFilter")
      if (parsed.some((o) => o.points)) {
        availability.points = "ready"
        clearSide("points")
        if (pending?.side === "points") cancel()
      }
      if (parsed.some((o) => o.base)) {
        availability.cash = "ready"
        clearSide("cash")
        if (pending?.side === "cash") cancel()
      }
      if (!parsed.length) {
        availability[nativeMode === "woh" ? "points" : "cash"] = (data as any)
          ?.roomRates
          ? "ready"
          : "error"
        if ((data as any)?.roomRates) {
          const side = nativeMode === "woh" ? "points" : "cash"
          clearSide(side)
          if (pending?.side === side) cancel()
        }
      }
      for (const offer of parsed) offers.set(offer.id, offer)
      publish()
      const hasPoints = [...offers.values()].some((o) => o.points)
      const hasCash = [...offers.values()].some((o) => o.base)
      if (hasPoints === hasCash) {
        cancel()
        return
      }
      const opposite = new URL(url, location.href)
      const mode = opposite.searchParams.get("rateFilter")
      if (mode !== null && mode !== "woh" && mode !== "standard") return
      opposite.searchParams.set("rateFilter", hasPoints ? "standard" : "woh")
      const key = opposite.href
      if (attempted.has(key) || pending?.key === key) return
      cancel()
      const side = hasPoints ? "cash" : "points"
      if (availability[side] === "ready") return
      availability[side] = "pending"
      pending = { key, page, context: next, request, side }
      publish()
      void run()
    },
    (status, retryAfter) => {
      for (const side of ["cash", "points"] as const)
        if (availability[side] === "pending") availability[side] = "error"
      publish()
      void requestPricingBudget("hyatt", status, {
        retryAfter: retryAfter ?? undefined
      })
    }
  )
  window.addEventListener("message", (e) => {
    if (
      e.source === window &&
      e.origin === location.origin &&
      e.data?.__POINTLENS_HYATT_ROOMS_READY__
    )
      publish()
  })
}
