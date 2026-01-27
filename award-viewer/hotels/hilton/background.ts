type HiltonCapturePayload = {
  url?: string
  status?: number
  operationName?: string | null
  body?: unknown
}

type HiltonCaptureMessage = {
  type?: string
  payload?: HiltonCapturePayload
}

const HILTON_STORAGE_KEY = "award-viewer:hilton-last-capture"

export const registerHiltonMessageListeners = () => {
  chrome.runtime.onMessage.addListener(
    (msg: HiltonCaptureMessage, sender) => {
      if (msg?.type !== "hilton-gql-capture") {
        return
      }

      if (!chrome?.storage?.local) {
        return
      }

      chrome.storage.local.set({
        [HILTON_STORAGE_KEY]: {
          ...(msg.payload ?? {}),
          receivedAt: new Date().toISOString(),
          tabId: sender.tab?.id
        }
      })
    }
  )
}
