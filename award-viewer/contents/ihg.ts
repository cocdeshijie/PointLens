import type { PlasmoCSConfig } from "plasmo"

const IHG_REQUEST_EVENT = "award-viewer:ihg-request"
const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
const IHG_TARGET_URL =
  "https://apis.ihg.com/availability/v3/hotels/offers"

export const config: PlasmoCSConfig = {
  matches: ["https://www.ihg.com/*"]
}

const injectRequestHook = () => {
  const script = document.createElement("script")
  script.textContent = `(() => {
    const targetUrl = ${JSON.stringify(IHG_TARGET_URL)}
    const eventName = ${JSON.stringify(IHG_REQUEST_EVENT)}

    const sendToExtension = (payload) => {
      window.dispatchEvent(
        new CustomEvent(eventName, {
          detail: payload
        })
      )
    }

    const normalizeBody = (body) => {
      if (!body) return null
      if (typeof body === "string") {
        try {
          return JSON.parse(body)
        } catch {
          return body
        }
      }
      return body
    }

    const originalFetch = window.fetch
    window.fetch = async (input, init = {}) => {
      try {
        const url = typeof input === "string" ? input : input?.url
        const method =
          init?.method ||
          (typeof input === "string" ? "GET" : input?.method || "GET")
        if (url && url.startsWith(targetUrl) && method.toUpperCase() === "POST") {
          sendToExtension({
            url,
            method,
            body: normalizeBody(init?.body),
            timestamp: Date.now()
          })
        }
      } catch {
        // no-op
      }
      return originalFetch(input, init)
    }

    const OriginalXHR = window.XMLHttpRequest
    function PatchedXHR() {
      const xhr = new OriginalXHR()
      let requestUrl = ""
      let requestMethod = "GET"

      const originalOpen = xhr.open
      xhr.open = function (method, url, ...rest) {
        requestMethod = method
        requestUrl = url
        return originalOpen.call(this, method, url, ...rest)
      }

      const originalSend = xhr.send
      xhr.send = function (body) {
        try {
          if (requestUrl && requestUrl.startsWith(targetUrl) && requestMethod.toUpperCase() === "POST") {
            sendToExtension({
              url: requestUrl,
              method: requestMethod,
              body: normalizeBody(body),
              timestamp: Date.now()
            })
          }
        } catch {
          // no-op
        }
        return originalSend.call(this, body)
      }

      return xhr
    }

    window.XMLHttpRequest = PatchedXHR
  })()`

  document.documentElement.appendChild(script)
  script.remove()
}

const handleRequestEvent = (event: Event) => {
  const detail = (event as CustomEvent).detail
  if (!detail) {
    return
  }

  const payload = {
    ...detail,
    receivedAt: new Date().toISOString()
  }

  chrome.storage.local.set({
    [IHG_STORAGE_KEY]: payload
  })
}

const init = () => {
  injectRequestHook()
  window.addEventListener(IHG_REQUEST_EVENT, handleRequestEvent)
}

init()
