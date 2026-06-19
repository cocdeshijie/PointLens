import type { PlasmoCSConfig } from "plasmo"
import React from "react"
import { createRoot } from "react-dom/client"
import { CiCircleInfo } from "react-icons/ci"

import {
  DEFAULT_IHG_VALUE_SETTINGS,
  IHG_VALUE_SETTINGS_KEY,
  normalizeIhgValueSettings
} from "./settings"

const IHG_STORAGE_KEY = "pointlens:ihg-last-request"
const IHG_SENT_STORAGE_KEY = "pointlens:ihg-sent-request"
const IHG_CONVERSION_STORAGE_KEY = "pointlens:ihg-currency-conversion-request"
const MESSAGE_FLAG = "__AWARD_VIEWER_IHG__"
const REPLAY_FLAG = "__AWARD_VIEWER_IHG_REPLAY__"
const PLACEHOLDER_CLASS = "pointlens-price-placeholder"
const PLACEHOLDER_ICON_CLASS = "pointlens-cpp-icon"
const PLACEHOLDER_VALUE_CLASS = "pointlens-cpp-value"
const PLACEHOLDER_STYLE_ID = "pointlens-placeholder-style"
const IHG_API_KEY = "se9ym5iAzaW8pxfBjkmgbuGjJcr3Pj6Y"
const USD_CURRENCY = "USD"

export const config: PlasmoCSConfig = {
  matches: ["https://www.ihg.com/*"],
  run_at: "document_start"
}

type IhgMessagePayload = {
  kind?: string
  url?: string
  method?: string
  bodyType?: string
  bodyText?: string | null
  bookingType?: IhgBookingType
  responseBodyText?: string | null
  responseStatus?: number
  responseStatusText?: string
  responseType?: string
  timestamp?: number
}

type IhgReplayPayload = {
  url?: string
  method?: string
  bodyType?: string
  bodyText?: string | null
  requestHeaders?: chrome.webRequest.HttpHeader[]
}

type IhgBookingType = "points" | "cash" | "unknown"

type IhgStoredPayload = {
  bookingType?: IhgBookingType
  bodyText?: string | null
  responseBodyText?: string | null
}

type IhgSentRequest = {
  bookingType?: IhgBookingType
  request?: {
    body?: unknown
  } | null
  response?: {
    bodyText: string | null
    bodyParsed?: unknown
  } | null
}

type IhgConversionRequest = {
  currencyCode: string
  targetCurrency: string
  request: {
    url: string
    method: string
    headers: Record<string, string>
  }
  response: {
    status: number
    statusText: string
    bodyText: string | null
    bodyParsed: unknown
  } | null
  error?: string | null
  requestedAt?: string
}

type IhgPointsCash = {
  points?: number
  cash?: number
}

type IhgRateInfo = {
  cashAmount?: number
  points?: number
  cpp?: number
  cppLow?: number
  cppHigh?: number
  lowestCash?: IhgCashCost
  highestCash?: IhgCashCost
  lowestPoints?: number
  highestPoints?: number
  lowestPointsAndCash?: IhgPointsCash
  highestPointsAndCash?: IhgPointsCash
  rewardNightAvailable?: boolean
  currency?: string
}

let ihgRatesByHotel = new Map<string, IhgRateInfo>()
let ihgRateErrorsByHotel = new Map<string, string>()
let ihgLastRateError: string | null = null
let ihgLastRateSource: string | null = null
let ihgShowPointsWithCpp = false

type IhgStayDetails = {
  status: "loading" | "ok" | "none" | "error"
  nights?: number
  totalPoints?: number
  originalTotalPoints?: number
  savedPoints?: number
  freeNightCount?: number
  benefitReason?: string | null
}
// Full-stay reward totals incl. "every 4th reward night free" — fetched lazily
// per hotel (on tooltip hover) since the search-results summary lacks them.
const ihgRateDetailsByHotel = new Map<string, IhgStayDetails>()
let ihgSearchNights = 0
let ihgRateDetailsSignature: string | null = null

// Map-marker support: IHG map pins carry no hotel id, only a price — cash
// ("212 USD", = baseAmount + fees) or points ("28K PTS"). We join on that to the
// hotel's CPP. Two lookups so both cash- and points-mode maps work. Value is
// null when two hotels share a price (ambiguous → skip).
const MAP_CPP_CLASS = "pointlens-map-cpp"
// Pin value: CPP (number) | "none" (hotel has no reward nights) | null (two
// hotels share the price → ambiguous, skip).
type IhgMapValue = number | "none"
const ihgMapCppByCash = new Map<number, IhgMapValue | null>()
const ihgMapCppByPoints = new Map<number, IhgMapValue | null>() // keyed by exact points
// Same price keys -> hotel mnemonic, to resolve the pin-click details dialog
// (which exposes no hotel id, only the "156 USD" price). null = ambiguous.
const ihgHotelIdByCash = new Map<number, string | null>()
const ihgHotelIdByPoints = new Map<number, string | null>()
let ihgMapUpdateScheduled = false

const computeNights = (bodyText?: string | null) => {
  if (!bodyText) {
    return 0
  }
  try {
    const parsed = JSON.parse(bodyText) as { startDate?: unknown; endDate?: unknown }
    if (typeof parsed.startDate === "string" && typeof parsed.endDate === "string") {
      const ms = Date.parse(parsed.endDate) - Date.parse(parsed.startDate)
      return ms > 0 ? Math.round(ms / 86_400_000) : 0
    }
  } catch {
    return 0
  }
  return 0
}
const iconRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
const currencyRates = new Map<string, number>()
const inflightCurrencyRates = new Map<string, Promise<number | null>>()
let ihgValueSettings = DEFAULT_IHG_VALUE_SETTINGS

type IhgCashCost = {
  baseAmount?: number
  excludedFeeSubTotal?: number
  feeOnlySubTotal?: number
  amountAfterTax?: number
  basePlusExcludedFeesAmount?: number
}

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

const detectBookingType = (bodyText: string | null): IhgBookingType => {
  if (!bodyText) {
    return "unknown"
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const rates = parsed.rates as { ratePlanCodes?: unknown } | undefined
    if (Array.isArray(rates?.ratePlanCodes) && rates.ratePlanCodes.length > 0) {
      return "points"
    }

    const products = parsed.products as
      | Array<{ guestCounts?: unknown; quantity?: unknown }>
      | undefined
    if (
      Array.isArray(products) &&
      products.some(
        (product) => product.guestCounts !== undefined || product.quantity !== undefined
      )
    ) {
      return "cash"
    }
  } catch {
    return "unknown"
  }

  return "unknown"
}

const saveConversionRequest = async (payload: IhgConversionRequest) => {
  if (!chrome?.storage?.local) {
    return
  }

  await chrome.storage.local.set({
    [IHG_CONVERSION_STORAGE_KEY]: {
      ...payload,
      savedAt: new Date().toISOString()
    }
  })
}

const handleMessage = async (event: MessageEvent) => {
  if (event.source !== window) {
    return
  }

  const data = event.data as Record<string, unknown> | undefined
  if (!data || data[MESSAGE_FLAG] !== true) {
    return
  }

  const payload: IhgMessagePayload = {
    kind: data.kind as string | undefined,
    url: data.url as string | undefined,
    method: data.method as string | undefined,
    bodyType: data.bodyType as string | undefined,
    bodyText: (data.bodyText as string | null) ?? null,
    bookingType: detectBookingType((data.bodyText as string | null) ?? null),
    responseBodyText: (data.responseBodyText as string | null) ?? null,
    responseStatus: data.responseStatus as number | undefined,
    responseStatusText: data.responseStatusText as string | undefined,
    responseType: data.responseType as string | undefined,
    timestamp: data.timestamp as number | undefined
  }

  try {
    chrome.runtime.sendMessage({
      type: "ihg-capture",
      payload
    })
  } catch {
    // ignore send errors
  }

  if (!chrome?.storage?.local) {
    return
  }

  const existing = await chrome.storage.local.get(IHG_STORAGE_KEY)
  const existingPayload = existing[IHG_STORAGE_KEY] as IhgMessagePayload | undefined

  chrome.storage.local.set({
    [IHG_STORAGE_KEY]: {
      ...existingPayload,
      ...payload,
      receivedAt: new Date().toISOString()
    }
  })
}

