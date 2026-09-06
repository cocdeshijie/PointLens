import { makeInfoAccessible } from "./dom"
import { attachTooltip } from "./tooltip"

export type RoomOffer = {
  id: string
  room: string
  roomName: string
  name: string
  currency: string
  nights: number
  base?: number
  total?: number
  points?: number
  copay?: number
}

export const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined

export function compareRoom(
  offers: RoomOffer[],
  selected: RoomOffer,
  pretax: boolean,
  allowFallback = true
) {
  const cashValue = (o: RoomOffer) => (pretax ? o.base : o.total ?? o.base)
  const cash = offers
    .filter((o) => !o.points && positive(cashValue(o)))
    .sort((a, b) => cashValue(a)! - cashValue(b)!)
  const awards = offers
    .filter((o) => positive(o.points))
    .sort((a, b) => a.points! - b.points! || (a.copay ?? 0) - (b.copay ?? 0))
  const opposite = selected.points
    ? cash.filter((o) => o.currency === selected.currency)
    : awards.filter((o) => o.currency === selected.currency)
  const match =
    opposite.find((o) => o.room === selected.room) ??
    (allowFallback ? opposite[0] : undefined)
  if (!match) return
  const paid = selected.points ? match : selected
  const award = selected.points ? selected : match
  const amount = cashValue(paid)
  if (!amount || !award.points || amount <= (award.copay ?? 0)) return
  return { paid, award, amount, fallback: paid.room !== award.room }
}

export function renderRoomValue(
  host: HTMLElement,
  selected: RoomOffer | undefined,
  offers: RoomOffer[],
  options: {
    brand: string
    pretax: boolean
    nightly: boolean
    good: number
    bad: number
    toUsd: (amount: number, currency: string) => number | undefined
    allowFallback?: boolean
  }
) {
  let badge = host.querySelector<HTMLElement>(
    ":scope > .pointlens-room-comparison"
  )
  const pair =
    selected &&
    compareRoom(offers, selected, options.pretax, options.allowFallback)
  if (!pair) {
    badge?.remove()
    return
  }
  const usd = options.toUsd(
    pair.amount - (pair.award.copay ?? 0),
    pair.paid.currency
  )
  const cpp = usd === undefined ? undefined : (usd / pair.award.points!) * 100
  const divisor = options.nightly ? pair.paid.nights : 1
  const currencyFormat = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: pair.paid.currency
  })
  const money = (n: number | undefined) =>
    n === undefined ? "—" : currencyFormat.format(n / divisor)
  // Keep the displayed breakdown additive when a stay splits into fractional
  // cents per night. CPP above still uses the exact full-stay amounts.
  const scale = 10 ** currencyFormat.resolvedOptions().maximumFractionDigits
  const roundingFormat = new Intl.NumberFormat("en-US", {
    useGrouping: false,
    maximumFractionDigits:
      currencyFormat.resolvedOptions().maximumFractionDigits
  })
  const displayedUnits = (n: number) =>
    Math.round(Number(roundingFormat.format(n / divisor)) * scale)
  const points = new Intl.NumberFormat().format(pair.award.points! / divisor)
  const ratio = cpp === undefined ? "" : `${cpp.toFixed(2)}¢/pt`
  const companion = selected!.points ? money(pair.amount) : `${points} pts`
  const text = [ratio, companion].filter(Boolean).join(" · ")
  const tier =
    cpp === undefined
      ? ""
      : cpp >= options.good
        ? "good"
        : cpp <= options.bad
          ? "bad"
          : "mid"
  const note = [
    options.nightly ? "Per night" : `${pair.paid.nights}-night stay`,
    pair.fallback ? "Lowest available room" : "",
    options.pretax
      ? "CPP before tax"
      : pair.paid.total === undefined
        ? "Tax unavailable"
        : ""
  ]
    .filter(Boolean)
    .join(" · ")
  const rows = [
    ["Base", money(pair.paid.base)],
    [
      "Fees",
      money(
        pair.paid.total !== undefined && pair.paid.base !== undefined
          ? ((displayedUnits(pair.paid.total) -
              displayedUnits(pair.paid.base)) /
              scale) *
              divisor
          : undefined
      )
    ],
    ["Total", money(pair.paid.total)],
    ["Points", `${points} pts${ratio ? ` (${ratio})` : ""}`]
  ]
  if (pair.award.copay) rows.push(["Award cash", money(pair.award.copay)])
  const signature = JSON.stringify({ text, tier, rows, note })
  if (badge?.dataset.signature === signature) return
  if (!document.getElementById("pointlens-room-comparison-style")) {
    const style = document.createElement("style")
    style.id = "pointlens-room-comparison-style"
    style.textContent = `.pointlens-room-comparison{display:flex;align-items:center;gap:7px;margin:7px 0;font:13px/1.4 system-ui,sans-serif;clear:both}.pointlens-room-comparison button{all:unset;cursor:help;color:#64748b;font-size:19px;line-height:1}.pointlens-room-comparison .pointlens-room-pill{border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;white-space:normal}.pointlens-room-pill.good{background:#d1fae5;color:#047857;border-color:#a7f3d0}.pointlens-room-pill.bad{background:#ffe4e6;color:#be123c;border-color:#fecdd3}.pointlens-room-pill.mid{background:#fef3c7;color:#b45309;border-color:#fde68a}`
    document.head.append(style)
  }
  if (!badge) {
    badge = document.createElement("div")
    badge.className = `pointlens-room-comparison pointlens-${options.brand}-room-value`
    const icon = document.createElement("button")
    icon.type = "button"
    makeInfoAccessible(icon)
    icon.textContent = "ⓘ"
    icon.setAttribute("aria-label", "PointLens: cash, points and value details")
    const tooltip = document.createElement("span")
    tooltip.className = "pointlens-tooltip"
    icon.append(tooltip)
    const pill = document.createElement("span")
    pill.className = "pointlens-room-pill"
    badge.append(icon, pill)
    host.append(badge)
    attachTooltip(icon)
  }
  badge.dataset.signature = signature
  badge.dataset.roomCode = selected!.room
  const pill = badge.querySelector<HTMLElement>(".pointlens-room-pill")!
  pill.className = `pointlens-room-pill ${tier}`
  pill.textContent = text
  const tip = badge.querySelector<HTMLElement>(".pointlens-tooltip")!
  const grid = document.createElement("div")
  grid.className = "pointlens-tooltip-grid"
  for (const [label, value] of rows) {
    const l = document.createElement("span"),
      v = document.createElement("span")
    l.className = "pointlens-tooltip-cell pointlens-tooltip-cell--label"
    l.textContent = label
    v.className = "pointlens-tooltip-cell"
    v.textContent = value
    grid.append(l, v)
  }
  const footer = document.createElement("div")
  footer.style.cssText = "margin-top:6px;font-size:11px;color:#64748b"
  footer.textContent = note
  tip.replaceChildren(grid, footer)
}
