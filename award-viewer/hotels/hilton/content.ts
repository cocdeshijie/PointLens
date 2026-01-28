import type { PlasmoCSConfig } from "plasmo"
import React from "react"
import { createRoot } from "react-dom/client"
import { CiCircleInfo } from "react-icons/ci"

import {
  DEFAULT_HILTON_VALUE_SETTINGS,
  HILTON_VALUE_SETTINGS_KEY,
  normalizeHiltonValueSettings
} from "./settings"

export const config: PlasmoCSConfig = {
  matches: ["https://www.hilton.com/*"],
  run_at: "document_start"
}

const PLACEHOLDER_CLASS = "award-viewer-hilton-price-placeholder"
const PLACEHOLDER_ICON_CLASS = "award-viewer-hilton-cpp-icon"
const PLACEHOLDER_VALUE_CLASS = "award-viewer-hilton-cpp-value"
const PLACEHOLDER_STYLE_ID = "award-viewer-hilton-placeholder-style"
const HILTON_STORAGE_KEY = "hilton-last-capture"

type HiltonRateInfo = {
  cpp?: number
  cash?: number
  points?: number
  rateAmount?: number
  amountAfterTax?: number
  currency?: string
  ratePlanName?: string
}

const iconRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
let hiltonRatesByHotel = new Map<string, HiltonRateInfo>()
let hiltonValueSettings = DEFAULT_HILTON_VALUE_SETTINGS

function inject(src: string) {
  const script = document.createElement("script")
  script.src = src
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()
}

// Inject page script
inject(chrome.runtime.getURL("hotels/hilton/injected/hilton-fetch-hook.js"))

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

