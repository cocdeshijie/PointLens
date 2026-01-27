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

const HILTON_SUMMARY_STORAGE_KEY =
  "award-viewer:hilton-last-hotel-summary-options"
const HILTON_SHOP_STORAGE_KEY =
  "award-viewer:hilton-last-shop-multi-prop-avail"

const getStorageKeyForOperation = (operationName?: string | null) => {
  if (operationName === "hotelSummaryOptions") {
    return HILTON_SUMMARY_STORAGE_KEY
  }
  if (operationName === "shopMultiPropAvail") {
    return HILTON_SHOP_STORAGE_KEY
  }
  return null
}

export const registerHiltonMessageListeners = () => {
  chrome.runtime.onMessage.addListener(
    (msg: HiltonCaptureMessage, sender) => {
      if (msg?.type !== "hilton-gql-capture") {
        return
      }

      if (!chrome?.storage?.local) {
        return
      }

      const storageKey = getStorageKeyForOperation(
        msg.payload?.operationName
      )
      if (!storageKey) {
        return
      }

      chrome.storage.local.set({
        [storageKey]: {
          ...(msg.payload ?? {}),
          receivedAt: new Date().toISOString(),
          tabId: sender.tab?.id
        }
      })
    }
  )
}
