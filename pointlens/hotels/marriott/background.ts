type Pending = {
  url: string
  method: string
  tabId: number
  bodyText?: string
  bodyJson?: unknown
  headers?: Record<string, string>
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

function normalizeHeaders(
  hs?: chrome.webRequest.HttpHeader[]
): { headers: Record<string, string> } {
  const out: Record<string, string> = {}

  for (const h of hs ?? []) {
    if (!h?.name) continue
    const name = h.name
    const value = (h.value ?? "").toString()
    out[name] = value
  }

  return { headers: out }
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
      operationName: p.operationName,
      headers: p.headers
    }
  })
}

function tryEmit(requestId: string) {
  const p = pending.get(requestId)
  if (!p) return

  if (p.operationName !== WANT_OP) return
  if (!p.headers) return
  if (!p.bodyJson && !p.bodyText) return

  requestPageReplay(p)
  pending.delete(requestId)
}

const FX_TTL_MS = 24 * 60 * 60 * 1000
const FX_KEY = (cur: string) => `pointlens:fx-usd:${cur}`

// Fetch "USD per 1 unit of <currency>" from a free, no-key FX API. Runs in the
// background (extension origin) so it isn't subject to page CORS. Cached in
// storage for a day. Returns null on failure (caller falls back to raw cash).
async function fetchUsdRate(currency: string): Promise<number | null> {
  const cur = currency.toUpperCase()
  if (cur === "USD") return 1

  const key = FX_KEY(cur)
  try {
    const cached = (await chrome.storage.local.get(key))?.[key] as
      | { rate?: number; ts?: number }
      | undefined
    if (
      cached &&
      typeof cached.rate === "number" &&
      typeof cached.ts === "number" &&
      Date.now() - cached.ts < FX_TTL_MS
    ) {
      return cached.rate
    }
  } catch {
    /* fall through to network */
  }

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${cur}`)
    if (!res.ok) return null
    const json = (await res.json()) as { rates?: Record<string, number> }
    const rate = json?.rates?.USD
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      await chrome.storage.local.set({ [key]: { rate, ts: Date.now() } })
      return rate
    }
  } catch {
    /* network/parse error */
  }
  return null
}

export const registerMarriottListeners = () => {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "MARRIOTT_SAVE_CAPTURE") return

    chrome.storage.local.set({
      "pointlens:marriott-last-capture": msg.payload
    })
  })

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "MARRIOTT_FETCH_FX" || typeof msg.currency !== "string") {
      return
    }
    fetchUsdRate(msg.currency)
      .then((rate) => sendResponse({ rate }))
      .catch(() => sendResponse({ rate: null }))
    return true // keep the message channel open for the async response
  })

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

      const { headers } = normalizeHeaders(details.requestHeaders)
      request.headers = headers

      tryEmit(details.requestId)
    },
    { urls: [`${TARGET}*`] },
    ["requestHeaders", "extraHeaders"]
  )
}
