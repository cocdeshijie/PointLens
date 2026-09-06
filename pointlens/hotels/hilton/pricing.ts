export type HiltonPrice = {
  key: string
  room: string
  roomName: string
  name: string
  currency: string
  base?: number
  baseApproximate?: boolean
  usdBase?: number
  total?: number
  points?: number
  pointsEstimated?: boolean
  package?: boolean
  member?: boolean
  nonrefundable?: boolean
}
export type HiltonHotel = {
  cash: HiltonPrice[]
  awards: HiltonPrice[]
  nights: number
  awardsKnown?: boolean
}
export type HiltonComparison = {
  cashRate?: HiltonPrice
  awardRate?: HiltonPrice
  fallback?: string
  stayNights: number
  currency?: string
  cash?: number
  points?: number
  rateAmount?: number
  amountAfterTax?: number
  cpp?: number
  rewardStatus?: "available" | "unavailable"
}
export function number(value: unknown, locale = "en"): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string" || !/\d/.test(value)) return undefined
  const parts = new Intl.NumberFormat(locale).formatToParts(1234.5)
  const group = parts.find((p) => p.type === "group")?.value || ","
  const decimal = parts.find((p) => p.type === "decimal")?.value || "."
  const raw = value
    .split(group)
    .join("")
    .replace(decimal, ".")
    .replace(/[^\d.\-]/g, "")
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}
export function nightsBetween(arrival: string, departure: string) {
  const n = (Date.parse(departure) - Date.parse(arrival)) / 86400000
  return Number.isInteger(n) && n > 0 && n <= 365 ? n : 0
}
export function parseHiltonHotel(
  hotel: any,
  nights: number,
  locale = "en"
): HiltonHotel {
  const shop = hotel?.shopAvail || {}
  const cash: HiltonPrice[] = [],
    awards: HiltonPrice[] = []
  const currency = shop.currencyCode
  if (!nights || !/^[A-Z]{3}$/.test(currency)) return { cash, awards, nights }
  for (const room of shop.roomTypes || []) {
    const roomId = room.roomTypeCode || room.code
    if (!roomId) continue
    const add = (
      r: any,
      isAward = false,
      isPackage = false,
      member = false
    ) => {
      if (!r) return
      const plan = r.ratePlan || {}
      const key = String(
        r.ratePlanCode || plan.ratePlanCode || (isAward ? "reward" : "lowest")
      )
      const details = Array.isArray(r.pointDetails) ? r.pointDetails : []
      const dailyPoints = number(details[0]?.pointsRate)
      const dailyValues = details.map((d: any) => number(d.pointsRate))
      const points =
        number(r.totalCostPoints) ??
        (dailyValues.length === nights &&
        dailyValues.every((v: number | undefined) => v !== undefined)
          ? dailyValues.reduce((a: number, b: number) => a + b, 0)
          : details.length === 1 && dailyPoints !== undefined
            ? dailyPoints * nights
            : undefined)
      const base = number(r.rateAmount)
      const total =
        number(r.amountAfterTax) ?? number(r.fullAmountAfterTax, locale)
      const p: HiltonPrice = {
        key,
        room: roomId,
        roomName: room.roomTypeName || room.name || roomId,
        name: plan.ratePlanName || "",
        currency,
        base: base === undefined ? undefined : base * nights,
        baseApproximate: nights > 1,
        usdBase:
          number(r.rateAmountUSD) === undefined
            ? undefined
            : number(r.rateAmountUSD)! * nights,
        total,
        package: isPackage,
        member: member || plan.hhonorsMembershipRequired,
        nonrefundable: r.guarantee?.nonRefundable || plan.advancePurchase
      }
      if (isAward || (points !== undefined && points > 0)) {
        // These endpoints expose the full redemption, before the Points & Money slider.
        if (points && points > 0) awards.push({ ...p, points })
      } else if ((total ?? p.base ?? 0) > 0) cash.push(p)
      if (r.hhonorsDiscountRate)
        add(r.hhonorsDiscountRate, false, isPackage, true)
    }
    for (const field of [
      "roomOnlyRates",
      "requestedRoomRates",
      "specialRoomRates",
      "packageRates"
    ]) {
      for (const r of room[field] || []) add(r, false, field === "packageRates")
    }
    for (const field of ["quickBookRate", "moreRatesFromRate", "bookNowRate"])
      add(room[field])
    for (const r of room.redemptionRoomRates || []) add(r, true)
  }
  const dedup = (rates: HiltonPrice[]) =>
    Array.from(new Map(rates.map((r) => [`${r.room}:${r.key}`, r])).values())
  return {
    cash: dedup(cash),
    awards: dedup(awards),
    nights,
    awardsKnown: awards.length > 0
  }
}
export function parseHiltonSearch(
  row: any,
  nights: number,
  pointsResponse: boolean,
  previous?: HiltonHotel
): HiltonHotel {
  const currency = row.currencyCode
  const lowest = row.summary?.lowest,
    reward = row.summary?.hhonors
  const cash = [...(previous?.cash || [])],
    awards = [...(previous?.awards || [])]
  if (!nights || !/^[A-Z]{3}$/.test(currency)) return { cash, awards, nights }
  // The native points response cash anchor describes its reward room. Preserve it
  // separately from the cheapest cash-search room; never substitute a generic lead rate.
  const room = pointsResponse ? "reward" : "hotel"
  const base = number(lowest?.rateAmount),
    total = number(lowest?.amountAfterTax)
  if ((total ?? base ?? 0) > 0) {
    const rate: HiltonPrice = {
      key: lowest?.ratePlanCode || "lowest",
      room,
      roomName: "",
      name: lowest?.ratePlan?.ratePlanName || "",
      currency,
      base: base === undefined ? undefined : base * nights,
      baseApproximate: nights > 1,
      total
    }
    const at = cash.findIndex((r) => r.room === room)
    if (at >= 0) cash.splice(at, 1)
    cash.push(rate)
  }
  const daily = number(reward?.dailyRmPointsRate)
  if (daily && daily > 0) {
    awards.splice(0, awards.length, {
      key: "reward",
      room: "reward",
      roomName: "",
      name: reward?.ratePlan?.ratePlanName || "",
      currency,
      points: daily * nights,
      pointsEstimated: nights > 1 && reward?.rateChangeIndicator !== false
    })
  } else if (pointsResponse) awards.length = 0
  return {
    cash,
    awards,
    nights,
    awardsKnown: pointsResponse || awards.length > 0 || previous?.awardsKnown
  }
}
export function compareHilton(
  hotel: HiltonHotel,
  options: {
    room?: string
    cashKey?: string
    awardKey?: string
    mode?: "cash" | "points"
    taxBasis?: "pretax" | "aftertax"
    usdRate?: number
  } = {}
): HiltonComparison {
  const basis = (r: HiltonPrice) =>
    options.taxBasis === "pretax" ? r.base ?? r.total : r.total ?? r.base
  const cheapestCash = (rates: HiltonPrice[]) => {
    const roomOnly = rates.filter((r) => !r.package)
    return [...(roomOnly.length ? roomOnly : rates)].sort(
      (a, b) => (basis(a) ?? Infinity) - (basis(b) ?? Infinity)
    )[0]
  }
  const cheapestAward = (rates: HiltonPrice[]) =>
    [...rates].sort(
      (a, b) => (a.points ?? Infinity) - (b.points ?? Infinity)
    )[0]
  const roomCash = hotel.cash.filter((r) => r.room === options.room),
    roomAwards = hotel.awards.filter((r) => r.room === options.room)
  let cash = options.cashKey
    ? roomCash.find((r) => r.key === options.cashKey)
    : undefined
  let award = options.awardKey
    ? roomAwards.find((r) => r.key === options.awardKey)
    : undefined
  if (options.mode === "cash") {
    cash ||=
      cheapestCash(
        options.room ? roomCash : hotel.cash.filter((r) => r.room === "hotel")
      ) || cheapestCash(hotel.cash)
    award ||=
      cheapestAward(
        hotel.awards.filter((r) => r.room === (options.room || cash?.room))
      ) || cheapestAward(hotel.awards)
  } else {
    award ||=
      cheapestAward(options.room ? roomAwards : hotel.awards) ||
      cheapestAward(hotel.awards)
    cash ||=
      cheapestCash(
        hotel.cash.filter((r) => r.room === (options.room || award?.room))
      ) || cheapestCash(hotel.cash)
  }
  // No comparison between currencies, even briefly while a selector is changing.
  if (cash && award && cash.currency !== award.currency)
    return { stayNights: hotel.nights }
  const totalCash = cash && basis(cash)
  const fx =
    cash?.currency === "USD"
      ? 1
      : cash?.usdBase && cash.base
        ? cash.usdBase / cash.base
        : options.usdRate
  const cpp =
    totalCash !== undefined && award?.points && fx
      ? ((totalCash * fx) / award.points) * 100
      : undefined
  let fallback: string | undefined
  if (options.room && cash && cash.room !== options.room)
    fallback = `Cash alternative: ${cash.roomName}`
  if (options.room && award && award.room !== options.room)
    fallback = `Points alternative: ${award.roomName}`
  return {
    cashRate: cash,
    awardRate: award,
    fallback,
    stayNights: hotel.nights,
    currency: cash?.currency || award?.currency,
    cash: totalCash === undefined ? undefined : totalCash / hotel.nights,
    points:
      award?.points === undefined ? undefined : award.points / hotel.nights,
    rateAmount: cash?.base === undefined ? undefined : cash.base / hotel.nights,
    amountAfterTax:
      cash?.total === undefined ? undefined : cash.total / hotel.nights,
    cpp,
    rewardStatus: award
      ? "available"
      : hotel.awardsKnown
        ? "unavailable"
        : undefined
  }
}
