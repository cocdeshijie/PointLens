// Parse only native room-detail responses. No additional hotel requests.
type Json = Record<string, any>

export type IhgRoomCashRate = {
  rateCode: string
  cash?: number
  cashBase?: number
  cashPretax?: number
  cashPlan?: string
  refundable?: boolean
  memberRate?: boolean
  packageComparison?: boolean
}

export type IhgRoomValue = {
  code: string
  name: string
  currency: string
  nights: number
  points?: number
  originalPoints?: number
  cash?: number
  cashBase?: number
  cashPretax?: number
  awardFees: number
  awardFeesPretax: number
  cashPlan?: string
  refundable?: boolean
  memberRate?: boolean
  packageComparison?: boolean
  cashRates?: IhgRoomCashRate[]
}

export type IhgRoomSnapshot = {
  hotel: string
  start: string
  end: string
  adults: number
  children: number
  rooms: IhgRoomValue[]
}

const number = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === "") return undefined
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

export function parseRoomRates(
  body: string,
  response: string
): IhgRoomSnapshot | null {
  try {
    const request: Json = JSON.parse(body)
    const data: Json = JSON.parse(response)
    const nights =
      (Date.parse(request.endDate) - Date.parse(request.startDate)) / 86400000
    // One room/occupancy group: do not compare totals across different rooms.
    if (
      !Number.isInteger(nights) ||
      nights < 1 ||
      request.products?.length !== 1 ||
      Number(request.products[0].quantity) !== 1 ||
      request.hotelMnemonics?.length !== 1
    )
      return null
    const hotel = data.hotels?.find(
      (h: Json) => h.hotelMnemonic === request.hotelMnemonics[0]
    )
    if (
      !hotel?.rateDetails?.offers ||
      !/^[A-Z]{3}$/.test(hotel.propertyCurrency)
    )
      return null
    const plans = new Map<string, Json>(
      (hotel.ratePlanDefinitions ?? []).map((p: Json) => [p.code, p])
    )
    const fees = new Map<number, Json>(
      (hotel.rateDetails.feeTaxDefinitions ?? []).map((f: Json) => [f.id, f])
    )
    const values: IhgRoomValue[] = []
    for (const product of hotel.productDefinitions ?? []) {
      const code = product.inventoryTypeCode
      if (
        !code ||
        product.isAvailable === false ||
        product.isDisplayable === false
      )
        continue
      const offers = hotel.rateDetails.offers.filter((o: Json) => {
        const main = o.productUses?.filter(
          (p: Json) => p.isMainProduct !== false
        )
        return (
          o.availableStatus === "AVAILABLE" &&
          main?.length === 1 &&
          main[0].inventoryTypeCode === code &&
          Number(main[0].quantity) === 1 &&
          main[0].period?.start === request.startDate &&
          main[0].period?.end === request.endDate
        )
      })
      const reward = offers
        .filter(
          (o: Json) => number(o.rewardNights?.pointsOnly?.totalPoints) > 0
        )
        .sort(
          (a: Json, b: Json) =>
            a.rewardNights.pointsOnly.totalPoints -
            b.rewardNights.pointsOnly.totalPoints
        )[0]
      const cashOffers = offers
        .filter((o: Json) => {
          const plan = plans.get(o.ratePlanCode)
          return (
            !o.rewardNights &&
            plan &&
            !plan.isRewardNight &&
            !plan.isGroupRatePlan &&
            !plan.isVoucherRequired &&
            !plan.isIdRequired &&
            !plan.areAmountsConfidential &&
            number(o.totalRate?.amountAfterTax) > 0
          )
        })
        .sort(
          (a: Json, b: Json) =>
            Number(a.totalRate.amountAfterTax) -
            Number(b.totalRate.amountAfterTax)
        )
      // Prefer a room-only comparison. Some points-only inventory is sold for
      // cash solely in a package; retain that fallback and label it explicitly.
      const cash =
        cashOffers.find((offer: Json) => {
          const plan = plans.get(offer.ratePlanCode)
          return !plan.isPackage && !plan.packageDetails
        }) ?? cashOffers[0]
      // Reward offer totalRate is the hotel's reimbursement, not the guest's
      // cash bill. Only explicit, excluded fixed charges survive a full award.
      let awardFees = 0,
        awardFeesPretax = 0
      for (const subtotal of reward?.totalRate?.feeTaxSubTotals ?? []) {
        if (subtotal.isIncludedInRate) continue
        for (const group of subtotal.feeTaxGroups ?? []) {
          const definitions = (group.feeTaxDefIds ?? []).map((id: number) =>
            fees.get(id)
          )
          if (
            !definitions.length ||
            !definitions.every((f: Json) => f?.computationType === "FLAT")
          )
            continue
          const amount = number(group.amount) ?? 0
          awardFees += amount
          if (subtotal.otaCodeType === "FEE") awardFeesPretax += amount
        }
      }
      const plan = plans.get(cash?.ratePlanCode)
      values.push({
        code,
        name: product.inventoryTypeName ?? code,
        currency: hotel.propertyCurrency,
        nights,
        points: number(reward?.rewardNights?.pointsOnly?.totalPoints),
        originalPoints: number(
          reward?.rewardNights?.pointsOnly?.originalTotalPoints
        ),
        cash: number(cash?.totalRate?.amountAfterTax),
        cashBase: number(cash?.totalRate?.baseAmount),
        cashPretax: number(cash?.totalRate?.basePlusExcludedFeesAmount),
        awardFees,
        awardFeesPretax,
        cashPlan: plan?.name ?? cash?.ratePlanCode,
        refundable: cash?.policies?.isRefundable,
        memberRate: plan?.isLoyaltyIdRequired,
        packageComparison: !!(plan?.isPackage || plan?.packageDetails),
        cashRates: cashOffers.map((offer: Json) => {
          const definition = plans.get(offer.ratePlanCode)
          return {
            rateCode: offer.ratePlanCode,
            cash: number(offer.totalRate?.amountAfterTax),
            cashBase: number(offer.totalRate?.baseAmount),
            cashPretax: number(offer.totalRate?.basePlusExcludedFeesAmount),
            cashPlan: definition?.name ?? offer.ratePlanCode,
            refundable: offer.policies?.isRefundable,
            memberRate: definition?.isLoyaltyIdRequired,
            packageComparison: !!(
              definition?.isPackage || definition?.packageDetails
            )
          }
        })
      })
    }
    const guests = request.products[0].guestCounts ?? []
    const adults = guests
      .filter((g: Json) => g.guestType === "ADULT" || g.otaCode === "AQC10")
      .reduce((sum: number, g: Json) => sum + Number(g.count), 0)
    const children = guests
      .filter((g: Json) => g.guestType !== "ADULT" && g.otaCode !== "AQC10")
      .reduce((sum: number, g: Json) => sum + Number(g.count), 0)
    return {
      hotel: hotel.hotelMnemonic,
      start: request.startDate,
      end: request.endDate,
      adults,
      children,
      rooms: values
    }
  } catch {
    return null
  }
}