window.addEventListener("message", handleMessage)

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: IhgReplayPayload }) => {
  if (message?.type !== "ihg-replay") {
    return
  }

  window.postMessage(
    {
      [REPLAY_FLAG]: true,
      ...message.payload
    },
    "*"
  )
})

const getHotelIdFromElement = (element: Element): string | null => {
  const candidates = [
    element.getAttribute("id"),
    element.getAttribute("data-hotel-id"),
    element.getAttribute("data-hotel-code")
  ]
  for (const candidate of candidates) {
    if (candidate) {
      const normalized = normalizeHotelId(candidate)
      if (normalized) {
        return normalized
      }
    }
  }

  const ancestor = element.closest(
    "app-hotel-card-list-view, .hotel-card-list-view-container, [data-testid='hotel-card'], [data-testid='hotelCardSID']"
  )
  if (ancestor) {
    const ancestorId =
      ancestor.getAttribute("id") ||
      ancestor.getAttribute("data-hotel-id") ||
      ancestor.getAttribute("data-hotel-code")
    if (ancestorId) {
      const normalized = normalizeHotelId(ancestorId)
      if (normalized) {
        return normalized
      }
    }
  }

  const fallback = element.closest("[id]")
  const fallbackId = fallback?.getAttribute("id")
  if (fallbackId && /^[a-z0-9]{3,8}$/i.test(fallbackId)) {
    const normalized = normalizeHotelId(fallbackId)
    if (normalized) {
      return normalized
    }
  }

  // Last resort: the pin-click details dialog has no id — join by price.
  return resolveHotelIdByPrice(element)
}

const formatCpp = (cpp?: number) => {
  return `${cpp.toFixed(2)}¢/pt`
}

const formatPoints = (points?: number) => {
  if (points === undefined) {
    return "—"
  }
  return `${new Intl.NumberFormat("en-US").format(points)} pts`
}

const formatCppSuffix = (cpp?: number) => {
  if (cpp === undefined || !Number.isFinite(cpp)) {
    return ""
  }
  return ` (${cpp.toFixed(2)}¢/pt)`
}

const formatPointsWithCpp = (points?: number, cpp?: number) => {
  return `${formatPoints(points)}${formatCppSuffix(cpp)}`
}

// Compact points for the tight map pin, matching IHG's own "21.5K" style.
const formatPointsCompact = (points?: number) => {
  if (points === undefined || points <= 0) {
    return ""
  }
  if (points >= 1000) {
    const k = points / 1000
    const text = Number.isInteger(k) ? String(k) : k.toFixed(2).replace(/\.?0+$/, "")
    return `${text}K pts`
  }
  return `${points} pts`
}

const formatPointsCash = (value?: IhgPointsCash, currency?: string) => {
  if (!value || (value.points === undefined && value.cash === undefined)) {
    return "—"
  }
  return `${formatPoints(value.points)} + ${formatCurrencyValue(value.cash, currency)}`
}

const formatCurrencyValue = (amount?: number, currency?: string) => {
  if (amount === undefined) {
    return "—"
  }
  if (currency) {
    const maybeUsd =
      currency !== USD_CURRENCY ? currencyRates.get(currency) : undefined
    const usdSuffix =
      currency !== USD_CURRENCY && maybeUsd !== undefined
        ? ` (${new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: USD_CURRENCY
          }).format(amount * maybeUsd)})`
        : ""
    try {
      return (
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency
        }).format(amount) + usdSuffix
      )
    } catch {
      return `${amount.toFixed(2)} ${currency}${usdSuffix}`
    }
  }
  return amount.toFixed(2)
}

const getUsdEquivalent = (amount?: number, currency?: string) => {
  if (amount === undefined) {
    return null
  }
  if (!currency || currency === USD_CURRENCY) {
    return amount
  }
  const rate = currencyRates.get(currency)
  if (rate === undefined) {
    return null
  }
  return amount * rate
}

const formatUsdAmount = (amount?: number) => {
  if (amount === undefined) {
    return ""
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: USD_CURRENCY
  }).format(amount)
}

const setTooltipText = (tooltip: HTMLElement, text: string) => {
  tooltip.replaceChildren(document.createTextNode(text))
}

const createCell = (text: string, className: string) => {
  const cell = document.createElement("span")
  cell.className = className
  cell.textContent = text
  return cell
}

const buildTooltipRow = (label: string, lowValue: string, highValue: string) => {
  const row = document.createElement("div")
  row.className = "pointlens-tooltip-row"
  row.appendChild(createCell(label, "pointlens-tooltip-cell pointlens-tooltip-cell--label"))
  row.appendChild(createCell(lowValue, "pointlens-tooltip-cell pointlens-tooltip-cell--value"))
  row.appendChild(
    createCell(
      highValue,
      "pointlens-tooltip-cell pointlens-tooltip-cell--value pointlens-tooltip-cell--high"
    )
  )
  return row
}

const buildTooltipDividerRow = () => {
  const divider = document.createElement("div")
  divider.className = "pointlens-tooltip-divider"
  return divider
}

const setTooltipDetails = (
  tooltip: HTMLElement,
  info: IhgRateInfo,
  options?: { pointsLabel?: string; stay?: IhgStayDetails }
) => {
  const content = document.createElement("div")
  content.className = "pointlens-tooltip-content"

  const grid = document.createElement("div")
  grid.className = "pointlens-tooltip-grid"
  const header = document.createElement("div")
  header.className = "pointlens-tooltip-row pointlens-tooltip-header"
  header.appendChild(
    createCell("", "pointlens-tooltip-cell pointlens-tooltip-cell--label")
  )
  header.appendChild(
    createCell("Lowest", "pointlens-tooltip-cell pointlens-tooltip-cell--value")
  )
  header.appendChild(
    createCell(
      "Highest",
      "pointlens-tooltip-cell pointlens-tooltip-cell--value pointlens-tooltip-cell--high"
    )
  )
  grid.appendChild(header)
  grid.appendChild(buildTooltipDividerRow())
  grid.appendChild(
    buildTooltipRow(
      "Base",
      formatCurrencyValue(info.lowestCash?.baseAmount, info.currency),
      formatCurrencyValue(info.highestCash?.baseAmount, info.currency)
    )
  )
  grid.appendChild(
    buildTooltipRow(
      "Fees",
      formatCurrencyValue(info.lowestCash?.excludedFeeSubTotal, info.currency),
      formatCurrencyValue(info.highestCash?.excludedFeeSubTotal, info.currency)
    )
  )
  grid.appendChild(
    buildTooltipRow(
      "Total",
      formatCurrencyValue(info.lowestCash?.amountAfterTax, info.currency),
      formatCurrencyValue(info.highestCash?.amountAfterTax, info.currency)
    )
  )
  grid.appendChild(buildTooltipDividerRow())
  grid.appendChild(
    buildTooltipRow(
      "Points",
      options?.pointsLabel ??
        formatPointsWithCpp(info.lowestPoints ?? info.points, info.cppLow ?? info.cpp),
      options?.pointsLabel ??
        formatPointsWithCpp(
          info.highestPoints ?? info.points,
          info.cppHigh ?? info.cpp
        )
    )
  )
  if (info.lowestPointsAndCash || info.highestPointsAndCash) {
    grid.appendChild(
      buildTooltipRow(
        "Pts + Cash",
        formatPointsCash(info.lowestPointsAndCash, info.currency),
        formatPointsCash(info.highestPointsAndCash, info.currency)
      )
    )
  }

  // Full-stay reward total (incl. 4th-night-free) when available.
  const stay = options?.stay
  if (stay && stay.status !== "none" && stay.status !== "error") {
    grid.appendChild(buildTooltipDividerRow())
    const stayLabel = stay.nights ? `Stay (${stay.nights}N)` : "Stay total"
    if (stay.status === "loading") {
      grid.appendChild(buildTooltipRow(stayLabel, "…", ""))
    } else if (stay.status === "ok" && stay.totalPoints !== undefined) {
      const discounted =
        stay.originalTotalPoints !== undefined && stay.originalTotalPoints > stay.totalPoints
      grid.appendChild(
        buildTooltipRow(
          stayLabel,
          formatPoints(stay.totalPoints),
          discounted ? `was ${formatPoints(stay.originalTotalPoints)}` : ""
        )
      )
    }
  }

  content.appendChild(grid)

  if (info.rewardNightAvailable === false) {
    const note = document.createElement("div")
    note.className = "pointlens-tooltip-note"
    note.textContent = "No award nights available"
    content.appendChild(note)
  }
  if (stay && stay.status === "ok" && (stay.freeNightCount ?? 0) > 0 && stay.savedPoints) {
    const benefit = document.createElement("div")
    benefit.className = "pointlens-tooltip-benefit"
    const nights = stay.freeNightCount === 1 ? "4th night free" : `${stay.freeNightCount} free nights`
    benefit.textContent = `★ ${nights} — saved ${formatPoints(stay.savedPoints)}`
    content.appendChild(benefit)
  }
  tooltip.replaceChildren(content)
}

