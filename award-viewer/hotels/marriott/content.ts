import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://www.marriott.com/*"],
  run_at: "document_start"
}

function inject(src: string) {
  const script = document.createElement("script")
  script.src = src
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()
}

inject(chrome.runtime.getURL("hotels/marriott/injected/marriott-fetch-hook.js"))

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MARRIOTT_PAGE_REPLAY") {
    window.postMessage(
      { __AV_MARRIOTT_DO_REPLAY__: true, payload: msg.payload },
      "*"
    )
  }
})
