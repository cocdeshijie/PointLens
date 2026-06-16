import type { PlasmoCSConfig } from "plasmo"
import React from "react"
import { createRoot } from "react-dom/client"
import { CiCircleInfo } from "react-icons/ci"

import {
  DEFAULT_HYATT_VALUE_SETTINGS,
  HYATT_VALUE_SETTINGS_KEY,
  normalizeHyattValueSettings
} from "./settings"

export const config: PlasmoCSConfig = {
  matches: ["https://www.hyatt.com/*"],
  run_at: "document_start"
}

const MESSAGE_FLAG = "__AV_HYATT_RATES__"
// Rates also persisted to storage so they survive a full SSR navigation (date /
// points toggle reload the page; the MAIN hook re-extracts, but seeding from
// storage avoids a flash of "loading" on every nav).
const HYATT_STORAGE_KEY = "award-viewer:hyatt-rates"

const PLACEHOLDER_CLASS = "award-viewer-hyatt-price-placeholder"
const PLACEHOLDER_ICON_CLASS = "award-viewer-hyatt-cpp-icon"
const PLACEHOLDER_VALUE_CLASS = "award-viewer-hyatt-cpp-value"
const PLACEHOLDER_STYLE_ID = "award-viewer-hyatt-placeholder-style"
// CPP line appended INSIDE Hyatt's own Google map price pin (.MapMarker_map-marker).
const MAP_PIN_CPP_CLASS = "award-viewer-hyatt-pin-cpp"
const MAP_PIN_ANNOTATED_CLASS = "award-viewer-hyatt-pin-annotated"
// CPP chip appended into the marker's selection popover (1st-click preview card,
// which natively shows only name/rating/distance — no price).
const POPOVER_CPP_CLASS = "award-viewer-hyatt-popover-cpp"

type HyattRateInfo = {
  cpp?: number
  rate?: number
  rateAfterTax?: number
  points?: number
  currency?: string
  status?: string
}

const iconRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
let hyattRatesByHotel = new Map<string, HyattRateInfo>()
let hyattValueSettings = DEFAULT_HYATT_VALUE_SETTINGS

// Currency -> USD-per-unit. CPP thresholds are USD cents, so non-USD cash is
// converted to USD before computing CPP. Displayed cash stays local; only the
// ¢/pt ratio is normalized.
const usdRateByCurrency = new Map<string, number>([["USD", 1]])
const fxInflight = new Set<string>()

const ensureFxRate = (currency: string) => {
  const cur = currency.toUpperCase()
  if (cur === "USD" || usdRateByCurrency.has(cur) || fxInflight.has(cur)) {
    return
  }
  fxInflight.add(cur)
  try {
    chrome.runtime.sendMessage({ type: "HYATT_FETCH_FX", currency: cur }, (resp) => {
      fxInflight.delete(cur)
      const rate = (resp as { rate?: number } | undefined)?.rate
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
        usdRateByCurrency.set(cur, rate)
        recomputeCpp()
        scheduleUpdate()
      }
    })
  } catch {
    fxInflight.delete(cur)
  }
}

const toUsd = (amount: number | undefined, currency?: string) => {
  if (amount === undefined) return undefined
  if (!currency || currency.toUpperCase() === "USD") return amount
  const cur = currency.toUpperCase()
  const rate = usdRateByCurrency.get(cur)
  if (rate !== undefined) return amount * rate
  ensureFxRate(cur)
  return amount
}

const normalizeId = (id: string | null | undefined) => {
  const t = (id ?? "").trim().toLowerCase()
  return t || null
}

const computeCpp = (cashUsd?: number, points?: number) => {
  if (
    cashUsd === undefined ||
    points === undefined ||
    !Number.isFinite(cashUsd) ||
    !Number.isFinite(points) ||
    points <= 0
  ) {
    return undefined
  }
  return (cashUsd / points) * 100
}

const isBookable = (info: HyattRateInfo) =>
  info.status !== "SOLD_OUT" &&
  info.rate !== undefined &&
  info.rate > 0 &&
  info.points !== undefined &&
  info.points > 0

