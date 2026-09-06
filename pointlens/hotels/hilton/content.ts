import type { PlasmoCSConfig } from "plasmo"
import React from "react"
import { createRoot } from "react-dom/client"
import { CiCircleInfo } from "react-icons/ci"

import { hasHostMutation, makeInfoAccessible } from "../../shared/dom"
import { attachTooltip } from "../../shared/tooltip"
import {
  DEFAULT_HILTON_VALUE_SETTINGS,
  HILTON_VALUE_SETTINGS_KEY,
  normalizeHiltonValueSettings
} from "./settings"

export const config: PlasmoCSConfig = {
  matches: ["https://www.hilton.com/*"],
  run_at: "document_start"
}

const PLACEHOLDER_CLASS = "pointlens-hilton-price-placeholder"
const PLACEHOLDER_ICON_CLASS = "pointlens-hilton-cpp-icon"
const PLACEHOLDER_VALUE_CLASS = "pointlens-hilton-cpp-value"
const DIALOG_CPP_CLASS = "pointlens-hilton-dialog-cpp"
const PLACEHOLDER_STYLE_ID = "pointlens-hilton-placeholder-style"
const HILTON_STORAGE_KEY = "hilton-last-capture"

type HiltonRateInfo = {
  cpp?: number
  cash?: number
  points?: number
  rateAmount?: number
  amountAfterTax?: number
  currency?: string
  ratePlanName?: string
  rewardStatus?: "available" | "unavailable"
  stayNights?: number
}

const iconRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
let hiltonRatesByHotel = new Map<string, HiltonRateInfo>()
// Comprehensive rates shared by the map overlay (hotelSummaryOptions), used as a
// fallback when Hilton's own shopMultiPropAvail capture is missing a hotel.
let overlayRatesByHotel = new Map<string, HiltonRateInfo>()
let hiltonValueSettings = DEFAULT_HILTON_VALUE_SETTINGS

const getRateInfo = (hotelId: string): HiltonRateInfo | undefined =>
  hiltonRatesByHotel.get(hotelId) ?? overlayRatesByHotel.get(hotelId)

function inject(src: string) {
  const script = document.createElement("script")
  script.src = src
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()
}

// Inject page scripts
inject(chrome.runtime.getURL("hotels/hilton/injected/hilton-fetch-hook.js"))
inject(chrome.runtime.getURL("hotels/hilton/injected/hilton-map-overlay.js"))

const normalizeHotelId = (id: string | null | undefined) => {
  if (!id) {
    return null
  }
  const trimmed = id.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.toUpperCase()
}

const getHotelIdFromCard = (card: HTMLElement) => {
  const testId = card.getAttribute("data-testid")
  if (testId?.startsWith("hotel-card-")) {
    return testId.replace("hotel-card-", "")
  }
  return null
}

const formatCpp = (cpp?: number) => {
  if (cpp === undefined || !Number.isFinite(cpp)) {
    return ""
  }
  return `${cpp.toFixed(2)}¢/pt`
}

const formatCash = (amount?: number, currency?: string) => {
  if (amount === undefined || !Number.isFinite(amount)) {
    return ""
  }
  if (!currency) {
    return amount.toFixed(2)
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency
    }).format(amount)
  } catch {
    return amount.toFixed(2)
  }
}

const formatPoints = (points?: number) => {
  if (points === undefined || !Number.isFinite(points)) {
    return ""
  }
  return new Intl.NumberFormat().format(points)
}

const formatUsdAmount = (amount?: number) => {
  if (amount === undefined || !Number.isFinite(amount)) {
    return ""
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount)
}

// Compact whole-dollar USD for the inline list value (e.g. "$246"). Hilton
// fetches all amounts in USD, so the fixed currency is safe.
const formatUsdRounded = (amount?: number) => {
  if (amount === undefined || !Number.isFinite(amount)) {
    return ""
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(amount)
}

const isStandardReward = (ratePlanName?: string) => {
  if (!ratePlanName) {
    return false
  }
  return ratePlanName.toLowerCase().includes("standard room reward")
}

const isPremiumReward = (ratePlanName?: string) => {
  if (!ratePlanName) {
    return false
  }
  return ratePlanName.toLowerCase().includes("premium room reward")
}

const extractNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  return undefined
}

