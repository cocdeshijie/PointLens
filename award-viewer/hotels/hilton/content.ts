import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://www.hilton.com/*"],
  run_at: "document_start"
}

const MESSAGE_FLAG = "__AV_HILTON__"

const injectScript = (src: string) => {
  const script = document.createElement("script")
  script.src = src
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()
}

injectScript(
  chrome.runtime.getURL("hotels/hilton/injected/hilton-fetch-hook.js")
)

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return
  }

  const data = event.data as Record<string, unknown> | undefined
  if (!data || data[MESSAGE_FLAG] !== true) {
    return
  }

  chrome.runtime.sendMessage({
    type: "hilton-gql-capture",
    payload: data.payload
  })
})
