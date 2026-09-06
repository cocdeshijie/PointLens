import { hasHostMutation, makeInfoAccessible } from "../../shared/dom"
import { attachTooltip } from "../../shared/tooltip"
import { calculateCpp } from "../../shared/value"
import { getIhgPaymentMode } from "./payment-mode"
import { compareIhgRoom, type IhgRoomComparison } from "./room-comparison"
import {
  matchesRoomStay,
  parseRoomRates,
  type IhgRoomSnapshot,
  type IhgRoomValue
} from "./room-rates"
import {
  DEFAULT_IHG_VALUE_SETTINGS,
  IHG_VALUE_SETTINGS_KEY,
  normalizeIhgValueSettings
} from "./settings"

let snapshot: IhgRoomSnapshot | null = null
// IHG can restore a previous stay from its SPA cache without fetching again.
// Keep reduced snapshots in this tab only; never reuse another tab's prices.
const recentStays = new Map<
  string,
  { snapshot: IhgRoomSnapshot; capturedAt: number }
>()
let settings = DEFAULT_IHG_VALUE_SETTINGS
let scheduled = false
let selectedRoom: string | undefined
let selectedCashRate: string | undefined
let initialized = false
const fx = new Map<string, number | undefined>([["USD", 1]])
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount)
const points = (amount: number) =>
  amount.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " pts"

const cpp = (room: IhgRoomValue) => {
  const cash = settings.taxBasis === "pretax" ? room.cashPretax : room.cash
  const fees =
    settings.taxBasis === "pretax" ? room.awardFeesPretax : room.awardFees
  const rate = fx.get(room.currency)
  return calculateCpp(
    cash !== undefined && rate ? cash * rate : undefined,
    room.points,
    rate ? fees * rate : 0
  )
}

function renderValue(host: HTMLElement, room: IhgRoomComparison) {
  const pointsMode = getIhgPaymentMode() !== "cash"
  room = compareIhgRoom(room, snapshot, pointsMode, settings.taxBasis)
  const value = cpp(room)
  const { cashRates, ...displayRoom } = room
  const signature = JSON.stringify([
    displayRoom,
    value,
    settings.taxBasis,
    settings.goodValueThreshold,
    settings.badValueThreshold,
    snapshot.start,
    snapshot.end,
    pointsMode
  ])
  let badge = host.querySelector<HTMLElement>(
    ":scope > .pointlens-ihg-room-value"
  )
  if (badge?.dataset.signature === signature) return
  if (!badge) {
    badge = document.createElement("div")
    badge.className = "pointlens-ihg-room-value"
    host.appendChild(badge)
  }
  badge.dataset.signature = signature
  badge.dataset.roomCode = room.code
  const title = document.createElement("span")
  title.className = "pointlens-room-value-text"
  title.textContent =
    room.points === undefined
      ? "Reward night unavailable"
      : value === undefined
        ? (settings.taxBasis === "pretax" ? room.cashPretax : room.cash) ===
          undefined
          ? "Cash rate unavailable"
          : "USD conversion unavailable"
        : `≈${value.toFixed(2)}¢/pt`
  badge.dataset.tier =
    value === undefined
      ? "none"
      : value >= settings.goodValueThreshold
        ? "good"
        : value <= settings.badValueThreshold
          ? "bad"
          : "mid"
  const context = document.createElement("span")
  context.className = "pointlens-room-value-context"
  const cash = settings.taxBasis === "pretax" ? room.cashPretax : room.cash
  const counterpart = pointsMode
    ? cash !== undefined
      ? `${money(cash / room.nights, room.currency)}`
      : ""
    : room.points
      ? points(room.points / room.nights)
      : ""
  context.textContent = counterpart ? `· ${counterpart}` : ""
  const info = document.createElement("span")
  info.textContent = "i"
  info.className = "pointlens-room-value-info"
  makeInfoAccessible(info)
  info.setAttribute(
    "aria-label",
    `PointLens cash and points comparison for ${room.name}`
  )
  const tip = document.createElement("span")
  tip.className = "pointlens-tooltip"
  const table = document.createElement("table")
  table.className = "pointlens-room-table"
  table.setAttribute(
    "aria-label",
    "Cash and points comparison for the full stay"
  )
  const header = table.createTHead().insertRow()
  for (const label of ["", "Cash", "Points"]) {
    const cell = document.createElement("th")
    cell.scope = "col"
    cell.textContent = label
    header.appendChild(cell)
  }
  const body = table.createTBody()
  const row = (label: string, cashText: string, pointsText: string) => {
    const tr = body.insertRow()
    const th = document.createElement("th")
    th.scope = "row"
    th.textContent = label
    tr.appendChild(th)
    tr.insertCell().textContent = cashText
    tr.insertCell().textContent = pointsText
    return tr
  }
  const format = (amount?: number) =>
    amount === undefined ? "—" : money(amount, room.currency)
  const awardFees =
    settings.taxBasis === "pretax" ? room.awardFeesPretax : room.awardFees
  row("Base", format(room.cashBase), room.points ? format(0) : "—")
  row(
    settings.taxBasis === "pretax" ? "Fees" : "Taxes & fees",
    format(
      cash !== undefined && room.cashBase !== undefined
        ? Math.max(0, cash - room.cashBase)
        : undefined
    ),
    room.points ? format(awardFees) : "—"
  )
  row("Total", format(cash), room.points ? format(awardFees) : "—")
  row(
    "Points",
    "—",
    room.points
      ? `${points(room.points)}${value === undefined ? "" : ` (≈${value.toFixed(2)}¢/pt)`}`
      : "—"
  ).className = "pointlens-room-table-divider"
  tip.appendChild(table)
  const details = document.createElement("div")
  details.className = "pointlens-room-notes"
  const line = (text: string) => {
    const item = document.createElement("div")
    item.textContent = text
    details.appendChild(item)
  }
  const terms = [
    `${room.nights}-night total`,
    ...(room.memberRate ? ["member"] : []),
    ...(room.refundable === false ? ["nonrefundable"] : [])
  ]
  line(terms.join(" · "))
  if (room.hotelFallback) {
    const alternative = pointsMode ? room.cashRoom : room.awardRoom
    line(
      `${pointsMode ? "Cash" : "Points"} alternative: ${alternative.trim()}${room.packageComparison ? " · package" : ""}`
    )
  } else if (room.packageComparison) line("Cash package")
  tip.appendChild(details)
  info.appendChild(tip)
  const pill = document.createElement("span")
  pill.className = "pointlens-room-value-pill"
  pill.append(title, context)
  badge.replaceChildren(info, pill)
  attachTooltip(info)
}