const maybeFetchRateDetails = async (placeholder: HTMLElement) => {
  if (ihgSearchNights < 4) {
    return // 4th-night-free only applies to stays of 4+ nights
  }
  const hotelId = placeholder.dataset.hotelId
  if (!hotelId || ihgRateDetailsByHotel.has(hotelId)) {
    return // already fetched or in flight
  }
  if (!chrome?.runtime?.sendMessage) {
    return
  }
  ihgRateDetailsByHotel.set(hotelId, { status: "loading" })
  updatePlaceholderText(placeholder)
  let result: IhgStayDetails | undefined
  try {
    result = (await chrome.runtime.sendMessage({
      type: "ihg-rate-details",
      hotelMnemonic: hotelId
    })) as IhgStayDetails | undefined
  } catch {
    result = undefined
  }
  if (result && (result.status === "ok" || result.status === "none")) {
    ihgRateDetailsByHotel.set(hotelId, result)
  } else {
    // Transient failure (no response / HTTP error) — drop it so a later hover
    // or refresh retries instead of caching a permanent blank.
    ihgRateDetailsByHotel.delete(hotelId)
  }
  updatePlaceholderText(placeholder)
}

const ensurePlaceholderContents = (placeholder: HTMLElement) => {
  let iconWrapper = placeholder.querySelector<HTMLElement>(
    `.${PLACEHOLDER_ICON_CLASS}`
  )
  if (!iconWrapper) {
    iconWrapper = document.createElement("span")
    iconWrapper.className = PLACEHOLDER_ICON_CLASS

    const iconTarget = document.createElement("span")
    iconTarget.className = "pointlens-icon"
    iconWrapper.appendChild(iconTarget)

    const tooltip = document.createElement("span")
    tooltip.className = "pointlens-tooltip"
    tooltip.textContent = "Awaiting points response"
    iconWrapper.appendChild(tooltip)

    placeholder.appendChild(iconWrapper)
    const root = createRoot(iconTarget)
    root.render(React.createElement(CiCircleInfo, { "aria-hidden": "true" }))
    iconRoots.set(iconTarget, root)
    // Hovering to read the tooltip lazily pulls the full-stay reward total
    // (incl. 4th-night-free) for 4+ night stays.
    iconWrapper.addEventListener("mouseenter", () => {
      void maybeFetchRateDetails(placeholder)
    })
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
  const existing = valueEl.querySelector(".pointlens-skeleton")
  if (existing) {
    return
  }
  const skeleton = document.createElement("span")
  skeleton.className = "pointlens-skeleton"
  skeleton.setAttribute("aria-hidden", "true")
  valueEl.appendChild(skeleton)
}

const updatePlaceholderText = (placeholder: HTMLElement) => {
  let hotelId = placeholder.dataset.hotelId
  if (!hotelId) {
    const sibling = placeholder.previousElementSibling
    if (sibling?.matches("app-hotel-price")) {
      const siblingId = getHotelIdFromElement(sibling)
      if (siblingId) {
        hotelId = siblingId
        placeholder.dataset.hotelId = siblingId
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

  // In the pin-detail dialog the user opened one hotel deliberately — fetch the
  // 4th-night-free total eagerly instead of waiting on a hover that may race.
  // (maybeFetchRateDetails self-guards: fetches once, only for 4+ night stays.)
  if (
    placeholder.closest(
      "app-hotel-details-info-card, .p-dialog-content, .ui-dialog-content"
    )
  ) {
    void maybeFetchRateDetails(placeholder)
  }

  const info = ihgRatesByHotel.get(hotelId)
  const { iconWrapper, valueEl } = ensurePlaceholderContents(placeholder)
  const tooltip = iconWrapper.querySelector<HTMLElement>(".pointlens-tooltip")
  const errorMessage =
    ihgRateErrorsByHotel.get(hotelId) ?? ihgLastRateError ?? "Awaiting points response"
  const hasCashRates =
    info !== undefined &&
    (info.lowestCash !== undefined ||
      info.highestCash !== undefined ||
      info.cashAmount !== undefined)
  const hasPointsRates =
    info !== undefined &&
    (info.lowestPoints !== undefined ||
      info.highestPoints !== undefined ||
      info.points !== undefined)
  const pointsUnavailable = hasCashRates && !hasPointsRates

  const displayCpp =
    info?.cppLow !== undefined && Number.isFinite(info.cppLow)
      ? info.cppLow
      : info?.cpp

  updateValueClass(valueEl, displayCpp)

  if (info?.cpp !== undefined && Number.isFinite(info.cpp)) {
    placeholder.classList.remove("is-loading")
    const lowestTotal = getCashTotal(info.lowestCash)
    const usdTotal = getUsdEquivalent(lowestTotal, info.currency)
    const usdSuffix = usdTotal !== null ? ` (${formatUsdAmount(usdTotal)})` : ""
    const pointsValue = ihgShowPointsWithCpp
      ? formatPoints(info.lowestPoints ?? info.points)
      : ""
    const pointsSuffix = pointsValue ? ` (${pointsValue})` : ""
    valueEl.textContent = `${formatCpp(displayCpp)}${pointsSuffix}${usdSuffix}`
    if (tooltip) {
      setTooltipDetails(tooltip, info, { stay: ihgRateDetailsByHotel.get(hotelId) })
    }
    return
  }

  if (info && pointsUnavailable) {
    placeholder.classList.remove("is-loading")
    valueEl.textContent = "Reward Nights Unavailable"
    if (tooltip) {
      setTooltipDetails(tooltip, info, {
        pointsLabel: "Unavailable",
        stay: ihgRateDetailsByHotel.get(hotelId)
      })
    }
    return
  }

  if (tooltip) {
    setTooltipText(tooltip, errorMessage)
  }
  setSkeleton(placeholder)
}

// Rebuild the price -> CPP join tables from the parsed per-hotel rates. A
// second write of a different CPP for the same key marks it ambiguous (null).
// Insert into a price-keyed map, marking the key ambiguous (null) if a second
// hotel with a different value collides on the same price.
const addByPrice = <T>(map: Map<number, T | null>, key: number, value: T) => {
  if (!map.has(key)) {
    map.set(key, value)
  } else if (map.get(key) !== value) {
    map.set(key, null)
  }
}

const rebuildMapCppLookup = () => {
  ihgMapCppByCash.clear()
  ihgMapCppByPoints.clear()
  ihgHotelIdByCash.clear()
  ihgHotelIdByPoints.clear()
  // Mark "no rewards" only when the dataset actually carries reward info (at
  // least one hotel has points). Otherwise it's a cash-only response and points
  // are simply unknown — labelling every pin "No rewards" would be wrong.
  let anyRewards = false
  const noneKeys: number[] = []
  for (const [hotelId, info] of ihgRatesByHotel.entries()) {
    const cpp = info.cppLow ?? info.cpp
    const hasCpp = cpp !== undefined && Number.isFinite(cpp)
    const points = info.lowestPoints ?? info.points
    const hasRewards = points !== undefined && points > 0
    if (hasRewards) {
      anyRewards = true
    }
    const base = info.lowestCash?.baseAmount
    if (base !== undefined) {
      const cashKey = Math.round(base + (info.lowestCash?.feeOnlySubTotal ?? 0))
      addByPrice(ihgHotelIdByCash, cashKey, hotelId)
      if (hasCpp) {
        addByPrice(ihgMapCppByCash, cashKey, cpp as number)
      } else if (!hasRewards) {
        noneKeys.push(cashKey) // a no-reward hotel; confirm later via anyRewards
      }
    }
    if (hasCpp && hasRewards) {
      const ptsKey = Math.round(points as number)
      addByPrice(ihgMapCppByPoints, ptsKey, cpp as number)
      addByPrice(ihgHotelIdByPoints, ptsKey, hotelId)
    }
  }
  if (anyRewards) {
    for (const cashKey of noneKeys) {
      addByPrice(ihgMapCppByCash, cashKey, "none")
    }
  }
}

// The pin-click details dialog (app-hotel-details-info-card) carries no hotel
// id — only a displayed "156 USD" / "21.5K PTS" price. Resolve the mnemonic by
// joining that price back to a hotel (skip when ambiguous).
const resolveHotelIdByPrice = (element: Element): string | null => {
  // Scope to the OUTER dialog content: the price sits in .right-column
  // (app-hotel-details-info-card) but the hotel-detail link lives in the
  // sibling .left-column, so the inner card alone wouldn't see the link.
  const dialog = element.closest(".ui-dialog-content, .p-dialog-content")
  if (!dialog) {
    return null
  }
  // 1) Unambiguous: the hotel-detail link path carries the mnemonic
  //    (/hotels/<cc>/<lang>/<city>/<mnemonic>/hoteldetail). Preferred — it
  //    survives price collisions (two hotels at the same "from" price).
  const href =
    dialog.querySelector("a[href*='hoteldetail']")?.getAttribute("href") ?? ""
  const linkMatch = /\/([a-z0-9]{5,6})\/hoteldetail/i.exec(href)
  if (linkMatch) {
    const id = normalizeHotelId(linkMatch[1])
    if (id) {
      return id
    }
  }
  // 2) Fallback: join by displayed price (ambiguous prices return null).
  const priceEl =
    dialog.querySelector(".price") ??
    dialog.querySelector("app-hotel-cash") ??
    dialog.querySelector("app-hotel-price")
  const parsed = parseMarkerValue(priceEl?.textContent)
  if (!parsed) {
    return null
  }
  const id = parsed.isPoints
    ? ihgHotelIdByPoints.get(Math.round(parsed.value))
    : ihgHotelIdByCash.get(Math.round(parsed.value))
  return id ?? null
}

// Parse a marker's price text -> { value, isPoints }. Handles "212 USD",
// "28K PTS", "1,234 USD", "50.5K".
const parseMarkerValue = (
  text: string | null | undefined
): { value: number; isPoints: boolean } | undefined => {
  if (!text) {
    return undefined
  }
  const isPoints = /pts|points/i.test(text) || /\d\s*K\b/i.test(text)
  const match = /([\d.,]+)\s*([KkMm])?/.exec(text)
  if (!match) {
    return undefined
  }
  let value = Number(match[1].replace(/,/g, ""))
  if (!Number.isFinite(value)) {
    return undefined
  }
  const suffix = (match[2] || "").toUpperCase()
  if (suffix === "K") {
    value *= 1000
  } else if (suffix === "M") {
    value *= 1_000_000
  }
  return { value, isPoints }
}

const updateMapMarkers = () => {
  // Iterate the price box (.item-text) directly — it exists in both the white
  // (.marker-container) and the brand-colored hover (.marker-container--xx)
  // bubble, both under .map-marker-container. The CPP label lives inside it.
  const boxes = document.querySelectorAll<HTMLElement>(".map-marker-container .item-text")
  boxes.forEach((box) => {
    // Read the price from IHG's .amount span, never from our own label.
    const amountEl = box.querySelector<HTMLElement>(".amount") ?? box
    const parsed = parseMarkerValue(amountEl.textContent)
    let label = box.querySelector<HTMLElement>(`:scope > .${MAP_CPP_CLASS}`)
    const value = parsed
      ? parsed.isPoints
        ? ihgMapCppByPoints.get(Math.round(parsed.value))
        : ihgMapCppByCash.get(Math.round(parsed.value))
      : undefined
    if (value === undefined || value === null) {
      label?.remove() // unknown price or ambiguous (shared price)
      return
    }
    const noRewards = value === "none"
    const cppText = noRewards ? "No rewards" : formatCpp(value)
    // In CASH mode the marker shows only the cash price, so add the points line
    // above the ¢/pt. (In points mode the marker already shows points.)
    let ptsText = ""
    if (!noRewards && parsed && !parsed.isPoints) {
      const mnem = ihgHotelIdByCash.get(Math.round(parsed.value))
      const pInfo = mnem ? ihgRatesByHotel.get(mnem) : undefined
      ptsText = formatPointsCompact(pInfo?.lowestPoints ?? pInfo?.points)
    }
    if (!label) {
      label = document.createElement("span")
      label.className = MAP_CPP_CLASS
      box.appendChild(label)
    }
    label.classList.toggle(`${MAP_CPP_CLASS}--none`, noRewards)
    // Color the pin by value (green/amber/red), same thresholds as the list
    // placeholders. "No rewards" pins stay grey via the --none modifier.
    if (noRewards) {
      label.classList.remove("is-good", "is-bad", "is-mid")
    } else {
      updateValueClass(label, value as number)
    }
    const sig = `${ptsText}|${cppText}`
    if (label.dataset.av !== sig) {
      label.dataset.av = sig
      label.replaceChildren()
      if (ptsText) {
        const ptsEl = document.createElement("span")
        ptsEl.className = "av-pts"
        ptsEl.textContent = ptsText
        label.appendChild(ptsEl)
      }
      const cppEl = document.createElement("span")
      cppEl.className = "av-cpp"
      cppEl.textContent = cppText
      label.appendChild(cppEl)
    }
  })
}

const scheduleMapUpdate = () => {
  if (ihgMapUpdateScheduled) {
    return
  }
  ihgMapUpdateScheduled = true
  requestAnimationFrame(() => {
    ihgMapUpdateScheduled = false
    updateMapMarkers()
  })
}

// The pin-click dialog renders its price asynchronously ("From" -> "156 USD"),
// so re-resolve placeholders once it settles.
let ihgPlaceholderRefreshScheduled = false
const schedulePlaceholderRefresh = () => {
  if (ihgPlaceholderRefreshScheduled) {
    return
  }
  ihgPlaceholderRefreshScheduled = true
  requestAnimationFrame(() => {
    ihgPlaceholderRefreshScheduled = false
    updateExistingPlaceholders()
  })
}

const ensurePlaceholder = (priceElement: Element) => {
  const parent = priceElement.parentElement
  if (!parent) {
    return
  }

  const existing = parent.querySelector(`:scope > .${PLACEHOLDER_CLASS}`)
  if (existing) {
    return
  }

  const placeholder = document.createElement("div")
  placeholder.className = PLACEHOLDER_CLASS
  const hotelId = getHotelIdFromElement(priceElement)
  if (hotelId) {
    placeholder.dataset.hotelId = hotelId
  }
  parent.insertBefore(placeholder, priceElement.nextSibling)
  ensurePlaceholderContents(placeholder)
  updatePlaceholderText(placeholder)
}

const updatePlaceholders = (root: ParentNode = document) => {
  const priceElements = root.querySelectorAll("app-hotel-price")
  priceElements.forEach((element) => ensurePlaceholder(element))
}

const updateExistingPlaceholders = () => {
  const placeholders = document.querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
  placeholders.forEach((placeholder) => updatePlaceholderText(placeholder))
}

const updateValueClass = (valueEl: HTMLElement, cpp?: number) => {
  valueEl.classList.remove("is-good", "is-bad", "is-mid")

  if (cpp === undefined || !Number.isFinite(cpp)) {
    return
  }

  if (cpp >= ihgValueSettings.goodValueThreshold) {
    valueEl.classList.add("is-good")
    return
  }

  if (cpp <= ihgValueSettings.badValueThreshold) {
    valueEl.classList.add("is-bad")
    return
  }

  valueEl.classList.add("is-mid")
}

const extractNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
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

const isHotelCandidate = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    "hotelCode" in record ||
    "propertyCode" in record ||
    "summary" in record ||
    "rateRanges" in record ||
    "lowestPointsOnlyCost" in record ||
    "lowestCashOnlyCost" in record
  )
}

const findHotelCollection = (data: Record<string, unknown>) => {
  const queue: unknown[] = [data]
  const visited = new WeakSet<object>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== "object") {
      continue
    }

    if (visited.has(current)) {
      continue
    }
    visited.add(current)

    if (Array.isArray(current)) {
      if (current.some((item) => isHotelCandidate(item))) {
        return current
      }
      current.forEach((item) => queue.push(item))
      continue
    }

    const record = current as Record<string, unknown>
    Object.values(record).forEach((value) => {
      if (value && typeof value === "object") {
        queue.push(value)
      }
    })
  }

  return []
}