const computeStayNights = (arrivalDate?: string, departureDate?: string) => {
  if (!arrivalDate || !departureDate) {
    return undefined
  }

  const arrivalTime = Date.parse(arrivalDate)
  const departureTime = Date.parse(departureDate)

  if (!Number.isFinite(arrivalTime) || !Number.isFinite(departureTime)) {
    return undefined
  }

  const diffMs = departureTime - arrivalTime
  const nights = Math.round(diffMs / (1000 * 60 * 60 * 24))

  return nights > 0 ? nights : undefined
}

const buildRatesFromStorage = (raw: unknown) => {
  if (!raw) {
    return new Map<string, HiltonRateInfo>()
  }

  const parsed = raw as
    | {
        shopMultiPropAvail?: unknown[]
        arrivalDate?: unknown
        departureDate?: unknown
      }
    | unknown[]
    | Record<string, unknown>

  const payload =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as {
          shopMultiPropAvail?: unknown[]
          arrivalDate?: unknown
          departureDate?: unknown
        })
      : undefined
  const stayNights = computeStayNights(
    typeof payload?.arrivalDate === "string" ? payload.arrivalDate : undefined,
    typeof payload?.departureDate === "string"
      ? payload.departureDate
      : undefined
  )

  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(payload?.shopMultiPropAvail)
      ? payload.shopMultiPropAvail
      : parsed && typeof parsed === "object" && "ctyhocn" in parsed
        ? [parsed]
        : []

  const map = new Map<string, HiltonRateInfo>()

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue
    }

    const record = item as Record<string, unknown>
    const hotelId = normalizeHotelId(record.ctyhocn as string | undefined)
    if (!hotelId) {
      continue
    }

    const summary = record.summary as Record<string, unknown> | undefined
    const lowest = summary?.lowest as Record<string, unknown> | undefined
    const hhonors = summary?.hhonors as Record<string, unknown> | undefined
    const rewardStatus =
      hhonors === null || hhonors === undefined ? "unavailable" : "available"

    const amountAfterTax = extractNumber(lowest?.amountAfterTax)
    const normalizedAmountAfterTax =
      amountAfterTax !== undefined && stayNights && stayNights > 1
        ? amountAfterTax / stayNights
        : amountAfterTax
    const rateAmount = extractNumber(lowest?.rateAmount)
    // Cash basis for CPP + the badge total, per the user's setting (default
    // after-tax). `rateAmount` is the pre-tax room rate; `normalizedAmountAfterTax`
    // is the taxes-included per-night total.
    const cash =
      hiltonValueSettings.taxBasis === "pretax"
        ? rateAmount ?? normalizedAmountAfterTax
        : normalizedAmountAfterTax ?? rateAmount
    const points = extractNumber(hhonors?.dailyRmPointsRate)
    const currency = record.currencyCode as string | undefined
    const ratePlanName =
      (hhonors?.ratePlan as Record<string, unknown> | undefined)
        ?.ratePlanName ??
      (lowest?.ratePlan as Record<string, unknown> | undefined)?.ratePlanName

    if (!cash || !points) {
      map.set(hotelId, {
        cash,
        points,
        rateAmount,
        amountAfterTax: normalizedAmountAfterTax,
        currency,
        ratePlanName: ratePlanName as string | undefined,
        rewardStatus,
        stayNights
      })
      continue
    }

    const cpp = (cash / points) * 100
    map.set(hotelId, {
      cpp,
      cash,
      points,
      rateAmount,
      amountAfterTax: normalizedAmountAfterTax,
      currency,
      ratePlanName: ratePlanName as string | undefined,
      rewardStatus,
      stayNights
    })
  }

  return map
}

const refreshRatesFromStorage = async () => {
  if (!chrome?.storage?.local) {
    return
  }

  const stored = await chrome.storage.local.get([HILTON_STORAGE_KEY])
  const payload = stored[HILTON_STORAGE_KEY] as
    | {
        shopMultiPropAvail?: unknown[]
        arrivalDate?: unknown
        departureDate?: unknown
      }
    | undefined

  hiltonRatesByHotel = buildRatesFromStorage(payload)
  updateExistingPlaceholders()
  refreshDialogPlaceholder()
  sendAuthoritativeRates()
}

