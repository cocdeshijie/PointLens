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
  }
>()
const replaySent = new Set<string>()

type IhgStoredPayload = {
  responseBodyText?: string | null
}

type IhgMessagePayload = {
  kind?: string
  url?: string
  method?: string
  bodyType?: string
  bodyText?: string | null
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

  const { bodyType, bodyText } = extractRequestBody(details)

  requestMap.set(details.requestId, {
    url: details.url,
    method: details.method,
    bodyType,
    bodyText
  })

  if (!chrome?.storage?.local) {
    return
  }

  chrome.storage.local.set({
    [IHG_STORAGE_KEY]: {
      kind: "webRequest",
      url: details.url,
      method: details.method,
      bodyType,
      bodyText,
      requestHeaders: requestMap.get(details.requestId)?.requestHeaders ?? [],
      timestamp: Date.now(),
      receivedAt: new Date().toISOString()
    }
  })
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

  chrome.storage.local.set({
    [IHG_STORAGE_KEY]: {
      kind: "webRequest",
      url: entry.url,
      method: entry.method,
      bodyType: entry.bodyType,
      bodyText: entry.bodyText,
      requestHeaders: entry.requestHeaders ?? [],
      statusCode: details.statusCode,
      responseHeaders: details.responseHeaders ?? [],
      responseBodyText: existingPayload?.responseBodyText ?? null,
      completedAt: new Date().toISOString()
    }
  })

  if (!replaySent.has(details.requestId) && !existingPayload?.responseBodyText) {
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
      chrome.tabs.sendMessage(details.tabId, replayPayload)
    } else {
      chrome.tabs.query({ url: "https://www.ihg.com/*" }, (tabs) => {
        const targetTab = tabs.find((tab) => tab.active) ?? tabs[0]
        if (targetTab?.id !== undefined) {
          chrome.tabs.sendMessage(targetTab.id, replayPayload)
        }
      })
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
  chrome.storage.local.get(IHG_STORAGE_KEY).then((existing) => {
    const existingPayload = existing[IHG_STORAGE_KEY] as IhgMessagePayload | undefined
    chrome.storage.local
      .set({
        [IHG_STORAGE_KEY]: {
          ...existingPayload,
          ...payload,
          receivedAt: new Date().toISOString()
        }
      })
      .then(() => {
        void runBackgroundRequest()
      })
  })
})

const toHeaderRecord = (headers: chrome.webRequest.HttpHeader[] | undefined) => {
  const record: Record<string, string> = {}
  for (const header of headers ?? []) {
    if (!header.name || header.value === undefined) {
      continue
    }
    const normalized = header.name.toLowerCase()
    if (
      normalized === "content-length" ||
      normalized === "host" ||
      normalized === "origin" ||
      normalized === "referer" ||
      normalized === "accept-encoding" ||
      normalized === "user-agent" ||
      normalized.startsWith("sec-ch-ua")
    ) {
      continue
    }
    record[header.name] = header.value
  }
  return record
}

const buildMinimalBody = (bodyText?: string | null) => {
  if (!bodyText) {
    return null
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const startDate =
      typeof parsed.startDate === "string" ? parsed.startDate : ""
    const endDate = typeof parsed.endDate === "string" ? parsed.endDate : ""
    const geoLocation = Array.isArray(parsed.geoLocation)
      ? parsed.geoLocation.map((entry) => ({
          latitude:
            typeof entry?.latitude === "number" ? entry.latitude : 0,
          longitude:
            typeof entry?.longitude === "number" ? entry.longitude : 0
        }))
      : []
    const productCode =
      Array.isArray(parsed.products) && parsed.products[0]?.productCode
        ? String(parsed.products[0].productCode)
        : "SR"

    const ratePlanCodes = Array.isArray(
      (parsed.rates as { ratePlanCodes?: unknown[] } | undefined)?.ratePlanCodes
    )
      ? (parsed.rates as { ratePlanCodes?: unknown[] }).ratePlanCodes
      : [
          { internal: "IVAN1" },
          { internal: "IVAN3" },
          { internal: "IVAN5" },
          { internal: "IVAN6" },
          { internal: "IVAN7" },
          { internal: "IVANI" }
        ]

    return {
      radius: 30,
      distanceType: "STRAIGHT_LINE",
      startDate,
      endDate,
      geoLocation:
        geoLocation.length > 0 ? geoLocation : [{ latitude: 0, longitude: 0 }],
      products: [
        {
          productCode,
          startDate,
          endDate
        }
      ],
      rates: {
        ratePlanCodes
      }
    }
  } catch {
    return null
  }
}

const runBackgroundRequest = async () => {
  const existing = await chrome.storage.local.get(IHG_STORAGE_KEY)
  const existingPayload = existing[IHG_STORAGE_KEY] as IhgMessagePayload | undefined

  if (!existingPayload?.url) {
    return
  }

  const headers = toHeaderRecord(existingPayload.requestHeaders as chrome.webRequest.HttpHeader[])
  headers["content-type"] = "application/json; charset=UTF-8"

  const body = buildMinimalBody(existingPayload.bodyText)
  if (!body) {
    return
  }

  try {
    const response = await fetch(existingPayload.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "include"
    })
    const responseBodyText = await response.text()
    const sentRequest: IhgSentRequest = {
      request: {
        url: existingPayload.url,
        method: "POST",
        headers,
        body
      },
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
    const sentRequest: IhgSentRequest = {
      request: {
        url: existingPayload.url,
        method: "POST",
        headers,
        body
      },
      response: null,
      error: error instanceof Error ? error.message : "Request failed",
      sentAt: new Date().toISOString()
    }

    chrome.storage.local.set({
      [IHG_SENT_STORAGE_KEY]: sentRequest
    })
  }
}