const getHotelCollection = (data: Record<string, unknown>): unknown[] => {
  const candidates = [
    data.hotels,
    data.hotelList,
    data.properties,
    data.data && (data.data as Record<string, unknown>).hotels,
    data.data && (data.data as Record<string, unknown>).hotelList,
    data.data && (data.data as Record<string, unknown>).properties
  ]

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
    }
  }

  return findHotelCollection(data)
}

const extractSearchSignature = (body: unknown) => {
  if (!body) {
    return null
  }

  let parsed: Record<string, unknown> | null = null
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as Record<string, unknown>
    } catch {
      return null
    }
  } else if (typeof body === "object") {
    parsed = body as Record<string, unknown>
  }

  if (!parsed) {
    return null
  }

  const startDate =
    typeof parsed.startDate === "string" ? parsed.startDate : undefined
  const endDate = typeof parsed.endDate === "string" ? parsed.endDate : undefined
  const geo =
    Array.isArray(parsed.geoLocation) && parsed.geoLocation.length > 0
      ? parsed.geoLocation[0]
      : null
  const lat =
    geo && typeof geo === "object" && "latitude" in geo
      ? String((geo as { latitude?: number }).latitude ?? "")
      : ""
  const lng =
    geo && typeof geo === "object" && "longitude" in geo
      ? String((geo as { longitude?: number }).longitude ?? "")
      : ""

  if (!startDate || !endDate || !lat || !lng) {
    return null
  }

  return `${startDate}|${endDate}|${lat}|${lng}`
}

