const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
const IHG_TARGET_URL = "https://apis.ihg.com/availability/v3/hotels/offers"

const decodeRawBody = (raw: chrome.webRequest.UploadedFile[]) => {
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

const handleIhgRequest = (
  details: chrome.webRequest.WebRequestBodyDetails
) => {
  if (details.method !== "POST") {
    return
  }

  const { bodyType, bodyText } = extractRequestBody(details)

  chrome.storage.local.set({
    [IHG_STORAGE_KEY]: {
      kind: "webRequest",
      url: details.url,
      method: details.method,
      bodyType,
      bodyText,
      timestamp: Date.now(),
      receivedAt: new Date().toISOString()
    }
  })
}

chrome.webRequest.onBeforeRequest.addListener(
  handleIhgRequest,
  {
    urls: [IHG_TARGET_URL + "*"]
  },
  ["requestBody"]
)
