import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://www.hilton.com/*"],
  run_at: "document_start"
}

function inject(src: string) {
  const script = document.createElement("script")
  script.src = src
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()
}

// Inject page script
inject(chrome.runtime.getURL("hotels/hilton/injected/hilton-fetch-hook.js"))

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