const hasPointsRates = (hotel: Record<string, unknown>) => {
  const pointsPaths = [
    ["summary", "rateRanges", "lowestPointsOnlyCost", "points"],
    ["rateRanges", "lowestPointsOnlyCost", "points"],
    ["summary", "lowestPointsOnlyCost", "points"],
    ["lowestPointsOnlyCost", "points"]
  ]

  return pointsPaths.some((path) => {
    const raw = getValueByPath(hotel, path)
    return extractNumber(raw) !== undefined
  })
}

const extractHotelIdsFromResponse = (responseBodyText: string | null) => {
  if (!responseBodyText) {
    return { ids: new Set<string>(), hasPoints: false }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(responseBodyText) as Record<string, unknown>
  } catch {
    return { ids: new Set<string>(), hasPoints: false }
  }

  const hotels = getHotelCollection(parsed)
  const ids = new Set<string>()
  let hasPoints = false

  hotels.forEach((hotel) => {
    if (!hotel || typeof hotel !== "object") {
      return
    }

    const record = hotel as Record<string, unknown>
    getHotelIdentifiers(record).forEach((id) => ids.add(id))
    if (!hasPoints && hasPointsRates(record)) {
      hasPoints = true
    }
  })

  return { ids, hasPoints }
}

const getHotelIdentifiers = (hotel: Record<string, unknown>) => {
  const keys = ["hotelCode", "hotelId", "propertyCode", "hotelMnemonic", "code", "id"]
  const identifiers = new Set<string>()

  for (const key of keys) {
    const value = hotel[key]
    if (typeof value === "string" && value.trim().length > 0) {
      const normalized = normalizeHotelId(value)
      if (normalized) {
        identifiers.add(normalized)
      }
    }
    if (typeof value === "number") {
      const normalized = normalizeHotelId(String(value))
      if (normalized) {
        identifiers.add(normalized)
      }
    }
  }

  return Array.from(identifiers)
}

const getRateValue = (
  hotel: Record<string, unknown>,
  paths: string[][]
) => {
  for (const path of paths) {
    const raw = getValueByPath(hotel, path)
    const parsed = extractNumber(raw)
    if (parsed !== undefined) {
      return parsed
    }
  }

  return undefined
}

const normalizeCashCost = (value: unknown): IhgCashCost | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const baseAmount = extractNumber(record.baseAmount)
  const amountAfterTax = extractNumber(record.amountAfterTax)
  const basePlusExcludedFeesAmount = extractNumber(record.basePlusExcludedFeesAmount)

  // Fees/taxes on top of the base rate. The offers response no longer carries a
  // single `excludedFeeSubTotal`; it itemizes `feeTaxSubTotals[]` and rolls the
  // total into `amountAfterTax`. Derive the add-on so the tooltip "Fees" row
  // (Base + Fees = Total) reconciles.
  const excludedFeeSubTotal =
    extractNumber(record.excludedFeeSubTotal) ??
    (amountAfterTax !== undefined && baseAmount !== undefined
      ? Math.max(0, amountAfterTax - baseAmount)
      : undefined)

  // Resort/mandatory FEES only (excludes taxes) — `baseAmount + feeOnlySubTotal`
  // is the pre-tax "from" price IHG prints on its map markers, our join key for
  // labelling map pins.
  const feeTaxSubTotals = Array.isArray(record.feeTaxSubTotals)
    ? (record.feeTaxSubTotals as Array<Record<string, unknown>>)
    : []
  const feeOnlySubTotal = feeTaxSubTotals.length
    ? feeTaxSubTotals.reduce(
        (sum, entry) =>
          entry.otaCodeType === "FEE" ? sum + (extractNumber(entry.amount) ?? 0) : sum,
        0
      )
    : undefined

  if (
    baseAmount === undefined &&
    excludedFeeSubTotal === undefined &&
    amountAfterTax === undefined &&
    basePlusExcludedFeesAmount === undefined
  ) {
    return undefined
  }

  return {
    baseAmount,
    excludedFeeSubTotal,
    feeOnlySubTotal,
    amountAfterTax,
    basePlusExcludedFeesAmount
  }
}

const getCashCostByPath = (
  hotel: Record<string, unknown>,
  paths: string[][]
) => {
  for (const path of paths) {
    const raw = getValueByPath(hotel, path)
    const normalized = normalizeCashCost(raw)
    if (normalized) {
      return normalized
    }
  }
  return undefined
}

// Cash figure CPP + the badge total are computed from, per the user's tax-basis
// setting (default after-tax). Pre-tax = the room base + mandatory fees only
// (what IHG prints on its markers); after-tax = the taxes-included total.
const getCashTotal = (cost?: IhgCashCost) => {
  if (!cost) {
    return undefined
  }
  if (ihgValueSettings.taxBasis === "pretax") {
    if (cost.baseAmount !== undefined) {
      return cost.baseAmount + (cost.feeOnlySubTotal ?? 0)
    }
    return cost.basePlusExcludedFeesAmount ?? cost.amountAfterTax
  }
  return (
    cost.amountAfterTax ??
    cost.basePlusExcludedFeesAmount ??
    cost.baseAmount
  )
}

const getPointsCostByPath = (
  hotel: Record<string, unknown>,
  paths: string[][]
) => {
  for (const path of paths) {
    const raw = getValueByPath(hotel, path)
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>
      const points = extractNumber(record.points ?? record.originalPoints)
      if (points !== undefined) {
        return points
      }
    }
    const parsed = extractNumber(raw)
    if (parsed !== undefined) {
      return parsed
    }
  }
  return undefined
}

