import { fetchUsdRate } from "../../shared/fx"
import { registerPricingBudget } from "../../shared/pricing-budget"

export const registerBestwesternListeners = () => {
  registerPricingBudget("bestwestern")
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (
      msg?.type !== "BESTWESTERN_FETCH_FX" ||
      typeof msg.currency !== "string"
    )
      return
    fetchUsdRate(msg.currency)
      .then((rate) => sendResponse({ rate }))
      .catch(() => sendResponse({ rate: null }))
    return true
  })
}