const recomputeCpp = () => {
  for (const info of hyattRatesByHotel.values()) {
    info.cpp = isBookable(info)
      ? computeCpp(toUsd(info.rate, info.currency), info.points)
      : undefined
  }
}

// Merge a freshly-posted rate map (from the MAIN hook) into our store.
const mergeRates = (rates: Record<string, unknown> | undefined) => {
  if (!rates || typeof rates !== "object") return
  for (const [spirit, raw] of Object.entries(rates)) {
    const id = normalizeId(spirit)
    if (!id || !raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const info: HyattRateInfo = {
      rate: typeof r.rate === "number" ? r.rate : undefined,
      rateAfterTax:
        typeof r.rateAfterTax === "number" ? r.rateAfterTax : undefined,
      points: typeof r.points === "number" ? r.points : undefined,
      currency: typeof r.currency === "string" ? r.currency : undefined,
      status: typeof r.status === "string" ? r.status : undefined
    }
    info.cpp = isBookable(info)
      ? computeCpp(toUsd(info.rate, info.currency), info.points)
      : undefined
    hyattRatesByHotel.set(id, info)
  }
}

const persistRates = () => {
  if (!chrome?.storage?.local) return
  const obj: Record<string, HyattRateInfo> = {}
  for (const [k, v] of hyattRatesByHotel) obj[k] = v
  try {
    chrome.storage.local.set({ [HYATT_STORAGE_KEY]: obj })
  } catch {
    /* storage may be unavailable mid-teardown */
  }
}

// ---- formatting helpers -----------------------------------------------------
const formatCpp = (cpp?: number) =>
  cpp === undefined || !Number.isFinite(cpp) ? "" : `${cpp.toFixed(2)}¢/pt`

const formatCash = (amount?: number, currency?: string) => {
  if (amount === undefined || !Number.isFinite(amount)) return ""
  if (!currency) return amount.toFixed(2)
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency
    }).format(amount)
  } catch {
    return amount.toFixed(2)
  }
}

const formatPoints = (points?: number) =>
  points === undefined || !Number.isFinite(points)
    ? ""
    : new Intl.NumberFormat().format(points)

// 12000 -> "12k", 7500 -> "7.5k" (up to 2 decimals, trailing zeros trimmed).
const formatPointsK = (points?: number) => {
  if (points === undefined || !Number.isFinite(points)) return ""
  if (points >= 1000) return parseFloat((points / 1000).toFixed(2)) + "k"
  return String(Math.round(points))
}

// Compact cash, rounded to whole units (matches Hyatt's own pin/card rounding):
// 332 -> "$332", 341.15 -> "$341". Falls back to a plain rounded number.
const formatCashCompact = (amount?: number, currency?: string) => {
  if (amount === undefined || !Number.isFinite(amount)) return ""
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0
    }).format(amount)
  } catch {
    return String(Math.round(amount))
  }
}

// Hyatt's "points view" (the WoH points filter). When ON, the page shows points
// as the primary price everywhere, so our badge surfaces the COMPLEMENTARY value
// (cash) instead — and vice-versa in cash view. Signal: the `rateFilter=woh` URL
// param (what Hyatt sets), with the header points switch as a fallback.
const isPointsView = () => {
  if (new URLSearchParams(location.search).get("rateFilter") === "woh") {
    return true
  }
  const sw = document.querySelector('button[role="switch"]')
  return sw?.getAttribute("aria-checked") === "true"
}

// The value we append next to CPP: cash in points-view, points in cash-view.
const secondaryText = (info: HyattRateInfo) =>
  isPointsView()
    ? formatCashCompact(info.rate, info.currency)
    : `${formatPointsK(info.points)} pts`

const valueTier = (cpp?: number) => {
  if (cpp === undefined || !Number.isFinite(cpp)) return ""
  if (cpp >= hyattValueSettings.goodValueThreshold) return "is-good"
  if (cpp <= hyattValueSettings.badValueThreshold) return "is-bad"
  return "is-mid"
}

