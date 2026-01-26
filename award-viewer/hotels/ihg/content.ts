import type { PlasmoCSConfig } from "plasmo"
import React from "react"
import { createRoot } from "react-dom/client"
import { FcViewDetails } from "react-icons/fc"

const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
const IHG_SENT_STORAGE_KEY = "award-viewer:ihg-sent-request"
const MESSAGE_FLAG = "__AWARD_VIEWER_IHG__"
const REPLAY_FLAG = "__AWARD_VIEWER_IHG_REPLAY__"
const PLACEHOLDER_CLASS = "award-viewer-price-placeholder"
const PLACEHOLDER_ICON_CLASS = "award-viewer-cpp-icon"
const PLACEHOLDER_VALUE_CLASS = "award-viewer-cpp-value"
const PLACEHOLDER_STYLE_ID = "award-viewer-placeholder-style"

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
}

let ihgRatesByHotel = new Map<string, IhgRateInfo>()
let ihgRateErrorsByHotel = new Map<string, string>()
let ihgLastRateError: string | null = null
let ihgLastRateSource: string | null = null
const iconRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()

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
    tooltip.textContent = "More details coming soon"
    iconWrapper.appendChild(tooltip)

    placeholder.appendChild(iconWrapper)
    const root = createRoot(iconTarget)
    root.render(React.createElement(FcViewDetails, { "aria-hidden": "true" }))
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
  if (info?.cpp !== undefined && Number.isFinite(info.cpp)) {
    const { valueEl } = ensurePlaceholderContents(placeholder)
    placeholder.classList.remove("is-loading")
    valueEl.textContent = formatCpp(info.cpp)
    return
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

  const pointsPaths = [
    ["summary", "rateRanges", "lowestPointsOnlyCost", "points"],
    ["rateRanges", "lowestPointsOnlyCost", "points"],
    ["summary", "lowestPointsOnlyCost", "points"],
    ["lowestPointsOnlyCost", "points"]
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

    const cashAmount = getRateValue(record, cashPaths)
    const points = getRateValue(record, pointsPaths)
    const errorMessage =
      cashAmount === undefined && points === undefined
        ? "Missing cash and points rates"
        : cashAmount === undefined
          ? "Missing cash rate"
          : points === undefined || points <= 0
            ? "Missing points rate"
            : null

    const cpp =
      cashAmount !== undefined && points !== undefined && points > 0
        ? (cashAmount / points) * 100
        : undefined

    hotelIds.forEach((hotelId) => {
      if (errorMessage) {
        errorsByHotel.set(hotelId, errorMessage)
      }
      nextMap.set(hotelId, {
        cashAmount,
        points,
        cpp
      })
    })
  })

  return {
    map: nextMap,
    errorsByHotel,
    error: nextMap.size === 0 ? "No matching hotels in points response" : null
  }
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
  ihgRatesByHotel = parsed.map
  ihgRateErrorsByHotel = parsed.errorsByHotel
  ihgLastRateError = selected.error ?? parsed.error
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
        background: #111827;
        color: #ffffff;
        font-size: 11px;
        padding: 4px 6px;
        border-radius: 4px;
        white-space: nowrap;
        transition: opacity 0.15s ease, transform 0.15s ease;
        z-index: 9999;
      }
      .${PLACEHOLDER_ICON_CLASS}:hover .award-viewer-tooltip {
        opacity: 1;
        transform: translateY(-8px);
      }
      .${PLACEHOLDER_VALUE_CLASS} {
        display: inline-flex;
        align-items: center;
        padding: 2px 6px;
        border: 1px solid #6b7280;
        background: #e5e7eb;
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
