import { fetchUsdRate } from "../../shared/fx"
import { registerPricingBudget } from "../../shared/pricing-budget"

export const registerHyattListeners = () => {
  registerPricingBudget("hyatt")
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "HYATT_FETCH_FX" || typeof msg.currency !== "string") {
      return
    }
    fetchUsdRate(msg.currency)
      .then((rate) => sendResponse({ rate }))
      .catch(() => sendResponse({ rate: null }))
    return true // keep the message channel open for the async response
  })
}
