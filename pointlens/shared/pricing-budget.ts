type BudgetDetails = { lease?: string; release?: string; retryAfter?: string }
type BudgetDecision = { allowed: boolean; retryAt?: number }

// A single serialized budget per brand across tabs and service-worker restarts.
export function registerPricingBudget(
  brand: "hyatt" | "marriott" | "wyndham" | "choice" | "bestwestern" | "sonesta"
) {
  let queue = Promise.resolve()
  const key = `pointlens:${brand}:pricing-budget`
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (
      msg?.type !== `POINTLENS_${brand}_BUDGET` ||
      !sender.url?.startsWith(
        `https://www.${brand === "wyndham" ? "wyndhamhotels" : brand === "choice" ? "choicehotels" : brand}.com/`
      )
    )
      return
    queue = queue
      .then(async () => {
        const storage = chrome.storage.session
        const prior = (await storage.get(key))[key] ?? {}
        const now = Date.now()
        const calls = (prior.calls ?? []).filter(
          (t: number) => now - t < 60_000
        )
        let until = prior.until ?? 0
        if ([403, 429, 503].includes(msg.status)) {
          const seconds = Number(msg.retryAfter)
          const retryAt =
            msg.retryAfter && Number.isFinite(seconds)
              ? now + Math.max(0, seconds) * 1000
              : Date.parse(msg.retryAfter ?? "")
          until = Math.max(
            until,
            now + 15 * 60_000,
            Number.isFinite(retryAt) ? retryAt : 0
          )
        }
        const released = msg.release && msg.release === prior.lease
        const activeUntil = released ? 0 : prior.activeUntil ?? 0
        const allowed =
          !msg.status &&
          !msg.release &&
          now >= activeUntil &&
          now >= until &&
          now - (prior.last ?? 0) >= 2500 &&
          calls.length < 4
        if (allowed) calls.push(now)
        await storage.set({
          [key]: {
            calls,
            until,
            last: allowed ? now : prior.last,
            lease: allowed ? msg.lease : released ? undefined : prior.lease,
            activeUntil: allowed ? now + 20000 : activeUntil
          }
        })
        reply({
          allowed,
          retryAt: allowed
            ? undefined
            : Math.max(
                now + 250,
                Math.min(activeUntil, now + 2500),
                until,
                (prior.last ?? 0) + 2500,
                calls.length >= 4 ? calls[0] + 60_000 : 0
              )
        })
      })
      .catch(() => reply({ allowed: false }))
    return true
  })
}

export function installBudgetBridge(
  brand: "hyatt" | "marriott" | "wyndham" | "choice" | "bestwestern" | "sonesta"
) {
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.kind !== `pointlens-${brand}-budget-request`
    )
      return
    const { id, status, lease, release, retryAfter } = event.data
    chrome.runtime.sendMessage(
      { type: `POINTLENS_${brand}_BUDGET`, status, lease, release, retryAfter },
      (result) => {
        void chrome.runtime.lastError
        window.postMessage(
          {
            kind: `pointlens-${brand}-budget-result`,
            id,
            allowed: result?.allowed === true,
            retryAt: result?.retryAt
          },
          location.origin
        )
      }
    )
  })
}

export function requestPricingBudgetDecision(
  brand: "hyatt" | "marriott" | "wyndham" | "choice" | "bestwestern" | "sonesta",
  status?: number,
  details: BudgetDetails = {}
): Promise<BudgetDecision> {
  const id = crypto.randomUUID()
  return new Promise((resolve) => {
    const done = (decision: BudgetDecision) => {
      clearTimeout(timer)
      window.removeEventListener("message", listener)
      resolve(decision)
    }
    const listener = (event: MessageEvent) => {
      if (
        event.source === window &&
        event.origin === location.origin &&
        event.data?.kind === `pointlens-${brand}-budget-result` &&
        event.data.id === id
      )
        done({
          allowed: event.data.allowed === true,
          retryAt: event.data.retryAt
        })
    }
    const timer = setTimeout(
      () => done({ allowed: false, retryAt: Date.now() + 2000 }),
      1500
    )
    window.addEventListener("message", listener)
    window.postMessage(
      { kind: `pointlens-${brand}-budget-request`, id, status, ...details },
      location.origin
    )
  })
}

export async function requestPricingBudget(
  brand: "hyatt" | "marriott" | "wyndham" | "choice" | "bestwestern" | "sonesta",
  status?: number,
  details: BudgetDetails = {}
): Promise<boolean> {
  return (await requestPricingBudgetDecision(brand, status, details)).allowed
}
