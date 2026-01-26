const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
const IHG_SENT_STORAGE_KEY = "award-viewer:ihg-sent-request"
const IHG_TARGET_URL = "https://apis.ihg.com/availability/v3/hotels/offers"
const requestMap = new Map<
  string,
  {
    url: string
    method: string
    bodyType: string
    bodyText: string | null
    requestHeaders?: chrome.webRequest.HttpHeader[]
    searchRadius?: number
    searchSignature?: string | null
  }
>()
const replaySent = new Set<string>()
const backgroundSent = new Set<string>()
let maxSearchRadius = 0
let lastSearchSignature: string | null = null
const MIN_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "X-CDC-API-KEY": "4_jpzahMO4CBnl9Elopzfr0A",
  "x-ihg-api-key": "se9ym5iAzaW8pxfBjkmgbuGjJcr3Pj6Y",
  "IHG-SessionId": "83770c05-7e86-4353-bebc-cc795c282872",
  "X-IHG-SSO-TOKEN":
    "REDACTED_EXPIRED_MEMBER_TOKEN"
}
const MIN_BODY = {
  radius: 30,
  distanceType: "STRAIGHT_LINE",
  startDate: "2026-02-09",
  endDate: "2026-02-10",
  geoLocation: [{ latitude: 45.464699, longitude: -98.486099 }],
  products: [
    { productCode: "SR", startDate: "2026-02-09", endDate: "2026-02-10" }
  ],
  rates: {
    ratePlanCodes: [
      { internal: "IVAN1" },
      { internal: "IVAN3" },
      { internal: "IVAN5" },
      { internal: "IVAN6" },
      { internal: "IVAN7" },
      { internal: "IVANI" }
    ]
  }
}

type IhgStoredPayload = {
  responseBodyText?: string | null
}

type IhgMessagePayload = {
  kind?: string
  url?: string
  method?: string
  bodyType?: string
  bodyText?: string | null
  bookingType?: IhgBookingType
  requestHeaders?: chrome.webRequest.HttpHeader[]
  responseBodyText?: string | null
  responseStatus?: number
  responseStatusText?: string
  responseType?: string
  timestamp?: number
}

type IhgSentRequest = {
  request: {
    url: string
    method: string
    headers: Record<string, string>
    body: unknown
  }
  bookingType?: IhgBookingType
  response: {
    status: number
    statusText: string
    bodyText: string | null
    bodyParsed: unknown
  } | null
  error?: string | null
  sentAt?: string
}

type RawBodyItem = {
  bytes?: ArrayBuffer
}

type IhgBookingType = "points" | "cash" | "unknown"

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

const parseBody = (bodyText: string | null) => {
  if (!bodyText) {
    return null
  }
  try {
    return JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return null
  }
}

const extractSearchSignature = (bodyText: string | null) => {
  const parsed = parseBody(bodyText)
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

const extractSearchRadius = (bodyText: string | null) => {
  const parsed = parseBody(bodyText)
  if (!parsed || !("radius" in parsed)) {
    return null
  }

  const raw = parsed.radius
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === "string") {
    const parsedNumber = Number.parseFloat(raw)
    return Number.isFinite(parsedNumber) ? parsedNumber : null
  }
  return null
}

const decodeRawBody = (raw: RawBodyItem[]) => {
  if (!raw.length || !raw[0].bytes) {
    return null
  }

  try {
    const decoder = new TextDecoder("utf-8")
    return decoder.decode(raw[0].bytes)
  } catch {
    return null
  }
}

const extractRequestBody = (details: chrome.webRequest.WebRequestBodyDetails) => {
  const { requestBody } = details
  if (!requestBody) {
    return { bodyType: "null", bodyText: null }
  }

  if (requestBody.formData) {
    return {
      bodyType: "formData",
      bodyText: JSON.stringify(requestBody.formData)
    }
  }

  if (requestBody.raw) {
    return {
      bodyType: "raw",
      bodyText: decodeRawBody(requestBody.raw)
    }
  }

  return { bodyType: "unknown", bodyText: null }
}

const handleIhgRequest = (details: chrome.webRequest.WebRequestBodyDetails) => {
  if (details.method !== "POST") {
    return
  }

  if (details.initiator?.startsWith("chrome-extension://")) {
    return
  }

  const { bodyType, bodyText } = extractRequestBody(details)
  const bookingType = detectBookingType(bodyText)
  const searchSignature = extractSearchSignature(bodyText)
  if (searchSignature && searchSignature !== lastSearchSignature) {
    lastSearchSignature = searchSignature
    maxSearchRadius = 0
  }
  const searchRadius = extractSearchRadius(bodyText) ?? 0

  requestMap.set(details.requestId, {
    url: details.url,
    method: details.method,
    bodyType,
    bodyText,
    searchRadius,
    searchSignature
  })

  if (!chrome?.storage?.local) {
    return
  }

  const isLargestSearch = searchRadius >= maxSearchRadius
  if (isLargestSearch) {
    maxSearchRadius = searchRadius
    chrome.storage.local.set({
      [IHG_STORAGE_KEY]: {
        kind: "webRequest",
        url: details.url,
        method: details.method,
        bodyType,
        bodyText,
        bookingType,
        requestHeaders: requestMap.get(details.requestId)?.requestHeaders ?? [],
        timestamp: Date.now(),
        receivedAt: new Date().toISOString()
      }
    })
  }
}