// ---- shared singleton tooltip (escapes transformed/overflow ancestors) ------
let sharedTooltip: HTMLElement | null = null
let activeTipIcon: HTMLElement | null = null
const hideSharedTooltip = () => {
  if (sharedTooltip) sharedTooltip.style.opacity = "0"
  activeTipIcon = null
}
const positionSharedTooltip = (icon: HTMLElement) => {
  const tip = getSharedTooltip()
  const ir = icon.getBoundingClientRect()
  const tw = tip.offsetWidth || 260
  const th = tip.offsetHeight || 120
  const m = 8
  let left = ir.left + ir.width / 2 - tw / 2
  left = Math.max(m, Math.min(left, window.innerWidth - tw - m))
  let top = ir.top - th - m
  if (top < m) top = ir.bottom + m // flip below when no room above
  if (top + th > window.innerHeight - m) {
    top = Math.max(m, window.innerHeight - th - m)
  }
  tip.style.left = `${left}px`
  tip.style.top = `${top}px`
}
const getSharedTooltip = () => {
  if (sharedTooltip && sharedTooltip.isConnected) return sharedTooltip
  sharedTooltip = document.createElement("div")
  sharedTooltip.className = "award-viewer-tooltip award-viewer-shared-tooltip"
  document.body.appendChild(sharedTooltip)
  document.addEventListener(
    "mousemove",
    (e) => {
      if (!activeTipIcon) return
      const r = activeTipIcon.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) {
        hideSharedTooltip()
        return
      }
      const pad = 6
      const inside =
        e.clientX >= r.left - pad &&
        e.clientX <= r.right + pad &&
        e.clientY >= r.top - pad &&
        e.clientY <= r.bottom + pad
      if (!inside) hideSharedTooltip()
    },
    true
  )
  window.addEventListener("scroll", hideSharedTooltip, true)
  return sharedTooltip
}
const attachSmartTooltip = (iconWrapper: HTMLElement) => {
  if (iconWrapper.dataset.avSmartTip) return
  const source = iconWrapper.querySelector<HTMLElement>(".award-viewer-tooltip")
  if (!source) return
  iconWrapper.dataset.avSmartTip = "1"
  const show = () => {
    const tip = getSharedTooltip()
    if (activeTipIcon !== iconWrapper) {
      activeTipIcon = iconWrapper
      tip.replaceChildren(
        ...Array.from(source.childNodes).map((n) => n.cloneNode(true))
      )
    }
    positionSharedTooltip(iconWrapper)
    tip.style.opacity = "1"
  }
  iconWrapper.addEventListener("mouseenter", show)
  iconWrapper.addEventListener("focusin", show)
  iconWrapper.addEventListener("focusout", hideSharedTooltip)
}

const buildTooltipContent = (info: HyattRateInfo) => {
  const wrapper = document.createElement("div")
  wrapper.className = "award-viewer-tooltip-content"
  const grid = document.createElement("div")
  grid.className = "award-viewer-tooltip-grid"

  const addRow = (label: string, value: string) => {
    const row = document.createElement("div")
    row.className = "award-viewer-tooltip-row"
    const labelEl = document.createElement("div")
    labelEl.className =
      "award-viewer-tooltip-cell award-viewer-tooltip-cell--label"
    labelEl.textContent = label
    const valueEl = document.createElement("div")
    valueEl.className =
      "award-viewer-tooltip-cell award-viewer-tooltip-cell--value"
    valueEl.textContent = value
    row.appendChild(labelEl)
    row.appendChild(valueEl)
    grid.appendChild(row)
  }

  if (!isBookable(info)) {
    wrapper.textContent = "Reward night unavailable"
    return wrapper
  }

  const cashLabel = formatCash(info.rate, info.currency)
  const taxLabel = formatCash(info.rateAfterTax, info.currency)
  if (cashLabel) addRow("Cash/night", cashLabel)
  if (info.rateAfterTax !== undefined && taxLabel) addRow("After tax", taxLabel)

  if (cashLabel && info.points !== undefined) {
    const divider = document.createElement("div")
    divider.className = "award-viewer-tooltip-divider"
    grid.appendChild(divider)
  }

  if (info.points !== undefined) {
    const pointsLabel = formatPoints(info.points)
    const cppLabel = formatCpp(info.cpp)
    if (pointsLabel) {
      addRow(
        "Points/night",
        cppLabel ? `${pointsLabel} pts (${cppLabel})` : `${pointsLabel} pts`
      )
    }
  }

  if (!grid.childNodes.length) {
    wrapper.textContent = "Reward night unavailable"
    return wrapper
  }
  wrapper.appendChild(grid)
  return wrapper
}

