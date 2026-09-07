import type { RoomOffer } from "../../shared/room-value"

export const SEARCH_ENDPOINT =
  "/BWSServices/services/hotels/property-availability"
export const ROOMS_ENDPOINT =
  "/BWSServices/services/hotels/availability/getRoomsAndRates"
export type WyndhamOffer = RoomOffer & { hotel: string; rate: string }
export type Availability = "pending" | "ready" | "error"
export type WyndhamSnapshot = {
  context: string
  scope: "search" | "rooms"
  offers: WyndhamOffer[]
  hotels: Record<string, { cash: Availability; points: Availability }>
}
const number = (n: unknown) =>
  (typeof n === "number" || (typeof n === "string" && n.trim() !== "")) &&
  Number.isFinite(Number(n)) &&
  Number(n) >= 0
    ? Number(n)
    : undefined
const amount = (n: unknown) => {
  const v = number(n)
  return v && v > 0 ? v : undefined
}
const flag = (v: unknown) => v === true || v === "true"
const currency = (v: unknown) =>
  typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : undefined

export function stayNights(url: string) {
  const q = new URL(url).searchParams
  const date = (v: string | null) => {
    const m = v?.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
    return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : NaN
  }
  const n =
    (date(q.get("checkin_date") ?? q.get("checkInDate")) -
      date(q.get("checkout_date") ?? q.get("checkOutDate"))) /
    -86400000
  return Number.isInteger(n) && n > 0 && n <= 365 ? n : undefined
}

export function wyndhamContext(page: string) {
  const u = new URL(page)
  // A view toggle, sort, or marketing token does not change a priced stay.
  for (const key of [...u.searchParams.keys()])
    if (
      /^(useWRPoints|rateTypeFilter|sessionId|sort.*|utm_.*|referringBrand)$/i.test(
        key
      )
    )
      u.searchParams.delete(key)
  u.searchParams.sort()
  return u.pathname + "?" + u.searchParams.toString()
}

export function pricingScope(url: string) {
  const u = new URL(url, "https://www.wyndhamhotels.com")
  if (u.origin !== "https://www.wyndhamhotels.com") return
  if (u.pathname === SEARCH_ENDPOINT) return "search" as const
  if (u.pathname === ROOMS_ENDPOINT) return "rooms" as const
}

export function parseWyndham(
  data: any,
  requestUrl: string,
  page: string
): WyndhamSnapshot | undefined {
  const scope = pricingScope(requestUrl)
  const nights = stayNights(requestUrl)
  if (!scope || !nights || data?.status !== "OK") return
  const q = new URL(requestUrl, "https://www.wyndhamhotels.com").searchParams
  const snapshot: WyndhamSnapshot = {
    context: wyndhamContext(page),
    scope,
    offers: [],
    hotels: {}
  }
  if (scope === "search") {
    if (!data.availability || typeof data.availability !== "object") return
    const groups = Object.values(data.availability) as any[]
    if (!groups.every((g) => Array.isArray(g?.availability))) return
    const filter = q.get("rateTypeFilter")
    const pointsReady =
      filter === "loyalty" ||
      (filter !== "price" && q.get("useWRPoints") === "true")
    const cashReady = filter !== "loyalty"
    // Include unavailable hotels from the requested batch, even when omitted.
    for (const code of (q.get("properties") ?? "").split(",")) {
      const hotel = code.split("|")[0].replace(/^[A-Za-z]{2}/, "")
      if (hotel)
        snapshot.hotels[hotel] = {
          cash: cashReady ? "ready" : "pending",
          points: pointsReady ? "ready" : "pending"
        }
    }
    for (const h of groups.flatMap((g) => g.availability)) {
      const hotel = String(h.hotelCode ?? h.hotelId ?? "")
      const r = h.rate
      const c = currency(r?.currencyCode)
      if (!hotel) continue
      snapshot.hotels[hotel] = {
        cash: cashReady ? "ready" : "pending",
        points: pointsReady ? "ready" : "pending"
      }
      const common = {
        hotel,
        room: hotel,
        roomName: String(h.hotelName ?? ""),
        currency: c ?? "XXX",
        nights
      }
      if (cashReady && c && amount(r?.displayRate))
        snapshot.offers.push({
          ...common,
          id: `${hotel}:cash`,
          rate: String(r.ratePlanId ?? ""),
          name: "Cash",
          base: amount(r.displayRate)! * nights,
          // Despite its name, this search field is the nightly after-tax amount.
          total: amount(r.totalAfterTax)
            ? amount(r.totalAfterTax)! * nights
            : undefined
        })
      if (pointsReady && flag(h.fnsAvailable) && amount(h.totalFnsPoints))
        snapshot.offers.push({
          ...common,
          id: `${hotel}:points`,
          rate: "FNS",
          name: "Free Nights",
          points: amount(h.totalFnsPoints)
        })
    }
  } else {
    if (!Array.isArray(data.roomsAndRates?.rooms)) return
    const hotel = q.get("propertyId") ?? ""
    const pointsReady = q.get("useWRPoints") === "true"
    snapshot.hotels[hotel] = {
      cash: "ready",
      points: pointsReady ? "ready" : "pending"
    }
    for (const room of data.roomsAndRates.rooms) {
      if (
        !room.roomTypeCode ||
        !Array.isArray(room.rates) ||
        room.inventoryCount === 0
      )
        continue
      for (const r of room.rates) {
        const c = currency(r.currencyCode)
        // Points + Cash is a different product, never a cash comparator.
        if (!c || flag(r.pacRatePlan) || !r.ratePlanId) continue
        const common = {
          hotel,
          room: String(room.roomTypeCode),
          roomName: String(room.shortName ?? ""),
          rate: String(r.ratePlanId),
          id: `${hotel}:${room.roomTypeCode}:${r.ratePlanId}`,
          name: String(r.ratePlanId),
          currency: c,
          nights
        }
        if (flag(r.fnsRatePlan)) {
          if (
            pointsReady &&
            amount(r.totalFnsPoints) &&
            number(r.totalAfterTax) !== undefined
          )
            snapshot.offers.push({
              ...common,
              points: amount(r.totalFnsPoints),
              copay: number(r.totalAfterTax)
            })
        } else if (amount(r.totalBeforeTax)) {
          snapshot.offers.push({
            ...common,
            base: amount(r.totalBeforeTax),
            total: amount(r.totalAfterTax)
          })
        }
      }
    }
  }
  return snapshot
}

export function complementUrl(url: string) {
  const u = new URL(url, "https://www.wyndhamhotels.com")
  if (!pricingScope(u.href)) return
  u.searchParams.set("useWRPoints", "true")
  // The unfiltered search response contains both cash and full awards.
  u.searchParams.delete("rateTypeFilter")
  u.searchParams.sort()
  return u.href
}
