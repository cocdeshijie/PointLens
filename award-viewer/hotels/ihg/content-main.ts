import type { PlasmoCSConfig } from "plasmo"

const TARGET_URL = "https://apis.ihg.com/availability/v3/hotels/offers"
const MESSAGE_FLAG = "__AWARD_VIEWER_IHG__"
const REPLAY_FLAG = "__AWARD_VIEWER_IHG_REPLAY__"

export const config: PlasmoCSConfig = {
  matches: ["https://www.ihg.com/*"],
  run_at: "document_start",
  world: "MAIN"
}

const matchesTarget = (url: string) => url === TARGET_URL || url.includes(TARGET_URL)

const normalizeBody = (body: unknown) => {
  if (!body) {
    return { bodyType: "null", bodyText: null }
  }

  if (typeof body === "string") {
    return { bodyType: "string", bodyText: body }
  }

  if (body instanceof URLSearchParams) {
    return { bodyType: "URLSearchParams", bodyText: body.toString() }
  }

  if (body instanceof FormData) {
    const obj: Record<string, unknown> = {}
    for (const [key, value] of body.entries()) {
      obj[key] =
        value instanceof File
          ? { name: value.name, size: value.size, type: value.type }
          : value
    }
    return { bodyType: "FormData", bodyText: JSON.stringify(obj) }
  }

  if (body && typeof body === "object" && "constructor" in body) {
    const constructorName = (body as { constructor?: { name?: string } })
      .constructor?.name
    return { bodyType: constructorName ?? "object", bodyText: null }
  }

  return { bodyType: typeof body, bodyText: null }
}

const decodeArrayBuffer = (buffer?: ArrayBuffer | null, encoding = "utf-8") => {
  if (!buffer) {
    return null
  }

  try {
    const decoder = new TextDecoder(encoding)
    return decoder.decode(buffer)
  } catch {
    return null
  }
}

const getEncodingFromContentType = (contentType?: string | null) => {
  if (!contentType) {
    return "utf-8"
  }
  const match = /charset=([^;]+)/i.exec(contentType)
  return match?.[1]?.trim().toLowerCase() ?? "utf-8"
}

const getResponseEncoding = (response: Response) =>
  getEncodingFromContentType(response.headers.get("content-type"))

const responsePayloadMap = new WeakMap<Response, Record<string, unknown>>()
const postedResponses = new WeakSet<Response>()
let responseHooksInstalled = false

const readResponseBody = async (response: Response) => {
  const encoding = getResponseEncoding(response)
  try {
    return await response.clone().text()
  } catch {
    // fall back to arrayBuffer decoding when text fails
  }

  try {
    const buffer = await response.clone().arrayBuffer()
    return decodeArrayBuffer(buffer, encoding)
  } catch {
    return null
  }
}

const postCapture = (payload: Record<string, unknown>) => {
  window.postMessage(
    {
      [MESSAGE_FLAG]: true,
      ...payload
    },
    "*"
  )
}

const toHeaderRecord = (headers: chrome.webRequest.HttpHeader[] | undefined) => {
  const record: Record<string, string> = {}
  for (const header of headers ?? []) {
    if (!header.name || header.value === undefined) {
      continue
    }
    record[header.name] = header.value
  }
  return record
}

const buildReplayBody = (bodyType?: string, bodyText?: string | null) => {
  if (!bodyText) {
    return null
  }

  if (bodyType === "formData") {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, string[]>
      const formData = new FormData()
      for (const [key, values] of Object.entries(parsed)) {
        for (const value of values) {
          formData.append(key, value)
        }
      }
      return formData
    } catch {
      return bodyText
    }
  }

  return bodyText
}

const postResponseOnce = (response: Response, responseBodyText: string | null) => {
  if (postedResponses.has(response)) {
    return
  }

  const payload = responsePayloadMap.get(response)
  if (!payload) {
    return
  }

  postedResponses.add(response)
  postCapture({
    ...payload,
    responseBodyText,
    responseStatus: response.status,
    responseStatusText: response.statusText,
    responseType: response.type
  })
}

const ensureResponseHooks = () => {
  if (responseHooksInstalled) {
    return
  }
  responseHooksInstalled = true

  const originalClone = Response.prototype.clone
  const originalText = Response.prototype.text
  const originalJson = Response.prototype.json
  const originalArrayBuffer = Response.prototype.arrayBuffer
  const originalBlob = Response.prototype.blob

  Response.prototype.clone = function (...args) {
    const cloned = originalClone.apply(this, args as [])
    const payload = responsePayloadMap.get(this)
    if (payload) {
      responsePayloadMap.set(cloned, payload)
    }
    return cloned
  }

  Response.prototype.text = async function (...args) {
    const result = await originalText.apply(this, args as [])
    postResponseOnce(this, typeof result === "string" ? result : null)
    return result
  }

  Response.prototype.json = async function (...args) {
    const result = await originalJson.apply(this, args as [])
    postResponseOnce(
      this,
      result === undefined ? null : JSON.stringify(result)
    )
    return result
  }

  Response.prototype.arrayBuffer = async function (...args) {
    const result = await originalArrayBuffer.apply(this, args as [])
    const text =
      result instanceof ArrayBuffer
        ? decodeArrayBuffer(result, getResponseEncoding(this))
        : null
    postResponseOnce(this, text)
    return result
  }

  Response.prototype.blob = async function (...args) {
    const result = await originalBlob.apply(this, args as [])
    const text =
      result instanceof Blob
        ? decodeArrayBuffer(
            await result.arrayBuffer(),
            getResponseEncoding(this)
          )
        : null
    postResponseOnce(this, text)
    return result
  }
}

