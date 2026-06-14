import type { PlasmoCSConfig } from "plasmo"
import React from "react"
import { createRoot } from "react-dom/client"
import { CiCircleInfo } from "react-icons/ci"

import {
  DEFAULT_MARRIOTT_VALUE_SETTINGS,
  MARRIOTT_VALUE_SETTINGS_KEY,
  normalizeMarriottValueSettings
} from "./settings"

export const config: PlasmoCSConfig = {
  matches: ["https://www.marriott.com/*"],
  run_at: "document_start"
}

const MARRIOTT_STORAGE_KEY = "award-viewer:marriott-last-capture"
const PLACEHOLDER_CLASS = "award-viewer-marriott-price-placeholder"
const PLACEHOLDER_ICON_CLASS = "award-viewer-marriott-cpp-icon"
const PLACEHOLDER_VALUE_CLASS = "award-viewer-marriott-cpp-value"
const PLACEHOLDER_STYLE_ID = "award-viewer-marriott-placeholder-style"
// CPP line we append INSIDE Marriott's own map price pin (.m-map-pin), IHG-style.
const MAP_PIN_CPP_CLASS = "award-viewer-marriott-pin-cpp"
const MAP_PIN_ANNOTATED_CLASS = "award-viewer-pin-annotated"
// CPP badge injected into the large "hqv" hotel detail modal (2nd click).
const DETAIL_CPP_CLASS = "award-viewer-marriott-detail-cpp"

type MarriottRateInfo = {
  cpp?: number
  cash?: number
  cashBase?: number
  cashFees?: number
  cashTotal?: number
  points?: number
  currency?: string
  stayNights?: number
}

const iconRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
let marriottRatesByHotel = new Map<string, MarriottRateInfo>()
// Marsha codes in search-result order. Marriott labels its map pins `pin-0`..
// `pin-N` by this same order, so `pin-N` -> marriottHotelOrder[N] is a direct id
// link (no coordinates/geometry needed).
let marriottHotelOrder: string[] = []
let marriottValueSettings = DEFAULT_MARRIOTT_VALUE_SETTINGS

// Currency -> USD-per-unit. CPP thresholds (0.6 / 0.45) are USD cents, so for a
// non-USD account we convert the cash to USD before computing CPP (otherwise a
// CNY/EUR/etc. price makes every hotel look "good"). The displayed cash in the
// tooltip stays in the local currency; only the ¢/pt ratio is normalized.
const usdRateByCurrency = new Map<string, number>([["USD", 1]])
const fxInflight = new Set<string>()

const ensureFxRate = (currency: string) => {
  const cur = currency.toUpperCase()
  if (cur === "USD" || usdRateByCurrency.has(cur) || fxInflight.has(cur)) {
    return
  }
  fxInflight.add(cur)
  try {
    chrome.runtime.sendMessage({ type: "MARRIOTT_FETCH_FX", currency: cur }, (resp) => {
      fxInflight.delete(cur)
      const rate = (resp as { rate?: number } | undefined)?.rate
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
        usdRateByCurrency.set(cur, rate)
        void refreshRatesFromStorage() // recompute CPP now that the rate is known
      }
    })
  } catch {
    fxInflight.delete(cur)
  }
}

// Convert an amount in `currency` to USD. Returns the raw amount (and kicks off a
// one-time rate fetch) until the rate is known, so CPP self-corrects on arrival.
const toUsd = (amount: number | undefined, currency?: string) => {
  if (amount === undefined) {
    return undefined
  }
  if (!currency || currency.toUpperCase() === "USD") {
    return amount
  }
  const cur = currency.toUpperCase()
  const rate = usdRateByCurrency.get(cur)
  if (rate !== undefined) {
    return amount * rate
  }
  ensureFxRate(cur)
  return amount
}

function inject(src: string) {
  const script = document.createElement("script")
  script.src = src
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()
}

inject(chrome.runtime.getURL("hotels/marriott/injected/marriott-fetch-hook.js"))

const normalizeHotelId = (id: string | null | undefined) => {
  if (!id) {
    return null
  }
  const trimmed = id.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.toUpperCase()
}

const getHotelIdFromCard = (card: HTMLElement) => {
  return card.getAttribute("data-marsha")
}

const formatCpp = (cpp?: number) => {
  if (cpp === undefined || !Number.isFinite(cpp)) {
    return ""
  }
  return `${cpp.toFixed(2)}¢/pt`
}

const formatCash = (amount?: number, currency?: string) => {
  if (amount === undefined || !Number.isFinite(amount)) {
    return ""
  }
  if (!currency) {
    return amount.toFixed(2)
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency
    }).format(amount)
  } catch {
    return amount.toFixed(2)
  }
}

const formatPoints = (points?: number) => {
  if (points === undefined || !Number.isFinite(points)) {
    return ""
  }
  return new Intl.NumberFormat().format(points)
}

const extractNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  if (value && typeof value === "object") {
    const record = value as { amount?: unknown; decimalPoint?: unknown }
    const amount = extractNumber(record.amount)
    if (amount === undefined) {
      return undefined
    }
    const decimalPoint = extractNumber(record.decimalPoint)
    if (decimalPoint === undefined || !Number.isFinite(decimalPoint)) {
      return amount
    }
    return amount / 10 ** decimalPoint
  }

  return undefined
}

const getValueByPath = (value: unknown, path: string[]) => {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const getRateValue = (rates: Record<string, unknown>, paths: string[][]) => {
  for (const path of paths) {
    const value = extractNumber(getValueByPath(rates, path))
    if (value !== undefined && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

const getRateValueFromCollection = (
  rates: Record<string, unknown> | Array<Record<string, unknown>> | undefined,
  paths: string[][]
) => {
  if (!rates) {
    return undefined
  }

  if (Array.isArray(rates)) {
    for (const rate of rates) {
      const value = getRateValue(rate, paths)
      if (value !== undefined && Number.isFinite(value)) {
        return value
      }
    }
    return undefined
  }

  return getRateValue(rates, paths)
}

const computeCpp = (cash?: number, points?: number) => {
  if (
    cash === undefined ||
    points === undefined ||
    !Number.isFinite(cash) ||
    !Number.isFinite(points) ||
    points <= 0
  ) {
    return undefined
  }
  return (cash / points) * 100
}

const buildRatesFromStorage = (raw: unknown) => {
  if (!raw) {
    return { map: new Map<string, MarriottRateInfo>(), order: [] as string[] }
  }

  const payload = raw as { hotels?: unknown[] } | unknown[]
  const hotels = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.hotels)
      ? payload.hotels
      : []

  const map = new Map<string, MarriottRateInfo>()

  for (const item of hotels) {
    if (!item || typeof item !== "object") {
      continue
    }

    const record = item as Record<string, unknown>
    const property = record.property as Record<string, unknown> | undefined
    const rawId =
      (property?.id as string | undefined) ??
      (property?.marshaCode as string | undefined) ??
      (property?.marshacode as string | undefined) ??
      (property?.propertyCode as string | undefined) ??
      (property?.code as string | undefined)
    const hotelId = normalizeHotelId(rawId)
    if (!hotelId) {
      continue
    }

    const rates = record.rates as
      | Record<string, unknown>
      | Array<Record<string, unknown>>
      | undefined
    if (!rates) {
      continue
    }

    const cash = getRateValueFromCollection(rates, [
      ["cashRate", "amount"],
      ["cashRate", "amountAfterTax"],
      ["cash", "amount"],
      ["rateModes", "lowestAverageRate", "amount"],
      ["rateModes", "lowestAverageRate", "amount", "amount"],
      ["rateModes", "lowestAverageRate", "amountPlusMandatoryFees"],
      ["rateModes", "lowestAverageRate", "amountPlusMandatoryFees", "amount"],
      ["rateModes", "lowestAverageRate", "totalAmount"],
      ["rateModes", "lowestAverageRate", "totalAmount", "amount"],
      ["lowestCashRate", "amount"],
      ["lowestCashRate", "amountAfterTax"],
      ["lowestAvailableRate", "amount"],
      ["lowestAvailableRate", "amountAfterTax"],
      ["bestAvailableRate", "amount"],
      ["bestAvailableRate", "amountAfterTax"],
      ["lowestRate", "amount"],
      ["lowestRate", "amountAfterTax"],
      ["total", "amount"],
      ["totalAmount"]
    ])

    const points = getRateValueFromCollection(rates, [
      ["pointsRate", "points"],
      ["pointsRate", "totalPoints"],
      ["rateModes", "pointsPerUnit", "points"],
      ["lowestPointsRate", "points"],
      ["lowestPointsRate", "totalPoints"],
      ["awardRate", "points"],
      ["points"]
    ])

    const standardRate = Array.isArray(rates)
      ? rates.find(
          (rate) =>
            (rate?.rateCategory as Record<string, unknown> | undefined)?.code ===
            "StandardRates"
        )
      : undefined
    const standardRateModes = (standardRate?.rateModes ??
      undefined) as Record<string, unknown> | undefined
    const standardLowestAverageRate = (standardRateModes?.lowestAverageRate ??
      undefined) as Record<string, unknown> | undefined

    const cashBase = extractNumber(standardLowestAverageRate?.amount)
    const cashFees = (() => {
      const fees = extractNumber(standardLowestAverageRate?.fees)
      const taxes = extractNumber(standardLowestAverageRate?.taxes)
      if (fees === undefined && taxes === undefined) {
        return undefined
      }
      return (fees ?? 0) + (taxes ?? 0)
    })()
    const cashTotal = extractNumber(standardLowestAverageRate?.totalAmount)
    const stayNights = (() => {
      if (standardRate?.lengthOfStay !== undefined) {
        return extractNumber(standardRate.lengthOfStay)
      }
      if (!Array.isArray(rates)) {
        return extractNumber((rates as Record<string, unknown>).lengthOfStay)
      }
      const rateWithStay = rates.find(
        (rate) => extractNumber(rate?.lengthOfStay) !== undefined
      )
      return rateWithStay ? extractNumber(rateWithStay.lengthOfStay) : undefined
    })()

    const currency =
      (standardLowestAverageRate?.amount as Record<string, unknown> | undefined)
        ?.currency ??
      (!Array.isArray(rates) ? (rates.currency as string | undefined) : undefined) ??
      (property?.currency as string | undefined) ??
      ((property?.basicInformation as Record<string, unknown> | undefined)
        ?.currency as string | undefined) ??
      (property?.currencyCode as string | undefined)

    const cashForCpp = cashTotal ?? cash ?? cashBase
    const cppPoints =
      stayNights !== undefined && stayNights > 1 && points !== undefined
        ? points / stayNights
        : points

    map.set(hotelId, {
      cash: cashForCpp,
      cashBase,
      cashFees,
      cashTotal,
      stayNights,
      points,
      currency,
      // CPP is normalized to USD cents so the value thresholds hold regardless
      // of the account's display currency.
      cpp: computeCpp(toUsd(cashForCpp, currency), cppPoints)
    })
  }

  // Ordered marsha list matching the result / map-pin order (index = pin-N).
  // Built over EVERY edge (even ones we skip for rates) so the index stays
  // aligned with Marriott's `pin-N` numbering.
  const order = hotels.map((item) => {
    const property = (item as Record<string, unknown> | null | undefined)
      ?.property as Record<string, unknown> | undefined
    const rawId =
      (property?.id as string | undefined) ??
      (property?.marshaCode as string | undefined) ??
      (property?.marshacode as string | undefined) ??
      (property?.propertyCode as string | undefined) ??
      (property?.code as string | undefined)
    return normalizeHotelId(rawId) ?? ""
  })

  return { map, order }
}

// ----------------------------------------------------------------------------
// Map pins. Marriott draws its search-map price pins as DOM elements
// (`.gm-style .m-map-pin`), each carrying a `pin-N` class whose index matches
// the search-result order. We append a CPP line INSIDE the pin (IHG-style) so it
// reads as part of Marriott's own pin rather than a separate overlay. Google
// re-creates these pins on pan/zoom, so we re-apply on a rAF-debounced schedule
// driven by the same MutationObserver that maintains the list placeholders.
// ----------------------------------------------------------------------------
const formatPointsCompact = (points?: number) => {
  if (points === undefined || !Number.isFinite(points)) {
    return ""
  }
  if (points >= 1000) {
    const k = points / 1000
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + "k"
  }
  return String(Math.round(points))
}

const pinValueTier = (cpp?: number) => {
  if (cpp === undefined || !Number.isFinite(cpp)) {
    return ""
  }
  if (cpp >= marriottValueSettings.goodValueThreshold) {
    return "is-good"
  }
  if (cpp <= marriottValueSettings.badValueThreshold) {
    return "is-bad"
  }
  return "is-mid"
}

const updateMapPins = () => {
  const pins = document.querySelectorAll<HTMLElement>(`.m-map-pin`)
  pins.forEach((pin) => {
    const cls = typeof pin.className === "string" ? pin.className : ""
    const match = /pin-(\d+)/.exec(cls)
    if (!match) {
      return
    }
    const marsha = marriottHotelOrder[Number(match[1])]
    const info = marsha ? marriottRatesByHotel.get(marsha) : undefined
    let line = pin.querySelector<HTMLElement>(`:scope > .${MAP_PIN_CPP_CLASS}`)

    const hasReward =
      !!info && info.points !== undefined && info.cash !== undefined
    const cashOnly =
      !!info && info.points === undefined && info.cash !== undefined

    if (!info || (!hasReward && !cashOnly)) {
      line?.remove()
      pin.classList.remove(MAP_PIN_ANNOTATED_CLASS)
      return
    }

    let text: string
    let tier: string
    if (hasReward) {
      const ptsPerNight =
        info.stayNights !== undefined &&
        info.stayNights > 1 &&
        info.points !== undefined
          ? info.points / info.stayNights
          : info.points
      const ptsText = formatPointsCompact(ptsPerNight)
      const cppText = info.cpp !== undefined ? `${info.cpp.toFixed(2)}¢` : ""
      text = cppText ? `${ptsText} · ${cppText}` : `${ptsText} pts`
      tier = pinValueTier(info.cpp)
    } else {
      text = "No reward"
      tier = "is-none"
    }

    if (!line) {
      line = document.createElement("div")
      pin.appendChild(line)
    }
    pin.classList.add(MAP_PIN_ANNOTATED_CLASS)
    const sig = `${text}|${tier}`
    if (line.dataset.av !== sig) {
      line.dataset.av = sig
      line.className = `${MAP_PIN_CPP_CLASS} ${tier}`.trim()
      line.textContent = text
    }
  })
}

// ----------------------------------------------------------------------------
// Detail ("hqv") modal — the large hotel window opened by the 2nd click (pin ->
// selected card -> detail window). It shows only a cash rate, so we inject a CPP
// badge next to the price (`.hqv-rate-container`). The modal carries no
// data-marsha, but its links do: `?propertyCode=NYCOF` and `/hotels/travel/
// nycof-...`, so we read the hotel id from there.
// ----------------------------------------------------------------------------
const marshaFromModal = (root: ParentNode): string | null => {
  const byCode = root.querySelector<HTMLAnchorElement>("a[href*='propertyCode=']")
  if (byCode) {
    const m = /propertyCode=([A-Za-z0-9]+)/.exec(byCode.getAttribute("href") || "")
    const id = m ? normalizeHotelId(m[1]) : null
    if (id) return id
  }
  const byPath = root.querySelector<HTMLAnchorElement>("a[href*='/hotels/travel/']")
  if (byPath) {
    const m = /\/hotels\/travel\/([A-Za-z0-9]+)-/.exec(byPath.getAttribute("href") || "")
    const id = m ? normalizeHotelId(m[1]) : null
    if (id) return id
  }
  return null
}

// Compact points, e.g. 52000 -> "52k", 52340 -> "52.34k" (up to 2 decimals,
// trailing zeros trimmed). Saves horizontal space vs the full "52,000".
const formatPointsK = (points?: number) => {
  if (points === undefined || !Number.isFinite(points)) {
    return ""
  }
  if (points >= 1000) {
    return parseFloat((points / 1000).toFixed(2)) + "k"
  }
  return String(Math.round(points))
}

// The detail "info" button (hover -> cash/points breakdown), reused from the
// list placeholder so it sits to the LEFT of the badge.
const buildInfoIcon = (info: MarriottRateInfo) => {
  const iconWrapper = document.createElement("span")
  iconWrapper.className = PLACEHOLDER_ICON_CLASS
  const iconTarget = document.createElement("span")
  iconTarget.className = "award-viewer-icon"
  iconWrapper.appendChild(iconTarget)
  const tooltip = document.createElement("span")
  tooltip.className = "award-viewer-tooltip"
  tooltip.appendChild(buildTooltipContent(info))
  iconWrapper.appendChild(tooltip)
  const root = createRoot(iconTarget)
  root.render(React.createElement(CiCircleInfo, { "aria-hidden": "true" }))
  iconRoots.set(iconTarget, root)
  return iconWrapper
}

// Shared horizontal CPP badge (used by both the selected preview card and the
// detail modal): [info icon] {cpp}¢/pt · {pts}k pts/night — single row so it
// grows horizontally, never pushing the surrounding layout down.
const buildCppBadgeContents = (info: MarriottRateInfo, hasReward: boolean) => {
  const frag = document.createDocumentFragment()
  frag.appendChild(buildInfoIcon(info))
  const cpp = document.createElement("span")
  cpp.className = "av-cpp"
  if (hasReward) {
    cpp.textContent = info.cpp !== undefined ? `${info.cpp.toFixed(2)}¢/pt` : "—"
    frag.appendChild(cpp)
    const sub = document.createElement("span")
    sub.className = "av-sub"
    const ptsPerNight =
      info.stayNights !== undefined &&
      info.stayNights > 1 &&
      info.points !== undefined
        ? info.points / info.stayNights
        : info.points
    sub.textContent = `${formatPointsK(ptsPerNight)} pts/night`
    frag.appendChild(sub)
  } else {
    cpp.textContent = "Reward nights unavailable"
    frag.appendChild(cpp)
  }
  return frag
}

// Create / update / remove a CPP badge inside `host`, inserted before `before`.
const renderCppBadge = (
  host: HTMLElement,
  before: Node | null,
  info: MarriottRateInfo | undefined,
  compact: boolean
) => {
  let badge = host.querySelector<HTMLElement>(`:scope > .${DETAIL_CPP_CLASS}`)
  const hasReward =
    !!info && info.points !== undefined && info.cash !== undefined
  const cashOnly =
    !!info && info.points === undefined && info.cash !== undefined

  if (!info || (!hasReward && !cashOnly)) {
    badge?.remove()
    return
  }

  const tier = hasReward ? pinValueTier(info.cpp) || "is-mid" : "is-none"
  const sig = `${hasReward ? info.cpp?.toFixed(2) : "none"}|${tier}|${compact ? "c" : "f"}`
  if (badge && badge.dataset.av === sig) return

  badge?.remove()
  badge = document.createElement("div")
  badge.className = `${DETAIL_CPP_CLASS} ${tier}${
    compact ? " award-viewer-marriott-cpp-compact" : ""
  }`.trim()
  badge.dataset.av = sig
  badge.appendChild(buildCppBadgeContents(info, hasReward))
  host.insertBefore(badge, before)
}

// 1st-click "selected" preview card: replace the hover-based list placeholder
// (suppressed via CSS inside .map-view-selected) with a small static CPP badge
// next to the price.
const updateSelectedCard = () => {
  const card = document.querySelector<HTMLElement>(
    ".property-card-container.map-view-selected"
  )
  if (!card) return
  const propCard = card.querySelector<HTMLElement>(".property-card[data-marsha]")
  const marsha = propCard
    ? normalizeHotelId(propCard.getAttribute("data-marsha"))
    : null
  const info = marsha ? marriottRatesByHotel.get(marsha) : undefined

  const rate = card.querySelector<HTMLElement>(".rate-container")
  const link = rate?.closest<HTMLElement>("a") ?? rate
  const host = link?.parentElement
  if (!host || !link) return
  renderCppBadge(host, link.nextSibling, info, true)
}

const updateDetailModal = () => {
  const rateContainer = document.querySelector<HTMLElement>(".hqv-rate-container")
  if (!rateContainer) return
  const host = rateContainer.parentElement
  if (!host) return

  const root: ParentNode =
    rateContainer.closest("[class*='hqv-modal']") ??
    rateContainer.closest("[role='dialog']") ??
    document
  const marsha = marshaFromModal(root)
  const info = marsha ? marriottRatesByHotel.get(marsha) : undefined
  renderCppBadge(host, rateContainer.nextSibling, info, false)
}

let mapPinScheduled = false
const scheduleMapPins = () => {
  if (mapPinScheduled) {
    return
  }
  mapPinScheduled = true
  requestAnimationFrame(() => {
    mapPinScheduled = false
    updateMapPins()
    updateSelectedCard()
    updateDetailModal()
  })
}

const refreshRatesFromStorage = async () => {
  if (!chrome?.storage?.local) return

  const result = await chrome.storage.local.get(MARRIOTT_STORAGE_KEY)
  const built = buildRatesFromStorage(result?.[MARRIOTT_STORAGE_KEY])
  marriottRatesByHotel = built.map
  marriottHotelOrder = built.order
  updateExistingPlaceholders()
  scheduleMapPins()
}

const refreshValueSettings = async () => {
  if (!chrome?.storage?.local) return

  const result = await chrome.storage.local.get(MARRIOTT_VALUE_SETTINGS_KEY)
  marriottValueSettings = normalizeMarriottValueSettings(
    result?.[MARRIOTT_VALUE_SETTINGS_KEY]
  )
  updateExistingPlaceholders()
  scheduleMapPins()
}

const ensurePlaceholderStyles = () => {
  if (document.getElementById(PLACEHOLDER_STYLE_ID)) {
    return
  }

  const style = document.createElement("style")
  style.id = PLACEHOLDER_STYLE_ID
  style.textContent = `
    .${PLACEHOLDER_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      min-height: 16px;
      min-width: 64px;
      margin-bottom: 0.5rem;
      margin-left: 8px;
      gap: 6px;
      font-size: 14px;
      text-align: right;
      width: 100%;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      overflow: visible;
      position: relative;
      z-index: 3;
    }
    .price-container,
    .price-sub-section,
    .property-card-price-component,
    .la-dUdY .price-sub-section {
      overflow: visible !important;
    }
    .${PLACEHOLDER_ICON_CLASS} {
      position: relative;
      display: inline-flex;
      align-items: center;
      color: #6b7280;
      cursor: default;
      font-size: 22px;
      line-height: 1;
      z-index: 2;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-icon {
      display: inline-flex;
      align-items: center;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip {
      position: absolute;
      right: 0;
      bottom: 100%;
      transform: translateY(-4px);
      opacity: 0;
      pointer-events: none;
      background: #f5f5f5;
      color: #111827;
      border: 1px solid #cbd5e1;
      font-size: 11px;
      padding: 6px;
      border-radius: 4px;
      white-space: normal;
      transition: opacity 0.15s ease, transform 0.15s ease;
      z-index: 9999;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12);
      min-width: 240px;
      max-width: 280px;
    }
    .${PLACEHOLDER_ICON_CLASS}:hover .award-viewer-tooltip,
    .${PLACEHOLDER_ICON_CLASS}:focus-within .award-viewer-tooltip {
      opacity: 1;
      transform: translateY(-8px);
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-grid {
      display: grid;
      grid-template-columns: max-content minmax(160px, auto);
      column-gap: 12px;
      row-gap: 2px;
      align-items: center;
      justify-content: start;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-row {
      display: contents;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-cell {
      white-space: normal;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-cell--label {
      color: #475569;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-cell--value {
      font-weight: 400;
      color: #0f172a;
      text-align: left;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-divider {
      grid-column: 1 / -1;
      border-top: 1px solid #e2e8f0;
      height: 1px;
    }
    .${PLACEHOLDER_VALUE_CLASS} {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      border: 1px solid #cbd5e1;
      background: #f5f5f5;
      border-radius: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .${PLACEHOLDER_VALUE_CLASS}.is-good {
      background: #d1fae5;
      border-color: #a7f3d0;
      color: #047857;
    }
    .${PLACEHOLDER_VALUE_CLASS}.is-bad {
      background: #ffe4e6;
      border-color: #fecdd3;
      color: #be123c;
    }
    .${PLACEHOLDER_VALUE_CLASS}.is-mid {
      background: #fef3c7;
      border-color: #fde68a;
      color: #b45309;
    }
    .${PLACEHOLDER_CLASS}.is-loading .award-viewer-skeleton {
      display: inline-block;
      width: 56px;
      height: 12px;
      border-radius: 6px;
      background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 37%, #e5e7eb 63%);
      background-size: 400% 100%;
      animation: award-viewer-skeleton 1.4s ease infinite;
    }
    @keyframes award-viewer-skeleton {
      0% { background-position: 100% 50%; }
      100% { background-position: 0 50%; }
    }
    /* CPP line appended inside Marriott's own dark map pin (.m-map-pin). Let the
       pin grow to fit the extra line (its base height is fixed for one row). */
    .m-map-pin.${MAP_PIN_ANNOTATED_CLASS} {
      height: auto !important;
      padding-top: 5px !important;
      padding-bottom: 5px !important;
      line-height: 13px !important;
    }
    .${MAP_PIN_CPP_CLASS} {
      display: block;
      margin-top: 2px;
      font-size: 10px;
      font-weight: 800;
      line-height: 11px;
      text-align: center;
      white-space: nowrap;
      font-family: Roboto, Arial, sans-serif;
      color: #ffffff;
    }
    .${MAP_PIN_CPP_CLASS}.is-good { color: #34d399; }
    .${MAP_PIN_CPP_CLASS}.is-mid { color: #fbbf24; }
    .${MAP_PIN_CPP_CLASS}.is-bad { color: #f87171; }
    .${MAP_PIN_CPP_CLASS}.is-none { color: #cbd5e1; font-weight: 600; }
    /* Shared horizontal CPP badge — used in the selected preview card (compact)
       and the detail modal. Row layout so it grows sideways, not downward. */
    .${DETAIL_CPP_CLASS} {
      display: inline-flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      padding: 5px 12px;
      border-radius: 8px;
      border: 1px solid #cbd5e1;
      background: #f5f5f5;
      white-space: nowrap;
      max-width: 100%;
      font-weight: 400;
    }
    .${DETAIL_CPP_CLASS} .${PLACEHOLDER_ICON_CLASS} { font-size: 18px; }
    .${DETAIL_CPP_CLASS} .av-cpp { font-size: 14px; font-weight: 400; line-height: 1.2; color: #0f172a; }
    .${DETAIL_CPP_CLASS} .av-sub { font-size: 14px; color: #475569; }
    .${DETAIL_CPP_CLASS} .av-sub::before { content: "·"; margin-right: 8px; color: #94a3b8; }
    .${DETAIL_CPP_CLASS}.is-good { background: #d1fae5; border-color: #a7f3d0; }
    .${DETAIL_CPP_CLASS}.is-good .av-cpp { color: #047857; }
    .${DETAIL_CPP_CLASS}.is-mid { background: #fef3c7; border-color: #fde68a; }
    .${DETAIL_CPP_CLASS}.is-mid .av-cpp { color: #b45309; }
    .${DETAIL_CPP_CLASS}.is-bad { background: #ffe4e6; border-color: #fecdd3; }
    .${DETAIL_CPP_CLASS}.is-bad .av-cpp { color: #be123c; }
    .${DETAIL_CPP_CLASS}.is-none .av-cpp { color: #64748b; font-size: 13px; }
    /* Compact variant for the small selected preview card. */
    .${DETAIL_CPP_CLASS}.award-viewer-marriott-cpp-compact {
      margin-top: 4px;
      padding: 3px 9px;
      border-radius: 6px;
      gap: 6px;
    }
    .award-viewer-marriott-cpp-compact .${PLACEHOLDER_ICON_CLASS} { font-size: 16px; }
    .award-viewer-marriott-cpp-compact .av-cpp { font-size: 12px; }
    .award-viewer-marriott-cpp-compact .av-sub { font-size: 12px; }
    .award-viewer-marriott-cpp-compact .av-sub::before { margin-right: 6px; }
    /* Selected preview card uses our static badge above, so suppress the
       hover-based list placeholder there (no hover in the small popup). */
    .property-card-container.map-view-selected .${PLACEHOLDER_CLASS} {
      display: none !important;
    }
  `
  document.head?.appendChild(style)
}

const buildTooltipContent = (info: MarriottRateInfo) => {
  const wrapper = document.createElement("div")
  wrapper.className = "award-viewer-tooltip-content"
  const grid = document.createElement("div")
  grid.className = "award-viewer-tooltip-grid"

  const addRow = (label: string, value: string) => {
    const row = document.createElement("div")
    row.className = "award-viewer-tooltip-row"

    const labelEl = document.createElement("div")
    labelEl.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--label"
    labelEl.textContent = label

    const valueEl = document.createElement("div")
    valueEl.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--value"
    valueEl.textContent = value

    row.appendChild(labelEl)
    row.appendChild(valueEl)
    grid.appendChild(row)
  }

  const hasCashContent =
    info.cashBase !== undefined ||
    info.cashFees !== undefined ||
    info.cashTotal !== undefined ||
    info.cash !== undefined
  const hasPointsContent = info.points !== undefined

  if (!hasCashContent && !hasPointsContent) {
    wrapper.textContent = "Awaiting Marriott response"
    return wrapper
  }

  if (hasCashContent) {
    const headerRow = document.createElement("div")
    headerRow.className = "award-viewer-tooltip-row"
    const headerLabel = document.createElement("div")
    headerLabel.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--label"
    headerLabel.textContent = "Lowest cash"
    const headerValue = document.createElement("div")
    headerValue.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--value"
    headerValue.textContent =
      info.stayNights !== undefined && info.stayNights > 1 ? "Price per night" : "Price"
    headerRow.appendChild(headerLabel)
    headerRow.appendChild(headerValue)
    grid.appendChild(headerRow)
  }

  const baseLabel = formatCash(info.cashBase, info.currency)
  const feesLabel = formatCash(info.cashFees, info.currency)
  const totalLabel = formatCash(info.cashTotal ?? info.cash, info.currency)

  if (baseLabel) {
    addRow("Base", baseLabel)
  }
  if (info.cashFees !== undefined) {
    addRow("Fees", feesLabel)
  }
  if (totalLabel) {
    addRow("Total", totalLabel)
  }

  const hasCashRow = baseLabel || totalLabel || info.cashFees !== undefined
  if (hasCashRow && hasPointsContent) {
    const divider = document.createElement("div")
    divider.className = "award-viewer-tooltip-divider"
    grid.appendChild(divider)
  }

  if (info.points !== undefined) {
    const displayPoints =
      info.stayNights !== undefined && info.stayNights > 1
        ? info.points / info.stayNights
        : info.points
    const pointsLabel = formatPoints(displayPoints)
    const cppLabel = formatCpp(info.cpp)
    if (pointsLabel) {
      addRow(
        "Points",
        cppLabel ? `${pointsLabel} pts (${cppLabel})` : `${pointsLabel} pts`
      )
    }
  }

  if (!grid.childNodes.length) {
    wrapper.textContent = "Awaiting Marriott response"
    return wrapper
  }

  wrapper.appendChild(grid)
  return wrapper
}

const ensurePlaceholderContents = (placeholder: HTMLElement) => {
  let iconWrapper = placeholder.querySelector<HTMLElement>(
    `.${PLACEHOLDER_ICON_CLASS}`
  )
  if (!iconWrapper) {
    iconWrapper = document.createElement("span")
    iconWrapper.className = PLACEHOLDER_ICON_CLASS

    const iconTarget = document.createElement("span")
    iconTarget.className = "award-viewer-icon"
    iconWrapper.appendChild(iconTarget)

    const tooltip = document.createElement("span")
    tooltip.className = "award-viewer-tooltip"
    tooltip.textContent = "Awaiting Marriott response"
    iconWrapper.appendChild(tooltip)

    placeholder.appendChild(iconWrapper)
    const root = createRoot(iconTarget)
    root.render(React.createElement(CiCircleInfo, { "aria-hidden": "true" }))
    iconRoots.set(iconTarget, root)
  }

  let valueEl = placeholder.querySelector<HTMLElement>(
    `.${PLACEHOLDER_VALUE_CLASS}`
  )
  if (!valueEl) {
    valueEl = document.createElement("span")
    valueEl.className = PLACEHOLDER_VALUE_CLASS
    placeholder.appendChild(valueEl)
  }

  return { iconWrapper, valueEl }
}

const setSkeleton = (placeholder: HTMLElement) => {
  const { valueEl } = ensurePlaceholderContents(placeholder)
  placeholder.classList.add("is-loading")
  valueEl.textContent = ""
  const existing = valueEl.querySelector(".award-viewer-skeleton")
  if (existing) {
    return
  }
  const skeleton = document.createElement("span")
  skeleton.className = "award-viewer-skeleton"
  skeleton.setAttribute("aria-hidden", "true")
  valueEl.appendChild(skeleton)
}

const updateValueClass = (valueEl: HTMLElement, cpp?: number) => {
  valueEl.classList.remove("is-good", "is-bad", "is-mid")

  if (cpp === undefined || !Number.isFinite(cpp)) {
    return
  }

  if (cpp >= marriottValueSettings.goodValueThreshold) {
    valueEl.classList.add("is-good")
    return
  }

  if (cpp <= marriottValueSettings.badValueThreshold) {
    valueEl.classList.add("is-bad")
    return
  }

  valueEl.classList.add("is-mid")
}

const updatePlaceholderText = (placeholder: HTMLElement) => {
  let hotelId = placeholder.dataset.hotelId
  if (!hotelId) {
    const card = placeholder.closest<HTMLElement>(".property-card")
    if (card) {
      hotelId = getHotelIdFromCard(card) ?? undefined
      if (hotelId) {
        placeholder.dataset.hotelId = hotelId
      }
    }
  }

  if (!hotelId) {
    setSkeleton(placeholder)
    return
  }

  const normalizedHotelId = normalizeHotelId(hotelId) ?? hotelId
  if (normalizedHotelId !== hotelId) {
    hotelId = normalizedHotelId
    placeholder.dataset.hotelId = normalizedHotelId
  }

  const info = marriottRatesByHotel.get(hotelId)
  const { iconWrapper, valueEl } = ensurePlaceholderContents(placeholder)
  const tooltip = iconWrapper.querySelector<HTMLElement>(".award-viewer-tooltip")

  updateValueClass(valueEl, info?.cpp)

  if (info?.points !== undefined && info?.cash !== undefined) {
    placeholder.classList.remove("is-loading")
    valueEl.textContent = formatCpp(info.cpp)
    if (tooltip) {
      tooltip.replaceChildren(buildTooltipContent(info))
    }
    return
  }

  if (info?.points === undefined && info?.cash !== undefined) {
    placeholder.classList.remove("is-loading")
    valueEl.classList.remove("is-good", "is-bad", "is-mid")
    valueEl.textContent = "Reward Nights Unavailable"
    if (tooltip) {
      tooltip.replaceChildren(buildTooltipContent(info))
    }
    return
  }

  if (tooltip) {
    tooltip.textContent = "Awaiting Marriott response"
  }
  setSkeleton(placeholder)
}

const getRateLink = (card: HTMLElement) => {
  const rateContainer = card.querySelector<HTMLElement>(".rate-container")
  if (!rateContainer) return null
  return rateContainer.closest<HTMLAnchorElement>("a")
}

const ensurePlaceholder = (card: HTMLElement) => {
  if (card.querySelector(`.${PLACEHOLDER_CLASS}`)) return

  const link = getRateLink(card)
  if (!link) return

  const container = link.parentElement
  if (!container) return

  const placeholder = document.createElement("div")
  placeholder.className = PLACEHOLDER_CLASS
  const hotelId = getHotelIdFromCard(card)
  if (hotelId) {
    placeholder.dataset.hotelId = hotelId
  }
  container.insertBefore(placeholder, link.nextSibling)
  ensurePlaceholderContents(placeholder)
  updatePlaceholderText(placeholder)
}

const refreshPlaceholders = () => {
  ensurePlaceholderStyles()
  const cards = document.querySelectorAll<HTMLElement>(".property-card")
  cards.forEach((card) => ensurePlaceholder(card))
}

const updateExistingPlaceholders = () => {
  const placeholders = document.querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
  placeholders.forEach((placeholder) => updatePlaceholderText(placeholder))
}

const startPlaceholderObserver = () => {
  if (!document.body) return
  refreshPlaceholders()
  void refreshRatesFromStorage()
  void refreshValueSettings()
  const observer = new MutationObserver(() => {
    refreshPlaceholders()
    scheduleMapPins()
  })
  observer.observe(document.body, { childList: true, subtree: true })

  chrome?.storage?.onChanged?.addListener(() => {
    void refreshRatesFromStorage()
    void refreshValueSettings()
  })
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startPlaceholderObserver, {
    once: true
  })
} else {
  startPlaceholderObserver()
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MARRIOTT_PAGE_REPLAY") {
    window.postMessage(
      { __AV_MARRIOTT_DO_REPLAY__: true, payload: msg.payload },
      "*"
    )
  }
})

window.addEventListener("message", (event) => {
  if (event.source !== window) return

  const data = event.data as Record<string, unknown> | undefined

  if (data?.__AV_MARRIOTT_SAVE__ === true) {
    chrome.runtime.sendMessage({
      type: "MARRIOTT_SAVE_CAPTURE",
      payload: data.payload
    })
  }
})