// ---- list-card placeholder badge --------------------------------------------
const ensurePlaceholderContents = (placeholder: HTMLElement) => {
  let iconWrapper = placeholder.querySelector<HTMLElement>(
    `.${PLACEHOLDER_ICON_CLASS}`
  )
  if (!iconWrapper) {
    iconWrapper = document.createElement("span")
    iconWrapper.className = PLACEHOLDER_ICON_CLASS
    const iconTarget = document.createElement("span")
    iconTarget.className = "award-viewer-icon"
    iconWrapper.appendChild(iconTarget)
    const tooltip = document.createElement("span")
    tooltip.className = "award-viewer-tooltip"
    tooltip.textContent = "Awaiting Hyatt rates"
    iconWrapper.appendChild(tooltip)
    placeholder.appendChild(iconWrapper)
    const root = createRoot(iconTarget)
    root.render(React.createElement(CiCircleInfo, { "aria-hidden": "true" }))
    iconRoots.set(iconTarget, root)
    attachSmartTooltip(iconWrapper)
  }

  let valueEl = placeholder.querySelector<HTMLElement>(
    `.${PLACEHOLDER_VALUE_CLASS}`
  )
  if (!valueEl) {
    valueEl = document.createElement("span")
    valueEl.className = PLACEHOLDER_VALUE_CLASS
    placeholder.appendChild(valueEl)
  }
  return { iconWrapper, valueEl }
}

const setSkeleton = (placeholder: HTMLElement) => {
  const { valueEl } = ensurePlaceholderContents(placeholder)
  placeholder.classList.add("is-loading")
  valueEl.textContent = ""
  if (valueEl.querySelector(".award-viewer-skeleton")) return
  const skeleton = document.createElement("span")
  skeleton.className = "award-viewer-skeleton"
  skeleton.setAttribute("aria-hidden", "true")
  valueEl.appendChild(skeleton)
}

const updateValueClass = (valueEl: HTMLElement, cpp?: number) => {
  valueEl.classList.remove("is-good", "is-bad", "is-mid")
  const tier = valueTier(cpp)
  if (tier) valueEl.classList.add(tier)
}

const updatePlaceholderText = (placeholder: HTMLElement) => {
  const hotelId = placeholder.dataset.hotelId
  const info = hotelId ? hyattRatesByHotel.get(hotelId) : undefined
  const { iconWrapper, valueEl } = ensurePlaceholderContents(placeholder)
  const tooltip = iconWrapper.querySelector<HTMLElement>(".award-viewer-tooltip")

  if (!info) {
    // No data yet — hide the icon so its tooltip can't float, show skeleton.
    iconWrapper.style.display = "none"
    setSkeleton(placeholder)
    return
  }

  if (isBookable(info)) {
    placeholder.classList.remove("is-loading")
    iconWrapper.style.removeProperty("display")
    updateValueClass(valueEl, info.cpp)
    valueEl.textContent = `${formatCpp(info.cpp)} · ${secondaryText(info)}`
    if (tooltip) tooltip.replaceChildren(buildTooltipContent(info))
    return
  }

  // Known but sold out / no reward: show a muted note, drop the skeleton.
  placeholder.classList.remove("is-loading")
  iconWrapper.style.removeProperty("display")
  valueEl.classList.remove("is-good", "is-bad", "is-mid")
  valueEl.textContent = "Reward night unavailable"
  if (tooltip) tooltip.replaceChildren(buildTooltipContent(info))
}

