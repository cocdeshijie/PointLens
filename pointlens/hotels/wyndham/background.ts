import { fetchUsdRate } from "../../shared/fx"
import { registerPricingBudget } from "../../shared/pricing-budget"

export const registerWyndhamListeners = () => {
  registerPricingBudget("wyndham")
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "WYNDHAM_FETCH_FX" || typeof msg.currency !== "string")
      return
    fetchUsdRate(msg.currency)
      .then((rate) => sendResponse({ rate }))
      .catch(() => sendResponse({ rate: null }))
    return true
  })
}