// Push Hilton's own shopMultiPropAvail-derived rates to the map overlay so its
// badges show the same after-tax total + CPP as the list cards (hotelSummaryOptions,
// the overlay's own source, only has the pre-tax lead rate).
const sendAuthoritativeRates = () => {
  const rates: Array<{
    id: string
    cpp?: number
    cash?: number
    points?: number
    rewardStatus?: "available" | "unavailable"
  }> = []
  for (const [id, info] of hiltonRatesByHotel) {
    rates.push({
      id,
      cpp: info.cpp,
      cash: info.cash ?? info.amountAfterTax,
      points: info.points,
      rewardStatus: info.rewardStatus
    })
  }
  window.postMessage({ __AV_HILTON_AUTH_RATES__: true, rates }, "*")
}

const sendMapSettings = () => {
  window.postMessage(
    { __AV_HILTON_MAP_SETTINGS__: true, settings: hiltonValueSettings },
    "*"
  )
}

const refreshValueSettings = async () => {
  if (!chrome?.storage?.local) {
    hiltonValueSettings = DEFAULT_HILTON_VALUE_SETTINGS
    updateExistingPlaceholders()
    sendMapSettings()
    return
  }

  const stored = await chrome.storage.local.get([HILTON_VALUE_SETTINGS_KEY])
  hiltonValueSettings = normalizeHiltonValueSettings(
    stored[HILTON_VALUE_SETTINGS_KEY] as
      | Partial<typeof hiltonValueSettings>
      | undefined
  )
  // Rebuild rates so CPP + the badge total reflect the (possibly changed) tax
  // basis; this also re-pushes authoritative rates to the map overlay.
  await refreshRatesFromStorage()
  sendMapSettings()
}

const updateValueClass = (valueEl: HTMLElement, cpp?: number) => {
  valueEl.classList.remove("is-good", "is-bad", "is-mid")

  if (cpp === undefined || !Number.isFinite(cpp)) {
    return
  }

  if (cpp >= hiltonValueSettings.goodValueThreshold) {
    valueEl.classList.add("is-good")
    return
  }

  if (cpp <= hiltonValueSettings.badValueThreshold) {
    valueEl.classList.add("is-bad")
    return
  }

  valueEl.classList.add("is-mid")
}

const setTooltipText = (tooltip: HTMLElement, text: string) => {
  tooltip.textContent = text
}

const buildTooltipCell = (label: string, value: string) => {
  const row = document.createElement("div")
  row.className = "pointlens-tooltip-row"

  const labelCell = document.createElement("div")
  labelCell.className = "pointlens-tooltip-cell pointlens-tooltip-cell--label"
  labelCell.textContent = label

  const valueCell = document.createElement("div")
  valueCell.className = "pointlens-tooltip-cell pointlens-tooltip-cell--value"
  valueCell.textContent = value

  row.appendChild(labelCell)
  row.appendChild(valueCell)
  return row
}

const buildTooltipContent = (info: HiltonRateInfo, showCpp: boolean) => {
  const wrapper = document.createElement("div")
  wrapper.className = "pointlens-tooltip-content"

  const grid = document.createElement("div")
  grid.className = "pointlens-tooltip-grid"

  const headerRow = document.createElement("div")
  headerRow.className = "pointlens-tooltip-row"
  const headerLabel = document.createElement("div")
  headerLabel.className = "pointlens-tooltip-cell pointlens-tooltip-cell--label"
  headerLabel.textContent = "Lowest cash"
  const headerValue = document.createElement("div")
  headerValue.className = "pointlens-tooltip-cell pointlens-tooltip-cell--value"
  headerValue.textContent =
    info.stayNights !== undefined && info.stayNights > 1
      ? "Price per night"
      : "Price"
  headerRow.appendChild(headerLabel)
  headerRow.appendChild(headerValue)
  grid.appendChild(headerRow)

  const lowestCash = info.amountAfterTax ?? info.rateAmount ?? info.cash
  const priceLabel = formatUsdAmount(info.rateAmount ?? info.cash)
  const totalLabel = formatUsdAmount(info.amountAfterTax ?? info.cash)
  const feeValue =
    info.rateAmount !== undefined &&
    info.amountAfterTax !== undefined &&
    Number.isFinite(info.rateAmount) &&
    Number.isFinite(info.amountAfterTax)
      ? Math.max(info.amountAfterTax - info.rateAmount, 0)
      : undefined
  const feeLabel = formatUsdAmount(feeValue)

  if (priceLabel) {
    grid.appendChild(buildTooltipCell("Base", priceLabel))
  }

  if (feeValue !== undefined) {
    grid.appendChild(buildTooltipCell("Fees", feeLabel))
  }

  if (totalLabel) {
    grid.appendChild(buildTooltipCell("Total", totalLabel))
  }

  const divider = document.createElement("div")
  divider.className = "pointlens-tooltip-divider"
  grid.appendChild(divider)

  const pointsLabel = formatPoints(info.points)
  const premiumCpp =
    !showCpp &&
    lowestCash !== undefined &&
    Number.isFinite(lowestCash) &&
    info.points
      ? (lowestCash / info.points) * 100
      : undefined
  const cppLabel = showCpp ? formatCpp(info.cpp) : formatCpp(premiumCpp)
  if (pointsLabel) {
    const pointLabelText = isPremiumReward(info.ratePlanName)
      ? "Premium Room Reward"
      : "Standard Room Award"
    grid.appendChild(
      buildTooltipCell(
        pointLabelText,
        cppLabel ? `${pointsLabel} (${cppLabel})` : `${pointsLabel} pts`
      )
    )
  }

  wrapper.appendChild(grid)
  return wrapper
}

