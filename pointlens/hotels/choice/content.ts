import { installBudgetBridge } from "../../shared/pricing-budget"
import { renderRoomValue } from "../../shared/room-value"
import { updateChoiceMap } from "./map"
import {
  choiceContext,
  choiceHotel,
  type ChoiceOffer,
  type ChoiceSnapshot
} from "./pricing"
import {
  CHOICE_VALUE_SETTINGS_KEY,
  DEFAULT_CHOICE_VALUE_SETTINGS,
  normalizeChoiceValueSettings
} from "./settings"
import { renderChoiceStatus } from "./status"

installBudgetBridge("choice")
let settings = DEFAULT_CHOICE_VALUE_SETTINGS
let snapshots: ChoiceSnapshot[] = [],
  context = choiceContext(location.href),
  started = Date.now()
let scheduled: ReturnType<typeof setTimeout> | undefined
let detail:
  | {
      context: string
      hotel: string
      room: string
      rate: string
      points: boolean
    }
  | undefined
const fx = new Map<string, number | undefined>([["USD", 1]])
const schedule = () => {
  if (!scheduled)
    scheduled = setTimeout(() => {
      scheduled = undefined
      update()
    }, 100)
}
const toUsd = (amount: number, currency: string) => {
  if (!fx.has(currency)) {
    fx.set(currency, undefined)
    chrome.runtime.sendMessage(
      { type: "CHOICE_FETCH_FX", currency },
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
const cheapest = (offers: ChoiceOffer[], points: boolean) =>
  offers
    .filter((o) => !!o.points === points)
    .sort(
      (a, b) =>
        (a.points ??
          (settings.taxBasis === "pretax" ? a.base : a.total ?? a.base) ??
          Infinity) -
        (b.points ??
          (settings.taxBasis === "pretax" ? b.base : b.total ?? b.base) ??
          Infinity)
    )[0]
const isPoints = (host: Element) =>
  !!host.querySelector(".pricing-display-points")
function identity(host: Element) {
  const row = host.closest(".rate-card-price-box")
  const id = row
    ?.querySelector('[id^="rates-room-card-book-room-"]')
    ?.id.match(/^rates-room-card-book-room-(.+?)-(.+)$/)
  const room =
    id?.[1] ??
    host
      .closest('[data-track-id$=" roomCard"]')
      ?.getAttribute("data-track-id")
      ?.split(" ")[0]
  const card = host.closest(
    ".search-result-list-view-card, .property-details-with-price, .map-flyout, [data-hotel-code]"
  )
  const mapHotel = host
    .closest('[id^="MapListItem-"]')
    ?.id.replace("MapListItem-", "")
  const link = Array.from(
    card?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []
  ).find((a) => choiceHotel(a.href))
  return {
    hotel:
      mapHotel ??
      card?.getAttribute("data-hotel-code") ??
      (link ? choiceHotel(link.href) : undefined) ??
      choiceHotel(location.href),
    room,
    rate: id?.[2]
  }
}
function update() {
  if (!document.body) return
  const next = choiceContext(location.href)
  if (next !== context) {
    snapshots = []
    context = next
    started = Date.now()
    setTimeout(schedule, 21000)
  }
  const options = {
    brand: "choice",
    pretax: settings.taxBasis === "pretax",
    nightly: true,
    good: settings.goodValueThreshold,
    bad: settings.badValueThreshold,
    toUsd,
    allowFallback: false
  }
  const all = (hotel: string, room?: string) => {
    const matching = snapshots.filter(
      (s) =>
        s.hotels[hotel] && (room ? s.scope !== "search" : s.scope === "search")
    )
    const map = new Map<string, ChoiceOffer>()
    for (const s of matching.sort(
      (a, b) => Number(a.scope === "rooms") - Number(b.scope === "rooms")
    ))
      for (const o of s.offers)
        if (o.hotel === hotel && (!room || o.room === room)) map.set(o.id, o)
    return [...map.values()]
  }
  const apply = (
    host: HTMLElement,
    hotel: string,
    room: string | undefined,
    rate: string | undefined,
    points: boolean,
    nightly = true
  ) => {
    const offers = all(hotel, room)
    const selected = rate
      ? offers.find((o) => o.rate === rate)
      : cheapest(offers, points)
    if (rate && !selected && /PPC|POINT.*CASH/i.test(rate)) {
      renderRoomValue(host, undefined, [], options)
      renderChoiceStatus(host)
      return
    }
    renderRoomValue(host, selected, offers, { ...options, nightly })
    if (host.querySelector(":scope > .pointlens-room-comparison")) {
      renderChoiceStatus(host)
      const paid = points ? cheapest(offers, false) : selected
      if (paid?.package) {
        const tip = host.querySelector(".pointlens-tooltip")!
        if (!tip.querySelector(".pointlens-choice-package-note")) {
          const note = document.createElement("div")
          note.className = "pointlens-choice-package-note"
          note.textContent = "Cash package"
          note.style.cssText = "font-size:11px;color:#64748b"
          tip.append(note)
        }
      }
      const award = points ? selected : cheapest(offers, true)
      if (award?.estimated) {
        const pill = host.querySelector(".pointlens-room-pill")!
        if (!pill.textContent?.startsWith("≈"))
          pill.textContent = "≈" + pill.textContent
        const tip = host.querySelector(".pointlens-tooltip")!
        if (!tip.querySelector(".pointlens-choice-fee-note")) {
          const note = document.createElement("div")
          note.className = "pointlens-choice-fee-note"
          note.textContent = "Additional property fees may apply"
          note.style.cssText = "font-size:11px;color:#64748b"
          tip.append(note)
        }
      }
      return
    }
    const states = snapshots
      .filter(
        (s) =>
          s.hotels[hotel] &&
          (room ? s.scope !== "search" : s.scope === "search")
      )
      .map((s) => s.hotels[hotel])
    const side = points ? "cash" : "points"
    const state = states.some((s) => s[side] === "ready")
      ? "ready"
      : states.some((s) => s[side] === "pending")
        ? "pending"
        : states.some((s) => s[side] === "error") ||
            Date.now() - started > 20000
          ? "error"
          : "pending"
    renderChoiceStatus(
      host,
      state === "pending"
        ? `Loading ${side} comparison`
        : state === "error"
          ? `Couldn’t load ${side}`
          : `${points ? "Cash" : "Points"} unavailable`,
      state === "pending"
    )
  }
  document
    .querySelectorAll<HTMLElement>('[aria-label="Pricing and Fees"]')
    .forEach((host) => {
      const { hotel, room, rate } = identity(host)
      if (
        /sold out|unavailable/i.test(
          host.querySelector(".main-price")?.textContent ?? ""
        )
      ) {
        renderRoomValue(host, undefined, [], options)
        renderChoiceStatus(host)
        return
      }
      if (hotel) apply(host, hotel, room, rate, isPoints(host))
    })
  updateChoiceMap(document)

  document
    .querySelectorAll<HTMLElement>(
      ".room-card-info-modal .room-details-container"
    )
    .forEach((dialog) => {
      const title = dialog.querySelector("h3")
      const hotel = choiceHotel(location.href)
      const room = snapshots
        .flatMap((s) => s.offers)
        .find(
          (o) => o.hotel === hotel && o.roomName === title?.textContent?.trim()
        )?.room
      if (!hotel || !room || !title) return
      let host = dialog.querySelector<HTMLElement>(
        ".pointlens-choice-detail-host"
      )
      if (!host) {
        host = document.createElement("div")
        host.className = "pointlens-choice-detail-host"
        title.after(host)
      }
      const points =
        !!document.querySelector(".points-toggle[aria-checked=true]") ||
        new URL(location.href).searchParams.get("ratePlanCode") === "SRD"
      apply(host, hotel, room, undefined, points)
    })
  if (detail?.context === context)
    document
      .querySelectorAll<HTMLElement>(
        ".react-rate-full-description-modal-content, .rate-plan-details-modal-content"
      )
      .forEach((dialog) => {
        apply(dialog, detail!.hotel, detail!.room, detail!.rate, detail!.points)
      })
  document
    .querySelectorAll<HTMLElement>(".rate-card-price-box")
    .forEach((row) => {
      const { hotel, room, rate } = identity(row)
      if (!hotel || !room || !rate) return
      let host = row.querySelector<HTMLElement>(
        ":scope > .pointlens-choice-rate-host"
      )
      if (!host) {
        host = document.createElement("div")
        host.className = "pointlens-choice-rate-host"
        row.querySelector(".price-total")?.after(host)
      }
      apply(host, hotel, room, rate, isPoints(row))
    })
}
window.addEventListener("message", (e) => {
  if (
    e.source !== window ||
    e.origin !== location.origin ||
    !e.data?.__POINTLENS_CHOICE__ ||
    e.data.context !== choiceContext(location.href) ||
    !Array.isArray(e.data.snapshots)
  )
    return
  context = e.data.context
  snapshots = e.data.snapshots.filter(
    (s: ChoiceSnapshot) =>
      s.context === context && Array.isArray(s.offers) && s.hotels
  )
  schedule()
})
window.postMessage({ __POINTLENS_CHOICE_READY__: true }, location.origin)
chrome.storage.local.get(CHOICE_VALUE_SETTINGS_KEY, (result) => {
  settings = normalizeChoiceValueSettings(result[CHOICE_VALUE_SETTINGS_KEY])
  schedule()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CHOICE_VALUE_SETTINGS_KEY]) {
    settings = normalizeChoiceValueSettings(
      changes[CHOICE_VALUE_SETTINGS_KEY].newValue
    )
    schedule()
  }
})
new MutationObserver((records) => {
  if (
    records.some((r) => {
      const node =
        r.target instanceof Element ? r.target : r.target.parentElement
      // Native marker labels change independently of our overlay.
      if (
        r.type === "attributes" &&
        r.attributeName === "aria-label" &&
        node?.classList.contains("pointlens-choice-map-pin")
      )
        return true
      if (node?.closest('[class*="pointlens-"], [id^="pointlens-"]'))
        return false
      if (
        r.type === "childList" &&
        [...r.addedNodes, ...r.removedNodes].every(
          (n) =>
            n instanceof Element &&
            (n.className?.toString().includes("pointlens-") ||
              n.getAttribute("id")?.startsWith("pointlens-"))
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
  attributeFilter: ["class", "id", "checked", "aria-checked", "aria-label"]
})
document.addEventListener(
  "click",
  (event) => {
    const target = event.target instanceof Element ? event.target : undefined
    if (target?.closest(".pointlens-room-comparison")) return
    const card =
      target?.closest(".rate-card-price-box") ??
      target?.closest(".rates-info-card")?.querySelector(".rate-card-price-box")
    if (card) {
      const id = identity(card)
      if (id.hotel && id.room && id.rate)
        detail = {
          context,
          hotel: id.hotel,
          room: id.room,
          rate: id.rate,
          points: isPoints(card)
        }
    }
    schedule()
  },
  true
)
document.addEventListener("change", schedule)
window.addEventListener("popstate", schedule)
setTimeout(schedule, 21000)
schedule()
