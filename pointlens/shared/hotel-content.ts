import type { HotelOffer, HotelSnapshot } from "./hotel-quotes"
import { compareRoom, renderRoomValue } from "./room-value"

export type ComparisonTarget = {
  host: HTMLElement
  hotel: string
  room?: string
  rate?: string
  points: boolean
  scope?: "search" | "rooms"
  nightly?: boolean
  compact?: boolean
}
type Settings = {
  goodValueThreshold: number
  badValueThreshold: number
  taxBasis: "pretax" | "aftertax"
}

// Shared presentation only. Each brand owns selectors, request parsing, popup,
// and availability rules; all tooltip behavior stays consistent with other sites.
export function installHotelContent(config: {
  brand: string
  storageKey: string
  defaults: Settings
  normalize: (value?: Partial<Settings>) => Settings
  current: (snapshot: HotelSnapshot) => boolean
  targets: (snapshots: HotelSnapshot[]) => ComparisonTarget[]
  // Native map libraries replace icon children during ordinary UI updates.
  // Restore these small surfaces in the mutation microtask, before paint.
  immediateSelector?: string
}) {
  const brand = config.brand,
    upper = brand.toUpperCase()
  let settings = config.defaults,
    snapshots: HotelSnapshot[] = [],
    started = Date.now()
  let scheduled: ReturnType<typeof setTimeout> | undefined
  const fx = new Map<string, number | undefined>([["USD", 1]])
  const schedule = () => {
    if (!scheduled)
      scheduled = setTimeout(() => {
        scheduled = undefined
        update()
      }, 100)
  }
  const toUsd = (value: number, currency: string) => {
    if (!fx.has(currency)) {
      fx.set(currency, undefined)
      chrome.runtime.sendMessage(
        { type: `${upper}_FETCH_FX`, currency },
        (result) => {
          void chrome.runtime.lastError
          if (Number.isFinite(result?.rate) && result.rate > 0)
            fx.set(currency, result.rate)
          schedule()
        }
      )
    }
    const rate = fx.get(currency)
    return rate === undefined ? undefined : value * rate
  }
  const cheapest = (offers: HotelOffer[], points: boolean) =>
    offers
      .filter((o) => !!o.points === points)
      .sort(
        (a, b) =>
          (a.points ??
            (settings.taxBasis === "pretax"
              ? a.base ?? a.total
              : a.total ?? a.base) ??
            Infinity) -
          (b.points ??
            (settings.taxBasis === "pretax"
              ? b.base ?? b.total
              : b.total ?? b.base) ??
            Infinity)
      )[0]
  const status = (
    host: HTMLElement,
    message?: string,
    loading = false,
    compact = false
  ) => {
    let node = host.querySelector<HTMLElement>(
      `:scope > .pointlens-${brand}-status`
    )
    if (!message) {
      node?.remove()
      return
    }
    const signature = `${loading}:${message}`
    if (node?.dataset.signature === signature) return
    if (!node) {
      node = document.createElement("div")
      node.className = `pointlens-${brand}-status pointlens-hotel-status`
      node.setAttribute("role", "status")
      node.append(document.createElement("span"))
      host.append(node)
    }
    node.dataset.signature = signature
    node.setAttribute("aria-busy", String(loading))
    node.setAttribute("aria-label", message)
    node.firstElementChild!.textContent = loading
      ? ""
      : compact
        ? message === "Points unavailable"
          ? "No points"
          : message === "Cash unavailable"
            ? "No cash"
            : message === "No points savings"
              ? "No savings"
              : "—"
        : message
  }
  function update() {
    if (!document.body) return
    if (!document.getElementById("pointlens-hotel-status-style")) {
      const style = document.createElement("style")
      style.id = "pointlens-hotel-status-style"
      style.textContent = `.pointlens-hotel-status{display:flex;gap:7px;align-items:center;clear:both;margin:7px 0;min-height:25px;font:13px/1.4 system-ui,sans-serif;color:#64748b}.pointlens-hotel-status::before{content:"";width:19px;flex-shrink:0}.pointlens-hotel-status span{padding:2px 6px;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc}.pointlens-hotel-status[aria-busy=true] span{width:150px;height:24px;box-sizing:border-box;background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:pointlens-hotel-loading 1.5s ease-in-out infinite}@keyframes pointlens-hotel-loading{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.pointlens-hotel-status[aria-busy=true] span{animation:none}}`
      document.head.append(style)
    }
    if (!document.getElementById("pointlens-hotel-map-style")) {
      const style = document.createElement("style")
      style.id = "pointlens-hotel-map-style"
      style.textContent = `.pointlens-hotel-map-host{pointer-events:none}.pointlens-hotel-map-host .pointlens-room-comparison{margin:0;gap:0;line-height:16px}.pointlens-hotel-map-host .pointlens-room-comparison button{display:none!important}.pointlens-hotel-map-host .pointlens-room-pill{display:block;box-sizing:border-box;white-space:nowrap!important;font:600 11px/16px system-ui,sans-serif!important;padding:1px 4px!important;letter-spacing:0}.pointlens-hotel-map-host .pointlens-hotel-status{margin:0;min-height:20px;font:500 11px/16px system-ui,sans-serif}.pointlens-hotel-map-host .pointlens-hotel-status::before{display:none}.pointlens-hotel-map-host .pointlens-hotel-status span{white-space:nowrap;padding:1px 4px}.pointlens-hotel-map-host .pointlens-hotel-status[aria-busy=true] span{width:60px;height:20px}`
      document.head.append(style)
    }
    const current = snapshots.filter(config.current)
    const targets = config.targets(current),
      hosts = new Set(targets.map((t) => t.host))
    document
      .querySelectorAll(
        `.pointlens-${brand}-room-value,.pointlens-${brand}-status`
      )
      .forEach((node) => {
        if (!hosts.has(node.parentElement!)) node.remove()
      })
    for (const target of targets) {
      const { host, hotel, room, rate, points } = target
      const matching = current.filter(
        (s) => s.hotels[hotel] && (!target.scope || s.scope === target.scope)
      )
      const offers = matching
        .flatMap((s) => s.offers)
        .filter((o) => o.hotel === hotel && (!room || o.room === room))
      const selected = rate
        ? offers.find((o) => o.rate === rate && !!o.points === points)
        : cheapest(offers, points)
      const totalFallback =
        settings.taxBasis === "pretax" &&
        selected &&
        !compareRoom(offers, selected, true, !room) &&
        !!compareRoom(offers, selected, false, !room)
      renderRoomValue(host, selected, offers, {
        brand,
        pretax: settings.taxBasis === "pretax" && !totalFallback,
        nightly: target.nightly !== false,
        good: settings.goodValueThreshold,
        bad: settings.badValueThreshold,
        toUsd,
        allowFallback: !room
      })
      const badge = host.querySelector<HTMLElement>(
        ":scope > .pointlens-room-comparison"
      )
      if (badge) {
        status(host)
        if (!totalFallback)
          badge.querySelector(".pointlens-total-fallback")?.remove()
        if (
          totalFallback &&
          !badge.querySelector(".pointlens-total-fallback")
        ) {
          const note = document.createElement("div")
          note.className = "pointlens-total-fallback"
          note.style.cssText = "font-size:11px;color:#64748b"
          note.textContent = "Total used; base unavailable"
          badge.querySelector(".pointlens-tooltip")!.append(note)
        }
        const award = points ? selected : cheapest(offers, true)
        if (award?.estimated) {
          const pill = badge.querySelector(".pointlens-room-pill")!
          if (!pill.textContent?.startsWith("≈"))
            pill.textContent = "≈" + pill.textContent
          const tooltip = badge.querySelector(".pointlens-tooltip")!
          if (!tooltip.querySelector(".pointlens-estimate-note")) {
            const note = document.createElement("div")
            note.className = "pointlens-estimate-note"
            note.style.cssText = "font-size:11px;color:#64748b"
            note.textContent = "Estimated award taxes & fees"
            tooltip.append(note)
          }
        }
        if (target.compact) {
          const pill = badge.querySelector<HTMLElement>(".pointlens-room-pill")!
          const text = pill.textContent?.split(" · ")[0] ?? ""
          if (pill.dataset.mapValue !== text) pill.dataset.mapValue = text
          // Render the compact label itself, not a pseudo-element alongside
          // invisible full text that screen readers would announce twice.
          if (pill.textContent !== text) pill.textContent = text
        }
        continue
      }
      const opposite = offers.some((o) => !!o.points !== points)
      const missingRate = !!rate && !selected
      const complete =
        !missingRate &&
        matching.some((s) => s.hotels[hotel][points ? "cash" : "points"])
      const side = points ? "Cash" : "Points"
      const loading = !complete && Date.now() - started < 20000
      status(
        host,
        loading
          ? `Loading ${side.toLowerCase()} comparison`
          : missingRate
            ? "Couldn’t load rate"
            : selected && opposite
              ? "No points savings"
              : complete
                ? `${side} unavailable`
                : `Couldn’t load ${side.toLowerCase()}`,
        loading,
        target.compact
      )
    }
  }
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      !event.data?.[`__POINTLENS_${upper}__`] ||
      !Array.isArray(event.data.snapshots)
    )
      return
    const next = event.data.snapshots.filter(
      (s: HotelSnapshot) =>
        s &&
        typeof s.context === "string" &&
        Array.isArray(s.offers) &&
        s.hotels
    )
    if (next[0]?.context !== snapshots[0]?.context) {
      started = Date.now()
      setTimeout(schedule, 21000)
    }
    snapshots = next
    schedule()
  })
  window.postMessage(
    { [`__POINTLENS_${upper}_READY__`]: true },
    location.origin
  )
  chrome.storage.local.get(config.storageKey, (result) => {
    settings = config.normalize(result[config.storageKey])
    schedule()
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[config.storageKey]) {
      settings = config.normalize(changes[config.storageKey].newValue)
      schedule()
    }
  })
  new MutationObserver((records) => {
    const relevant = records.filter((r) => {
      const el = r.target instanceof Element ? r.target : r.target.parentElement
      if (el?.closest('[class*="pointlens-"],[id^="pointlens-"]')) return false
      return (
        r.type !== "childList" ||
        [...r.addedNodes, ...r.removedNodes].some(
          (n) =>
            !(n instanceof Element) ||
            !n.className?.toString().includes("pointlens-")
        )
      )
    })
    if (!relevant.length) return
    const selector = config.immediateSelector
    const immediate =
      selector &&
      relevant.some((r) => {
        const el =
          r.target instanceof Element ? r.target : r.target.parentElement
        return (
          !!el?.closest(selector) ||
          [...r.addedNodes].some(
            (n) =>
              n instanceof Element &&
              (n.matches(selector) || n.querySelector(selector))
          )
        )
      })
    if (immediate) {
      clearTimeout(scheduled)
      scheduled = undefined
      update()
    } else schedule()
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "class",
      "id",
      "value",
      "aria-label",
      "alt",
      "data-amount",
      "data-amount-code"
    ]
  })
  document.addEventListener("change", schedule)
  document.addEventListener("click", schedule, true)
  window.addEventListener("popstate", schedule)
  setTimeout(schedule, 21000)
  schedule()
}

export function comparisonHost(parent: Element, brand: string) {
  let host = parent.querySelector<HTMLElement>(
    `:scope > .pointlens-${brand}-host`
  )
  if (!host) {
    host = document.createElement("div")
    host.className = `pointlens-${brand}-host`
    host.style.cssText = "position:relative;z-index:2;clear:both"
    parent.append(host)
  }
  return host
}
