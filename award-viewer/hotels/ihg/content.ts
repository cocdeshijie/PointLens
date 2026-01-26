import type { PlasmoCSConfig } from "plasmo"
import React from "react"
import { createRoot } from "react-dom/client"
import { CiCircleInfo } from "react-icons/ci"

const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
const IHG_SENT_STORAGE_KEY = "award-viewer:ihg-sent-request"
const MESSAGE_FLAG = "__AWARD_VIEWER_IHG__"
const REPLAY_FLAG = "__AWARD_VIEWER_IHG_REPLAY__"
const PLACEHOLDER_CLASS = "award-viewer-price-placeholder"
const PLACEHOLDER_ICON_CLASS = "award-viewer-cpp-icon"
const PLACEHOLDER_VALUE_CLASS = "award-viewer-cpp-value"
const PLACEHOLDER_STYLE_ID = "award-viewer-placeholder-style"
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
  currency?: string
}

let ihgRatesByHotel = new Map<string, IhgRateInfo>()
let ihgRateErrorsByHotel = new Map<string, string>()
let ihgLastRateError: string | null = null
let ihgLastRateSource: string | null = null
const iconRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
const currencyRates = new Map<string, number>()
const inflightCurrencyRates = new Map<string, Promise<number | null>>()

type IhgCashCost = {
  baseAmount?: number
  excludedFeeSubTotal?: number
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

  return null
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

const buildTooltipRow = (label: string, lowValue: string, highValue: string) => {
  const row = document.createElement("div")
  row.className = "award-viewer-tooltip-row"
  const labelEl = document.createElement("span")
  labelEl.textContent = label
  const lowEl = document.createElement("span")
  lowEl.textContent = lowValue
  const highEl = document.createElement("span")
  highEl.textContent = highValue
  row.appendChild(labelEl)
  row.appendChild(lowEl)
  row.appendChild(highEl)
  return row
}

const setTooltipDetails = (tooltip: HTMLElement, info: IhgRateInfo) => {
  const content = document.createElement("div")
  content.className = "award-viewer-tooltip-content"

  const grid = document.createElement("div")
  grid.className = "award-viewer-tooltip-grid"
  const header = document.createElement("div")
  header.className = "award-viewer-tooltip-row award-viewer-tooltip-header"
  header.appendChild(document.createElement("span"))
  const lowLabel = document.createElement("span")
  lowLabel.textContent = "Lowest"
  const highLabel = document.createElement("span")
  highLabel.textContent = "Highest"
  header.appendChild(lowLabel)
  header.appendChild(highLabel)
  grid.appendChild(header)
  const headerDivider = document.createElement("div")
  headerDivider.className = "award-viewer-tooltip-divider"
  grid.appendChild(headerDivider)
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
  const divider = document.createElement("div")
  divider.className = "award-viewer-tooltip-divider"
  grid.appendChild(divider)
  grid.appendChild(
    buildTooltipRow(
      "Points",
      formatPointsWithCpp(info.lowestPoints ?? info.points, info.cppLow ?? info.cpp),
      formatPointsWithCpp(info.highestPoints ?? info.points, info.cppHigh ?? info.cpp)
    )
  )
  content.appendChild(grid)
  tooltip.replaceChildren(content)
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
    tooltip.textContent = "Awaiting points response"
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

  const info = ihgRatesByHotel.get(hotelId)
  const { iconWrapper, valueEl } = ensurePlaceholderContents(placeholder)
  const tooltip = iconWrapper.querySelector<HTMLElement>(".award-viewer-tooltip")
  const errorMessage =
    ihgRateErrorsByHotel.get(hotelId) ?? ihgLastRateError ?? "Awaiting points response"

  if (info?.cpp !== undefined && Number.isFinite(info.cpp)) {
    placeholder.classList.remove("is-loading")
    const lowestTotal = getCashTotal(info.lowestCash)
    const usdTotal = getUsdEquivalent(lowestTotal, info.currency)
    const usdSuffix = usdTotal !== null ? ` (${formatUsdAmount(usdTotal)})` : ""
    valueEl.textContent = `${formatCpp(info.cpp)}${usdSuffix}`
    if (tooltip) {
      setTooltipDetails(tooltip, info)
    }
    return
  }

  if (tooltip) {
    setTooltipText(tooltip, errorMessage)
  }
  setSkeleton(placeholder)
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
  const excludedFeeSubTotal = extractNumber(record.excludedFeeSubTotal)
  const amountAfterTax = extractNumber(record.amountAfterTax)
  const basePlusExcludedFeesAmount = extractNumber(record.basePlusExcludedFeesAmount)

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

const getCashTotal = (cost?: IhgCashCost) => {
  if (!cost) {
    return undefined
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
  const currenciesNeeded = new Set<string>()

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
      } else if (
        usdCashAmount !== undefined ||
        usdLowestCash !== undefined ||
        usdHighestCash !== undefined
      ) {
        usdCashAmount = undefined
        usdLowestCash = undefined
        usdHighestCash = undefined
        currenciesNeeded.add(propertyCurrency)
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
        currency: propertyCurrency
      })
    })
  })

  return {
    map: nextMap,
    errorsByHotel,
    error: nextMap.size === 0 ? "No matching hotels in points response" : null,
    currenciesNeeded
  }
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

    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json, text/plain, */*",
          "content-type": "application/json; charset=UTF-8",
          "x-ihg-api-key": IHG_API_KEY,
          "ihg-language": "en-US"
        },
        credentials: "include"
      })
      if (!response.ok) {
        return null
      }
      const payload = (await response.json()) as {
        results?: Array<{ result?: number }>
      }
      const rate = payload.results?.[0]?.result
      if (typeof rate === "number" && Number.isFinite(rate)) {
        currencyRates.set(currencyCode, rate)
        return rate
      }
    } catch {
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
    updateExistingPlaceholders()
    return
  }

  const parsed = parseRateMap(selected.responseBodyText)
  if (parsed.currenciesNeeded.size > 0) {
    await Promise.all(
      Array.from(parsed.currenciesNeeded).map((currencyCode) =>
        fetchConversionRate(currencyCode)
      )
    )
  }
  const finalParsed =
    parsed.currenciesNeeded.size > 0 ? parseRateMap(selected.responseBodyText) : parsed
  ihgRatesByHotel = finalParsed.map
  ihgRateErrorsByHotel = finalParsed.errorsByHotel
  ihgLastRateError = selected.error ?? finalParsed.error
  ihgLastRateSource = selected.source
  updateExistingPlaceholders()
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
        padding: 8px;
        border-radius: 4px;
        white-space: normal;
        transition: opacity 0.15s ease, transform 0.15s ease;
        z-index: 9999;
        box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12);
        min-width: 320px;
      }
      .${PLACEHOLDER_ICON_CLASS}:hover .award-viewer-tooltip {
        opacity: 1;
        transform: translateY(-8px);
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-grid {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
        gap: 8px;
        align-items: center;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-row span:first-child {
        color: #475569;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-row span:not(:first-child) {
        font-weight: 600;
        color: #0f172a;
        text-align: left;
        white-space: nowrap;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-row span:last-child {
        border-left: 1px solid #e2e8f0;
        padding-left: 8px;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-row span {
        white-space: nowrap;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-divider {
        height: 1px;
        background: #e2e8f0;
        margin: 0;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-header span {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #475569;
      }
      .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-header span:first-child {
        color: transparent;
      }
      .${PLACEHOLDER_VALUE_CLASS} {
        display: inline-flex;
        align-items: center;
        padding: 2px 6px;
        border: 1px solid #cbd5e1;
        background: #f5f5f5;
        border-radius: 4px;
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
    `
    document.head.appendChild(style)
  }

  updatePlaceholders()
  void refreshRatesFromStorage()

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
  })
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", observePriceCards, { once: true })
} else {
  observePriceCards()
}