function ensurePlaceholderStyles() {
  if (document.getElementById(PLACEHOLDER_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = PLACEHOLDER_STYLE_ID
  style.textContent = `
    .${PLACEHOLDER_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      min-height: 16px;
      min-width: 64px;
      margin-bottom: 0.5rem;
      margin-left: 8px;
      gap: 6px;
      font-size: 14px;
      text-align: right;
      width: 100%;
    }
    .${PLACEHOLDER_ICON_CLASS} {
      position: relative;
      display: inline-flex;
      align-items: center;
      color: #6b7280;
      cursor: default;
      font-size: 22px;
      line-height: 1;
    }
    .${PLACEHOLDER_ICON_CLASS} .pointlens-icon {
      display: inline-flex;
      align-items: center;
    }
    .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip {
      position: absolute;
      right: 0;
      bottom: 100%;
      transform: translateY(-4px);
      opacity: 0;
      pointer-events: none;
      background: #f5f5f5;
      color: #111827;
      border: 1px solid #cbd5e1;
      font-size: 11px;
      padding: 6px;
      border-radius: 4px;
      white-space: normal;
      transition: opacity 0.15s ease, transform 0.15s ease;
      z-index: 9999;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12);
      min-width: 240px;
      max-width: 280px;
    }
    .${PLACEHOLDER_ICON_CLASS}:hover .pointlens-tooltip {
      opacity: 1;
      transform: translateY(-8px);
    }
    .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-grid {
      display: grid;
      grid-template-columns: max-content minmax(160px, auto);
      column-gap: 12px;
      row-gap: 2px;
      align-items: center;
      justify-content: start;
    }
    .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-row {
      display: contents;
    }
    .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-cell {
      white-space: normal;
    }
    .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-cell--label {
      color: #475569;
    }
    .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-cell--value {
      font-weight: 400;
      color: #0f172a;
      text-align: left;
    }
    .${PLACEHOLDER_ICON_CLASS} .pointlens-tooltip-divider {
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
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .${PLACEHOLDER_VALUE_CLASS}.is-good {
      background: #d1fae5;
      border-color: #a7f3d0;
      color: #047857;
    }
    .${PLACEHOLDER_VALUE_CLASS}.is-bad {
      background: #ffe4e6;
      border-color: #fecdd3;
      color: #be123c;
    }
    .${PLACEHOLDER_VALUE_CLASS}.is-mid {
      background: #fef3c7;
      border-color: #fde68a;
      color: #b45309;
    }
    .${PLACEHOLDER_CLASS}.is-loading .pointlens-skeleton {
      display: inline-block;
      width: 56px;
      height: 12px;
      border-radius: 6px;
      background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 37%, #e5e7eb 63%);
      background-size: 400% 100%;
      animation: pointlens-skeleton 1.4s ease infinite;
    }
    @keyframes pointlens-skeleton {
      0% { background-position: 100% 50%; }
      100% { background-position: 0 50%; }
    }
    .${DIALOG_CPP_CLASS} {
      position: fixed;
      z-index: 2147483646;
      width: auto;
      min-width: 0;
      margin: 0;
      padding: 6px 10px;
      gap: 6px;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.18);
      pointer-events: auto;
    }
  `
  document.head?.appendChild(style)
}

const ensurePlaceholderContents = (placeholder: HTMLElement) => {
  let iconWrapper = placeholder.querySelector<HTMLElement>(
    `.${PLACEHOLDER_ICON_CLASS}`
  )
  if (!iconWrapper) {
    iconWrapper = document.createElement("span")
    iconWrapper.className = PLACEHOLDER_ICON_CLASS
    makeInfoAccessible(iconWrapper)

    const iconTarget = document.createElement("span")
    iconTarget.className = "pointlens-icon"
    iconWrapper.appendChild(iconTarget)

    const tooltip = document.createElement("span")
    tooltip.className = "pointlens-tooltip"
    tooltip.textContent = "Awaiting Hilton response"
    iconWrapper.appendChild(tooltip)
    attachTooltip(iconWrapper)

    placeholder.appendChild(iconWrapper)
    const root = createRoot(iconTarget)
    root.render(React.createElement(CiCircleInfo, { "aria-hidden": "true" }))
    iconRoots.set(iconTarget, root)
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
  const existing = valueEl.querySelector(".pointlens-skeleton")
  if (existing) {
    return
  }
  const skeleton = document.createElement("span")
  skeleton.className = "pointlens-skeleton"
  skeleton.setAttribute("aria-hidden", "true")
  valueEl.appendChild(skeleton)
}

const updatePlaceholderText = (placeholder: HTMLElement) => {
  let hotelId = placeholder.dataset.hotelId
  if (!hotelId) {
    const card = placeholder.closest<HTMLElement>(
      '[data-testid^="hotel-card-"]'
    )
    if (card) {
      hotelId = getHotelIdFromCard(card) ?? undefined
      if (hotelId) {
        placeholder.dataset.hotelId = hotelId
      }
    }
  }

  if (!hotelId) {
    setSkeleton(placeholder)
    return
  }

  const normalizedHotelId = normalizeHotelId(hotelId) ?? hotelId
  if (normalizedHotelId !== hotelId) {
    hotelId = normalizedHotelId
    placeholder.dataset.hotelId = normalizedHotelId
  }

  const info = getRateInfo(hotelId)
  const { iconWrapper, valueEl } = ensurePlaceholderContents(placeholder)
  const tooltip = iconWrapper.querySelector<HTMLElement>(".pointlens-tooltip")
  const showCpp = isStandardReward(info?.ratePlanName)
  const displayCpp = showCpp ? info?.cpp : undefined

  updateValueClass(valueEl, displayCpp)

  if (info?.rewardStatus === "unavailable") {
    placeholder.classList.remove("is-loading")
    valueEl.classList.remove("is-good", "is-bad", "is-mid")
    valueEl.textContent = "No Reward Available"
    if (tooltip) {
      setTooltipText(tooltip, "No Reward Available")
    }
    return
  }

  if (showCpp && info?.cpp !== undefined && Number.isFinite(info.cpp)) {
    placeholder.classList.remove("is-loading")
    const total = info?.cash ?? info?.amountAfterTax
    const totalSuffix =
      total !== undefined && Number.isFinite(total)
        ? ` (${formatUsdAmount(total)})`
        : ""
    valueEl.textContent = `${formatCpp(displayCpp)}${totalSuffix}`
    if (tooltip) {
      tooltip.replaceChildren(buildTooltipContent(info, true))
    }
    return
  }

  if (info?.points !== undefined && Number.isFinite(info.points)) {
    placeholder.classList.remove("is-loading")
    valueEl.classList.remove("is-good", "is-bad", "is-mid")
    const pointsText = formatPoints(info.points)
    if (isPremiumReward(info?.ratePlanName)) {
      valueEl.textContent = `Premium: ${pointsText} pts`
    } else {
      valueEl.textContent = `${pointsText} pts`
    }
    if (tooltip) {
      tooltip.replaceChildren(buildTooltipContent(info, false))
    }
    return
  }

  if (tooltip) {
    setTooltipText(tooltip, "Awaiting Hilton response")
  }
  setSkeleton(placeholder)
}

function getRateButton(card: HTMLElement) {
  const priceInfo = card.querySelector<HTMLElement>('[data-testid="priceInfo"]')
  if (!priceInfo) return null

  return priceInfo.querySelector<HTMLAnchorElement>(
    'a[href*="/book/reservation/rooms/"], a.btn.btn-primary'
  )
}

function ensurePlaceholder(card: HTMLElement) {
  const existing = card.querySelector<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
  if (existing) {
    const id = normalizeHotelId(getHotelIdFromCard(card))
    if (id && existing.dataset.hotelId !== id) {
      existing.dataset.hotelId = id
      updatePlaceholderText(existing)
    }
    return
  }

  const rateButton = getRateButton(card)
  if (!rateButton) return

  const container = rateButton.parentElement
  if (!container) return

  const placeholder = document.createElement("div")
  placeholder.className = PLACEHOLDER_CLASS
  const hotelId = getHotelIdFromCard(card)
  if (hotelId) {
    placeholder.dataset.hotelId = hotelId
  }
  container.insertBefore(placeholder, rateButton)
  ensurePlaceholderContents(placeholder)
  updatePlaceholderText(placeholder)
}

function refreshPlaceholders() {
  ensurePlaceholderStyles()
  const cards = document.querySelectorAll<HTMLElement>(
    '[data-testid^="hotel-card-"]'
  )
  cards.forEach((card) => ensurePlaceholder(card))
}

const updateExistingPlaceholders = () => {
  const placeholders = document.querySelectorAll<HTMLElement>(
    `.${PLACEHOLDER_CLASS}`
  )
  placeholders.forEach((placeholder) => updatePlaceholderText(placeholder))
}

// The pin-click window is a [role=dialog] holding the hotel detail. Add the same
// CPP placeholder to it, keyed by the ctyhocn in its /hotels/<ctyhocn>- link.
const findHotelDialog = (): HTMLElement | null => {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]')
  for (const dialog of dialogs) {
    if (
      dialog.getBoundingClientRect().width > 250 &&
      dialog.querySelector('a[href*="/hotels/"]')
    ) {
      return dialog
    }
  }
  return null
}

const extractDialogCtyhocn = (dialog: HTMLElement): string | null => {
  const link = dialog.querySelector<HTMLAnchorElement>('a[href*="/hotels/"]')
  const href = link?.getAttribute("href") ?? ""
  const match = /\/hotels\/([a-z0-9]{5,7})-/i.exec(href)
  return match ? match[1].toUpperCase() : null
}

// Injecting INTO Hilton's React-managed pin dialog corrupts it (React unmounts
// on reconciliation). Instead we render the CPP as a fixed chip appended to
// <body> — outside the dialog's React tree — positioned over the dialog and
// removed when it closes. React never sees the node, so the dialog stays intact.
let dialogCppEl: HTMLDivElement | null = null
let dialogRepositionBound = false

const removeDialogCpp = () => {
  if (dialogCppEl) {
    dialogCppEl.remove()
    dialogCppEl = null
  }
}

// Anchor the chip to the dialog's price/CTA row so it reads next to the rate,
// not floating in a corner. "View Rates"/room CTA is always present and stable;
// fall back to the first $-amount, then the dialog itself.
const findDialogPriceAnchor = (dialog: HTMLElement): HTMLElement | null => {
  const cta = Array.from(
    dialog.querySelectorAll<HTMLElement>("a, button")
  ).find((b) => /view rates|choose room|select room/i.test(b.textContent || ""))
  if (cta) return cta
  const price = Array.from(
    dialog.querySelectorAll<HTMLElement>("span, div, p, strong")
  ).find(
    (e) =>
      e.children.length === 0 &&
      /^\$[\d,]+(\.\d{2})?$/.test((e.textContent || "").trim())
  )
  return price ?? null
}

const positionDialogCpp = () => {
  if (!dialogCppEl) return
  const dialog = findHotelDialog()
  if (!dialog) {
    removeDialogCpp()
    return
  }
  const anchor = findDialogPriceAnchor(dialog)
  const dr = dialog.getBoundingClientRect()
  const a = (anchor ?? dialog).getBoundingClientRect()
  const chipH = dialogCppEl.offsetHeight || 38
  const chipW = dialogCppEl.offsetWidth || 184
  // Sit just below the price/"View Rates" row (the empty bottom strip of the
  // dialog), so it doesn't hover over the room content above. If there's no room
  // below, fall back to above.
  let top = a.bottom + 8
  if (top + chipH > window.innerHeight - 8) top = a.top - chipH - 8
  top = Math.min(Math.max(top, 8), window.innerHeight - chipH - 8)
  let left = anchor ? a.left : dr.left + 12
  left = Math.min(Math.max(left, dr.left + 8), dr.right - chipW - 8)
  left = Math.min(Math.max(left, 8), window.innerWidth - chipW - 8)
  dialogCppEl.style.top = `${top}px`
  dialogCppEl.style.left = `${left}px`
}

const refreshDialogPlaceholder = () => {
  try {
    const dialog = findHotelDialog()
    if (!dialog) {
      removeDialogCpp()
      return
    }
    const ctyhocn = extractDialogCtyhocn(dialog)
    if (!ctyhocn) {
      removeDialogCpp()
      return
    }

    ensurePlaceholderStyles()
    if (!dialogCppEl) {
      dialogCppEl = document.createElement("div")
      dialogCppEl.className = `${PLACEHOLDER_CLASS} ${DIALOG_CPP_CLASS}`
      ensurePlaceholderContents(dialogCppEl)
      document.body.appendChild(dialogCppEl)
      if (!dialogRepositionBound) {
        window.addEventListener("scroll", positionDialogCpp, true)
        window.addEventListener("resize", positionDialogCpp)
        dialogRepositionBound = true
      }
    }
    dialogCppEl.dataset.hotelId = ctyhocn
    updatePlaceholderText(dialogCppEl)
    positionDialogCpp()
  } catch {}
}

function startPlaceholderObserver() {
  if (!document.body) return
  refreshPlaceholders()
  refreshDialogPlaceholder()
  void refreshValueSettings()
  // The map overlay churns hundreds of marker nodes; coalesce mutations so we
  // don't re-scan the DOM on every one (that was making the page laggy).
  let scanScheduled = false
  const observer = new MutationObserver((mutations) => {
    if (!hasHostMutation(mutations)) return
    if (scanScheduled) return
    scanScheduled = true
    setTimeout(() => {
      scanScheduled = false
      refreshPlaceholders()
      refreshDialogPlaceholder()
    }, 250)
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-testid"]
  })

  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return
    if (changes[HILTON_VALUE_SETTINGS_KEY]) void refreshValueSettings()
    else if (changes[HILTON_STORAGE_KEY]) void refreshRatesFromStorage()
  })
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startPlaceholderObserver, {
    once: true
  })
} else {
  startPlaceholderObserver()
}