const getPointsCashByPath = (
  hotel: Record<string, unknown>,
  paths: string[][]
): IhgPointsCash | undefined => {
  for (const path of paths) {
    const raw = getValueByPath(hotel, path)
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>
      const points = extractNumber(record.points ?? record.originalPoints)
      const cash = extractNumber(record.cash ?? record.originalCash)
      if (points !== undefined || cash !== undefined) {
        return { points, cash }
      }
    }
  }
  return undefined
}

const parseRateMap = (responseBodyText: string | null) => {
  if (!responseBodyText) {
    return {
      map: new Map<string, IhgRateInfo>(),
      errorsByHotel: new Map<string, string>(),
      error: "Missing points response body"
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(responseBodyText) as Record<string, unknown>
  } catch {
    return {
      map: new Map<string, IhgRateInfo>(),
      errorsByHotel: new Map<string, string>(),
      error: "Failed to parse points response"
    }
  }

  const hotels = getHotelCollection(parsed)
  const nextMap = new Map<string, IhgRateInfo>()
  const errorsByHotel = new Map<string, string>()
  if (!Array.isArray(hotels) || hotels.length === 0) {
    return {
      map: nextMap,
      errorsByHotel,
      error: "No hotels found in points response"
    }
  }

  const cashPaths = [
    ["summary", "rateRanges", "lowestCashOnlyCost", "amountAfterTax"],
    ["summary", "rateRanges", "lowestCashOnlyCost", "amount"],
    ["rateRanges", "lowestCashOnlyCost", "amountAfterTax"],
    ["rateRanges", "lowestCashOnlyCost", "amount"],
    ["summary", "lowestCashOnlyCost", "amountAfterTax"],
    ["lowestCashOnlyCost", "amountAfterTax"],
    ["lowestCashOnlyCost", "amount"]
  ]
  const lowestCashPaths = [
    ["summary", "rateRanges", "lowestCashOnlyCost"],
    ["rateRanges", "lowestCashOnlyCost"],
    ["summary", "lowestCashOnlyCost"],
    ["lowestCashOnlyCost"]
  ]
  const highestCashPaths = [
    ["summary", "rateRanges", "highestCashOnlyCost"],
    ["rateRanges", "highestCashOnlyCost"],
    ["summary", "highestCashOnlyCost"],
    ["highestCashOnlyCost"]
  ]

  const pointsPaths = [
    ["summary", "rateRanges", "lowestPointsOnlyCost", "points"],
    ["rateRanges", "lowestPointsOnlyCost", "points"],
    ["summary", "lowestPointsOnlyCost", "points"],
    ["lowestPointsOnlyCost", "points"]
  ]
  const lowestPointsPaths = [
    ["summary", "rateRanges", "lowestPointsOnlyCost"],
    ["rateRanges", "lowestPointsOnlyCost"],
    ["summary", "lowestPointsOnlyCost"],
    ["lowestPointsOnlyCost"]
  ]
  const highestPointsPaths = [
    ["summary", "rateRanges", "highestPointsOnlyCost"],
    ["rateRanges", "highestPointsOnlyCost"],
    ["summary", "highestPointsOnlyCost"],
    ["highestPointsOnlyCost"]
  ]
  const lowestPointsAndCashPaths = [
    ["summary", "rateRanges", "lowestPointsAndCashCost"],
    ["rateRanges", "lowestPointsAndCashCost"],
    ["summary", "lowestPointsAndCashCost"],
    ["lowestPointsAndCashCost"]
  ]
  const highestPointsAndCashPaths = [
    ["summary", "rateRanges", "highestPointsAndCashCost"],
    ["rateRanges", "highestPointsAndCashCost"],
    ["summary", "highestPointsAndCashCost"],
    ["highestPointsAndCashCost"]
  ]

  hotels.forEach((hotel) => {
    if (!hotel || typeof hotel !== "object") {
      return
    }

    const record = hotel as Record<string, unknown>
    const hotelIds = getHotelIdentifiers(record)
    if (hotelIds.length === 0) {
      return
    }

    const propertyCurrency =
      typeof record.propertyCurrency === "string"
        ? record.propertyCurrency
        : undefined
    const lowestCash = getCashCostByPath(record, lowestCashPaths)
    const highestCash = getCashCostByPath(record, highestCashPaths)
    const lowestPoints = getPointsCostByPath(record, lowestPointsPaths)
    const highestPoints = getPointsCostByPath(record, highestPointsPaths)
    const lowestPointsAndCash = getPointsCashByPath(record, lowestPointsAndCashPaths)
    const highestPointsAndCash = getPointsCashByPath(record, highestPointsAndCashPaths)
    const rewardNightAvailable =
      typeof record.rewardNightAvailable === "boolean"
        ? record.rewardNightAvailable
        : undefined
    const cashAmount = getRateValue(record, cashPaths)
    const points = getRateValue(record, pointsPaths)
    const lowestCashTotal = getCashTotal(lowestCash)
    const highestCashTotal = getCashTotal(highestCash)
    let usdCashAmount = cashAmount
    let usdLowestCash = lowestCashTotal
    let usdHighestCash = highestCashTotal
    if (propertyCurrency && propertyCurrency !== USD_CURRENCY) {
      const conversionRate = currencyRates.get(propertyCurrency)
      if (conversionRate !== undefined) {
        if (usdCashAmount !== undefined) {
          usdCashAmount = usdCashAmount * conversionRate
        }
        if (usdLowestCash !== undefined) {
          usdLowestCash = usdLowestCash * conversionRate
        }
        if (usdHighestCash !== undefined) {
          usdHighestCash = usdHighestCash * conversionRate
        }
      } else {
        usdCashAmount = undefined
        usdLowestCash = undefined
        usdHighestCash = undefined
      }
    }
    const errorMessage =
      usdCashAmount === undefined && points === undefined
        ? "Missing cash and points rates"
        : usdCashAmount === undefined
          ? "Missing cash rate"
          : points === undefined || points <= 0
        ? "Missing points rate"
        : null

    const cppLow =
      usdLowestCash !== undefined && lowestPoints !== undefined && lowestPoints > 0
        ? (usdLowestCash / lowestPoints) * 100
        : undefined
    const cppHigh =
      usdHighestCash !== undefined && highestPoints !== undefined && highestPoints > 0
        ? (usdHighestCash / highestPoints) * 100
        : undefined
    const cppCandidates = [cppLow, cppHigh].filter(
      (value): value is number => value !== undefined && Number.isFinite(value)
    )
    const cpp = cppCandidates.length > 0 ? Math.min(...cppCandidates) : undefined

    hotelIds.forEach((hotelId) => {
      if (errorMessage) {
        errorsByHotel.set(hotelId, errorMessage)
      }
      nextMap.set(hotelId, {
        cashAmount: usdCashAmount,
        points,
        cpp,
        cppLow,
        cppHigh,
        lowestCash,
        highestCash,
        lowestPoints,
        highestPoints,
        lowestPointsAndCash,
        highestPointsAndCash,
        rewardNightAvailable,
        currency: propertyCurrency
      })
    })
  })

  return {
    map: nextMap,
    errorsByHotel,
    error: nextMap.size === 0 ? "No matching hotels in points response" : null
  }
}

const collectCurrencies = (responseBodyText: string | null) => {
  if (!responseBodyText) {
    return new Set<string>()
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(responseBodyText) as Record<string, unknown>
  } catch {
    return new Set<string>()
  }

  const hotels = getHotelCollection(parsed)
  const currencies = new Set<string>()
  hotels.forEach((hotel) => {
    if (!hotel || typeof hotel !== "object") {
      return
    }
    const record = hotel as Record<string, unknown>
    const propertyCurrency =
      typeof record.propertyCurrency === "string"
        ? record.propertyCurrency
        : undefined
    if (propertyCurrency && propertyCurrency !== USD_CURRENCY) {
      currencies.add(propertyCurrency)
    }
  })

  return currencies
}

const fetchConversionRate = async (currencyCode: string) => {
  const cached = currencyRates.get(currencyCode)
  if (cached !== undefined) {
    return cached
  }

  const inflight = inflightCurrencyRates.get(currencyCode)
  if (inflight) {
    return inflight
  }

  const request = (async () => {
    const url = new URL(
      "https://apis.ihg.com/finance/conversions/v2/currencies"
    )
    url.searchParams.set("qFcc", currencyCode)
    url.searchParams.set("qTcc", USD_CURRENCY)
    url.searchParams.set("qV", "1")

    const headers = {
      Accept: "application/json, text/plain, */*",
      "content-type": "application/json; charset=UTF-8",
      "x-ihg-api-key": IHG_API_KEY,
      "ihg-language": "en-US"
    }
    const requestDetails: IhgConversionRequest = {
      currencyCode,
      targetCurrency: USD_CURRENCY,
      request: {
        url: url.toString(),
        method: "GET",
        headers
      },
      response: null,
      error: null,
      requestedAt: new Date().toISOString()
    }

    const selectConversionRate = (
      results: Array<{
        from?: number
        result?: number
        source?: string
        brand?: unknown
      }> | null
    ) => {
      if (!results || results.length === 0) {
        return null
      }

      const valid = results.filter(
        (entry) =>
          entry &&
          entry.from === 1 &&
          typeof entry.result === "number" &&
          Number.isFinite(entry.result)
      )

      const preferred =
        valid.find((entry) => entry.source === "P") ??
        valid.find((entry) => entry.brand === undefined) ??
        valid[0]

      return preferred?.result ?? null
    }

    try {
      const response = await fetch(url.toString(), {
        headers,
        credentials: "include"
      })
      const responseBodyText = await response
        .clone()
        .text()
        .catch(() => null)
      const responsePayload = {
        status: response.status,
        statusText: response.statusText,
        bodyText: responseBodyText,
        bodyParsed: responseBodyText
      }
      if (responseBodyText) {
        try {
          responsePayload.bodyParsed = JSON.parse(responseBodyText)
        } catch {
          responsePayload.bodyParsed = responseBodyText
        }
      }
      if (!response.ok) {
        await saveConversionRequest({
          ...requestDetails,
          response: responsePayload,
          error: `Request failed with ${response.status}`
        })
        return null
      }

      const parsedBody =
        responsePayload.bodyParsed && typeof responsePayload.bodyParsed === "object"
          ? (responsePayload.bodyParsed as {
              results?: Array<{ result?: number }>
            })
          : null
      const rate = selectConversionRate(
        parsedBody?.results as
          | Array<{
              from?: number
              result?: number
              source?: string
              brand?: unknown
            }>
          | null
      )
      if (typeof rate === "number" && Number.isFinite(rate)) {
        currencyRates.set(currencyCode, rate)
        await saveConversionRequest({
          ...requestDetails,
          response: responsePayload
        })
        return rate
      }
      await saveConversionRequest({
        ...requestDetails,
        response: responsePayload,
        error: "Conversion rate missing from response."
      })
    } catch {
      await saveConversionRequest({
        ...requestDetails,
        response: null,
        error: "Request failed."
      })
      return null
    }
    return null
  })()

  inflightCurrencyRates.set(currencyCode, request)
  const result = await request
  inflightCurrencyRates.delete(currencyCode)
  return result
}

const getPointsResponseText = (
  lastRequest?: IhgStoredPayload,
  sentRequest?: IhgSentRequest,
  currentHotelIds?: Set<string>
) => {
  const sentParsedText =
    typeof sentRequest?.response?.bodyParsed === "string"
      ? sentRequest.response.bodyParsed
      : null
  const lastSignature = extractSearchSignature(lastRequest?.bodyText ?? null)
  const sentSignature = extractSearchSignature(
    sentRequest?.request?.body ?? sentParsedText ?? sentRequest?.response?.bodyText
  )
  const candidates = [
    {
      responseBodyText: lastRequest?.responseBodyText ?? null,
      source: "last",
      signature: lastSignature
    },
    {
      responseBodyText: sentParsedText ?? sentRequest?.response?.bodyText ?? null,
      source: "sent",
      signature: sentSignature
    }
  ]

  const withMeta = candidates.map((candidate) => {
    const meta = extractHotelIdsFromResponse(candidate.responseBodyText)
    return { ...candidate, ...meta }
  })

  if (currentHotelIds && currentHotelIds.size > 0) {
    const matchingWithPoints = withMeta.find(
      (candidate) =>
        candidate.responseBodyText &&
        candidate.hasPoints &&
        Array.from(currentHotelIds).some((id) => candidate.ids.has(id))
    )
    if (matchingWithPoints) {
      return {
        responseBodyText: matchingWithPoints.responseBodyText,
        error: null,
        source: matchingWithPoints.source
      }
    }

    const matching = withMeta.find(
      (candidate) =>
        candidate.responseBodyText &&
        Array.from(currentHotelIds).some((id) => candidate.ids.has(id))
    )
    if (matching) {
      return {
        responseBodyText: null,
        error: "Points response missing for current search",
        source: matching.source
      }
    }
  }

  const sentCandidate = withMeta.find((candidate) => candidate.source === "sent")
  if (
    sentCandidate?.responseBodyText &&
    sentCandidate.hasPoints &&
    sentCandidate.signature &&
    lastSignature &&
    sentCandidate.signature !== lastSignature
  ) {
    return {
      responseBodyText: null,
      error: "Points response does not match last search",
      source: sentCandidate.source
    }
  }

  const fallbackWithPoints = withMeta.find((candidate) => {
    if (!candidate.responseBodyText || !candidate.hasPoints) {
      return false
    }
    if (candidate.source === "sent" && lastSignature && candidate.signature) {
      return candidate.signature === lastSignature
    }
    return true
  })
  if (fallbackWithPoints) {
    return {
      responseBodyText: fallbackWithPoints.responseBodyText,
      error: currentHotelIds?.size ? "Points response does not match current search" : null,
      source: fallbackWithPoints.source
    }
  }

  const fallback = withMeta.find((candidate) => candidate.responseBodyText)
  if (fallback) {
    return {
      responseBodyText: fallback.responseBodyText,
      error: "Points response missing for current search",
      source: fallback.source
    }
  }

  return { responseBodyText: null, error: null, source: null }
}

const refreshRatesFromStorage = async () => {
  if (!chrome?.storage?.local) {
    return
  }

  const stored = await chrome.storage.local.get([
    IHG_STORAGE_KEY,
    IHG_SENT_STORAGE_KEY
  ])

  const lastRequest = stored[IHG_STORAGE_KEY] as IhgStoredPayload | undefined
  const sentRequest = stored[IHG_SENT_STORAGE_KEY] as IhgSentRequest | undefined
  const lastBookingType =
    lastRequest?.bookingType ?? detectBookingType(lastRequest?.bodyText ?? null)
  ihgShowPointsWithCpp = lastBookingType !== "points"

  // Track stay length + invalidate per-hotel rateDetails when the search changes.
  ihgSearchNights = computeNights(lastRequest?.bodyText)
  const rateDetailsSignature = extractSearchSignature(lastRequest?.bodyText ?? null)
  if (rateDetailsSignature !== ihgRateDetailsSignature) {
    ihgRateDetailsSignature = rateDetailsSignature
    ihgRateDetailsByHotel.clear()
  }

  const hotelIdElements = document.querySelectorAll(
    "app-hotel-card-list-view[id], .hotel-card-list-view-container[id], [data-testid='hotel-card'][id]"
  )
  const currentHotelIds = new Set<string>()
  hotelIdElements.forEach((element) => {
    const id = normalizeHotelId(element.getAttribute("id"))
    if (id) {
      currentHotelIds.add(id)
    }
  })

  const selected = getPointsResponseText(lastRequest, sentRequest, currentHotelIds)
  if (!selected.responseBodyText) {
    ihgRatesByHotel = new Map<string, IhgRateInfo>()
    ihgRateErrorsByHotel = new Map<string, string>()
    ihgLastRateError = selected.error ?? "Awaiting points response"
    ihgLastRateSource = selected.source
    rebuildMapCppLookup()
    updateExistingPlaceholders()
    scheduleMapUpdate()
    return
  }

  const currenciesNeeded = collectCurrencies(selected.responseBodyText)
  if (currenciesNeeded.size > 0) {
    await Promise.all(
      Array.from(currenciesNeeded).map((currencyCode) =>
        fetchConversionRate(currencyCode)
      )
    )
  }
  const parsed = parseRateMap(selected.responseBodyText)
  ihgRatesByHotel = parsed.map
  ihgRateErrorsByHotel = parsed.errorsByHotel
  ihgLastRateError = selected.error ?? parsed.error
  ihgLastRateSource = selected.source
  rebuildMapCppLookup()
  updateExistingPlaceholders()
  scheduleMapUpdate()
}

const refreshValueSettings = async () => {
  if (!chrome?.storage?.local) {
    ihgValueSettings = DEFAULT_IHG_VALUE_SETTINGS
    updateExistingPlaceholders()
    return
  }

  const stored = await chrome.storage.local.get([IHG_VALUE_SETTINGS_KEY])
  ihgValueSettings = normalizeIhgValueSettings(
    stored[IHG_VALUE_SETTINGS_KEY] as Partial<typeof ihgValueSettings> | undefined
  )
  // Rebuild rates so CPP + the badge total reflect the (possibly changed) tax basis.
  await refreshRatesFromStorage()
}

const observePriceCards = () => {
  if (!document.getElementById(PLACEHOLDER_STYLE_ID)) {
    const style = document.createElement("style")
    style.id = PLACEHOLDER_STYLE_ID
    style.textContent = `
      .${PLACEHOLDER_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        min-height: 16px;
        min-width: 64px;
        margin-left: 8px;
        gap: 6px;
        font-size: 14px;
        text-align: right;
        width: 100%;
      }
      .${PLACEHOLDER_ICON_CLASS} {
        position: relative;
        display: inline-flex;
        align-items: center;
        color: #6b7280;
        cursor: default;
        font-size: 22px;
        line-height: 1;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-icon {
        display: inline-flex;
        align-items: center;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip {
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
        padding: 8px;
        border-radius: 4px;
        white-space: normal;
        transition: opacity 0.15s ease, transform 0.15s ease;
        z-index: 9999;
        box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12);
        min-width: 320px;
      }
      .${PLACEHOLDER_ICON_CLASS}:hover .pointlens-tooltip {
        opacity: 1;
        transform: translateY(-8px);
      }
      /* In the pin-detail dialog, .right-column is position:sticky → a stacking
         context that traps our tooltip below the image gallery (z-index:9999 is
         scoped inside it). While the CPP icon is hovered, lift the whole column
         above the gallery so the tooltip is fully visible. */
      .p-dialog-content .right-column:has(.${PLACEHOLDER_ICON_CLASS}:hover),
      .ui-dialog-content .right-column:has(.${PLACEHOLDER_ICON_CLASS}:hover),
      app-hotel-details-info-card .right-column:has(.${PLACEHOLDER_ICON_CLASS}:hover) {
        z-index: 1000;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-grid {
        display: grid;
        grid-template-columns: max-content minmax(140px, auto) minmax(140px, auto);
        column-gap: 12px;
        row-gap: 2px;
        align-items: center;
        justify-content: start;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-row {
        display: contents;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-cell {
        white-space: nowrap;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-cell--label {
        color: #475569;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-cell--value {
        font-weight: 400;
        color: #0f172a;
        text-align: left;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-cell--high {
        border-left: 1px solid #e2e8f0;
        padding-left: 8px;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-divider {
        grid-column: 1 / -1;
        border-top: 1px solid #e2e8f0;
        height: 1px;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-header .pointlens-tooltip-cell {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #475569;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-header .pointlens-tooltip-cell--label {
        color: transparent;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-note {
        margin-top: 4px;
        font-size: 10px;
        font-weight: 600;
        color: #b91c1c;
      }
      .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-benefit {
        margin-top: 4px;
        font-size: 10px;
        font-weight: 600;
        color: #047857;
      }
      .${PLACEHOLDER_VALUE_CLASS} {
        display: inline-flex;
        align-items: center;
        padding: 2px 6px;
        border: 1px solid #cbd5e1;
        background: #f5f5f5;
        border-radius: 4px;
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
      .${PLACEHOLDER_CLASS}.is-loading .pointlens-skeleton {
        display: inline-block;
        width: 56px;
        height: 12px;
        border-radius: 6px;
        background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 37%, #e5e7eb 63%);
        background-size: 400% 100%;
        animation: pointlens-skeleton 1.4s ease infinite;
      }
      @keyframes pointlens-skeleton {
        0% { background-position: 100% 50%; }
        100% { background-position: 0 50%; }
      }
      /* The pin's price box (.item-text) is a flex ROW, which would shove our
         label to the right. Stack it UNDER the price — scoped to labelled pins
         only via :has() so untouched pins are unaffected. */
      .item-text:has(> .${MAP_CPP_CLASS}) {
        flex-direction: column !important;
        justify-content: center;
        align-items: center;
      }
      .${MAP_CPP_CLASS} {
        display: block;
        font-size: 9px;
        font-weight: 800;
        line-height: 1.05;
        text-align: center;
        color: #475569;            /* neutral fallback, readable on the white bubble */
        white-space: nowrap;
      }
      /* Color by value, same thresholds/palette as the list placeholders. */
      .${MAP_CPP_CLASS}.is-good { color: #047857; }   /* green */
      .${MAP_CPP_CLASS}.is-mid { color: #b45309; }    /* amber */
      .${MAP_CPP_CLASS}.is-bad { color: #be123c; }    /* red */
      .${MAP_CPP_CLASS} > span { display: block; }
      .${MAP_CPP_CLASS} .av-pts { font-weight: 600; }   /* points line */
      .${MAP_CPP_CLASS} .av-cpp { font-weight: 800; }   /* ¢/pt line */
      .${MAP_CPP_CLASS}--none {
        color: #9ca3af;            /* muted grey: hotel has no reward nights */
        font-weight: 600;
      }
      /* On hover / list-card highlight the bubble swaps to the brand color with
         white text (a .marker-container--xx brand container or .brand-highlight
         ancestor). Match it so the CPP stays legible. */
      .brand-highlight .${MAP_CPP_CLASS},
      [class*="marker-container--"] .${MAP_CPP_CLASS} {
        color: #ffffff;
      }
      .map-marker-container,
      .map-marker-container .item-text { overflow: visible; }
    `
    document.head.appendChild(style)
  }

  updatePlaceholders()
  void refreshRatesFromStorage()
  void refreshValueSettings()

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) {
          return
        }

        if (node.matches("app-hotel-price")) {
          ensurePlaceholder(node)
        }

        updatePlaceholders(node)

        // Details dialog price loads late and has no hotel id (resolved by
        // price) — re-resolve placeholders when price nodes settle.
        if (
          node.matches?.("app-hotel-price, app-hotel-cash, .price") ||
          node.querySelector?.("app-hotel-price")
        ) {
          schedulePlaceholderRefresh()
        }

        // Map pins are highly dynamic: they get added on pan and the bubble is
        // re-rendered (white <-> brand container) on hover/select, which drops
        // our label. Re-run on any marker-ish mutation (debounced via rAF).
        if (
          node.matches?.("[class*='marker'], .item-text, .amount") ||
          node.querySelector?.("[class*='marker'], .map-marker")
        ) {
          scheduleMapUpdate()
        }
      })
    }
  })

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  })
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return
    }

    if (changes[IHG_STORAGE_KEY] || changes[IHG_SENT_STORAGE_KEY]) {
      void refreshRatesFromStorage()
    }
    if (changes[IHG_VALUE_SETTINGS_KEY]) {
      ihgValueSettings = normalizeIhgValueSettings(
        changes[IHG_VALUE_SETTINGS_KEY]?.newValue as
          | Partial<typeof ihgValueSettings>
          | undefined
      )
      // Rebuild rates so CPP + the badge total reflect the new tax basis.
      void refreshRatesFromStorage()
    }
  })
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", observePriceCards, { once: true })
} else {
  observePriceCards()
}
