import { fetchUsdRate } from "../../shared/fx"
import { registerPricingBudget } from "../../shared/pricing-budget"

export const registerSonestaListeners = () => {
  registerPricingBudget("sonesta")
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "SONESTA_FETCH_FX" || typeof msg.currency !== "string")
      return
    fetchUsdRate(msg.currency)
      .then((rate) => sendResponse({ rate }))
      .catch(() => sendResponse({ rate: null }))
    return true
  })
}
