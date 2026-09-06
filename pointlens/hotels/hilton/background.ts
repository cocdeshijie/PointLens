import { fetchUsdRate } from "../../shared/fx"

// One shared budget across Hilton tabs. Session storage survives worker restarts.
const KEY = "pointlens:hilton:budget"
let serial = Promise.resolve()
export function registerHiltonListeners() {
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!sender.url?.startsWith("https://www.hilton.com/")) return
    if (msg?.type === "HILTON_FX") {
      void fetchUsdRate(String(msg.currency)).then(reply)
      return true
    }
    if (
      !["HILTON_REQUEST_BUDGET", "HILTON_REQUEST_FINISHED"].includes(msg?.type)
    )
      return
    serial = serial
      .then(async () => {
        const now = Date.now()
        const stored = (await chrome.storage.session.get(KEY))[KEY] || {}
        const times: number[] = (stored.times || []).filter(
          (t: number) => now - t < 60_000
        )
        let until = Number(stored.until) || 0
        let lease = Number(stored.lease) || 0
        let owner = stored.owner
        let allowed = false
        if (msg.type === "HILTON_REQUEST_FINISHED") {
          if (owner === sender.tab?.id) {
            lease = 0
            owner = undefined
          }
          if ([403, 429, 503].includes(msg.status)) {
            until = Math.max(
              until,
              now +
                Math.max(
                  900_000,
                  Math.min(Number(msg.retryMs) || 0, 86_400_000)
                )
            )
          }
        } else if (
          now >= until &&
          now >= lease &&
          times.length < 4 &&
          now - (times.at(-1) || 0) >= 2000
        ) {
          times.push(now)
          lease = now + 15_000
          owner = sender.tab?.id
          allowed = true
        }
        await chrome.storage.session.set({
          [KEY]: { times, until, lease, owner }
        })
        // Wait only for an occupied slot/minimum spacing. Exhausted minute
        // budgets and server cooldowns stop the attempt entirely.
        const waitMs =
          !allowed && now >= until && times.length < 4
            ? Math.max(
                100,
                lease > now ? 1000 : 2000 - (now - (times.at(-1) || 0))
              )
            : 0
        reply({ allowed, waitMs })
      })
      .catch(() => reply({ allowed: false }))
    return true
  })
}
