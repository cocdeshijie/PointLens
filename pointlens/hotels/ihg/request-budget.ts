// A shared budget for extension-initiated IHG calls across all tabs.
// Native browsing is untouched. No automatic retries or queued requests.
export function createIhgRequestBudget(options: {
  fetch: typeof fetch
  now?: () => number
  saveCooldown?: (until: number) => Promise<void>
  loadCooldown?: () => Promise<number>
}) {
  const now = options.now ?? Date.now
  let cooldown = 0
  const ready =
    options
      .loadCooldown?.()
      .then((until) => {
        cooldown = Math.max(cooldown, until || 0)
      })
      .catch(() => {}) ?? Promise.resolve()
  const calls: number[] = []
  const cache = new Map<string, { at: number; response: Response }>()
  const pending = new Map<string, Promise<Response>>()
  function limited(status: number, retryAfter?: string | null) {
    if (![429, 503].includes(status)) return
    const seconds = Number(retryAfter)
    const parsed = retryAfter
      ? Number.isFinite(seconds)
        ? now() + seconds * 1000
        : Date.parse(retryAfter)
      : 0
    const until = Math.max(
      now() + (status === 429 ? 15 * 60_000 : 60_000),
      Number.isFinite(parsed) ? parsed : 0
    )
    cooldown = Math.max(cooldown, until)
    void options.saveCooldown?.(cooldown).catch(() => {})
  }
  async function request(url: string, init: RequestInit): Promise<Response> {
    const key = JSON.stringify([url, init.body, init.headers])
    const cached = cache.get(key)
    if (cached && now() - cached.at < 5 * 60_000) return cached.response.clone()
    const existing = pending.get(key)
    if (existing) return (await existing).clone()
    const task = (async () => {
      await ready
      while (calls.length && calls[0] <= now() - 60_000) calls.shift()
      if (now() < cooldown)
        throw new Error(
          "IHG comparisons paused after a rate-limit response. Try later."
        )
      if (calls.length >= 6)
        throw new Error("IHG comparison request budget reached. Try later.")
      calls.push(now())
      try {
        const response = await options.fetch(url, {
          ...init,
          signal: AbortSignal.timeout(15_000)
        })
        limited(response.status, response.headers.get("retry-after"))
        if (response.ok) {
          // Consume before caching so failed streams cannot be reused.
          const body = await response.arrayBuffer()
          const copy = new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          })
          if (cache.size >= 20) cache.delete(cache.keys().next().value)
          cache.set(key, { at: now(), response: copy })
          return copy
        }
        cooldown = Math.max(cooldown, now() + 60_000)
        return response
      } catch (error) {
        cooldown = Math.max(cooldown, now() + 60_000)
        throw error
      }
    })().finally(() => pending.delete(key))
    pending.set(key, task)
    return (await task).clone()
  }
  return { request, limited }
}
