import type { PlasmoCSConfig } from "plasmo"

const TARGET_URL = "https://apis.ihg.com/availability/v3/hotels/offers"
const MESSAGE_FLAG = "__AWARD_VIEWER_IHG__"

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

    let didPost = false
    const postOnce = (responseBodyText: string | null) => {
      if (didPost) {
        return
      }
      didPost = true
      postCapture({
        ...capturePayload,
        responseBodyText,
        responseStatus: response.status,
        responseStatusText: response.statusText,
        responseType: response.type
      })
    }

    const wrapResponseMethod = <T extends (...args: never[]) => Promise<unknown>>(
      methodName: "text" | "json" | "arrayBuffer" | "blob",
      formatter: (value: unknown) => Promise<string | null>
    ) => {
      const original = response[methodName].bind(response) as T
      response[methodName] = (async (...args: never[]) => {
        const result = await original(...args)
        try {
          const formatted = await formatter(result)
          postOnce(formatted)
        } catch {
          postOnce(null)
        }
        return result
      }) as T
    }

    wrapResponseMethod("text", async (value) =>
      typeof value === "string" ? value : null
    )
    wrapResponseMethod("json", async (value) =>
      value === undefined ? null : JSON.stringify(value)
    )
    wrapResponseMethod("arrayBuffer", async (value) =>
      value instanceof ArrayBuffer
        ? decodeArrayBuffer(value, getResponseEncoding(response))
        : null
    )
    wrapResponseMethod("blob", async (value) => {
      if (!(value instanceof Blob)) {
        return null
      }
      const buffer = await value.arrayBuffer()
      return decodeArrayBuffer(buffer, getResponseEncoding(response))
    })

    try {
      const responseBodyText = await readResponseBody(response)
      postOnce(responseBodyText)
    } catch {
      postOnce(null)
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

const init = () => {
  hookFetch()
  hookXhr()
}

init()
