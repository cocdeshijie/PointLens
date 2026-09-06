import { observeNativeJson } from "../../shared/native-json"
import { requestPricingBudget } from "../../shared/pricing-budget"
import type { RoomOffer } from "../../shared/room-value"
import { parseMarriottRooms } from "./room-pricing"

export function installMarriottRoomCapture() {
  const nativeFetch = window.fetch
  const attempted = new Set<string>()
  let latest:
    | {
        __POINTLENS_MARRIOTT_ROOMS__: true
        context: string
        offers: RoomOffer[]
      }
    | undefined
  const publish = (offers: RoomOffer[], page: string) => {
    latest = { __POINTLENS_MARRIOTT_ROOMS__: true, context: page, offers }
    window.postMessage(latest, location.origin)
  }
  const currentRevision = observeNativeJson(
    (url) => {
      try {
        const u = new URL(url, location.href)
        return (
          u.origin === location.origin &&
          u.pathname === "/mi/query/PhoenixBookDTTSearchProductsByProperty"
        )
      } catch {
        return false
      }
    },
    (data, url, page, body, request, revision) => {
      if (page !== location.href || revision !== currentRevision()) return
      const offers = parseMarriottRooms(data)
      publish(offers, page)
      const hasCash = offers.some((o) => o.base)
      const hasPoints = offers.some((o) => o.points)
      if (hasCash === hasPoints || !request || !body) return
      let query: any
      try {
        query = JSON.parse(body)
      } catch {
        return
      }
      const rates = query?.variables?.search?.options?.rateRequestTypes
      if (!Array.isArray(rates)) return
      const type = hasPoints ? "STANDARD" : "REDEMPTION"
      // Use the exact selector observed when the user switches to points.
      // An already requested but absent rate is unavailable, not a retry cue.
      if (rates.some((r) => r.type === type)) return
      rates.push({ value: "", type })
      const replayBody = JSON.stringify(query)
      const key = request.url + replayBody
      if (attempted.has(key)) return
      attempted.add(key)
      void (async () => {
        const lease = crypto.randomUUID()
        if (!(await requestPricingBudget("marriott", undefined, { lease })))
          return
        try {
          if (page !== location.href || revision !== currentRevision()) return
          const response = await nativeFetch(request.url, {
            method: request.method,
            headers: request.headers,
            credentials: request.credentials,
            body: replayBody,
            signal: AbortSignal.timeout(15000)
          })
          if (!response.ok) {
            void requestPricingBudget("marriott", response.status, {
              retryAfter: response.headers.get("retry-after") ?? undefined
            })
            return
          }
          const opposite = parseMarriottRooms(await response.json()).filter(
            (o) => (hasCash ? !!o.points : !!o.base)
          )
          if (page === location.href && revision === currentRevision())
            // Keep native IDs: replayed cash products may have a new opaque
            // suffix, while existing room and rate links still use the old ID.
            publish([...offers, ...opposite], page)
        } finally {
          void requestPricingBudget("marriott", undefined, { release: lease })
        }
      })().catch(() => {})
    },
    (status, retryAfter) => {
      void requestPricingBudget("marriott", status, {
        retryAfter: retryAfter ?? undefined
      })
    }
  )
  window.addEventListener("message", (e) => {
    if (
      e.source === window &&
      e.origin === location.origin &&
      e.data?.__POINTLENS_MARRIOTT_ROOMS_READY__ &&
      latest
    )
      window.postMessage(latest, location.origin)
  })
}
