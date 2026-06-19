const IHG_STORAGE_KEY = "pointlens:ihg-last-request"
const IHG_SENT_STORAGE_KEY = "pointlens:ihg-sent-request"
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
    // IHG's live search requests only the consolidated reward plan `IVANI`,
    // which returns the full points / points+cash response on its own. The
    // older IVAN1/3/5/6/7 codes are redundant (confirmed 2026-06 capture).
    ratePlanCodes: [{ internal: "IVANI" }]
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

    const rates = parsed.rates as { ratePlanCodes?: unknown } | undefined
    return {
      ...parsed,
      rates: {
        ...rates,
        ratePlanCodes: MIN_BODY.rates.ratePlanCodes
      }
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
  rawRequestHeaders?: chrome.webRequest.HttpHeader[]
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
    const derivedHeaders = toHeaderRecord(
      rawRequestHeaders ?? existingPayload?.requestHeaders
    )
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
    const derivedHeaders = toHeaderRecord(
      rawRequestHeaders ?? existingPayload?.requestHeaders
    )
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

// ---- Reward-night detail (4th-night-free) -------------------------------
//
// The search-results `summary` endpoint returns per-night rate ranges, so the
// IHG One Rewards "every 4th reward night free" benefit (points-only, applied
// when a cardmember is logged in) never appears there — it's a full-STAY total
// that lives in the per-hotel `rateDetails` response under
// `hotels[].rateDetails.offers[IVANI].rewardNights.pointsOnly`. We fetch that
// lazily, per hotel, reusing the live request headers (incl. X-IHG-SSO-TOKEN)
// captured from the page so the member benefit is applied.

const IHG_RATEDETAILS_URL =
  "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=rateDetails,rateDetails.policies,rateDetails.bonusRates,rateDetails.upsells,alternatePayments"

type IhgStayDetails = {
  status: "ok" | "none" | "error"
  nights?: number
  totalPoints?: number
  originalTotalPoints?: number
  savedPoints?: number
  freeNightCount?: number
  benefitReason?: string | null
  error?: string
}

// hotelMnemonic + search signature -> result (avoid refetching the heavy call)
const rateDetailsCache = new Map<string, IhgStayDetails>()

const buildRateDetailsBody = (baseBodyText: string | null, hotelMnemonic: string) => {
  let base: Record<string, unknown> = {}
  try {
    base = baseBodyText ? (JSON.parse(baseBodyText) as Record<string, unknown>) : {}
  } catch {
    base = {}
  }
  return {
    ...base,
    hotelMnemonics: [hotelMnemonic],
    geoLocation: null,
    rates: { ratePlanCodes: [{ internal: "IVANI" }] }
  }
}

const parseRewardNights = (responseBodyText: string): IhgStayDetails => {
  const parsed = JSON.parse(responseBodyText) as Record<string, unknown>
  const hotels = (parsed.hotels as Array<Record<string, unknown>> | undefined) ?? []
  const offers =
    ((hotels[0]?.rateDetails as Record<string, unknown> | undefined)?.offers as
      | Array<Record<string, unknown>>
      | undefined) ?? []
  const offer =
    offers.find((o) => o.ratePlanCode === "IVANI" && o.rewardNights) ??
    offers.find((o) => o.rewardNights)
  const reward = offer?.rewardNights as Record<string, unknown> | undefined
  const pointsOnly = reward?.pointsOnly as Record<string, unknown> | undefined
  if (!pointsOnly) {
    return { status: "none" }
  }
  const daily = (pointsOnly.daily as Array<Record<string, unknown>> | undefined) ?? []
  const freeNightCount = daily.filter((d) => Number(d.points) === 0).length
  const totalPoints = Number(pointsOnly.totalPoints)
  const originalTotalPoints = Number(pointsOnly.originalTotalPoints)
  return {
    status: "ok",
    nights: daily.length,
    totalPoints: Number.isFinite(totalPoints) ? totalPoints : undefined,
    originalTotalPoints: Number.isFinite(originalTotalPoints) ? originalTotalPoints : undefined,
    savedPoints:
      Number.isFinite(originalTotalPoints) && Number.isFinite(totalPoints)
        ? originalTotalPoints - totalPoints
        : undefined,
    freeNightCount,
    benefitReason:
      typeof reward?.displayBenefitReason === "string"
        ? (reward.displayBenefitReason as string)
        : null
  }
}

const runRateDetailsRequest = async (hotelMnemonic: string): Promise<IhgStayDetails> => {
  const stored = await chrome.storage.local.get(IHG_STORAGE_KEY)
  const last = stored[IHG_STORAGE_KEY] as
    | { bodyText?: string | null; requestHeaders?: chrome.webRequest.HttpHeader[]; bookingType?: string }
    | undefined
  const sig = extractSearchSignature(last?.bodyText ?? null)
  const cacheKey = `${hotelMnemonic}|${sig ?? ""}`
  const cached = rateDetailsCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const body = buildRateDetailsBody(last?.bodyText ?? null, hotelMnemonic)
  const headers = {
    ...MIN_HEADERS,
    ...toHeaderRecord(last?.requestHeaders),
    "content-type": "application/json; charset=UTF-8"
  }
  try {
    const response = await fetch(IHG_RATEDETAILS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "include"
    })
    const text = await response.text()
    const result = response.ok ? parseRewardNights(text) : { status: "error" as const, error: `HTTP ${response.status}` }
    rateDetailsCache.set(cacheKey, result)
    return result
  } catch (error) {
    const result: IhgStayDetails = {
      status: "error",
      error: error instanceof Error ? error.message : "rateDetails request failed"
    }
    return result
  }
}

chrome.runtime.onMessage.addListener(
  (message: { type?: string; hotelMnemonic?: string }, _sender, sendResponse) => {
    if (message?.type !== "ihg-rate-details" || !message.hotelMnemonic) {
      return undefined
    }
    runRateDetailsRequest(message.hotelMnemonic).then(sendResponse)
    return true // async sendResponse
  }
)
