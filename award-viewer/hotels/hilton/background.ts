type Pending = {
  url: string
  method: string
  tabId: number
  bodyText?: string
  bodyJson?: unknown
  headers?: Record<string, string>
  cookieHeader?: string
  operationName?: string | null
  ts: number
}

const TARGET = "https://www.hilton.com/graphql/customer"
const WANT_OP = "shopMultiPropAvail"

const ALLOW_ORIGINAL_OPNAMES = new Set([
  "shopMultiPropAvail",
  "shopMultiPropAvailPoints"
])

const REPLAY_MARKER_HEADER = "x-av-replay"

// ----------------------------
// Grouped save state (per tab + dates)
// ----------------------------

type CaptureGroup = {
  tabId: number
  arrivalDate?: string
  departureDate?: string
  startedAtMs: number
  lastAtMs: number
  status: number
  items: unknown[]
  itemsByCtyhocn: Map<string, unknown>
}

const groupsByTab = new Map<number, CaptureGroup>()

function flushGroup(tabId: number, reason: string) {
  const group = groupsByTab.get(tabId)
  if (!group) return

  const payload = {
    status: group.status,
    shopMultiPropAvail: [
      ...Array.from(group.itemsByCtyhocn.values()),
      ...group.items
    ],
    count: group.itemsByCtyhocn.size + group.items.length,
    startedAt: new Date(group.startedAtMs).toISOString(),
    lastAt: new Date(group.lastAtMs).toISOString(),
    savedAt: new Date().toISOString(),
    tabId,
    arrivalDate: group.arrivalDate,
    departureDate: group.departureDate,
    reason
  }

  chrome.storage.local.set({
    "hilton-last-capture": payload
  })

  console.log("[Hilton] Saved grouped capture:", payload)

  groupsByTab.delete(tabId)
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "HILTON_SAVE_CAPTURE") return

  const tabId = sender.tab?.id
  if (typeof tabId !== "number" || tabId < 0) return

  const status = msg?.payload?.status
  const arr = msg?.payload?.shopMultiPropAvail
  const arrivalDate = msg?.payload?.meta?.arrivalDate
  const departureDate = msg?.payload?.meta?.departureDate

  // Only care about status 200 + array
  if (status !== 200) return
  if (!Array.isArray(arr)) return

  const now = Date.now()
  const existing = groupsByTab.get(tabId)

  const matchesDates =
    existing?.arrivalDate === arrivalDate &&
    existing?.departureDate === departureDate

  // If dates match -> same group, append and save
  if (existing && matchesDates) {
    for (const item of arr) {
      const ctyhocn =
        typeof item === "object" && item !== null
          ? (item as { ctyhocn?: unknown }).ctyhocn
          : null
      if (typeof ctyhocn === "string" && ctyhocn.length > 0) {
        existing.itemsByCtyhocn.set(ctyhocn, item)
      } else {
        existing.items.push(item)
      }
    }
    existing.lastAtMs = now
    chrome.storage.local.set({
      "hilton-last-capture": {
        status: existing.status,
        shopMultiPropAvail: [
          ...Array.from(existing.itemsByCtyhocn.values()),
          ...existing.items
        ],
        count: existing.itemsByCtyhocn.size + existing.items.length,
        startedAt: new Date(existing.startedAtMs).toISOString(),
        lastAt: new Date(existing.lastAtMs).toISOString(),
        savedAt: new Date().toISOString(),
        tabId,
        arrivalDate: existing.arrivalDate,
        departureDate: existing.departureDate,
        reason: "date-match"
      }
    })
    return
  }

  // Otherwise flush old group (if any) and start a new one
  if (existing) {
    flushGroup(tabId, "date-change")
  }

  const group: CaptureGroup = {
    tabId,
    status,
    items: [],
    itemsByCtyhocn: new Map(),
    arrivalDate,
    departureDate,
    startedAtMs: now,
    lastAtMs: now
  }

  for (const item of arr) {
    const ctyhocn =
      typeof item === "object" && item !== null
        ? (item as { ctyhocn?: unknown }).ctyhocn
        : null
    if (typeof ctyhocn === "string" && ctyhocn.length > 0) {
      group.itemsByCtyhocn.set(ctyhocn, item)
    } else {
      group.items.push(item)
    }
  }

  groupsByTab.set(tabId, group)
  chrome.storage.local.set({
    "hilton-last-capture": {
      status: group.status,
      shopMultiPropAvail: [
        ...Array.from(group.itemsByCtyhocn.values()),
        ...group.items
      ],
      count: group.itemsByCtyhocn.size + group.items.length,
      startedAt: new Date(group.startedAtMs).toISOString(),
      lastAt: new Date(group.lastAtMs).toISOString(),
      savedAt: new Date().toISOString(),
      tabId,
      arrivalDate: group.arrivalDate,
      departureDate: group.departureDate,
      reason: "new-group"
    }
  })
})

// ----------------------------
// Request capture plumbing
// ----------------------------

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
): { headers: Record<string, string>; cookie?: string } {
  const out: Record<string, string> = {}
  let cookie: string | undefined

  for (const h of hs ?? []) {
    if (!h?.name) continue
    const name = h.name
    const value = (h.value ?? "").toString()
    out[name] = value
    if (name.toLowerCase() === "cookie") cookie = value
  }

  return { headers: out, cookie }
}

function hasReplayMarker(hs?: chrome.webRequest.HttpHeader[]): boolean {
  for (const h of hs ?? []) {
    if (!h?.name) continue
    if (h.name.toLowerCase() === REPLAY_MARKER_HEADER) return true
  }
  return false
}

function getOriginalOpNameFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("originalOpName")
  } catch {
    return null
  }
}

function requestPageReplay(p: Pending) {
  if (p.tabId < 0) return

  const orig = getOriginalOpNameFromUrl(p.url)
  if (!orig || !ALLOW_ORIGINAL_OPNAMES.has(orig)) return

  const bodyText = p.bodyText ?? (p.bodyJson ? JSON.stringify(p.bodyJson) : "")

  chrome.tabs.sendMessage(p.tabId, {
    type: "HILTON_PAGE_REPLAY",
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
  if (!p.headers) return
  if (!p.bodyJson && !p.bodyText) return

  requestPageReplay(p)
  pending.delete(requestId)
}

export const registerHiltonListeners = () => {
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

      const { headers, cookie } = normalizeHeaders(details.requestHeaders)
      request.headers = headers
      request.cookieHeader = cookie

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