function rateCardValue(
  element: Element
): (IhgRoomValue & { rateCode: string }) | undefined {
  const tracking = element
    .querySelector('[data-slnm-ihg^="roomRate"]')
    ?.getAttribute("data-slnm-ihg")
  for (const room of snapshot?.rooms ?? []) {
    const rate = room.cashRates?.find(
      (r) => tracking === `roomRate${room.code}${r.rateCode}`
    )
    if (rate) return { ...room, ...rate }
  }
}

function render() {
  scheduled = false
  if (!snapshot || !matchesRoomStay(snapshot, location.href, true)) {
    snapshot =
      [...recentStays.values()]
        .reverse()
        .find(
          (entry) =>
            Date.now() - entry.capturedAt < 5 * 60_000 &&
            matchesRoomStay(entry.snapshot, location.href, true)
        )?.snapshot ?? null
  }
  if (!snapshot || !matchesRoomStay(snapshot, location.href, true)) {
    document
      .querySelectorAll(".pointlens-ihg-room-value")
      .forEach((e) => e.remove())
    return
  }
  for (const card of document.querySelectorAll<HTMLElement>(
    ".room-rate-card"
  )) {
    const title = card.querySelector<HTMLElement>('[id^="room-card-title-"]')
    const code = title?.id.replace("room-card-title-", "")
    const room = snapshot.rooms.find((r) => r.code === code)
    const host =
      card.querySelector<HTMLElement>(".roomInfo") ?? title?.parentElement
    if (room && host) renderValue(host, room)
    else
      card
        .querySelectorAll(".pointlens-ihg-room-value")
        .forEach((e) => e.remove())
  }
  for (const card of document.querySelectorAll<HTMLElement>(
    ".rate-card-wrapper"
  )) {
    const rate = rateCardValue(card)
    const host = card.querySelector<HTMLElement>(".rate-info-wrapper")
    if (rate && host) renderValue(host, rate)
    else
      card
        .querySelectorAll(".pointlens-ihg-room-value")
        .forEach((e) => e.remove())
  }
  // A room modal has a product title; the rate modal uses the room whose
  // native details button was clicked, never a price-only match.
  for (const dialog of document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"]'
  )) {
    const name = dialog
      .querySelector("#dialog-header-title")
      ?.textContent?.trim()
    const byName = snapshot.rooms.filter((r) => r.name.trim() === name)
    let room =
      byName.length === 1
        ? byName[0]
        : dialog.classList.contains("ihg-ui-rate-details-modal-v2")
          ? snapshot.rooms.find((r) => r.code === selectedRoom)
          : undefined
    if (
      room &&
      dialog.classList.contains("ihg-ui-rate-details-modal-v2") &&
      selectedCashRate
    ) {
      const rate = room.cashRates?.find((r) => r.rateCode === selectedCashRate)
      room = rate ? { ...room, ...rate } : undefined
    }
    const host = dialog.querySelector<HTMLElement>(".p-dialog-content")
    if (room && host) renderValue(host, room)
    else
      dialog
        .querySelectorAll(".pointlens-ihg-room-value")
        .forEach((e) => e.remove())
  }
  const hotelTitle = /\/hoteldetail(?:\/|$)/i.test(location.pathname)
    ? document.querySelector<HTMLElement>("h1")?.parentElement
    : null
  // No hotel-wide "best" badge above different room rates. On a standalone
  // property page, explicitly select the room whose comparison is displayed.
  if (!hotelTitle) {
    document.querySelector(".pointlens-ihg-room-overview")?.remove()
  } else if (snapshot.rooms.length) {
    let overview = document.querySelector<HTMLElement>(
      ".pointlens-ihg-room-overview"
    )
    if (!overview) {
      overview = document.createElement("div")
      overview.className = "pointlens-ihg-room-overview"
      hotelTitle.after(overview)
    }
    let select = overview.querySelector<HTMLSelectElement>("select")
    if (!select) {
      const label = document.createElement("label")
      label.textContent = "Compare room "
      select = document.createElement("select")
      select.setAttribute("aria-label", "Room for cash and points comparison")
      label.appendChild(select)
      overview.appendChild(label)
      select.addEventListener("change", schedule)
    }
    const optionsKey = JSON.stringify(
      snapshot.rooms.map((r) => [r.code, r.name])
    )
    if (select.dataset.options !== optionsKey) {
      const previous = select.value
      select.replaceChildren(
        ...snapshot.rooms.map((room) => new Option(room.name.trim(), room.code))
      )
      if (snapshot.rooms.some((r) => r.code === previous))
        select.value = previous
      select.dataset.options = optionsKey
    }
    let dates = overview.querySelector<HTMLElement>(".pointlens-room-dates")
    if (!dates) {
      dates = document.createElement("span")
      dates.className = "pointlens-room-dates"
      overview.appendChild(dates)
    }
    const dateText = `${snapshot.start} – ${snapshot.end}`
    if (dates.textContent !== dateText) dates.textContent = dateText
    const room = snapshot.rooms.find((r) => r.code === select.value)
    if (room) renderValue(overview, room)
  }
}

