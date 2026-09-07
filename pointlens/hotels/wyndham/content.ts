import { installBudgetBridge } from "../../shared/pricing-budget"
import { renderRoomValue } from "../../shared/room-value"
import { overviewPricing } from "./overview"
import {
  wyndhamContext,
  type WyndhamOffer,
  type WyndhamSnapshot
} from "./pricing"
import {
  DEFAULT_WYNDHAM_VALUE_SETTINGS,
  normalizeWyndhamValueSettings,
  WYNDHAM_VALUE_SETTINGS_KEY
} from "./settings"
import { renderWyndhamStatus } from "./status"

installBudgetBridge("wyndham")
let settings = DEFAULT_WYNDHAM_VALUE_SETTINGS
let snapshots: WyndhamSnapshot[] = []
let context = ""
let detail: { context: string; room: string; rate?: string } | undefined
const fx = new Map<string, number | undefined>([["USD", 1]])
let scheduled: ReturnType<typeof setTimeout> | undefined
let started = Date.now()
let expiry: ReturnType<typeof setTimeout> | undefined
const schedule = () => {
  if (!scheduled)
    scheduled = setTimeout(() => {
      scheduled = undefined
      update()
    }, 80)
}
const toUsd = (amount: number, currency: string) => {
  if (!fx.has(currency)) {
    fx.set(currency, undefined)
    chrome.runtime.sendMessage(
      { type: "WYNDHAM_FETCH_FX", currency },
      (result) => {
        void chrome.runtime.lastError
        if (Number.isFinite(result?.rate) && result.rate > 0)
          fx.set(currency, result.rate)
        schedule()
      }
    )
  }
  const rate = fx.get(currency)
  return rate === undefined ? undefined : amount * rate
}
const value = (o: WyndhamOffer) =>
  o.points ??
  (settings.taxBasis === "pretax" ? o.base : o.total ?? o.base) ??
  Infinity
const cheapest = (offers: WyndhamOffer[], points: boolean) =>
  offers
    .filter((o) => !!o.points === points)
    .sort((a, b) => value(a) - value(b))[0]
