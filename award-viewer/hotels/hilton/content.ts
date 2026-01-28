import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://www.hilton.com/*"],
  run_at: "document_start"
}

const PLACEHOLDER_CLASS = "award-viewer-hilton-cpp-placeholder"
const PLACEHOLDER_STYLE_ID = "award-viewer-hilton-placeholder-style"
const PLACEHOLDER_TEXT = "CPP value placeholder"

function inject(src: string) {
  const script = document.createElement("script")
  script.src = src
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()
}

// Inject page script
inject(chrome.runtime.getURL("hotels/hilton/injected/hilton-fetch-hook.js"))

function ensurePlaceholderStyles() {
  if (document.getElementById(PLACEHOLDER_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = PLACEHOLDER_STYLE_ID
  style.textContent = `
    .${PLACEHOLDER_CLASS} {
      margin-bottom: 0.5rem;
      padding: 0.35rem 0.5rem;
      border-radius: 0.5rem;
      background: rgba(15, 23, 42, 0.06);
      color: #334155;
      font-size: 0.75rem;
      font-weight: 600;
      text-align: right;
    }
  `
  document.head?.appendChild(style)
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
  placeholder.textContent = PLACEHOLDER_TEXT
  container.insertBefore(placeholder, rateButton)
}

function refreshPlaceholders() {
  ensurePlaceholderStyles()
  const cards = document.querySelectorAll<HTMLElement>(
    '[data-testid^="hotel-card-"]'
  )
  cards.forEach((card) => ensurePlaceholder(card))
}

function startPlaceholderObserver() {
  if (!document.body) return
  refreshPlaceholders()
  const observer = new MutationObserver(() => {
    refreshPlaceholders()
  })
  observer.observe(document.body, { childList: true, subtree: true })
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
