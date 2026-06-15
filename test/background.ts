// test/background.ts

type Pending = {
    url: string
    method: string
    tabId: number
    bodyText?: string
    bodyJson?: any
    headers?: Record<string, string>
    cookieHeader?: string
    operationName?: string
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
// Grouped save state (per tab)
// ----------------------------

type CaptureGroup = {
    tabId: number
    startedAtMs: number
    lastAtMs: number
    status: number
    items: any[]
    flushTimer?: number
}

const GROUP_WINDOW_MS = 1000
const groupsByTab = new Map<number, CaptureGroup>()

function flushGroup(tabId: number, reason: string) {
    const g = groupsByTab.get(tabId)
    if (!g) return

    if (g.flushTimer) {
        clearTimeout(g.flushTimer)
        g.flushTimer = undefined
    }

    const payload = {
        status: g.status,
        shopMultiPropAvail: g.items,
        count: g.items.length,
        startedAt: new Date(g.startedAtMs).toISOString(),
        lastAt: new Date(g.lastAtMs).toISOString(),
        savedAt: new Date().toISOString(),
        tabId,
        reason
    }

    chrome.storage.local.set({
        "hilton-last-capture": payload
    })

    console.log("[Hilton] Saved grouped capture:", payload)

    groupsByTab.delete(tabId)
}

function scheduleFlush(tabId: number) {
    const g = groupsByTab.get(tabId)
    if (!g) return

    if (g.flushTimer) clearTimeout(g.flushTimer)

    // wait slightly longer than window so we don't flush mid-burst
    g.flushTimer = setTimeout(() => {
        flushGroup(tabId, "idle-timeout")
    }, GROUP_WINDOW_MS + 100) as unknown as number
}

chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== "HILTON_SAVE_CAPTURE") return

    const tabId = sender.tab?.id
    if (typeof tabId !== "number" || tabId < 0) return

    const status = msg?.payload?.status
    const arr = msg?.payload?.shopMultiPropAvail

    // Only care about status 200 + array
    if (status !== 200) return
    if (!Array.isArray(arr)) return

    const now = Date.now()
    const existing = groupsByTab.get(tabId)

    // If within 1s -> same group, append
    if (existing && now - existing.lastAtMs <= GROUP_WINDOW_MS) {
        existing.items.push(...arr)
        existing.lastAtMs = now
        scheduleFlush(tabId)
        return
    }

    // Otherwise flush old group (if any) and start a new one
    if (existing) {
        flushGroup(tabId, "new-burst")
    }

    const g: CaptureGroup = {
        tabId,
        status,
        items: [...arr],
        startedAtMs: now,
        lastAtMs: now
    }

    groupsByTab.set(tabId, g)
    scheduleFlush(tabId)
})

// ----------------------------
// Request capture plumbing (unchanged)
// ----------------------------

const pending = new Map<string, Pending>()

function cleanupOld(maxAgeMs = 30_000) {
    const now = Date.now()
    for (const [k, v] of pending.entries()) {
        if (now - v.ts > maxAgeMs) pending.delete(k)
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

    const bodyText =
        p.bodyText ?? (p.bodyJson ? JSON.stringify(p.bodyJson) : "")

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

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        cleanupOld()

        if (details.method !== "POST") return
        if (!details.url.startsWith(TARGET)) return
        if (details.tabId < 0) return

        const p: Pending = {
            url: details.url,
            method: details.method,
            tabId: details.tabId,
            ts: Date.now()
        }

        const raw = details.requestBody?.raw?.[0]?.bytes
        const txt = bytesToText(raw)
        p.bodyText = txt

        if (txt) {
            try {
                const j = JSON.parse(txt)
                p.bodyJson = j
                p.operationName = j?.operationName ?? null
            } catch {}
        }

        pending.set(details.requestId, p)

        if (p.operationName !== WANT_OP) {
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

        const p = pending.get(details.requestId)
        if (!p) return

        const { headers, cookie } = normalizeHeaders(details.requestHeaders)
        p.headers = headers
        p.cookieHeader = cookie

        if (p.operationName !== WANT_OP) {
            pending.delete(details.requestId)
            return
        }

        tryEmit(details.requestId)
    },
    { urls: [`${TARGET}*`] },
    ["requestHeaders", "extraHeaders"]
)
