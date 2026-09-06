const TTL_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 60_000
const pending = new Map<string, Promise<number | null>>()
const failedUntil = new Map<string, number>()

// Shared by all brand listeners in the same service worker. Concurrent tabs
// requesting the same currency share both the storage lookup and network call.
export function fetchUsdRate(currency: string): Promise<number | null> {
  const cur = currency.trim().toUpperCase()
  if (cur === "USD") return Promise.resolve(1)
  if (!/^[A-Z]{3}$/.test(cur)) return Promise.resolve(null)
  const existing = pending.get(cur)
  if (existing) return existing
  if ((failedUntil.get(cur) ?? 0) > Date.now()) return Promise.resolve(null)
  const request = (async () => {
    const key = `pointlens:fx-usd:${cur}`
    try {
      const cached = (await chrome.storage.local.get(key))[key]
      if (
        Number.isFinite(cached?.rate) &&
        cached.rate > 0 &&
        Number.isFinite(cached?.ts) &&
        Date.now() - cached.ts >= 0 &&
        Date.now() - cached.ts < TTL_MS
      )
        return cached.rate as number
    } catch {
      /* Storage failure must not prevent a conversion. */
    }
    try {
      const response = await fetch(`https://open.er-api.com/v6/latest/${cur}`, {
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error("FX unavailable")
      const data = await response.json()
      const rate = data?.rates?.USD
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
        throw new Error("Invalid FX rate")
      }
      try {
        await chrome.storage.local.set({ [key]: { rate, ts: Date.now() } })
      } catch {
        /* A usable rate is still usable when storage is full. */
      }
      failedUntil.delete(cur)
      return rate
    } catch {
      failedUntil.set(cur, Date.now() + RETRY_MS)
      return null
    }
  })().finally(() => pending.delete(cur))
  pending.set(cur, request)
  return request
}