// The card fee notice ("Includes fees before taxes"). Badge sits directly below.
const FEE_TEXT_RE = /includes fees|before tax|fees before|all-in/i
const cardFeeNotice = (card: HTMLElement) =>
  card.querySelector<HTMLElement>("[data-testid='all-in-pricing-label']") ??
  [...card.querySelectorAll<HTMLElement>("[class*='rate_with_text'] *")].find(
    (e) => e.offsetParent !== null && FEE_TEXT_RE.test(e.textContent || "")
  )

// The price block we anchor inside when there's no fee notice yet.
const cardRateBlock = (card: HTMLElement) =>
  card.querySelector<HTMLElement>("[class*='rate_with_text']")

const ensurePlaceholder = (card: HTMLElement) => {
  const fee = cardFeeNotice(card)
  const rateBlock = cardRateBlock(card)
  const anchor = fee ?? rateBlock
  if (!anchor) return

  let placeholder = card.querySelector<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
  if (!placeholder) {
    placeholder = document.createElement("div")
    placeholder.className = PLACEHOLDER_CLASS
    const hotelId = normalizeId(card.getAttribute("data-spirit-code"))
    if (hotelId) placeholder.dataset.hotelId = hotelId
    ensurePlaceholderContents(placeholder)
    updatePlaceholderText(placeholder)
  }

  // Keep the badge directly BELOW the fee notice (idempotent reposition). The
  // fee can render after first insertion, so re-anchor each pass.
  if (fee) {
    if (fee.nextElementSibling !== placeholder) fee.after(placeholder)
  } else if (rateBlock && placeholder.parentElement !== rateBlock) {
    rateBlock.appendChild(placeholder)
  }
}

const refreshPlaceholders = () => {
  ensureStyles()
  document
    .querySelectorAll<HTMLElement>("div[data-spirit-code]")
    .forEach((card) => ensurePlaceholder(card))
}

const updateExistingPlaceholders = () => {
  document
    .querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
    .forEach((placeholder) => updatePlaceholderText(placeholder))
}

// ---- map pins ---------------------------------------------------------------
// Hyatt draws Google Advanced Markers `<gmp-advanced-marker
// data-locator="map-pin-<spirit>">`; the price pill inside is
// `.MapMarker_map-marker`. Append a CPP line inside the pill (strip `map-pin-`
// for the spiritCode — direct id, no index matching).
const updateMapPins = () => {
  const markers = document.querySelectorAll<HTMLElement>(
    "gmp-advanced-marker[data-locator^='map-pin-']"
  )
  markers.forEach((marker) => {
    const locator = marker.getAttribute("data-locator") || ""
    const spirit = normalizeId(locator.replace(/^map-pin-/, ""))
    const pill = marker.querySelector<HTMLElement>(
      ".MapMarker_map-marker, [data-testid='map-marker']"
    )
    if (!pill) return
    const info = spirit ? hyattRatesByHotel.get(spirit) : undefined
    let line = pill.querySelector<HTMLElement>(`:scope > .${MAP_PIN_CPP_CLASS}`)

    if (!info || !isBookable(info)) {
      line?.remove()
      pill.classList.remove(MAP_PIN_ANNOTATED_CLASS)
      return
    }

    // Lead with the complementary value to the native pin: cash when the pin
    // shows points (points-view), points when the pin shows cash (cash-view).
    const leadText = isPointsView()
      ? formatCashCompact(info.rate, info.currency)
      : formatPointsK(info.points)
    const cppText = info.cpp !== undefined ? `${info.cpp.toFixed(2)}¢` : ""
    const text = cppText ? `${leadText} · ${cppText}` : leadText
    const tier = valueTier(info.cpp)

    if (!line) {
      line = document.createElement("div")
      pill.appendChild(line)
    }
    pill.classList.add(MAP_PIN_ANNOTATED_CLASS)
    const sig = `${text}|${tier}`
    if (line.dataset.av !== sig) {
      line.dataset.av = sig
      line.className = `${MAP_PIN_CPP_CLASS} ${tier}`.trim()
      line.textContent = text
    }
  })
}

