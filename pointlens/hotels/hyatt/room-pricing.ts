import { positive, type RoomOffer } from "../../shared/room-value"

export function hyattStayContext(href: string) {
  const u = new URL(href)
  u.hash = ""
  for (const key of ["rateFilter", "hpesrId"]) u.searchParams.delete(key)
  u.searchParams.sort()
  return u.href
}

export function parseHyattRooms(data: any, href: string): RoomOffer[] {
  const u = new URL(href)
  const nights =
    (Date.parse(u.searchParams.get("checkoutDate") || "") -
      Date.parse(u.searchParams.get("checkinDate") || "")) /
    86400000
  if (!(nights > 0)) return []
  const offers: RoomOffer[] = []
  for (const [code, raw] of Object.entries(data?.roomRates ?? {})) {
    const room = raw as any
    for (const plan of room.ratePlans ?? []) {
      // These require a suite-upgrade award in addition to the listed points.
      // They are not an independently bookable points alternative.
      if (plan.id === "STEXLP" || /suite upgrade/i.test(plan.name ?? ""))
        continue
      const points =
        positive(plan.totalPoints) ??
        (positive(plan.avgPoints) ?? positive(plan.points))! * nights
      const base =
        positive(plan.totalBeforeTax) ??
        (positive(plan.rate) ? plan.rate * nights : undefined)
      const total =
        positive(plan.totalAfterTax) ??
        (positive(plan.rateAfterTax) ? plan.rateAfterTax * nights : undefined)
      if (!positive(points) && !base) continue
      offers.push({
        id: `${code}:${plan.id}`,
        room: code,
        roomName: room.roomType?.title ?? code,
        name: plan.name ?? "",
        currency: plan.currencyCode || room.currencyCode || "USD",
        nights,
        base: positive(points) ? undefined : base,
        total: positive(points) ? undefined : total,
        points: positive(points),
        copay: positive(points) ? total ?? base ?? 0 : undefined
      })
    }
  }
  return offers
}
