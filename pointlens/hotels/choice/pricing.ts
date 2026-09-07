import type { RoomOffer } from "../../shared/room-value"

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined

export type ChoiceOffer = RoomOffer & {
  hotel: string
  rate: string
  display: number
  estimated?: boolean
  package?: boolean
}
export type ChoiceSnapshot = {
  context: string
  scope: "search" | "lowest" | "rooms"
  offers: ChoiceOffer[]
  hotels: Record<
    string,
    {
      cash: "ready" | "pending" | "error"
      points: "ready" | "pending" | "error"
    }
  >
}
export function choiceHotel(page: string) {
  return new URL(page).pathname
    .match(/\/([a-z]{2,3}\d{3})(?:\/rates)?\/?$/i)?.[1]
    ?.toUpperCase()
}
export function choiceContext(page: string) {
  const u = new URL(page)
  const params = [...u.searchParams].filter(
    ([k]) =>
      ![
        "ratePlanCode",
        "roomCode",
        "view",
        "viewProperty",
        "sortBy",
        "map",
        "latitude",
        "longitude"
      ].includes(k) && !k.startsWith("utm_")
  )
  const rate = u.searchParams.get("ratePlanCode")
  if (rate && !["RACK", "SRD"].includes(rate)) params.push(["discount", rate])
  return JSON.stringify([
    u.pathname.replace(/\/rates\/?$/, ""),
    params.sort(([a], [b]) => a.localeCompare(b))
  ])
}
export function pricingOperation(url: string) {
  try {
    const u = new URL(url, "https://www.choicehotels.com")
    const op = u.searchParams.get("q")
    return u.origin === "https://www.choicehotels.com" &&
      u.pathname === "/dxapi/graphql" &&
      [
        "GetSearchResultsRatesWithRoomPolicy",
        "GetHotelLowestRates",
        "GetLowestRoomRates",
        "GetRoomRates"
      ].includes(op ?? "")
      ? op
      : undefined
  } catch {
    return
  }
}
const rates = (pair: any) =>
  [pair?.defaultRate, pair?.memberRate].filter(Boolean)
// Property fees can be absent from SRD's zero-dollar totals. Only fixed,
// dated charges are computable without inventing a cash basis for points.
export function awardFees(item: any, currency: string) {
  let total = 0,
    estimated = false
  for (const fee of item.fees ?? []) {
    if (!(fee.amount > 0)) continue
    if (fee.currencyCode && fee.currencyCode !== currency) {
      estimated = true
      continue
    }
    const start = Math.max(
      Date.parse(item.startDate),
      Date.parse(fee.startDate || item.startDate)
    )
    const end = Math.min(
      Date.parse(item.endDate),
      Date.parse(fee.endDate || item.endDate)
    )
    const nights = Math.max(0, (end - start) / 86400000)
    if (!nights) continue
    if (fee.frequency === "PER_ROOM_PER_NIGHT") total += fee.amount * nights
    else if (["PER_ROOM_PER_STAY", "PER_STAY"].includes(fee.frequency))
      total += fee.amount
    else estimated = true
    // Tax treatment of charges collected at the property is not included in SRD.
    if (total) estimated = true
  }
  return { total, estimated }
}
export function parseChoice(
  data: any,
  page: string,
  variables: any = {}
): ChoiceSnapshot | undefined {
  if (data?.errors?.length) return
  const root = data?.data ?? data
  const room = root?.getHotelAvailabilityRoomRates
  const lowest = root?.getHotelAvailabilityLowestRoomRates
  const scope = room ? "rooms" : lowest ? "lowest" : "search"
  const items =
    room || lowest ? [room || lowest] : root?.getHotelAvailabilityLowestRate
  if (!Array.isArray(items)) return
  const snapshot: ChoiceSnapshot = {
    context: choiceContext(page),
    scope,
    offers: [],
    hotels: {}
  }
  const query = new URL(page).searchParams
  for (const item of items) {
    if (
      !item?.hotelCode ||
      !positive(item.nights) ||
      (query.get("checkInDate") &&
        item.startDate !== query.get("checkInDate")) ||
      (query.get("checkOutDate") && item.endDate !== query.get("checkOutDate"))
    )
      continue
    const hotel = item.hotelCode.toUpperCase()
    if (choiceHotel(page) && hotel !== choiceHotel(page)) continue
    const requested = variables.ratePlanCodes ?? []
    const entries: { rate: any; room: string; title: string }[] = []
    const names = new Map(
      (item.rooms ?? []).map((r: any) => [r.key, r.value?.title])
    )
    const add = (pair: any, code: string) =>
      rates(pair).forEach((rate) =>
        entries.push({
          rate,
          room: code,
          title: String(names.get(code) ?? code)
        })
      )
    if (scope === "search") {
      add(item.lowestRate, hotel)
      for (const p of item.requestedRates ?? []) add(p, hotel)
    } else
      for (const r of item.roomRates ?? []) {
        if (Array.isArray(r.value)) for (const p of r.value) add(p.value, r.key)
        else {
          add(r.value?.lowestRoomRate, r.key)
          for (const p of r.value?.requestedRoomRates ?? []) add(p, r.key)
        }
      }
    const currency =
      entries.find((e) => e.rate.currencyCode && e.rate.currencyCode !== "XLY")
        ?.rate.currencyCode ?? variables.currencyCode
    snapshot.hotels[hotel] = {
      cash:
        requested.some((r: string) => r !== "SRD") ||
        entries.some((e) => !e.rate.points && e.rate.amountBeforeTaxFees > 0)
          ? "ready"
          : "pending",
      points:
        requested.includes("SRD") ||
        entries.some((e) => e.rate.ratePlanCode === "SRD")
          ? "ready"
          : "pending"
    }
    for (const { rate: r, room: code, title } of entries) {
      if (r.availabilityStatus && r.availabilityStatus !== "AVAILABLE") continue
      const points = positive(r.points)
      if (points && r.ratePlanCode !== "SRD") continue
      if (
        !points &&
        !positive(r.amountBeforeTaxFees) &&
        !positive(r.amountAfterTaxFees)
      )
        continue
      const money = points ? currency : r.currencyCode
      if (!money || !/^[A-Z]{3}$/.test(money) || money === "XLY") continue
      const fees = awardFees(item, money)
      const offer: ChoiceOffer = {
        id: `${hotel}:${code}:${r.ratePlanCode}`,
        hotel,
        room: code,
        roomName: title,
        rate: r.ratePlanCode,
        name: r.ratePlanCode,
        currency: money,
        nights: item.nights,
        display: points ? r.avgNightlyPoints : r.avgNightlyAmount,
        package: (
          r.ratePlanCategories ??
          item.ratePlans?.find((p: any) => p.key === r.ratePlanCode)?.value
            ?.ratePlanCategories ??
          []
        ).includes("PACKAGE"),
        ...(points
          ? {
              points,
              copay: Math.max(r.amountAfterTaxFees ?? 0, fees.total),
              estimated: fees.estimated
            }
          : {
              base: positive(r.amountBeforeTaxFees),
              total: positive(r.amountAfterTaxFees)
            })
      }
      const prior = snapshot.offers.findIndex((o) => o.id === offer.id)
      if (prior < 0) snapshot.offers.push(offer)
      else snapshot.offers[prior] = offer
    }
  }
  return Object.keys(snapshot.hotels).length ? snapshot : undefined
}