const buildRatesFromStorage = (raw: unknown) => {
  if (!raw) {
    return new Map<string, HiltonRateInfo>()
  }

  const parsed = raw as
    | { shopMultiPropAvail?: unknown[] }
    | unknown[]
    | Record<string, unknown>

  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { shopMultiPropAvail?: unknown[] })?.shopMultiPropAvail)
      ? (parsed as { shopMultiPropAvail: unknown[] }).shopMultiPropAvail
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

    const amountAfterTax = extractNumber(lowest?.amountAfterTax)
    const rateAmount = extractNumber(lowest?.rateAmount)
    const cash = amountAfterTax ?? rateAmount
    const points = extractNumber(hhonors?.dailyRmPointsRate)
    const currency = record.currencyCode as string | undefined
    const ratePlanName =
      (hhonors?.ratePlan as Record<string, unknown> | undefined)?.ratePlanName ??
      (lowest?.ratePlan as Record<string, unknown> | undefined)?.ratePlanName

    if (!cash || !points) {
      map.set(hotelId, {
        cash,
        points,
        rateAmount,
        amountAfterTax,
        currency,
        ratePlanName: ratePlanName as string | undefined
      })
      continue
    }

    const cpp = (cash / points) * 100
    map.set(hotelId, {
      cpp,
      cash,
      points,
      rateAmount,
      amountAfterTax,
      currency,
      ratePlanName: ratePlanName as string | undefined
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
    | { shopMultiPropAvail?: unknown[] }
    | undefined

  hiltonRatesByHotel = buildRatesFromStorage(payload)
  updateExistingPlaceholders()
}

const refreshValueSettings = async () => {
  if (!chrome?.storage?.local) {
    hiltonValueSettings = DEFAULT_HILTON_VALUE_SETTINGS
    updateExistingPlaceholders()
    return
  }

  const stored = await chrome.storage.local.get([HILTON_VALUE_SETTINGS_KEY])
  hiltonValueSettings = normalizeHiltonValueSettings(
    stored[HILTON_VALUE_SETTINGS_KEY] as Partial<typeof hiltonValueSettings> | undefined
  )
  updateExistingPlaceholders()
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
  row.className = "award-viewer-tooltip-row"

  const labelCell = document.createElement("div")
  labelCell.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--label"
  labelCell.textContent = label

  const valueCell = document.createElement("div")
  valueCell.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--value"
  valueCell.textContent = value

  row.appendChild(labelCell)
  row.appendChild(valueCell)
  return row
}

const buildTooltipContent = (info: HiltonRateInfo, showCpp: boolean) => {
  const wrapper = document.createElement("div")
  wrapper.className = "award-viewer-tooltip-content"

  const header = document.createElement("div")
  header.className =
    "award-viewer-tooltip-grid award-viewer-tooltip-row award-viewer-tooltip-header"
  const headerLabel = document.createElement("div")
  headerLabel.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--label"
  headerLabel.textContent = "Lowest"
  const headerValue = document.createElement("div")
  headerValue.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--value"
  headerValue.textContent = "Price"
  header.appendChild(headerLabel)
  header.appendChild(headerValue)
  wrapper.appendChild(header)

  const grid = document.createElement("div")
  grid.className = "award-viewer-tooltip-grid"

  const priceLabel = formatCash(info.rateAmount ?? info.cash, info.currency)
  const totalLabel = formatCash(info.amountAfterTax ?? info.cash, info.currency)
  const feeValue =
    info.rateAmount !== undefined &&
    info.amountAfterTax !== undefined &&
    Number.isFinite(info.rateAmount) &&
    Number.isFinite(info.amountAfterTax)
      ? Math.max(info.amountAfterTax - info.rateAmount, 0)
      : undefined
  const feeLabel = formatCash(feeValue, info.currency)

  if (priceLabel) {
    grid.appendChild(buildTooltipCell("Price", priceLabel))
  }

  if (feeValue !== undefined) {
    grid.appendChild(buildTooltipCell("Fees", feeLabel))
  }

  if (totalLabel) {
    grid.appendChild(buildTooltipCell("Total", totalLabel))
  }

  const divider = document.createElement("div")
  divider.className = "award-viewer-tooltip-divider"
  grid.appendChild(divider)

  const pointsLabel = formatPoints(info.points)
  const cppLabel = showCpp ? formatCpp(info.cpp) : ""
  if (pointsLabel) {
    const pointLabelText = isPremiumReward(info.ratePlanName)
      ? "Premium Room Reward"
      : "Points"
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
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-icon {
      display: inline-flex;
      align-items: center;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip {
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
    .${PLACEHOLDER_ICON_CLASS}:hover .award-viewer-tooltip {
      opacity: 1;
      transform: translateY(-8px);
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-content {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-grid {
      display: grid;
      grid-template-columns: max-content minmax(160px, auto);
      column-gap: 12px;
      row-gap: 2px;
      align-items: center;
      justify-content: start;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-row {
      display: contents;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-cell {
      white-space: normal;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-cell--label {
      color: #475569;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-cell--value {
      font-weight: 400;
      color: #0f172a;
      text-align: left;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-divider {
      grid-column: 1 / -1;
      border-top: 1px solid #e2e8f0;
      height: 1px;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-header .award-viewer-tooltip-cell {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #475569;
    }
    .${PLACEHOLDER_ICON_CLASS} .award-viewer-tooltip-header .award-viewer-tooltip-cell--label {
      color: transparent;
    }
    .${PLACEHOLDER_VALUE_CLASS} {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      border: 1px solid #cbd5e1;
      background: #f5f5f5;
      border-radius: 4px;
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

    const iconTarget = document.createElement("span")
    iconTarget.className = "award-viewer-icon"
    iconWrapper.appendChild(iconTarget)

    const tooltip = document.createElement("span")
    tooltip.className = "award-viewer-tooltip"
    tooltip.textContent = "Awaiting Hilton response"
    iconWrapper.appendChild(tooltip)

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
  const existing = valueEl.querySelector(".award-viewer-skeleton")
  if (existing) {
    return
  }
  const skeleton = document.createElement("span")
  skeleton.className = "award-viewer-skeleton"
  skeleton.setAttribute("aria-hidden", "true")
  valueEl.appendChild(skeleton)
}

const updatePlaceholderText = (placeholder: HTMLElement) => {
  let hotelId = placeholder.dataset.hotelId
  if (!hotelId) {
    const card = placeholder.closest<HTMLElement>('[data-testid^="hotel-card-"]')
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

  const info = hiltonRatesByHotel.get(hotelId)
  const { iconWrapper, valueEl } = ensurePlaceholderContents(placeholder)
  const tooltip = iconWrapper.querySelector<HTMLElement>(".award-viewer-tooltip")
  const showCpp = isStandardReward(info?.ratePlanName)
  const displayCpp = showCpp ? info?.cpp : undefined

  updateValueClass(valueEl, displayCpp)

  if (showCpp && info?.cpp !== undefined && Number.isFinite(info.cpp)) {
    placeholder.classList.remove("is-loading")
    valueEl.textContent = formatCpp(displayCpp)
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
      valueEl.textContent = `Premium Room Reward: ${pointsText} pts`
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
  if (card.querySelector(`.${PLACEHOLDER_CLASS}`)) return

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
  const placeholders = document.querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
  placeholders.forEach((placeholder) => updatePlaceholderText(placeholder))
}

function startPlaceholderObserver() {
  if (!document.body) return
  refreshPlaceholders()
  void refreshRatesFromStorage()
  void refreshValueSettings()
  const observer = new MutationObserver(() => {
    refreshPlaceholders()
  })
  observer.observe(document.body, { childList: true, subtree: true })

  chrome?.storage?.onChanged?.addListener(() => {
    void refreshRatesFromStorage()
    void refreshValueSettings()
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
    window.postMessage(
      { __AV_HILTON_PRINT__: true, payload: msg.payload },
      "*"
    )
  }

  if (msg?.type === "HILTON_PAGE_REPLAY") {
    window.postMessage(
      { __AV_HILTON_DO_REPLAY__: true, payload: msg.payload },
      "*"
    )
  }
})

// Page -> background
window.addEventListener("message", (event) => {
  if (event.source !== window) return

  const data = event.data as Record<string, unknown> | undefined

  if (data?.__AV_HILTON_SAVE__ === true) {
    chrome.runtime.sendMessage({
      type: "HILTON_SAVE_CAPTURE",
      payload: data.payload
    })
  }
})