// Bridge messages
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "HILTON_CAPTURE_PRINT") {
    window.postMessage({ __AV_HILTON_PRINT__: true, payload: msg.payload }, "*")
  }

  if (msg?.type === "HILTON_PAGE_REPLAY") {
    window.postMessage(
      { __AV_HILTON_DO_REPLAY__: true, payload: msg.payload },
      "*"
    )
  }
})

type OverlayRate = {
  id?: unknown
  points?: unknown
  cash?: unknown
  cpp?: unknown
  hasReward?: unknown
}

const ingestOverlayRates = (rates: OverlayRate[]) => {
  const map = new Map<string, HiltonRateInfo>()
  for (const r of rates) {
    const id = normalizeHotelId(typeof r.id === "string" ? r.id : undefined)
    if (!id) continue
    const points = typeof r.points === "number" ? r.points : undefined
    const cash = typeof r.cash === "number" ? r.cash : undefined
    const cpp = typeof r.cpp === "number" ? r.cpp : undefined
    const hasReward = r.hasReward === true
    map.set(id, {
      cpp,
      cash,
      points,
      rateAmount: cash,
      currency: "USD",
      // Marks it as a standard reward so the CPP value renders.
      ratePlanName: "Standard Room Reward",
      rewardStatus: hasReward ? "available" : "unavailable"
    })
  }
  overlayRatesByHotel = map
  updateExistingPlaceholders()
  refreshDialogPlaceholder()
}

// Page -> background / overlay -> content
window.addEventListener("message", (event) => {
  if (event.source !== window) return

  const data = event.data as Record<string, unknown> | undefined

  if (data?.__AV_HILTON_SAVE__ === true) {
    chrome.runtime.sendMessage({
      type: "HILTON_SAVE_CAPTURE",
      payload: data.payload
    })
  }

  if (data?.__AV_HILTON_RATES__ === true && Array.isArray(data.rates)) {
    ingestOverlayRates(data.rates as OverlayRate[])
  }
})
