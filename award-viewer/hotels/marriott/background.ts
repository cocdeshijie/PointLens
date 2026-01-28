type Pending = {
  url: string
  method: string
  tabId: number
  bodyText?: string
  bodyJson?: unknown
  operationName?: string | null
  ts: number
}

const TARGET =
  "https://www.marriott.com/mi/query/phoenixShopDatedSearchByGeoQuery"
const WANT_OP = "phoenixShopDatedSearchByGeoQuery"
const REPLAY_MARKER_HEADER = "x-av-replay"

const pending = new Map<string, Pending>()

function cleanupOld(maxAgeMs = 30_000) {
  const now = Date.now()
  for (const [key, value] of pending.entries()) {
    if (now - value.ts > maxAgeMs) pending.delete(key)
  }
}

function bytesToText(
  bytes?: ArrayBuffer | Uint8Array | number[] | null
): string | undefined {
  if (!bytes) return

  try {
    if (bytes instanceof ArrayBuffer) {
      return new TextDecoder("utf-8").decode(new Uint8Array(bytes))
    }
    if (bytes instanceof Uint8Array) {
      return new TextDecoder("utf-8").decode(bytes)
    }
    if (Array.isArray(bytes)) {
      return new TextDecoder("utf-8").decode(new Uint8Array(bytes))
    }
    return
  } catch {
    return
  }
}

function hasReplayMarker(hs?: chrome.webRequest.HttpHeader[]): boolean {
  for (const h of hs ?? []) {
    if (!h?.name) continue
    if (h.name.toLowerCase() === REPLAY_MARKER_HEADER) return true
  }
  return false
}

function requestPageReplay(p: Pending) {
  if (p.tabId < 0) return
  const bodyText = p.bodyText ?? (p.bodyJson ? JSON.stringify(p.bodyJson) : "")

  chrome.tabs.sendMessage(p.tabId, {
    type: "MARRIOTT_PAGE_REPLAY",
    payload: {
      url: p.url,
      bodyText,
      operationName: p.operationName
    }
  })
}

function tryEmit(requestId: string) {
  const p = pending.get(requestId)
  if (!p) return

  if (p.operationName !== WANT_OP) return
  if (!p.bodyJson && !p.bodyText) return

  requestPageReplay(p)
  pending.delete(requestId)
}

export const registerMarriottListeners = () => {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      cleanupOld()

      if (details.method !== "POST") return
      if (!details.url.startsWith(TARGET)) return
      if (details.tabId < 0) return

      const pendingRequest: Pending = {
        url: details.url,
        method: details.method,
        tabId: details.tabId,
        ts: Date.now()
      }

      const raw = details.requestBody?.raw?.[0]?.bytes
      const txt = bytesToText(raw)
      pendingRequest.bodyText = txt

      if (txt) {
        try {
          const parsed = JSON.parse(txt)
          pendingRequest.bodyJson = parsed
          pendingRequest.operationName = parsed?.operationName ?? null
        } catch {
          pendingRequest.operationName = null
        }
      }

      pending.set(details.requestId, pendingRequest)

      if (pendingRequest.operationName !== WANT_OP) {
        pending.delete(details.requestId)
        return
      }

      tryEmit(details.requestId)
    },
    { urls: [`${TARGET}*`] },
    ["requestBody"]
  )

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      cleanupOld()

      if (!details.url.startsWith(TARGET)) return
      if (details.tabId < 0) return

      if (hasReplayMarker(details.requestHeaders)) {
        pending.delete(details.requestId)
        return
      }

      const request = pending.get(details.requestId)
      if (!request) return

      if (request.operationName !== WANT_OP) {
        pending.delete(details.requestId)
        return
      }

      tryEmit(details.requestId)
    },
    { urls: [`${TARGET}*`] },
    ["requestHeaders", "extraHeaders"]
  )
}
