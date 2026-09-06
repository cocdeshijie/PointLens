import { fetchUsdRate } from "../../shared/fx"
import { createIhgRequestBudget } from "./request-budget"
import { extractSearchSignature } from "./search"

const cooldownKey = "pointlens:ihg-request-cooldown"
const ihgRequests = createIhgRequestBudget({
  fetch: (input, init) => fetch(input, init),
  loadCooldown: async () =>
    (await chrome.storage.session?.get(cooldownKey))?.[cooldownKey] ?? 0,
  saveCooldown: async (until) => {
    await chrome.storage.session?.set({ [cooldownKey]: until })
  }
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "IHG_FETCH_FX" || typeof message.currency !== "string")
    return
  fetchUsdRate(message.currency)
    .then((rate) => sendResponse({ rate }))
    .catch(() => sendResponse({ rate: null }))
  return true
})

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
const backgroundSent = new Set<string>()
let maxSearchRadius = 0
let lastSearchSignature: string | null = null
// Public application headers only. Member/session headers come exclusively
// from the current search request; never ship a captured member token.
const MIN_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "X-CDC-API-KEY": "4_jpzahMO4CBnl9Elopzfr0A",
  "x-ihg-api-key": "se9ym5iAzaW8pxfBjkmgbuGjJcr3Pj6Y"
}
const REWARD_RATE_PLANS = [{ internal: "IVANI" }]