export function matchesRoomStay(
  snapshot: IhgRoomSnapshot,
  href: string,
  allowImplicitDates = false
): boolean {
  const url = new URL(href)
  const params = url.searchParams
  const hotel =
    /\/([a-z0-9]{5,6})\/hoteldetail/i.exec(url.pathname)?.[1] ??
    params.get("qSlH") ??
    params.get("qPm")
  const date = (day: string, monthYear: string) => {
    if (!day || !/^\d{6}$/.test(monthYear)) return ""
    return `${monthYear.slice(2)}-${String(Number(monthYear.slice(0, 2)) + 1).padStart(2, "0")}-${day.padStart(2, "0")}`
  }
  return (
    hotel?.toUpperCase() === snapshot.hotel.toUpperCase() &&
    (!params.has("qRms") || Number(params.get("qRms")) === 1) &&
    (!params.has("qAdlt") || Number(params.get("qAdlt")) === snapshot.adults) &&
    (!params.has("qChld") ||
      Number(params.get("qChld")) === snapshot.children) &&
    ((allowImplicitDates &&
      !["qCiD", "qCiMy", "qCoD", "qCoMy"].some((key) => params.has(key))) ||
      (date(params.get("qCiD"), params.get("qCiMy")) === snapshot.start &&
        date(params.get("qCoD"), params.get("qCoMy")) === snapshot.end))
  )
}