function update() {
  if (!document.body) return
  if (!document.getElementById("pointlens-wyndham-layout")) {
    const style = document.createElement("style")
    style.id = "pointlens-wyndham-layout"
    style.textContent = `.pointlens-wyndham-room-value>button{box-shadow:none!important;text-transform:none;letter-spacing:normal}#mapRateView:has(.pointlens-wyndham-room-value) .hotel-img-wrapper img{max-height:135px;object-fit:cover;width:100%}`
    document.head.append(style)
  }
  const next = wyndhamContext(location.href)
  if (context !== next) {
    snapshots = []
    context = next
    started = Date.now()
    clearTimeout(expiry)
    expiry = setTimeout(schedule, 21000)
  }
  const pointsView =
    document.querySelector<HTMLInputElement>(
      "#wyndham-rewards-filter, #wyndham-rewards-filter-wc"
    )?.checked ??
    new URL(location.href).searchParams.get("useWRPoints") === "true"
  const options = {
    brand: "wyndham",
    pretax: settings.taxBasis === "pretax",
    nightly: true,
    good: settings.goodValueThreshold,
    bad: settings.badValueThreshold,
    toUsd,
    allowFallback: false
  }
  const all = (scope: "search" | "rooms", hotel?: string) =>
    snapshots
      .filter((s) => s.scope === scope)
      .flatMap((s) => s.offers)
      .filter((o) => !hotel || o.hotel === hotel)
  const stateFor = (scope: "search" | "rooms", hotel?: string) => {
    const states = snapshots
      .filter((s) => s.scope === scope)
      .flatMap((s) => Object.entries(s.hotels))
      .filter(([id]) => !hotel || id === hotel)
    return (
      states.at(-1)?.[1] ?? {
        cash: Date.now() - started > 20000 ? "error" : "pending",
        points: Date.now() - started > 20000 ? "error" : "pending"
      }
    )
  }
  const apply = (
    host: HTMLElement,
    selected: WyndhamOffer | undefined,
    offers: WyndhamOffer[],
    scope: "search" | "rooms",
    hotel: string | undefined,
    points: boolean,
    nightly = true
  ) => {
    renderRoomValue(host, selected, offers, { ...options, nightly })
    if (host.querySelector(":scope > .pointlens-room-comparison")) {
      renderWyndhamStatus(host)
      return
    }
    const states = stateFor(scope, hotel)
    const side = points ? "cash" : "points"
    const own = points ? "points" : "cash"
    const state = selected ? states[side] : states[own]
    const label = selected ? side : own
    if (state === "pending")
      renderWyndhamStatus(host, `Loading ${label} comparison`, true)
    else if (state === "error")
      renderWyndhamStatus(host, `Couldn’t load ${label}`)
    else
      renderWyndhamStatus(
        host,
        `${label === "cash" ? "Cash" : "Points"} unavailable`
      )
  }
  document
    .querySelectorAll<HTMLElement>(
      ".prop-summary-wrapper[id], .hotel-details-wrapper[id]"
    )
    .forEach((card) => {
      const hotel = card.id.replace(/^[A-Za-z]{2}/, "")
      const host = card.querySelector<HTMLElement>(".hotel-rate .average-rate")
      if (!host || !hotel) return
      const offers = all("search", hotel)
      apply(
        host,
        cheapest(offers, pointsView),
        offers,
        "search",
        hotel,
        pointsView
      )
    })
  const overview = overviewPricing(document, location.href)
  if (overview) {
    const offers = all("search", overview.hotel)
    apply(
      overview.host,
      cheapest(offers, overview.points),
      offers,
      "search",
      overview.hotel,
      overview.points
    )
  }
  const preview = document.getElementById("mapRateView")
  const previewHost = preview?.querySelector<HTMLElement>(".average-rate")
  if (previewHost) {
    const name = preview?.querySelector("#map-name")?.textContent?.trim()
    const matches = new Set(
      all("search")
        .filter((o) => o.roomName === name)
        .map((o) => o.hotel)
    )
    if (matches.size === 1) {
      const hotel = [...matches][0]
      const offers = all("search", hotel)
      apply(
        previewHost,
        cheapest(offers, pointsView),
        offers,
        "search",
        hotel,
        pointsView
      )
    } else {
      renderRoomValue(previewHost, undefined, [], options)
      renderWyndhamStatus(previewHost)
    }
  }
  document
    .querySelectorAll<HTMLElement>(".room[room]:not(.clone)")
    .forEach((card) => {
      const room = card.getAttribute("room")
      if (!room) return
      const offers = all("rooms").filter((o) => o.room === room)
      const hotel = offers[0]?.hotel
      card
        .querySelectorAll<HTMLElement>(
          "li.rate[rate]:not(.clone):not(.rate-section)"
        )
        .forEach((row) => {
          const rate = row.getAttribute("rate")
          const selected = offers.find((o) => o.rate === rate)
          const host = row.querySelector<HTMLElement>(".room-rate")
          if (!host) return
          // Mixed redemptions have their own native section and aren't full awards.
          if (
            !selected &&
            row.classList.contains("points-rate") &&
            row.querySelector(".money")
          ) {
            renderRoomValue(host, undefined, [], options)
            renderWyndhamStatus(host)
            return
          }
          apply(
            host,
            selected,
            offers,
            "rooms",
            hotel,
            row.classList.contains("points-rate")
          )
        })
      const summary = card.querySelector<HTMLElement>(":scope > .from-rate")
      if (summary)
        apply(
          summary,
          cheapest(offers, pointsView),
          offers,
          "rooms",
          hotel,
          pointsView
        )
      // A points-only view can leave a room with just mixed rates; keep its
      // full-award status explicit without adding a misleading CPP to those rates.
      const title = card.querySelector<HTMLElement>(".room-detail-text")
      if (title) {
        if (
          pointsView &&
          offers.length &&
          !offers.some((o) => o.points) &&
          stateFor("rooms", hotel).points === "ready"
        )
          renderWyndhamStatus(title, "Points unavailable")
        else renderWyndhamStatus(title)
      }
    })
  if (detail?.context === context) {
    const offers = all("rooms").filter((o) => o.room === detail!.room)
    const selected = detail.rate
      ? offers.find((o) => o.rate === detail!.rate)
      : cheapest(offers, pointsView)
    // Do not label a mixed redemption with the full-award comparison.
    if (selected || !detail.rate) {
      const roomDialog = document.querySelector<HTMLElement>(
        "#genericLightbox.in .room-detail-modal-content, #genericLightbox.in .addl-details-modal"
      )
      const totalDialog = document.querySelector<HTMLElement>(
        "#rateSummaryDetail.in .room-info"
      )
      for (const host of [roomDialog, totalDialog])
        if (host) {
          apply(
            host,
            selected,
            offers,
            "rooms",
            offers[0]?.hotel,
            selected ? !!selected.points : pointsView,
            host !== totalDialog
          )
        }
    } else {
      for (const host of document.querySelectorAll<HTMLElement>(
        "#genericLightbox .room-detail-modal-content, #genericLightbox .addl-details-modal, #rateSummaryDetail .room-info"
      )) {
        renderRoomValue(host, undefined, [], options)
        renderWyndhamStatus(host)
      }
    }
  }
}
window.addEventListener("message", (e) => {
  if (
    e.source !== window ||
    e.origin !== location.origin ||
    !e.data?.__POINTLENS_WYNDHAM__ ||
    e.data.context !== wyndhamContext(location.href) ||
    !Array.isArray(e.data.snapshots)
  )
    return
  context = e.data.context
  snapshots = e.data.snapshots.filter(
    (s: WyndhamSnapshot) =>
      s.context === context && Array.isArray(s.offers) && s.hotels
  )
  schedule()
})
window.postMessage({ __POINTLENS_WYNDHAM_READY__: true }, location.origin)
chrome.storage.local.get(WYNDHAM_VALUE_SETTINGS_KEY, (result) => {
  settings = normalizeWyndhamValueSettings(result[WYNDHAM_VALUE_SETTINGS_KEY])
  schedule()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[WYNDHAM_VALUE_SETTINGS_KEY]) {
    settings = normalizeWyndhamValueSettings(
      changes[WYNDHAM_VALUE_SETTINGS_KEY].newValue
    )
    schedule()
  }
})
new MutationObserver((records) => {
  if (
    records.some((r) => {
      const node =
        r.target instanceof Element ? r.target : r.target.parentElement
      if (node?.closest('[class*="pointlens-"], [id^="pointlens-"]'))
        return false
      if (
        r.type === "childList" &&
        [...r.addedNodes, ...r.removedNodes].every(
          (n) =>
            n instanceof Element &&
            (n.className?.toString().includes("pointlens-") ||
              (n.getAttribute("id") ?? "").startsWith("pointlens-"))
        )
      )
        return false
      return true
    })
  )
    schedule()
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    "class",
    "style",
    "room",
    "rate",
    "rate-processed",
    "fns-points"
  ]
})
window.addEventListener("popstate", schedule)
document.addEventListener("change", schedule)
setTimeout(schedule, 21000)
schedule()

document.addEventListener(
  "click",
  (event) => {
    const target = event.target instanceof Element ? event.target : undefined
    const link = target?.closest(
      ".stay-total, .addl-details, .room-detail-link"
    )
    const room = link?.closest(".room[room]")?.getAttribute("room")
    if (!room) return
    detail = {
      context: wyndhamContext(location.href),
      room,
      rate: link?.closest("li.rate[rate]")?.getAttribute("rate") ?? undefined
    }
    schedule()
  },
  true
)
