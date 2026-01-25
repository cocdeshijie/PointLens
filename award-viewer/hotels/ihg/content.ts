import type { PlasmoCSConfig } from "plasmo"

const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
const IHG_SENT_STORAGE_KEY = "award-viewer:ihg-sent-request"
const MESSAGE_FLAG = "__AWARD_VIEWER_IHG__"
const REPLAY_FLAG = "__AWARD_VIEWER_IHG_REPLAY__"
const PLACEHOLDER_CLASS = "award-viewer-price-placeholder"

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
  responseBodyText?: string | null
}

type IhgSentRequest = {
  bookingType?: IhgBookingType
  response?: {
    bodyText: string | null
  } | null
}

type IhgRateInfo = {
  cashAmount?: number
  points?: number
  cpp?: number
}

let ihgRatesByHotel = new Map<string, IhgRateInfo>()

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
      return candidate
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
      return ancestorId
    }
  }

  const fallback = element.closest("[id]")
  const fallbackId = fallback?.getAttribute("id")
  if (fallbackId && /^[a-z0-9]{3,8}$/i.test(fallbackId)) {
    return fallbackId
  }

  return null
}

const formatCpp = (cpp?: number) => {
  if (cpp === undefined || !Number.isFinite(cpp)) {
    return "placeholder"
  }

  return `${cpp.toFixed(2)}¢/pt`
}

const updatePlaceholderText = (placeholder: HTMLElement) => {
  let hotelId = placeholder.dataset.hotelId
  if (!hotelId) {
    const sibling = placeholder.previousElementSibling
    if (sibling?.matches("app-hotel-price")) {
      hotelId = getHotelIdFromElement(sibling)
      if (hotelId) {
        placeholder.dataset.hotelId = hotelId
      }
    }
  }

  if (!hotelId) {
    placeholder.textContent = "placeholder"
    return
  }

  const info = ihgRatesByHotel.get(hotelId)
  placeholder.textContent = formatCpp(info?.cpp)
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

const getHotelIdentifier = (hotel: Record<string, unknown>) => {
  const keys = ["hotelCode", "hotelId", "propertyCode", "hotelMnemonic", "code", "id"]
  for (const key of keys) {
    const value = hotel[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
    if (typeof value === "number") {
      return String(value)
    }
  }

  return null
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
    return new Map<string, IhgRateInfo>()
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(responseBodyText) as Record<string, unknown>
  } catch {
    return new Map<string, IhgRateInfo>()
  }

  const hotels = getHotelCollection(parsed)
  const nextMap = new Map<string, IhgRateInfo>()

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
    const hotelId = getHotelIdentifier(record)
    if (!hotelId) {
      return
    }

    const cashAmount = getRateValue(record, cashPaths)
    const points = getRateValue(record, pointsPaths)
    const cpp =
      cashAmount !== undefined && points !== undefined && points > 0
        ? (cashAmount / points) * 100
        : undefined

    nextMap.set(hotelId, {
      cashAmount,
      points,
      cpp
    })
  })

  return nextMap
}

const getPointsResponseText = (
  lastRequest?: IhgStoredPayload,
  sentRequest?: IhgSentRequest
) => {
  if (lastRequest?.bookingType === "points" && lastRequest.responseBodyText) {
    return lastRequest.responseBodyText
  }

  if (sentRequest?.bookingType === "points" && sentRequest.response?.bodyText) {
    return sentRequest.response.bodyText
  }

  return null
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

  const responseBodyText = getPointsResponseText(lastRequest, sentRequest)
  if (!responseBodyText) {
    return
  }

  ihgRatesByHotel = parseRateMap(responseBodyText)
  updateExistingPlaceholders()
}

const observePriceCards = () => {
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