type IhgStoredPayload = {
  bodyText?: string | null
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
        (product) =>
          product.guestCounts !== undefined || product.quantity !== undefined
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

const extractRequestBody = (
  details: chrome.webRequest.WebRequestBodyDetails
) => {
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
  ihgRequests.limited(
    details.statusCode,
    details.responseHeaders?.find((h) => h.name.toLowerCase() === "retry-after")
      ?.value
  )
  const entry = requestMap.get(details.requestId)
  if (!entry) {
    return
  }

  if (!chrome?.storage?.local) {
    return
  }

  const existing = await chrome.storage.local.get(IHG_STORAGE_KEY)
  const existingPayload = existing[IHG_STORAGE_KEY] as
    | IhgStoredPayload
    | undefined
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
        responseBodyText:
          existingPayload?.bodyText === entry.bodyText
            ? existingPayload?.responseBodyText ?? null
            : null,
        completedAt: new Date().toISOString()
      }
    })
  }

  // MAIN-world fetch/XHR hooks already capture the response. Replaying cash
  // here races their async body read and duplicates both cash and award calls.

  if (
    details.url ===
      "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=summary,summary.rateRanges" &&
    !backgroundSent.has(details.requestId) &&
    details.statusCode >= 200 &&
    details.statusCode < 300 &&
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

chrome.runtime.onMessage.addListener(
  (message: { type?: string; payload?: IhgMessagePayload }) => {
    if (message?.type !== "ihg-capture") {
      return
    }

    if (!chrome?.storage?.local) {
      return
    }

    const payload = message.payload ?? {}
    const bookingType = detectBookingType(payload.bodyText ?? null)
    chrome.storage.local.get(IHG_STORAGE_KEY).then((existing) => {
      const existingPayload = existing[IHG_STORAGE_KEY] as
        | IhgMessagePayload
        | undefined
      chrome.storage.local.set({
        [IHG_STORAGE_KEY]: {
          ...existingPayload,
          ...payload,
          bookingType,
          receivedAt: new Date().toISOString()
        }
      })
    })
  }
)

const buildPointsBodyFromText = (bodyText?: string | null) => {
  if (!bodyText) {
    return null
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>

    if (!parsed.startDate || !parsed.endDate || !Array.isArray(parsed.products))
      return null
    const rates = parsed.rates as { ratePlanCodes?: unknown } | undefined
    return {
      ...parsed,
      rates: {
        ...rates,
        ratePlanCodes: REWARD_RATE_PLANS
      }
    }
  } catch {
    return null
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
  const existingPayload = existing[IHG_STORAGE_KEY] as
    | IhgMessagePayload
    | undefined
  if (
    existingPayload?.url !==
    "https://apis.ihg.com/availability/v3/hotels/offers?fieldset=summary,summary.rateRanges"
  ) {
    return
  }

  const pointsBody = buildPointsBodyFromText(
    bodyText ?? existingPayload?.bodyText
  )
  if (!pointsBody) {
    backgroundSent.delete(requestId)
    return
  }
  try {
    const derivedHeaders = toHeaderRecord(
      rawRequestHeaders ?? existingPayload?.requestHeaders
    )
    const requestHeaders = {
      ...MIN_HEADERS,
      ...derivedHeaders,
      "content-type": "application/json; charset=UTF-8"
    }
    const response = await ihgRequests.request(
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
const rateDetailsCache = new Map<
  string,
  { result: IhgStayDetails; ts: number }
>()
const rateDetailsPending = new Map<string, Promise<IhgStayDetails>>()

const buildRateDetailsBody = (
  baseBodyText: string | null,
  hotelMnemonic: string
) => {
  let base: Record<string, unknown> = {}
  try {
    base = baseBodyText
      ? (JSON.parse(baseBodyText) as Record<string, unknown>)
      : {}
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
  const hotels =
    (parsed.hotels as Array<Record<string, unknown>> | undefined) ?? []
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
  const daily =
    (pointsOnly.daily as Array<Record<string, unknown>> | undefined) ?? []
  const freeNightCount = daily.filter((d) => Number(d.points) === 0).length
  const totalPoints = Number(pointsOnly.totalPoints)
  const originalTotalPoints = Number(pointsOnly.originalTotalPoints)
  return {
    status: "ok",
    nights: daily.length,
    totalPoints: Number.isFinite(totalPoints) ? totalPoints : undefined,
    originalTotalPoints: Number.isFinite(originalTotalPoints)
      ? originalTotalPoints
      : undefined,
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

const runRateDetailsRequest = async (
  hotelMnemonic: string
): Promise<IhgStayDetails> => {
  const stored = await chrome.storage.local.get(IHG_STORAGE_KEY)
  const last = stored[IHG_STORAGE_KEY] as
    | {
        bodyText?: string | null
        requestHeaders?: chrome.webRequest.HttpHeader[]
        bookingType?: string
      }
    | undefined
  if (!last?.bodyText || !buildPointsBodyFromText(last.bodyText)) {
    return { status: "error", error: "Run a hotel search first" }
  }
  const body = buildRateDetailsBody(last.bodyText, hotelMnemonic)
  // Include occupancy and current member headers, not just dates/location.
  const cacheKey = JSON.stringify([body, last.requestHeaders])
  const cached = rateDetailsCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < 60_000) return cached.result
  const pending = rateDetailsPending.get(cacheKey)
  if (pending) return pending
  const headers = {
    ...MIN_HEADERS,
    ...toHeaderRecord(last?.requestHeaders),
    "content-type": "application/json; charset=UTF-8"
  }
  const request = (async (): Promise<IhgStayDetails> => {
    try {
      const response = await ihgRequests.request(IHG_RATEDETAILS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        credentials: "include"
      })
      const text = await response.text()
      const result = response.ok
        ? parseRewardNights(text)
        : { status: "error" as const, error: `HTTP ${response.status}` }
      if (result.status !== "error") {
        if (rateDetailsCache.size >= 100)
          rateDetailsCache.delete(rateDetailsCache.keys().next().value)
        rateDetailsCache.set(cacheKey, { result, ts: Date.now() })
      }
      return result
    } catch (error) {
      const result: IhgStayDetails = {
        status: "error",
        error:
          error instanceof Error ? error.message : "rateDetails request failed"
      }
      return result
    }
  })().finally(() => rateDetailsPending.delete(cacheKey))
  rateDetailsPending.set(cacheKey, request)
  return request
}

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; hotelMnemonic?: string },
    _sender,
    sendResponse
  ) => {
    if (message?.type !== "ihg-rate-details" || !message.hotelMnemonic) {
      return undefined
    }
    runRateDetailsRequest(message.hotelMnemonic)
      .then(sendResponse)
      .catch(() =>
        sendResponse({ status: "error", error: "Rate details unavailable" })
      )
    return true // async sendResponse
  }
)