// The 1st-click selection popover (`.MapMarker_map-marker__popover--visible`)
// shows only name/rating/distance. Append a CPP chip so the value is visible
// there too. The popover lives inside its `gmp-advanced-marker`, so the
// spiritCode comes from the marker's data-locator (no link/data-attr on it).
const updatePopovers = () => {
  const markers = document.querySelectorAll<HTMLElement>(
    "gmp-advanced-marker[data-locator^='map-pin-']"
  )
  markers.forEach((marker) => {
    const pop = marker.querySelector<HTMLElement>(
      "[class*='map-marker__popover--visible']"
    )
    const container =
      pop?.querySelector<HTMLElement>("[class*='map-marker-popover']") ?? pop
    if (!pop || !container) return
    const spirit = normalizeId(
      (marker.getAttribute("data-locator") || "").replace(/^map-pin-/, "")
    )
    const info = spirit ? hyattRatesByHotel.get(spirit) : undefined
    let chip = container.querySelector<HTMLElement>(
      `:scope > .${POPOVER_CPP_CLASS}`
    )
    if (!info || !isBookable(info)) {
      chip?.remove()
      return
    }
    const tier = valueTier(info.cpp)
    const text = `${formatCpp(info.cpp)} · ${secondaryText(info)}`
    if (!chip) {
      chip = document.createElement("div")
      container.appendChild(chip)
    }
    const sig = `${text}|${tier}`
    if (chip.dataset.av !== sig) {
      chip.dataset.av = sig
      chip.className = `${POPOVER_CPP_CLASS} ${tier}`.trim()
      chip.textContent = text
    }
  })
}

// ---- scheduling -------------------------------------------------------------
let updateScheduled = false
const scheduleUpdate = () => {
  if (updateScheduled) return
  updateScheduled = true
  requestAnimationFrame(() => {
    updateScheduled = false
    refreshPlaceholders()
    updateExistingPlaceholders()
    updateMapPins()
    updatePopovers()
  })
}

const refreshValueSettings = async () => {
  if (!chrome?.storage?.local) return
  const result = await chrome.storage.local.get(HYATT_VALUE_SETTINGS_KEY)
  hyattValueSettings = normalizeHyattValueSettings(
    result?.[HYATT_VALUE_SETTINGS_KEY]
  )
  scheduleUpdate()
}

const seedRatesFromStorage = async () => {
  if (!chrome?.storage?.local) return
  const result = await chrome.storage.local.get(HYATT_STORAGE_KEY)
  mergeRates(result?.[HYATT_STORAGE_KEY] as Record<string, unknown> | undefined)
  scheduleUpdate()
}

