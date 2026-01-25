const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
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
  responseBodyText?: string | null
  responseStatus?: number
  responseStatusText?: string
  responseType?: string
  timestamp?: number
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
    chrome.storage.local.set({
      [IHG_STORAGE_KEY]: {
        ...existingPayload,
        ...payload,
        receivedAt: new Date().toISOString()
      }
    })
  })
})
