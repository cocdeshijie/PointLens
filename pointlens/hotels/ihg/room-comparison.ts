import type { IhgRoomSnapshot, IhgRoomValue } from "./room-rates"

export type IhgRoomComparison = IhgRoomValue & {
  rateCode?: string
  hotelFallback?: boolean
  cashRoom?: string
  awardRoom?: string
}

// Preserve the price the guest is looking at. Only replace the missing or
// incompatible opposite payment option, within this exact hotel's stay.
export function compareIhgRoom(
  room: IhgRoomComparison,
  snapshot: IhgRoomSnapshot,
  pointsMode: boolean,
  taxBasis: "pretax" | "aftertax"
): IhgRoomComparison {
  const cashKey = taxBasis === "pretax" ? "cashPretax" : "cash"
  const eligible = snapshot.rooms.filter(
    (r) => r.currency === room.currency && r.nights === room.nights
  )
  if (pointsMode && (room[cashKey] === undefined || room.packageComparison)) {
    const rates = eligible
      .flatMap((candidate) =>
        (candidate.cashRates ?? [candidate]).map((rate) => ({
          candidate,
          rate
        }))
      )
      .filter(({ rate }) => rate[cashKey] > 0)
    // Prefer an ordinary hotel stay over package extras. If the entire hotel
    // only has packages, still show its cheapest cash alternative explicitly.
    const ordinary = rates.filter(({ rate }) => !rate.packageComparison)
    const cheapest = (ordinary.length ? ordinary : rates).sort(
      (a, b) => a.rate[cashKey] - b.rate[cashKey]
    )[0]
    if (cheapest) {
      const { candidate, rate } = cheapest
      return {
        ...room,
        cash: rate.cash,
        cashBase: rate.cashBase,
        cashPretax: rate.cashPretax,
        cashPlan: rate.cashPlan,
        refundable: rate.refundable,
        memberRate: rate.memberRate,
        packageComparison: rate.packageComparison,
        hotelFallback: true,
        cashRoom: candidate.name,
        awardRoom: room.name
      }
    }
  } else if (!pointsMode && (!room.points || room.packageComparison)) {
    const cheapest = eligible
      .filter((r) => r.points > 0)
      .sort((a, b) => a.points - b.points)[0]
    if (cheapest)
      return {
        ...room,
        points: cheapest.points,
        originalPoints: cheapest.originalPoints,
        awardFees: cheapest.awardFees,
        awardFeesPretax: cheapest.awardFeesPretax,
        hotelFallback: true,
        cashRoom: room.name,
        awardRoom: cheapest.name
      }
  }
  return room
}