const handleIhgRequestHeaders = (
  details: chrome.webRequest.WebRequestHeadersDetails
) => {
  const entry = requestMap.get(details.requestId)
  if (!entry) {
    return
  }

  entry.requestHeaders = details.requestHeaders ?? []
}

const handleIhgCompleted = async (
  details: chrome.webRequest.WebResponseCacheDetails
) => {
  const entry = requestMap.get(details.requestId)
  if (!entry) {
    return
  }

  if (!chrome?.storage?.local) {
    return
  }

  const existing = await chrome.storage.local.get(IHG_STORAGE_KEY)
  const existingPayload = existing[IHG_STORAGE_KEY] as IhgStoredPayload | undefined
  const searchRadius = entry.searchRadius ?? 0
  const isLargestSearch = searchRadius >= maxSearchRadius

  if (isLargestSearch) {
    maxSearchRadius = searchRadius
    chrome.storage.local.set({
      [IHG_STORAGE_KEY]: {
        kind: "webRequest",
        url: entry.url,
        method: entry.method,
        bodyType: entry.bodyType,
        bodyText: entry.bodyText,
        bookingType: detectBookingType(entry.bodyText),
        requestHeaders: entry.requestHeaders ?? [],
        statusCode: details.statusCode,
        responseHeaders: details.responseHeaders ?? [],
        responseBodyText: existingPayload?.responseBodyText ?? null,
        completedAt: new Date().toISOString()
      }
    })
  }

  if (
    isLargestSearch &&
    !replaySent.has(details.requestId) &&
    !existingPayload?.responseBodyText
  ) {
    replaySent.add(details.requestId)
    const replayPayload = {
      type: "ihg-replay",
      payload: {
        url: entry.url,
        method: entry.method,
        bodyType: entry.bodyType,
        bodyText: entry.bodyText,
        requestHeaders: entry.requestHeaders ?? []
      }
    }

    if (details.tabId >= 0) {
      chrome.tabs.sendMessage(details.tabId, replayPayload, () => {
        void chrome.runtime.lastError
      })
    } else {
      chrome.tabs.query({ url: "https://www.ihg.com/*" }, (tabs) => {
        const targetTab = tabs.find((tab) => tab.active) ?? tabs[0]
        if (targetTab?.id !== undefined) {
          chrome.tabs.sendMessage(targetTab.id, replayPayload, () => {
            void chrome.runtime.lastError
          })
        }
      })
    }
  }

  if (
    details.url ===
      "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=summary,summary.rateRanges" &&
    !backgroundSent.has(details.requestId) &&
    !details.initiator?.startsWith("chrome-extension://")
  ) {
    const bookingType = detectBookingType(entry.bodyText)
    if (bookingType !== "points") {
      backgroundSent.add(details.requestId)
      void runBackgroundRequest(
        details.requestId,
        entry.bodyText,
        entry.requestHeaders ?? []
      )
    }
  }

  requestMap.delete(details.requestId)
}

export const registerIhgWebRequestListeners = () => {
  chrome.webRequest.onBeforeRequest.addListener(
    handleIhgRequest,
    {
      urls: [IHG_TARGET_URL + "*"]
    },
    ["requestBody"]
  )

  chrome.webRequest.onBeforeSendHeaders.addListener(
    handleIhgRequestHeaders,
    {
      urls: [IHG_TARGET_URL + "*"]
    },
    ["requestHeaders"]
  )

  chrome.webRequest.onCompleted.addListener(
    handleIhgCompleted,
    {
      urls: [IHG_TARGET_URL + "*"]
    },
    ["responseHeaders"]
  )
}

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: IhgMessagePayload }) => {
  if (message?.type !== "ihg-capture") {
    return
  }

  if (!chrome?.storage?.local) {
    return
  }

  const payload = message.payload ?? {}
  const bookingType = detectBookingType(payload.bodyText ?? null)
  chrome.storage.local.get(IHG_STORAGE_KEY).then((existing) => {
    const existingPayload = existing[IHG_STORAGE_KEY] as IhgMessagePayload | undefined
    chrome.storage.local.set({
      [IHG_STORAGE_KEY]: {
        ...existingPayload,
        ...payload,
        bookingType,
        receivedAt: new Date().toISOString()
      }
    })
  })
})

