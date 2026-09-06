import type { PlasmoCSConfig } from "plasmo"

import { hasHostMutation, makeInfoAccessible } from "../../shared/dom"
import { attachTooltip } from "../../shared/tooltip"
import {
  compareHilton,
  nightsBetween,
  number,
  parseHiltonHotel,
  parseHiltonSearch,
  type HiltonComparison,
  type HiltonHotel
} from "./pricing"
import {
  DEFAULT_HILTON_VALUE_SETTINGS,
  HILTON_VALUE_SETTINGS_KEY,
  normalizeHiltonValueSettings
} from "./settings"

export const config: PlasmoCSConfig = {
  matches: ["https://www.hilton.com/*"],
  run_at: "document_start"
}
const CLASS = "pointlens-hilton-price-placeholder"
const hotels = new Map<string, HiltonHotel>()
const fx = new Map<string, number>()
let settings = DEFAULT_HILTON_VALUE_SETTINGS
let context = 0,
  lastUrl = "",
  scheduled = false
let activeRoom = "",
  activeCashKey = "",
  currentHotel = ""
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\u200b-\u200d]/g, "")
    .replace(/\s+/g, " ")
    .trim()
const money = (n: number | undefined, currency = "USD") =>
  n === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
        n
      )
const points = (n: number | undefined) =>
  n === undefined
    ? "—"
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n)} pts`
const pointsMode = () =>
  !!document.querySelector<HTMLInputElement>(
    '[data-testid="usePointsCheckbox"], #usePoints, input[type="checkbox"][name="usePoints"]'
  )?.checked ||
  Array.from(document.querySelectorAll("label")).some(
    (l) =>
      /use points/i.test(l.textContent || "") &&
      !!(
        l.querySelector("input") ||
        (document.getElementById(l.htmlFor) as HTMLInputElement)
      )?.checked
  )
function urlScope() {
  const p = new URL(location.href).searchParams
  if (!p.has("arrivalDate") && !p.has("departureDate")) return ""
  return JSON.stringify(
    [...p]
      .filter(([k]) =>
        /^(arrivalDate|departureDate|numAdults|numChildren|numRooms|room\d+(NumAdults|NumChildren|ChildAges)|ctyhocn|displayCurrency|corporateCode|groupCode|promoCode)$/.test(
          k
        )
      )
      .sort()
  )
}
function clear() {
  hotels.clear()
  context = 0
  activeRoom = ""
  activeCashKey = ""
  currentHotel = ""
  publishMap()
  document.querySelectorAll(`.${CLASS}`).forEach((e) => e.remove())
}
function inject(name: string) {
  const script = document.createElement("script")
  script.src = chrome.runtime.getURL(`hotels/hilton/injected/${name}.js`)
  script.async = false
  script.dataset.debug = String(process.env.PLASMO_PUBLIC_HILTON_QA === "1")
  script.onload = () => script.remove()
  ;(document.head || document.documentElement).appendChild(script)
}
function info(
  hotel: HiltonHotel,
  room?: string,
  cashKey?: string,
  mode: "cash" | "points" = pointsMode() ? "points" : "cash"
): HiltonComparison {
  return compareHilton(hotel, {
    room,
    cashKey,
    mode,
    taxBasis: settings.taxBasis,
    usdRate: fx.get(hotel.cash[0]?.currency)
  })
}
function publishMap() {
  const rates = Array.from(hotels, ([id, h]) => ({ id, ...info(h) }))
    .filter((r) => r.rewardStatus !== undefined)
    .map(({ id, cpp, cash, points, rewardStatus, currency, awardRate }) => ({
      id,
      cpp,
      cash,
      points,
      rewardStatus,
      currency,
      pointsEstimated: awardRate?.pointsEstimated === true
    }))
  window.postMessage({ __AV_HILTON_AUTH_RATES__: true, rates }, location.origin)
  window.postMessage(
    { __AV_HILTON_MAP_SETTINGS__: true, settings },
    location.origin
  )
}
function tooltip(value: HiltonComparison) {
  const wrap = document.createElement("div"),
    grid = document.createElement("div")
  grid.className = "pointlens-tooltip-grid"
  const row = (label: string, text: string) => {
    const r = document.createElement("div")
    r.className = "pointlens-tooltip-row"
    const l = document.createElement("div")
    l.className = "pointlens-tooltip-cell pointlens-tooltip-cell--label"
    l.textContent = label
    const v = document.createElement("div")
    v.className = "pointlens-tooltip-cell"
    v.textContent = text
    r.append(l, v)
    grid.append(r)
  }
  const cash = value.cashRate,
    n = value.stayNights
  row(
    "Base",
    (cash?.baseApproximate && cash.base !== undefined ? "≈" : "") +
      money(cash?.base, value.currency)
  )
  const fees =
    cash?.total !== undefined && cash.base !== undefined
      ? Math.max(0, cash.total - cash.base)
      : undefined
  row(
    "Fees",
    (cash?.baseApproximate && fees !== undefined ? "≈" : "") +
      money(fees, value.currency)
  )
  row("Total", money(cash?.total, value.currency))
  const divider = document.createElement("div")
  divider.className = "pointlens-tooltip-divider"
  grid.append(divider)
  row(
    "Points",
    (value.awardRate?.pointsEstimated
      ? `${points(value.points)} (first night)`
      : points(value.awardRate?.points)) +
      (value.cpp === undefined ? "" : ` (≈${value.cpp.toFixed(2)}¢/pt)`)
  )
  wrap.append(grid)
  const foot = document.createElement("div")
  foot.style.cssText = "margin-top:8px;color:#64748b;font-size:11px"
  foot.textContent = [
    value.awardRate?.pointsEstimated
      ? `${n}-night cash total · estimated CPP`
      : `${n}-night total`,
    settings.taxBasis === "pretax" ? "CPP before tax" : undefined,
    cash?.nonrefundable
      ? "nonrefundable"
      : cash?.member
        ? "member rate"
        : undefined,
    cash?.package ? "package" : undefined
  ]
    .filter(Boolean)
    .join(" · ")
  wrap.append(foot)
  if (value.fallback) {
    const alt = document.createElement("div")
    alt.textContent = value.fallback
    alt.style.cssText = "color:#64748b;font-size:11px"
    wrap.append(alt)
  }
  return wrap
}
function badge(
  anchor: HTMLElement,
  value: HiltonComparison,
  mode: "cash" | "points",
  key: string
) {
  let el = anchor.parentElement?.querySelector<HTMLElement>(
    `.${CLASS}[data-slot="${CSS.escape(key)}"]`
  )
  if (!el) {
    el = document.createElement("div")
    el.className = CLASS
    el.dataset.slot = key
    const icon = document.createElement("span")
    icon.className = "pointlens-hilton-cpp-icon"
    icon.textContent = "i"
    makeInfoAccessible(icon)
    const source = document.createElement("span")
    source.className = "pointlens-tooltip"
    icon.append(source)
    const valueEl = document.createElement("span")
    valueEl.className = "pointlens-hilton-cpp-value"
    el.append(icon, valueEl)
    anchor.before(el)
    attachTooltip(icon)
  }
  el.dataset.seen = "1"
  const narrow =
    key !== "preview" &&
    (anchor.parentElement?.getBoundingClientRect().width || 999) < 215
  el.classList.toggle("is-compact", narrow)
  const sig = JSON.stringify([value, mode, settings, narrow])
  if (el.dataset.signature === sig) return
  el.dataset.signature = sig
  const pill = el.querySelector<HTMLElement>(".pointlens-hilton-cpp-value")!
  const opposite =
    mode === "points"
      ? money(value.cash, value.currency)
      : narrow && value.points !== undefined
        ? new Intl.NumberFormat("en", {
            notation: "compact",
            maximumFractionDigits: 1
          })
            .format(value.points)
            .toLowerCase()
        : points(value.points)
  const available =
    mode === "points" ? value.cash !== undefined : value.points !== undefined
  pill.textContent =
    value.cpp !== undefined
      ? `≈${value.cpp.toFixed(2)}¢/pt · ${opposite}`
      : available
        ? opposite
        : mode === "points"
          ? "Cash unavailable"
          : value.rewardStatus === "unavailable"
            ? "Points unavailable"
            : "Points —"
  pill.className =
    "pointlens-hilton-cpp-value" +
    (value.cpp === undefined
      ? ""
      : value.cpp >= settings.goodValueThreshold
        ? " is-good"
        : value.cpp <= settings.badValueThreshold
          ? " is-bad"
          : " is-mid")
  el.querySelector(".pointlens-tooltip")!.replaceChildren(tooltip(value))
}
function styles() {
  if (document.getElementById("pointlens-hilton-style")) return
  const style = document.createElement("style")
  style.id = "pointlens-hilton-style"
  style.textContent = `.${CLASS}{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin:6px 0;font:14px/1.35 system-ui,sans-serif;font-variant-numeric:tabular-nums;max-width:100%;flex-wrap:wrap}.pointlens-hilton-cpp-icon{display:inline-flex;align-items:center;justify-content:center;border:1px solid #64748b;color:#64748b;width:20px;height:20px;border-radius:50%;font:14px Georgia,serif;flex:none;cursor:help}.pointlens-hilton-cpp-value{padding:2px 6px;border:1px solid #cbd5e1;border-radius:5px;background:#f8fafc;color:#475569;white-space:normal}.pointlens-hilton-cpp-value.is-good{background:#d1fae5;border-color:#a7f3d0;color:#047857}.pointlens-hilton-cpp-value.is-mid{background:#fef3c7;border-color:#fde68a;color:#b45309}.pointlens-hilton-cpp-value.is-bad{background:#ffe4e6;border-color:#fecdd3;color:#be123c}`
  document.head.append(style)
  style.textContent += `.${CLASS}.is-compact{font-size:12px;gap:4px;flex-wrap:nowrap;justify-content:flex-start}.${CLASS}.is-compact .pointlens-hilton-cpp-icon{width:17px;height:17px;font-size:12px}.${CLASS}.is-compact .pointlens-hilton-cpp-value{padding:2px 4px;white-space:nowrap}`
  // Keep Hilton's fixed preview footer and its View Rates button in place.
  style.textContent += `div:has(> .${CLASS}[data-slot="preview"]){position:relative}.${CLASS}[data-slot="preview"]{position:absolute;bottom:calc(100% + 6px);right:0;width:max-content;max-width:min(320px,calc(100vw - 32px));margin:0;flex-wrap:nowrap}`
}
function roomByName(h: HiltonHotel, name: string) {
  return [...h.cash, ...h.awards].find(
    (r) => normalize(r.roomName) === normalize(name)
  )?.room
}
function scan() {
  scheduled = false
  if (!document.body) return
  const scope = urlScope()
  if (scope && lastUrl && lastUrl !== scope) clear()
  if (scope) lastUrl = scope
  styles()
  document
    .querySelectorAll<HTMLElement>(`.${CLASS}`)
    .forEach((e) => (e.dataset.seen = "0"))
  const mode = pointsMode() ? "points" : "cash"
  for (const card of document.querySelectorAll<HTMLElement>(
    '[data-testid^="hotel-card-"]'
  )) {
    const id = card.dataset.testid!.slice(11).toUpperCase(),
      h = hotels.get(id)
    const anchor = card.querySelector<HTMLElement>(
      '[data-testid="priceInfo"] a[href*="/book/reservation/rooms/"]'
    )
    if (h && anchor)
      badge(anchor, info(h, undefined, undefined, mode), mode, "search")
  }
  const params = new URL(location.href).searchParams,
    id = params.get("ctyhocn")?.toUpperCase() || currentHotel
  const h = id ? hotels.get(id) : undefined
  if (h) {
    // Native rate details contain exact stay totals; the list API rounds its
    // nightly average to cents. Refine the existing quote without another request.
    for (const dialog of document.querySelectorAll<HTMLElement>(
      '[role="dialog"]'
    )) {
      const title = dialog.querySelector(
        '[data-testid="quickLookRoomTypeName"]'
      )?.textContent
      const room = title ? roomByName(h, title) : undefined
      const rate = h.cash.find(
        (r) =>
          r.room === room &&
          normalize(r.name) ===
            normalize(dialog.getAttribute("aria-label") || "")
      )
      const currency = dialog.querySelector(
        '[data-testid="currencyText"]'
      )?.textContent
      if (!rate || !currency?.includes(rate.currency)) continue
      const base = number(
        dialog.querySelector('[data-testid="totalRoomChargeAmount"]')
          ?.textContent,
        document.documentElement.lang || "en"
      )
      const total = number(
        dialog.querySelector('[data-testid="totalForStayAmount"]')?.textContent,
        document.documentElement.lang || "en"
      )
      if (base !== undefined && total !== undefined && total >= base) {
        if (rate.usdBase && rate.base) rate.usdBase *= base / rate.base
        rate.base = base
        rate.total = total
        rate.baseApproximate = false
      }
    }
    for (const card of document.querySelectorAll<HTMLElement>(
      "[data-roomtypecode]"
    )) {
      const room = card.dataset.roomtypecode
      const anchor = card.querySelector<HTMLElement>(
        '[data-testid="moreRatesButton"], [data-testid="accessibleMoreRatesButton"], [data-testid="bookButton"], [data-testid="quickBookButton"], [data-testid="accessibleQuickBookButton"]'
      )
      if (anchor && room) badge(anchor, info(h, room), mode, `room-${room}`)
    }
    const selected =
      params.get("roomTypeCode") ||
      roomByName(
        h,
        document.querySelector('[data-testid="roomSelectedLabel"] .sr-only')
          ?.textContent || ""
      ) ||
      activeRoom
    for (const block of document.querySelectorAll<HTMLElement>(
      '[data-testid="standardRateBlock"], [data-testid="rateTableHonorsCell"]'
    )) {
      const details = Array.from(
        block.querySelectorAll<HTMLButtonElement>("button")
      ).find((b) => /^Rate details for /i.test(b.textContent || ""))
      const label = (details?.textContent || "")
        .replace(/^Rate details for /i, "")
        .replace(/Rate details$/i, "")
        .trim()
      const rateKey = details?.id.replace(/InfoModalTrigger$/, "")
      const rates = h.cash.filter(
        (r) =>
          (!selected || r.room === selected) &&
          (r.key === rateKey || normalize(r.name) === normalize(label))
      )
      const r = rates.length === 1 ? rates[0] : undefined
      if (r && details)
        badge(
          details.parentElement!,
          info(h, r.room, r.key, "cash"),
          "cash",
          `rate-${r.key}`
        )
    }
    const reward = document.querySelector<HTMLElement>(
      '[data-testid="pamRatesBlock"] [data-testid="allPointsTotalCost"]'
    )
    if (reward && selected)
      badge(
        reward.parentElement!,
        info(h, selected, undefined, "points"),
        "points",
        "reward"
      )
  }
  for (const dialog of document.querySelectorAll<HTMLElement>(
    '[role="dialog"]'
  )) {
    const cta = dialog.querySelector<HTMLAnchorElement>(
      'a[href*="/book/reservation/rooms/"]'
    )
    if (cta) {
      const hotelId = new URL(cta.href, location.origin).searchParams
        .get("ctyhocn")
        ?.toUpperCase()
      const hotel = hotelId ? hotels.get(hotelId) : undefined
      if (hotel) badge(cta, info(hotel), mode, "preview")
    }
    if (!h) continue
    const title = dialog.querySelector(
      '[data-testid="quickLookRoomTypeName"], [data-testid="quickLookHeaderBar"]'
    )?.textContent
    const room = title ? roomByName(h, title) : activeRoom
    const anchor = dialog.querySelector<HTMLElement>(
      '[data-testid="priceDetailsExpandedSection"], [data-testid="modalMoreRatesButton"], [data-testid="modalQuickBookButton"], [data-testid="moreRatesButton"], [data-testid="bookButton"]'
    )
    if (room && anchor) {
      const rateName = dialog.getAttribute("aria-label") || ""
      const rate = h.cash.find(
        (r) => r.room === room && normalize(r.name) === normalize(rateName)
      )
      badge(
        anchor,
        info(h, room, rate?.key || activeCashKey, rate ? "cash" : mode),
        rate ? "cash" : mode,
        "detail"
      )
    }
  }
  document
    .querySelectorAll<HTMLElement>(`.${CLASS}[data-seen="0"]`)
    .forEach((e) => e.remove())
}
function schedule() {
  if (!scheduled) {
    scheduled = true
    setTimeout(scan, 100)
  }
}
async function capture(payload: any) {
  const meta = payload?.meta,
    n = nightsBetween(meta?.arrivalDate, meta?.departureDate)
  if (!n) return
  const params = new URL(location.href).searchParams
  if (
    (params.has("arrivalDate") &&
      params.get("arrivalDate") !== meta.arrivalDate) ||
    (params.has("departureDate") &&
      params.get("departureDate") !== meta.departureDate)
  )
    return
  const adults = params.get("numAdults") || params.get("room1NumAdults")
  if (
    adults &&
    meta.numAdults !== undefined &&
    Number(adults) !== meta.numAdults
  )
    return
  const scope = urlScope()
  if (
    (scope && lastUrl && lastUrl !== scope) ||
    (context && context !== meta.context)
  )
    clear()
  if (scope) lastUrl = scope
  context = meta.context
  if (Array.isArray(payload.hotels))
    for (const row of payload.hotels) {
      if (typeof row.ctyhocn !== "string") continue
      const id = row.ctyhocn.toUpperCase()
      hotels.set(id, parseHiltonSearch(row, n, meta.points, hotels.get(id)))
    }
  if (payload.hotel?.ctyhocn) {
    const id = payload.hotel.ctyhocn.toUpperCase()
    if (params.has("ctyhocn") && params.get("ctyhocn")?.toUpperCase() !== id)
      return
    currentHotel = id
    const parsed = parseHiltonHotel(payload.hotel, n, meta.language || "en")
    if (meta.points) parsed.awardsKnown = true
    const old = hotels.get(id)
    // A rate-page response may contain only the selected room. Retain other rooms
    // from this exact stay so cheapest-hotel fallback needs no extra request.
    if (old) {
      for (const rate of parsed.cash) {
        const exact = old.cash.find(
          (r) =>
            r.room === rate.room &&
            r.key === rate.key &&
            r.currency === rate.currency &&
            r.total === rate.total &&
            r.baseApproximate === false
        )
        if (exact) {
          rate.base = exact.base
          rate.usdBase = exact.usdBase
          rate.baseApproximate = false
        }
      }
      const rooms = new Set(
        payload.hotel.shopAvail.roomTypes?.map((r: any) => r.roomTypeCode)
      )
      parsed.cash = [
        ...old.cash.filter((r) => !rooms.has(r.room)),
        ...parsed.cash
      ]
      parsed.awards = [
        ...old.awards.filter((r) => !rooms.has(r.room)),
        ...parsed.awards
      ]
      if (!meta.points && !parsed.awards.length) {
        parsed.awards = old.awards
        parsed.awardsKnown = old.awardsKnown
      }
    }
    hotels.set(id, parsed)
  }
  publishMap()
  schedule()
  const currencies = new Set(
    Array.from(hotels.values()).flatMap((h) => h.cash.map((r) => r.currency))
  )
  for (const currency of currencies) {
    if (
      currency === "USD" ||
      fx.has(currency) ||
      Array.from(hotels.values()).some((h) =>
        h.cash.some((r) => r.currency === currency && r.usdBase && r.base)
      )
    )
      continue
    fx.set(currency, 0)
    try {
      const rate = await chrome.runtime.sendMessage({
        type: "HILTON_FX",
        currency
      })
      if (rate > 0) fx.set(currency, rate)
    } catch {}
  }
  publishMap()
  schedule()
}
window.addEventListener("message", (e) => {
  if (e.source !== window) return
  const d = e.data
  if (d?.__AV_HILTON_CONTEXT__ && context && d.meta?.context !== context) {
    clear()
    schedule()
  }
  if (d?.__AV_HILTON_PRICING__) void capture(d.payload)
  if (d?.__AV_HILTON_BUDGET__)
    void chrome.runtime
      .sendMessage({ type: "HILTON_REQUEST_BUDGET" })
      .then((r) =>
        window.postMessage(
          {
            __AV_HILTON_BUDGET_REPLY__: true,
            id: d.id,
            allowed: r?.allowed === true,
            waitMs: r?.waitMs || 0
          },
          location.origin
        )
      )
      .catch(() => {})
  if (d?.__AV_HILTON_FINISHED__)
    void chrome.runtime
      .sendMessage({
        type: "HILTON_REQUEST_FINISHED",
        status: d.status,
        retryMs: d.retryMs
      })
      .catch(() => {})
})
// Install the bridge before either page script can emit a capture.
inject("hilton-fetch-hook")
inject("hilton-map-overlay")
function start() {
  if (!document.body) return
  lastUrl = urlScope()
  const refresh = async () => {
    settings = normalizeHiltonValueSettings(
      (await chrome.storage.local.get(HILTON_VALUE_SETTINGS_KEY))[
        HILTON_VALUE_SETTINGS_KEY
      ]
    )
    publishMap()
    schedule()
  }
  void refresh()
  chrome.storage.onChanged.addListener((c, a) => {
    if (a === "local" && c[HILTON_VALUE_SETTINGS_KEY]) void refresh()
  })
  new MutationObserver((ms) => {
    if (hasHostMutation(ms)) schedule()
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-testid", "data-roomtypecode", "aria-checked"]
  })
  document.addEventListener("change", () => {
    schedule()
    setTimeout(publishMap, 100)
  })
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement
      const card = target.closest<HTMLElement>("[data-roomtypecode]")
      if (card) activeRoom = card.dataset.roomtypecode || ""
      schedule()
    },
    true
  )
  window.addEventListener("popstate", schedule)
  window.addEventListener("resize", schedule)
  // Poll only navigation state; price rendering follows native captures/DOM changes.
  setInterval(() => {
    const scope = urlScope()
    if (scope && scope !== lastUrl) schedule()
  }, 1000)
  schedule()
}
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start, { once: true })
else start()
