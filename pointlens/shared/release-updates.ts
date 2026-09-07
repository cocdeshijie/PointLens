export const UPDATE_CACHE_KEY = "pointlens:release-update"
export const RELEASE_API = "https://api.github.com/repos/cocdeshijie/PointLens/releases/latest"
export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000

export type ReleaseUpdate = { version: string; url: string }
type Cache = { nextCheck: number; tag: string | null }

function versionParts(value: string): number[] | null {
  if (!/^v?\d{1,5}\.\d{1,5}\.\d{1,5}(?:\.\d{1,5})?$/.test(value)) return null
  return value.replace(/^v/, "").split(".").map(Number)
}

export function newerRelease(tag: unknown, installed: string): ReleaseUpdate | null {
  if (typeof tag !== "string") return null
  const latest = versionParts(tag)
  const current = versionParts(installed)
  if (!latest || !current) return null
  for (let i = 0; i < 4; i++) {
    const difference = (latest[i] ?? 0) - (current[i] ?? 0)
    if (difference < 0) return null
    if (difference > 0) return {
      version: tag.replace(/^v/, ""),
      url: `https://github.com/cocdeshijie/PointLens/releases/tag/${encodeURIComponent(tag)}`
    }
  }
  return null
}

export function createReleaseChecker(deps: {
  load: () => Promise<unknown>
  save: (cache: Cache) => Promise<void>
  fetch: typeof fetch
  now?: () => number
}) {
  let pending: Promise<string | null> | null = null
  const now = deps.now ?? Date.now

  async function lookup(): Promise<string | null> {
    let cache: Cache = { nextCheck: 0, tag: null }
    try {
      const stored = await deps.load() as Partial<Cache> | null
      if (stored && typeof stored.nextCheck === "number" && Number.isFinite(stored.nextCheck)) {
        cache = {
          nextCheck: stored.nextCheck,
          tag: typeof stored.tag === "string" && versionParts(stored.tag) ? stored.tag : null
        }
      }
      if (cache.nextCheck > now()) return cache.tag
      // Persist the attempt before fetching, including failures and popup closure.
      cache.nextCheck = now() + UPDATE_INTERVAL
      await deps.save(cache)
      const response = await deps.fetch(RELEASE_API, {
        credentials: "omit",
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8000)
      })
      if (response.status === 403 || response.status === 429) {
        const retry = response.headers.get("retry-after")
        const retryAt = retry && /^\d+$/.test(retry)
          ? now() + Number(retry) * 1000 : Date.parse(retry ?? "")
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000
        cache.nextCheck = Math.max(cache.nextCheck, retryAt || 0, reset || 0)
        await deps.save(cache)
      } else if (response.ok) {
        const release = await response.json()
        if (release?.draft === false && release?.prerelease === false &&
            typeof release.tag_name === "string" && versionParts(release.tag_name)) {
          cache.tag = release.tag_name
          await deps.save(cache)
        }
      }
      // Private repositories, offline requests, and API errors stay unobtrusive.
    } catch { /* Retain the last known release and the persisted cooldown. */ }
    return cache.tag
  }

  return async (installed: string): Promise<ReleaseUpdate | null> => {
    if (!pending) pending = lookup().finally(() => { pending = null })
    return newerRelease(await pending, installed)
  }
}
