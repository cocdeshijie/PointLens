import type { PlasmoCSConfig } from "plasmo"
import React from "react"
import { createRoot } from "react-dom/client"
import { CiCircleInfo } from "react-icons/ci"

import {
  DEFAULT_MARRIOTT_VALUE_SETTINGS,
  MARRIOTT_VALUE_SETTINGS_KEY,
  normalizeMarriottValueSettings
} from "./settings"

export const config: PlasmoCSConfig = {
  matches: ["https://www.marriott.com/*"],
  run_at: "document_start"
}

const MARRIOTT_STORAGE_KEY = "award-viewer:marriott-last-capture"
const PLACEHOLDER_CLASS = "award-viewer-marriott-price-placeholder"
const PLACEHOLDER_ICON_CLASS = "award-viewer-marriott-cpp-icon"
const PLACEHOLDER_VALUE_CLASS = "award-viewer-marriott-cpp-value"
const PLACEHOLDER_STYLE_ID = "award-viewer-marriott-placeholder-style"

type MarriottRateInfo = {
  cpp?: number
  cash?: number
  points?: number
  currency?: string
}

const iconRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
let marriottRatesByHotel = new Map<string, MarriottRateInfo>()
let marriottValueSettings = DEFAULT_MARRIOTT_VALUE_SETTINGS

function inject(src: string) {
  const script = document.createElement("script")
  script.src = src
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()
}

inject(chrome.runtime.getURL("hotels/marriott/injected/marriott-fetch-hook.js"))

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
  return card.getAttribute("data-marsha")
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

const extractNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  if (value && typeof value === "object") {
    const record = value as { amount?: unknown; decimalPoint?: unknown }
    const amount = extractNumber(record.amount)
    if (amount === undefined) {
      return undefined
    }
    const decimalPoint = extractNumber(record.decimalPoint)
    if (decimalPoint === undefined || !Number.isFinite(decimalPoint)) {
      return amount
    }
    return amount / 10 ** decimalPoint
  }

  return undefined
}