const schedule = () => {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(render)
}

export function acceptIhgRoomRates(payload: {
  url?: string
  bodyText?: string | null
  responseBodyText?: string | null
  responseStatus?: number
}) {
  if (
    !payload.url?.includes("fieldset=rateDetails") ||
    !payload.bodyText ||
    !payload.responseBodyText ||
    payload.responseStatus !== 200
  )
    return
  // Package widgets request a restricted subset of cash plans. Those cannot
  // replace the hotel's full room-only comparison.
  if (payload.url.includes("packagesAdditionalInfo")) return
  const parsed = parseRoomRates(payload.bodyText, payload.responseBodyText)
  if (!parsed) return
  const key = JSON.stringify([
    parsed.hotel,
    parsed.start,
    parsed.end,
    parsed.adults,
    parsed.children
  ])
  recentStays.delete(key)
  if (recentStays.size >= 10)
    recentStays.delete(recentStays.keys().next().value)
  recentStays.set(key, { snapshot: parsed, capturedAt: Date.now() })
  if (!matchesRoomStay(parsed, location.href, true)) return
  snapshot = parsed
  for (const room of snapshot.rooms) {
    if (fx.has(room.currency) || !/^[A-Z]{3}$/.test(room.currency)) continue
    fx.set(room.currency, undefined)
    void chrome.runtime
      .sendMessage({ type: "IHG_FETCH_FX", currency: room.currency })
      .then((result) => {
        if (result?.rate > 0) fx.set(room.currency, result.rate)
        schedule()
      })
      .catch(() => {})
  }
  schedule()
}

