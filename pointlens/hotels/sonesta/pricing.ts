import {
  amount,
  stayNights,
  type HotelSnapshot
} from "../../shared/hotel-quotes.ts"

export function sonestaRequest(body?: string) {
  try {
    const request = JSON.parse(body ?? "")
    if (request.operationName !== "getHotelAvailability") return
    const input = request.variables?.input
    const start = input?.start,
      end = input?.end,
      nights = stayNights(start ?? "", end ?? "")
    if (!nights || !input.crsHotelCode) return
    const context = JSON.stringify([
      start,
      end,
      input.adults,
      input.children,
      input.childrenAges,
      input.quantity,
      input.promotionCode,
      input.ratePlanCode,
      input.ratePlanFilterCode
    ])
    return { input, start, end, nights, context }
  } catch {}
}

export function parseSonesta(
  data: any,
  body?: string
): HotelSnapshot | undefined {
  const request = sonestaRequest(body)
  if (!request) return
  const { input, start, end, nights, context } = request
  const result = data?.data?.hotelAvailablity,
    hotel = result?.queryHotel
  if (
    !hotel ||
    String(hotel.id) !== String(input.crsHotelCode) ||
    !Array.isArray(hotel.rooms)
  )
    return
  const id = String(hotel.id)
  const snapshot: HotelSnapshot = {
    key: id,
    context,
    start,
    end,
    scope: "rooms",
    hotels: { [id]: { name: hotel.name ?? id, cash: true, points: true } },
    offers: []
  }
  const nightlyPoints = amount(hotel.redemptionItem?.currencyRequired)
  for (const room of hotel.rooms) {
    if (!(room.quantity > 0) || !room.code) continue
    for (const rate of room.roomRates ?? []) {
      if (!rate.rateCode || !/^[A-Z]{3}$/.test(rate.currencyCode)) continue
      const common = {
        hotel: id,
        id: `${id}:${room.code}:${rate.rateCode}`,
        room: room.code,
        roomName: room.name ?? "",
        rate: rate.rateCode,
        name: rate.name ?? "",
        currency: rate.currencyCode,
        nights
      }
      if (rate.isRedemptionRate === true) {
        // Hotel tiers alone do not establish availability: require an actual
        // redemption rate on this exact room for this stay. Native redemption
        // booking supports one room only. Its USD room rate is accounting data.
        if (!nightlyPoints || input.quantity !== 1) continue
        const taxes = amount(rate.taxes),
          fees = amount(rate.fees)
        if (taxes === undefined || fees === undefined) continue
        snapshot.offers.push({
          ...common,
          points: nightlyPoints * nights,
          copay: Math.round((taxes + fees) * 100) / 100,
          estimated: taxes + fees > 0
        })
      } else {
        const base = amount(rate.subTotal),
          total = amount(rate.total)
        if (!base || !total || total < base) continue
        snapshot.offers.push({
          ...common,
          base,
          total,
          display: amount(rate.roomRateWithFees)
        })
      }
    }
  }
  return snapshot
}
