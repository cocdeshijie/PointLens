const FX_TTL_MS = 24 * 60 * 60 * 1000
const FX_KEY = (cur: string) => `award-viewer:fx-usd:${cur}`

// Fetch "USD per 1 unit of <currency>" from a free, no-key FX API. Runs in the
// background (extension origin) so it isn't subject to page CORS. Cached in
// storage for a day. Returns null on failure (caller falls back to raw cash).
// Mirrors the Marriott implementation; the cache key is shared across sites.
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

export const registerHyattListeners = () => {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "HYATT_FETCH_FX" || typeof msg.currency !== "string") {
      return
    }
    fetchUsdRate(msg.currency)
      .then((rate) => sendResponse({ rate }))
      .catch(() => sendResponse({ rate: null }))
    return true // keep the message channel open for the async response
  })
}
