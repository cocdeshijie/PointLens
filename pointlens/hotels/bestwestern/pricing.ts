import {
  amount,
  stayNights,
  type HotelSnapshot
} from "../../shared/hotel-quotes.ts"

export function bestwesternRequest(url: string) {
  const u = new URL(url, "https://www.bestwestern.com")
  if (
    u.origin !== "https://www.bestwestern.com" ||
    u.pathname !== "/bin/bestwestern/proxy"
  )
    return
  const q = u.searchParams,
    op = q.get("gwServiceURL")
  if (op !== "HOTEL_SEARCH" && op !== "ROOM_RATE_PLAN") return
  const start = q.get("checkinDate") ?? "",
    end = q.get("checkoutDate") ?? ""
  const nights = stayNights(start, end)
  if (!nights) return
  // Both endpoints express the same occupancy differently. Keep search and room
  // contexts separate; never combine rates from different guest selections.
  const scope = op === "HOTEL_SEARCH" ? "search" : "rooms"
  const occupancy =
    scope === "search"
      ? [q.get("numberOfRooms"), q.getAll("occupant")]
      : [q.get("numAdult"), q.get("numChild"), q.get("childrenAge")]
  const context = JSON.stringify([
    start,
    end,
    scope,
    occupancy,
    scope === "search"
      ? [q.get("latitude"), q.get("longitude"), q.get("distance")]
      : q.get("hotelid")
  ])
  const points =
    scope === "search"
      ? q.get("ratePlan") === "BWR"
      : q.get("rateplan") === "FX"
  return { u, q, start, end, nights, context, scope, points } as const
}

export function parseBestwestern(
  data: any,
  url: string,
  roomCurrency?: string
): HotelSnapshot | undefined {
  const req = bestwesternRequest(url)
  if (!req) return
  const { q, start, end, nights, context, scope, points } = req
  const key =
    scope === "search"
      ? `search:${points}`
      : `rooms:${q.get("hotelid")}:${q.get("rateplan")}`
  const snapshot: HotelSnapshot = {
    key,
    context,
    start,
    end,
    scope,
    hotels: {},
    offers: []
  }
  if (scope === "search") {
    if (!Array.isArray(data)) return
    for (const h of data) {
      const hotel = String(h.resort ?? ""),
        summary = h.resortSummary
      if (!hotel || !summary) continue
      snapshot.hotels[hotel] = {
        name: summary.name ?? hotel,
        [points ? "points" : "cash"]: true
      }
      if (h.resortAvailable !== "AVAILABLE") continue
      const r = points ? h.resortSearchPoint : h.resortSearchRate
      const value = amount(points ? r?.totalPoints : r?.totalAmount)
      if (!value || !/^[A-Z]{3}$/.test(summary.currencyCode)) continue
      snapshot.offers.push({
        hotel,
        id: `${hotel}:${points}`,
        rate: r.resortRateCode ?? "",
        room: String(r.resortRoomCategory ?? ""),
        roomName: "",
        name: "",
        currency: summary.currencyCode,
        nights,
        // Search's totalAmount/totalPoints are nightly averages, not stay totals.
        ...(points
          ? { points: value * nights }
          : summary["display-taxes-fees-inclusive"] === true
            ? { total: value * nights }
            : { base: value * nights })
      })
    }
  } else {
    // Error envelopes are not proof of award unavailability.
    if (
      !Array.isArray(data?.roomDetailsList) ||
      !/^[A-Z]{3}$/.test(roomCurrency ?? "")
    )
      return
    const hotel = String(data.resort ?? q.get("hotelid") ?? "")
    snapshot.hotels[hotel] = { name: hotel, [points ? "points" : "cash"]: true }
    for (const room of data.roomDetailsList) {
      if (room.inventory !== true || room.restriction !== "NO_RESTRICTION")
        continue
      const dates = Object.keys(room.dailyPriceMap ?? {}).sort()
      if (
        dates.length !== nights ||
        dates[0] !== start ||
        dates.some((d, i) => Date.parse(d) !== Date.parse(start) + i * 86400000)
      )
        continue
      const values = dates.map((d) => amount(room.dailyPriceMap[d]))
      if (values.some((v) => v === undefined || v <= 0)) continue
      const value = values.reduce<number>((sum, v) => sum + v!, 0)
      const code = String(room.roomCategoryCode ?? "")
      if (!code) continue
      snapshot.offers.push({
        hotel,
        id: `${hotel}:${code}:${data.rateCode}`,
        rate: data.rateCode,
        room: code,
        roomName: room.description ?? "",
        name: data.rateCode,
        currency: roomCurrency!,
        nights,
        ...(points
          ? { points: value }
          : data.taxIncluded === true
            ? { total: value }
            : { base: value })
      })
    }
  }
  return snapshot
}
