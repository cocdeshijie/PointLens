import { positive, type RoomOffer } from "../../shared/room-value"

export function marriottMoney(value: any): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (typeof value?.amount === "object") return marriottMoney(value.amount)
  if (typeof value?.amount !== "number" || !Number.isFinite(value.amount))
    return
  return (
    value.amount /
    10 ** (Number.isInteger(value.decimalPoint) ? value.decimalPoint : 0)
  )
}

export function marriottProductIdentity(id: string) {
  try {
    const [hotel, plan, room, checkin, checkout] = atob(
      id.replace(/-/g, "+").replace(/_/g, "/")
    ).split("|")
    const nights = (Date.parse(checkout) - Date.parse(checkin)) / 86400000
    if (!hotel || !plan || !room || !(nights > 0)) return
    return { hotel, plan, room: room.toLowerCase(), checkin, checkout, nights }
  } catch {
    return
  }
}

export function parseMarriottRooms(data: any): RoomOffer[] {
  const edges = data?.data?.commerce?.product?.searchProductsByProperty?.edges
  if (!Array.isArray(edges)) return []
  return edges.flatMap(({ node }: any) => {
    const identity = marriottProductIdentity(node?.id ?? "")
    if (!identity) return []
    const modes = node.rates?.rateModes
    // Mixed redemptions have separate cash components; never mistake their
    // internal subtotal for an ordinary cash room price.
    if (modes?.cashAndPointsPerUnit || modes?.pointsPlusCashUpgradePerUnit)
      return []
    const points = positive(modes?.pointsPerUnit?.points)
    const pricing = node.totalPricing?.rateModes
    const quantity = positive(node.totalPricing?.quantity) ?? 1
    const base = marriottMoney(pricing?.subtotalPerQuantity)
    const grand = marriottMoney(pricing?.grandTotal)
    const total = grand === undefined ? undefined : grand / quantity
    // Points-only rate modes carry an internal cash subtotal as well. It is
    // not a guest copay (the native room card and rate details show points
    // only). Deduct only the mandatory cash fees for these award offers.
    const awardFees = marriottMoney(pricing?.totalMandatoryFeesPerQuantity) ?? 0
    const currency =
      pricing?.grandTotal?.amount?.currency ??
      pricing?.subtotalPerQuantity?.amount?.currency
    if ((!positive(base) && !points) || typeof currency !== "string") return []
    return [
      {
        id: node.id,
        room: identity.room,
        roomName:
          typeof node.basicInformation?.name === "string"
            ? node.basicInformation.name
            : identity.room,
        name: node.rates?.name ?? "",
        currency,
        nights: identity.nights,
        base: points ? undefined : base,
        total: points ? undefined : total,
        points,
        copay: points ? awardFees : undefined
      }
    ]
  })
}