export function initIhgRoomView() {
  if (initialized) return
  initialized = true
  const style = document.createElement("style")
  style.textContent = `
    .pointlens-ihg-room-value {display:flex;align-items:center;align-self:flex-start;box-sizing:border-box;max-width:100%;gap:8px;margin:8px 0;color:#475569;font:14px/1.4 system-ui,sans-serif;text-align:left;}
    .pointlens-room-value-pill {display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap;min-width:0;padding:2px 7px;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;font-variant-numeric:tabular-nums;}
    .pointlens-room-value-text,.pointlens-room-value-context {font:inherit;color:inherit;}
    .pointlens-ihg-room-value[data-tier=good] .pointlens-room-value-pill {color:#047857;background:#ecfdf5;border-color:#a7f3d0;}
    .pointlens-ihg-room-value[data-tier=mid] .pointlens-room-value-pill {color:#b45309;background:#fffbeb;border-color:#fde68a;}
    .pointlens-ihg-room-value[data-tier=bad] .pointlens-room-value-pill {color:#be123c;background:#fff1f2;border-color:#fecdd3;}
    .pointlens-room-value-info {display:inline-flex;align-items:center;justify-content:center;flex:0 0 18px;width:18px;height:18px;border:1px solid #64748b;border-radius:50%;font:12px/1 system-ui,sans-serif;cursor:help;}
    #pointlens-value-details .pointlens-room-table {border-collapse:collapse;width:100%;font:13px/1.5 system-ui,sans-serif;table-layout:auto;}
    #pointlens-value-details .pointlens-room-table th,#pointlens-value-details .pointlens-room-table td {padding:3px 10px;text-align:left;vertical-align:top;font-weight:400;white-space:normal;}
    #pointlens-value-details .pointlens-room-table th:first-child {padding-left:0;color:#475569;}
    #pointlens-value-details .pointlens-room-table td:last-child {padding-right:0;}
    #pointlens-value-details .pointlens-room-table thead {border-bottom:1px solid #e2e8f0;}
    #pointlens-value-details .pointlens-room-table-divider {border-top:1px solid #e2e8f0;}
    #pointlens-value-details .pointlens-room-notes {max-width:340px;margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0;font:11px/1.5 system-ui,sans-serif;color:#64748b;overflow-wrap:anywhere;}
    .pointlens-ihg-room-overview {margin:12px auto;max-width:1170px;clear:both;width:100%;padding:0 8px;box-sizing:border-box;}
    .pointlens-ihg-room-overview label {font:13px/1.5 system-ui,sans-serif;}
    .pointlens-ihg-room-overview select {max-width:100%;font:inherit;padding:5px;border:1px solid #cbd5e1;border-radius:5px;background:white;color:#334155;}
    .pointlens-room-dates {display:block;font:12px/1.5 system-ui,sans-serif;color:#64748b;margin-top:5px;}
    .p-dialog-content > .pointlens-ihg-room-value {position:sticky;bottom:0;z-index:1;}
  `
  document.head.appendChild(style)
  document.addEventListener(
    "click",
    (event) => {
      const cashCard = (event.target as Element)?.closest?.(
        ".rate-card-wrapper"
      )
      if (cashCard) {
        const rate = rateCardValue(cashCard)
        selectedRoom = rate?.code
        selectedCashRate = rate?.rateCode
        return
      }
      const card = (event.target as Element)?.closest?.(".room-rate-card")
      const title = card?.querySelector('[id^="room-card-title-"]')
      if (title) {
        selectedRoom = title.id.replace("room-card-title-", "")
        selectedCashRate = undefined
      }
    },
    true
  )
  new MutationObserver((ms) => {
    if (hasHostMutation(ms)) schedule()
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "id",
      "aria-modal",
      "aria-pressed",
      "aria-selected",
      "aria-valuetext",
      "data-slnm-ihg"
    ]
  })
  window.addEventListener("popstate", schedule)
  window.addEventListener("pageshow", schedule)
  void chrome.storage.local.get(IHG_VALUE_SETTINGS_KEY).then((result) => {
    settings = normalizeIhgValueSettings(result[IHG_VALUE_SETTINGS_KEY])
    schedule()
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[IHG_VALUE_SETTINGS_KEY]) {
      settings = normalizeIhgValueSettings(
        changes[IHG_VALUE_SETTINGS_KEY].newValue
      )
      schedule()
    }
  })
  schedule()
}
