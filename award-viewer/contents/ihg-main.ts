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
    try {
      const url = typeof input === "string" ? input : input?.url
      if (url && matchesTarget(url)) {
        const method =
          init?.method ||
          (typeof input === "string" ? "GET" : input?.method || "GET")
        const { bodyType, bodyText } = normalizeBody(init?.body)
        postCapture({
          kind: "fetch",
          url,
          method,
          bodyType,
          bodyText,
          timestamp: Date.now()
        })
      }
    } catch {
      // no-op
    }
    return originalFetch(input, init)
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
      }
      const url = tracked.__ihgUrl
      if (url && matchesTarget(url)) {
        const { bodyType, bodyText } = normalizeBody(body ?? null)
        postCapture({
          kind: "xhr",
          url,
          method: tracked.__ihgMethod ?? "GET",
          bodyType,
          bodyText,
          timestamp: Date.now()
        })
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