// ---- styles -----------------------------------------------------------------
const ensureStyles = () => {
  if (document.getElementById(PLACEHOLDER_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = PLACEHOLDER_STYLE_ID
  style.textContent = `
    .${PLACEHOLDER_CLASS} {
      display: inline-flex;
      align-items: center;
      min-height: 16px;
      margin-top: 6px;
      gap: 6px;
      font-size: 13px;
      overflow: visible;
      position: relative;
      z-index: 3;
    }
    .${PLACEHOLDER_ICON_CLASS} {
      position: relative;
      display: inline-flex;
      align-items: center;
      color: #6b7280;
      cursor: default;
      font-size: 18px;
      line-height: 1;
      z-index: 2;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-icon {
      display: inline-flex;
      align-items: center;
    }
    .award-viewer-tooltip {
      position: fixed;
      opacity: 0;
      pointer-events: none;
      background: #f5f5f5;
      color: #111827;
      border: 1px solid #cbd5e1;
      font-size: 11px;
      padding: 6px;
      border-radius: 4px;
      white-space: normal;
      transition: opacity 0.12s ease;
      z-index: 2147483647;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.18);
      min-width: 220px;
      max-width: 280px;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip { display: none; }
    .award-viewer-tooltip-grid {
      display: grid;
      grid-template-columns: max-content minmax(120px, auto);
      column-gap: 12px;
      row-gap: 2px;
      align-items: center;
      justify-content: start;
    }
    .award-viewer-tooltip-row { display: contents; }
    .award-viewer-tooltip-cell { white-space: normal; }
    .award-viewer-tooltip-cell--label { color: #475569; }
    .award-viewer-tooltip-cell--value { color: #0f172a; text-align: left; }
    .award-viewer-tooltip-divider {
      grid-column: 1 / -1;
      border-top: 1px solid #e2e8f0;
      height: 1px;
    }
    .${PLACEHOLDER_VALUE_CLASS} {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      border: 1px solid #cbd5e1;
      background: #f5f5f5;
      border-radius: 4px;
      white-space: nowrap;
      max-width: 100%;
    }
    .${PLACEHOLDER_VALUE_CLASS}.is-good { background: #d1fae5; border-color: #a7f3d0; color: #047857; }
    .${PLACEHOLDER_VALUE_CLASS}.is-bad { background: #ffe4e6; border-color: #fecdd3; color: #be123c; }
    .${PLACEHOLDER_VALUE_CLASS}.is-mid { background: #fef3c7; border-color: #fde68a; color: #b45309; }
    .${PLACEHOLDER_CLASS}.is-loading .award-viewer-skeleton {
      display: inline-block;
      width: 56px;
      height: 12px;
      border-radius: 6px;
      background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 37%, #e5e7eb 63%);
      background-size: 400% 100%;
      animation: award-viewer-skeleton 1.4s ease infinite;
    }
    @keyframes award-viewer-skeleton {
      0% { background-position: 100% 50%; }
      100% { background-position: 0 50%; }
    }
    /* CPP line appended inside Hyatt's own Google map price pin. The pill is a
       flex ROW (price only); we add our annotated class to it and flip it to a
       column so the CPP line stacks UNDER the price inside the same blue pill
       (the pill's real class is hashed, so we key off our own class). */
    .${MAP_PIN_ANNOTATED_CLASS} {
      flex-direction: column !important;
      align-items: center !important;
      height: auto !important;
    }
    .${MAP_PIN_CPP_CLASS} {
      display: block;
      margin-top: 1px;
      font-size: 10px;
      font-weight: 700;
      line-height: 11px;
      text-align: center;
      white-space: nowrap;
      color: #ffffff;
    }
    /* Bright variants — the pill background is Hyatt blue, so dark tints read
       poorly; use saturated colors that pop on blue (Marriott-style). */
    .${MAP_PIN_CPP_CLASS}.is-good { color: #6ee7b7; }
    .${MAP_PIN_CPP_CLASS}.is-mid { color: #fcd34d; }
    .${MAP_PIN_CPP_CLASS}.is-bad { color: #fca5a5; }
    /* CPP chip inside the 1st-click selection popover (a white preview card). */
    .${POPOVER_CPP_CLASS} {
      display: inline-flex;
      align-items: center;
      margin-top: 6px;
      padding: 2px 8px;
      border-radius: 6px;
      border: 1px solid #cbd5e1;
      background: #f5f5f5;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.4;
      white-space: nowrap;
    }
    .${POPOVER_CPP_CLASS}.is-good { background: #d1fae5; border-color: #a7f3d0; color: #047857; }
    .${POPOVER_CPP_CLASS}.is-bad { background: #ffe4e6; border-color: #fecdd3; color: #be123c; }
    .${POPOVER_CPP_CLASS}.is-mid { background: #fef3c7; border-color: #fde68a; color: #b45309; }
  `
  document.head?.appendChild(style)
}

// ---- bootstrap --------------------------------------------------------------
const start = () => {
  if (!document.body) return
  void seedRatesFromStorage()
  void refreshValueSettings()
  refreshPlaceholders()
  const observer = new MutationObserver(scheduleUpdate)
  observer.observe(document.body, { childList: true, subtree: true })

  chrome?.storage?.onChanged?.addListener((_changes, area) => {
    if (area !== "local") return
    void refreshValueSettings()
  })
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true })
} else {
  start()
}

// Rates pushed from the MAIN-world hook (window.postMessage same-origin).
window.addEventListener("message", (event) => {
  if (event.source !== window) return
  const data = event.data as Record<string, unknown> | undefined
  if (data?.[MESSAGE_FLAG] !== true) return
  mergeRates(data.rates as Record<string, unknown> | undefined)
  persistRates()
  scheduleUpdate()
})
