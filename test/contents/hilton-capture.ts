import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
    matches: ["https://www.hilton.com/*"],
    run_at: "document_start"
}

function inject(src: string) {
    const s = document.createElement("script")
    s.src = src
    s.async = false
    ;(document.head || document.documentElement).appendChild(s)
    s.onload = () => s.remove()
}

// Inject page script
inject(chrome.runtime.getURL("injected/hilton-fetch-hook.js"))

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
window.addEventListener("message", (ev) => {
    if (ev.source !== window) return

    const d = ev.data

    if (d?.__AV_HILTON_SAVE__ === true) {
        chrome.runtime.sendMessage({
            type: "HILTON_SAVE_CAPTURE",
            payload: d.payload
        })
    }
})