const getValueByPath = (value: unknown, path: string[]) => {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const getRateValue = (rates: Record<string, unknown>, paths: string[][]) => {
  for (const path of paths) {
    const value = extractNumber(getValueByPath(rates, path))
    if (value !== undefined && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

const getRateValueFromCollection = (
  rates: Record<string, unknown> | Array<Record<string, unknown>> | undefined,
  paths: string[][]
) => {
  if (!rates) {
    return undefined
  }

  if (Array.isArray(rates)) {
    for (const rate of rates) {
      const value = getRateValue(rate, paths)
      if (value !== undefined && Number.isFinite(value)) {
        return value
      }
    }
    return undefined
  }

  return getRateValue(rates, paths)
}

const computeCpp = (cash?: number, points?: number) => {
  if (
    cash === undefined ||
    points === undefined ||
    !Number.isFinite(cash) ||
    !Number.isFinite(points) ||
    points <= 0
  ) {
    return undefined
  }
  return (cash / points) * 100
}

const buildRatesFromStorage = (raw: unknown) => {
  if (!raw) {
    return new Map<string, MarriottRateInfo>()
  }

  const payload = raw as { hotels?: unknown[] } | unknown[]
  const hotels = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.hotels)
      ? payload.hotels
      : []

  const map = new Map<string, MarriottRateInfo>()

  for (const item of hotels) {
    if (!item || typeof item !== "object") {
      continue
    }

    const record = item as Record<string, unknown>
    const property = record.property as Record<string, unknown> | undefined
    const rawId =
      (property?.id as string | undefined) ??
      (property?.marshaCode as string | undefined) ??
      (property?.marshacode as string | undefined) ??
      (property?.propertyCode as string | undefined) ??
      (property?.code as string | undefined)
    const hotelId = normalizeHotelId(rawId)
    if (!hotelId) {
      continue
    }

    const rates = record.rates as
      | Record<string, unknown>
      | Array<Record<string, unknown>>
      | undefined
    if (!rates) {
      continue
    }

    const cash = getRateValueFromCollection(rates, [
      ["cashRate", "amount"],
      ["cashRate", "amountAfterTax"],
      ["cash", "amount"],
      ["rateModes", "lowestAverageRate", "amount"],
      ["rateModes", "lowestAverageRate", "amount", "amount"],
      ["rateModes", "lowestAverageRate", "amountPlusMandatoryFees"],
      ["rateModes", "lowestAverageRate", "amountPlusMandatoryFees", "amount"],
      ["rateModes", "lowestAverageRate", "totalAmount"],
      ["rateModes", "lowestAverageRate", "totalAmount", "amount"],
      ["lowestCashRate", "amount"],
      ["lowestCashRate", "amountAfterTax"],
      ["lowestAvailableRate", "amount"],
      ["lowestAvailableRate", "amountAfterTax"],
      ["bestAvailableRate", "amount"],
      ["bestAvailableRate", "amountAfterTax"],
      ["lowestRate", "amount"],
      ["lowestRate", "amountAfterTax"],
      ["total", "amount"],
      ["totalAmount"]
    ])

    const points = getRateValueFromCollection(rates, [
      ["pointsRate", "points"],
      ["pointsRate", "totalPoints"],
      ["rateModes", "pointsPerUnit", "points"],
      ["lowestPointsRate", "points"],
      ["lowestPointsRate", "totalPoints"],
      ["awardRate", "points"],
      ["points"]
    ])

    const currency =
      (!Array.isArray(rates) ? (rates.currency as string | undefined) : undefined) ??
      (property?.currency as string | undefined) ??
      ((property?.basicInformation as Record<string, unknown> | undefined)
        ?.currency as string | undefined) ??
      (property?.currencyCode as string | undefined)

    map.set(hotelId, {
      cash,
      points,
      currency,
      cpp: computeCpp(cash, points)
    })
  }

  return map
}

const refreshRatesFromStorage = async () => {
  if (!chrome?.storage?.local) return

  const result = await chrome.storage.local.get(MARRIOTT_STORAGE_KEY)
  marriottRatesByHotel = buildRatesFromStorage(result?.[MARRIOTT_STORAGE_KEY])
  updateExistingPlaceholders()
}

const refreshValueSettings = async () => {
  if (!chrome?.storage?.local) return

  const result = await chrome.storage.local.get(MARRIOTT_VALUE_SETTINGS_KEY)
  marriottValueSettings = normalizeMarriottValueSettings(
    result?.[MARRIOTT_VALUE_SETTINGS_KEY]
  )
  updateExistingPlaceholders()
}

const ensurePlaceholderStyles = () => {
  if (document.getElementById(PLACEHOLDER_STYLE_ID)) {
    return
  }

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
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      overflow: visible;
      position: relative;
      z-index: 3;
    }
    .price-container,
    .price-sub-section,
    .property-card-price-component {
      overflow: visible;
    }
    .${PLACEHOLDER_ICON_CLASS} {
      position: relative;
      display: inline-flex;
      align-items: center;
      color: #6b7280;
      cursor: default;
      font-size: 22px;
      line-height: 1;
      z-index: 2;
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
    .${PLACEHOLDER_ICON_CLASS}:hover .award-viewer-tooltip,
    .${PLACEHOLDER_ICON_CLASS}:focus-within .award-viewer-tooltip {
      opacity: 1;
      transform: translateY(-8px);
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

const buildTooltipContent = (info: MarriottRateInfo) => {
  const wrapper = document.createElement("div")
  const grid = document.createElement("div")
  grid.className = "award-viewer-tooltip-grid"

  const addRow = (label: string, value: string) => {
    const row = document.createElement("div")
    row.className = "award-viewer-tooltip-row"

    const labelEl = document.createElement("div")
    labelEl.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--label"
    labelEl.textContent = label

    const valueEl = document.createElement("div")
    valueEl.className = "award-viewer-tooltip-cell award-viewer-tooltip-cell--value"
    valueEl.textContent = value

    row.appendChild(labelEl)
    row.appendChild(valueEl)
    grid.appendChild(row)
  }

  if (info.cash !== undefined) {
    addRow("Cash", formatCash(info.cash, info.currency))
  }
  if (info.points !== undefined) {
    addRow("Points", `${formatPoints(info.points)} pts`)
  }
  if (info.cpp !== undefined) {
    addRow("Value", formatCpp(info.cpp))
  }

  if (!grid.childNodes.length) {
    wrapper.textContent = "Awaiting Marriott response"
    return wrapper
  }

  wrapper.appendChild(grid)
  return wrapper
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
    tooltip.textContent = "Awaiting Marriott response"
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

const updateValueClass = (valueEl: HTMLElement, cpp?: number) => {
  valueEl.classList.remove("is-good", "is-bad", "is-mid")

  if (cpp === undefined || !Number.isFinite(cpp)) {
    return
  }

  if (cpp >= marriottValueSettings.goodValueThreshold) {
    valueEl.classList.add("is-good")
    return
  }

  if (cpp <= marriottValueSettings.badValueThreshold) {
    valueEl.classList.add("is-bad")
    return
  }

  valueEl.classList.add("is-mid")
}

const updatePlaceholderText = (placeholder: HTMLElement) => {
  let hotelId = placeholder.dataset.hotelId
  if (!hotelId) {
    const card = placeholder.closest<HTMLElement>(".property-card")
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

  const info = marriottRatesByHotel.get(hotelId)
  const { iconWrapper, valueEl } = ensurePlaceholderContents(placeholder)
  const tooltip = iconWrapper.querySelector<HTMLElement>(".award-viewer-tooltip")

  updateValueClass(valueEl, info?.cpp)

  if (info?.points !== undefined && info?.cash !== undefined) {
    placeholder.classList.remove("is-loading")
    valueEl.textContent = formatCpp(info.cpp)
    if (tooltip) {
      tooltip.replaceChildren(buildTooltipContent(info))
    }
    return
  }

  if (info?.points === undefined && info?.cash !== undefined) {
    placeholder.classList.remove("is-loading")
    valueEl.classList.remove("is-good", "is-bad", "is-mid")
    valueEl.textContent = "Reward Nights Unavailable"
    if (tooltip) {
      tooltip.replaceChildren(buildTooltipContent(info))
    }
    return
  }

  if (tooltip) {
    tooltip.textContent = "Awaiting Marriott response"
  }
  setSkeleton(placeholder)
}

const getRateLink = (card: HTMLElement) => {
  const rateContainer = card.querySelector<HTMLElement>(".rate-container")
  if (!rateContainer) return null
  return rateContainer.closest<HTMLAnchorElement>("a")
}

const ensurePlaceholder = (card: HTMLElement) => {
  if (card.querySelector(`.${PLACEHOLDER_CLASS}`)) return

  const link = getRateLink(card)
  if (!link) return

  const container = link.parentElement
  if (!container) return

  const placeholder = document.createElement("div")
  placeholder.className = PLACEHOLDER_CLASS
  const hotelId = getHotelIdFromCard(card)
  if (hotelId) {
    placeholder.dataset.hotelId = hotelId
  }
  container.insertBefore(placeholder, link.nextSibling)
  ensurePlaceholderContents(placeholder)
  updatePlaceholderText(placeholder)
}

const refreshPlaceholders = () => {
  ensurePlaceholderStyles()
  const cards = document.querySelectorAll<HTMLElement>(".property-card")
  cards.forEach((card) => ensurePlaceholder(card))
}

const updateExistingPlaceholders = () => {
  const placeholders = document.querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
  placeholders.forEach((placeholder) => updatePlaceholderText(placeholder))
}

const startPlaceholderObserver = () => {
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MARRIOTT_PAGE_REPLAY") {
    window.postMessage(
      { __AV_MARRIOTT_DO_REPLAY__: true, payload: msg.payload },
      "*"
    )
  }
})

window.addEventListener("message", (event) => {
  if (event.source !== window) return

  const data = event.data as Record<string, unknown> | undefined

  if (data?.__AV_MARRIOTT_SAVE__ === true) {
    chrome.runtime.sendMessage({
      type: "MARRIOTT_SAVE_CAPTURE",
      payload: data.payload
    })
  }
})