const buildPointsBodyFromText = (bodyText?: string | null) => {
  if (!bodyText) {
    return MIN_BODY
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const startDate =
      typeof parsed.startDate === "string" ? parsed.startDate : MIN_BODY.startDate
    const endDate =
      typeof parsed.endDate === "string" ? parsed.endDate : MIN_BODY.endDate
    const geoLocation =
      Array.isArray(parsed.geoLocation) && parsed.geoLocation.length > 0
        ? parsed.geoLocation
        : MIN_BODY.geoLocation

    const product =
      Array.isArray(parsed.products) && parsed.products.length > 0
        ? (parsed.products[0] as Record<string, unknown>)
        : null
    const productCode =
      product && typeof product.productCode === "string"
        ? product.productCode
        : "SR"
    const quantity =
      product && typeof product.quantity === "number" ? product.quantity : 1
    const guestCounts =
      product && Array.isArray(product.guestCounts) ? product.guestCounts : undefined

    return {
      radius:
        typeof parsed.radius === "number" ? parsed.radius : MIN_BODY.radius,
      maxRadius:
        typeof parsed.maxRadius === "number" ? parsed.maxRadius : undefined,
      minHotels:
        typeof parsed.minHotels === "number" ? parsed.minHotels : undefined,
      incrementRadiusBy:
        typeof parsed.incrementRadiusBy === "number"
          ? parsed.incrementRadiusBy
          : undefined,
      distanceUnit:
        typeof parsed.distanceUnit === "string"
          ? parsed.distanceUnit
          : "MI",
      distanceType:
        typeof parsed.distanceType === "string"
          ? parsed.distanceType
          : MIN_BODY.distanceType,
      startDate,
      endDate,
      geoLocation,
      products: [
        {
          productCode,
          startDate,
          endDate,
          quantity,
          ...(guestCounts ? { guestCounts } : {})
        }
      ],
      rates: MIN_BODY.rates
    }
  } catch {
    return MIN_BODY
  }
}

const toHeaderRecord = (headers?: chrome.webRequest.HttpHeader[]) => {
  if (!headers) {
    return {}
  }

  const record: Record<string, string> = {}
  for (const header of headers) {
    if (!header.name || header.value === undefined) {
      continue
    }

    const normalized = header.name.toLowerCase()
    if (
      normalized === "content-length" ||
      normalized === "host" ||
      normalized === "origin" ||
      normalized === "referer" ||
      normalized === "accept-encoding"
    ) {
      continue
    }

    record[header.name] = header.value
  }

  return record
}

const runBackgroundRequest = async (
  requestId: string,
  bodyText?: string | null,
  requestHeaders?: chrome.webRequest.HttpHeader[]
) => {
  const existing = await chrome.storage.local.get(IHG_STORAGE_KEY)
  const existingPayload = existing[IHG_STORAGE_KEY] as IhgMessagePayload | undefined
  if (
    existingPayload?.url !==
    "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=summary,summary.rateRanges"
  ) {
    return
  }

  try {
    const pointsBody = buildPointsBodyFromText(bodyText ?? existingPayload?.bodyText)
    const derivedHeaders = toHeaderRecord(requestHeaders ?? existingPayload?.requestHeaders)
    const requestHeaders = {
      ...MIN_HEADERS,
      ...derivedHeaders,
      "content-type": "application/json; charset=UTF-8"
    }
    const response = await fetch(
      "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=summary,summary.rateRanges",
      {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(pointsBody),
        credentials: "include"
      }
    )
    const responseBodyText = await response.text()
    const sentRequest: IhgSentRequest = {
      request: {
        url: "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=summary,summary.rateRanges",
        method: "POST",
        headers: requestHeaders,
        body: pointsBody
      },
      bookingType: detectBookingType(JSON.stringify(pointsBody)),
      response: {
        status: response.status,
        statusText: response.statusText,
        bodyText: responseBodyText,
        bodyParsed: responseBodyText
      },
      error: null,
      sentAt: new Date().toISOString()
    }

    chrome.storage.local.set({
      [IHG_SENT_STORAGE_KEY]: sentRequest
    })
  } catch (error) {
    const pointsBody = buildPointsBodyFromText(bodyText ?? existingPayload?.bodyText)
    const derivedHeaders = toHeaderRecord(requestHeaders ?? existingPayload?.requestHeaders)
    const requestHeaders = {
      ...MIN_HEADERS,
      ...derivedHeaders,
      "content-type": "application/json; charset=UTF-8"
    }
    const sentRequest: IhgSentRequest = {
      request: {
        url: "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=summary,summary.rateRanges",
        method: "POST",
        headers: requestHeaders,
        body: pointsBody
      },
      bookingType: detectBookingType(JSON.stringify(pointsBody)),
      response: null,
      error: error instanceof Error ? error.message : "Request failed",
      sentAt: new Date().toISOString()
    }

    chrome.storage.local.set({
      [IHG_SENT_STORAGE_KEY]: sentRequest
    })
  }

  backgroundSent.delete(requestId)
}