const hookFetch = () => {
  const originalFetch = window.fetch

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let capturePayload: Record<string, unknown> | null = null
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : undefined
      if (url && matchesTarget(url)) {
        const method =
          init?.method ||
          (input instanceof Request ? input.method : "GET")
        const { bodyType, bodyText } = normalizeBody(init?.body)
        capturePayload = {
          kind: "fetch",
          url,
          method,
          bodyType,
          bodyText,
          timestamp: Date.now()
        }
      }
    } catch {
      // no-op
    }
    const response = await originalFetch(input, init)
    if (!capturePayload) {
      return response
    }

    ensureResponseHooks()
    responsePayloadMap.set(response, capturePayload)

    try {
      const responseBodyText = await readResponseBody(response)
      postResponseOnce(response, responseBodyText)
    } catch {
      postResponseOnce(response, null)
    }

    return response
  }
}

const hookXhr = () => {
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest) {
    ;(this as XMLHttpRequest & { __ihgMethod?: string }).__ihgMethod = method
    ;(this as XMLHttpRequest & { __ihgUrl?: string }).__ihgUrl = url
    return originalOpen.call(this, method, url, ...rest)
  }

  XMLHttpRequest.prototype.send = function (body?: Document | BodyInit | null) {
    try {
      const tracked = this as XMLHttpRequest & {
        __ihgUrl?: string
        __ihgMethod?: string
        __ihgCapture?: Record<string, unknown>
      }
      const url = tracked.__ihgUrl
      if (url && matchesTarget(url)) {
        const { bodyType, bodyText } = normalizeBody(body ?? null)
        tracked.__ihgCapture = {
          kind: "xhr",
          url,
          method: tracked.__ihgMethod ?? "GET",
          bodyType,
          bodyText,
          timestamp: Date.now()
        }
        this.addEventListener(
          "loadend",
          async () => {
            let responseBodyText: string | null = null
            try {
              if (this.responseType === "" || this.responseType === "text") {
                responseBodyText = this.responseText
              } else if (this.responseType === "json") {
                responseBodyText =
                  this.response && typeof this.response === "object"
                    ? JSON.stringify(this.response)
                    : null
              } else if (this.responseType === "document") {
                responseBodyText =
                  this.responseXML?.documentElement?.outerHTML ?? null
              } else if (this.responseType === "arraybuffer") {
                responseBodyText = decodeArrayBuffer(
                  this.response as ArrayBuffer | null,
                  getEncodingFromContentType(
                    this.getResponseHeader("content-type")
                  )
                )
              } else if (this.responseType === "blob") {
                const responseBlob = this.response as Blob | null
                responseBodyText = responseBlob
                  ? decodeArrayBuffer(
                      await responseBlob.arrayBuffer(),
                      getEncodingFromContentType(
                        this.getResponseHeader("content-type")
                      )
                    )
                  : null
              }
            } catch {
              responseBodyText = null
            }

            postCapture({
              ...(tracked.__ihgCapture ?? {}),
              responseBodyText,
              responseStatus: this.status,
              responseStatusText: this.statusText,
              responseType: this.responseType
            })
          },
          { once: true }
        )
      }
    } catch {
      // no-op
    }
    return originalSend.call(this, body as Document | BodyInit | null)
  }
}

const hookReplay = () => {
  window.addEventListener("message", async (event: MessageEvent) => {
    if (event.source !== window) {
      return
    }

    const data = event.data as Record<string, unknown> | undefined
    if (!data || data[REPLAY_FLAG] !== true) {
      return
    }

    const url = typeof data.url === "string" ? data.url : null
    if (!url) {
      return
    }

    const method = typeof data.method === "string" ? data.method : "POST"
    const bodyType = typeof data.bodyType === "string" ? data.bodyType : undefined
    const bodyText = typeof data.bodyText === "string" ? data.bodyText : null
    const requestHeaders = Array.isArray(data.requestHeaders)
      ? (data.requestHeaders as chrome.webRequest.HttpHeader[])
      : []

    const headers = toHeaderRecord(requestHeaders)
    if (!headers["content-type"] && bodyType !== "formData") {
      headers["content-type"] = "application/json; charset=UTF-8"
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: buildReplayBody(bodyType, bodyText),
        credentials: "include"
      })
      const responseBodyText = await readResponseBody(response)
      postCapture({
        kind: "replay",
        url,
        method,
        bodyType,
        bodyText,
        responseBodyText,
        responseStatus: response.status,
        responseStatusText: response.statusText,
        responseType: response.type,
        timestamp: Date.now()
      })
    } catch {
      postCapture({
        kind: "replay",
        url,
        method,
        bodyType,
        bodyText,
        responseBodyText: null,
        timestamp: Date.now()
      })
    }
  })
}

const init = () => {
  hookFetch()
  hookXhr()
  hookReplay()
}

init()
