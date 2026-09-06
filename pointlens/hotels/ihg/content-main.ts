import type { PlasmoCSConfig } from "plasmo"

const TARGET_URL = "https://apis.ihg.com/availability/v3/hotels/offers"
const MESSAGE_FLAG = "__AWARD_VIEWER_IHG__"
const REPLAY_FLAG = "__AWARD_VIEWER_IHG_REPLAY__"

export const config: PlasmoCSConfig = {
  matches: ["https://www.ihg.com/*"],
  run_at: "document_start",
  world: "MAIN"
}

const matchesTarget = (url: string) => {
  try {
    const parsed = new URL(url, location.href)
    return (
      parsed.origin === "https://apis.ihg.com" &&
      parsed.pathname === "/availability/v3/hotels/offers"
    )
  } catch {
    return false
  }
}

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

const readResponseBody = async (response: Response) => {
  try {
    return await response.clone().text()
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

const toHeaderRecord = (
  headers: chrome.webRequest.HttpHeader[] | undefined
) => {
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

const originalFetch = window.fetch.bind(window)

const hookFetch = () => {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let capturePayload: Record<string, unknown> | null = null
    let requestBody: Promise<string | null> | undefined
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
          init?.method || (input instanceof Request ? input.method : "GET")
        const { bodyType, bodyText } = normalizeBody(init?.body)
        if (init?.body === undefined && input instanceof Request) {
          requestBody = input
            .clone()
            .text()
            .catch(() => null)
        }
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

    // Observe a clone asynchronously; the site's fetch must resolve as soon as
    // headers arrive. Do not replace Response.prototype for unrelated traffic.
    void Promise.all([readResponseBody(response), requestBody]).then(
      ([responseBodyText, body]) => {
        postCapture({
          ...capturePayload,
          ...(requestBody ? { bodyType: "string", bodyText: body } : {}),
          responseBodyText,
          responseStatus: response.status,
          responseStatusText: response.statusText,
          responseType: response.type
        })
      }
    )

    return response
  }
}

const hookXhr = () => {
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string,
    ...rest
  ) {
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
    if (!url || !matchesTarget(url)) {
      return
    }

    const method = typeof data.method === "string" ? data.method : "POST"
    const bodyType =
      typeof data.bodyType === "string" ? data.bodyType : undefined
    const bodyText = typeof data.bodyText === "string" ? data.bodyText : null
    const requestHeaders = Array.isArray(data.requestHeaders)
      ? (data.requestHeaders as chrome.webRequest.HttpHeader[])
      : []

    const headers = toHeaderRecord(requestHeaders)
    if (!headers["content-type"] && bodyType !== "formData") {
      headers["content-type"] = "application/json; charset=UTF-8"
    }

    try {
      const response = await originalFetch(url, {
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
