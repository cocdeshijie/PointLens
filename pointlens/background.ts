import { registerBestwesternListeners } from "./hotels/bestwestern/background"
import { registerSonestaListeners } from "./hotels/sonesta/background"
import { registerChoiceListeners } from "./hotels/choice/background"
import { registerHiltonListeners } from "./hotels/hilton/background"
import { registerHyattListeners } from "./hotels/hyatt/background"
import { registerIhgWebRequestListeners } from "./hotels/ihg/background"
import { registerMarriottListeners } from "./hotels/marriott/background"
import { registerWyndhamListeners } from "./hotels/wyndham/background"
import { createReleaseChecker, UPDATE_CACHE_KEY } from "./shared/release-updates"

const checkRelease = createReleaseChecker({
  load: async () => (await chrome.storage.local.get(UPDATE_CACHE_KEY))[UPDATE_CACHE_KEY],
  save: async (cache) => { await chrome.storage.local.set({ [UPDATE_CACHE_KEY]: cache }) },
  fetch: (input, init) => fetch(input, init)
})
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "POINTLENS_CHECK_UPDATE" || sender.id !== chrome.runtime.id) return
  void checkRelease(chrome.runtime.getManifest().version).then(sendResponse, () => sendResponse(null))
  return true
})

// MAIN-world scripts are declared in the manifest. Remove this extension's
// legacy dynamic registrations, including entries whose old bundles vanished.
// PointLens has no other dynamically registered content scripts.
void chrome.scripting
  .unregisterContentScripts()
  .catch((error) =>
    console.error("PointLens legacy page-script cleanup failed", error)
  )

registerHiltonListeners()
registerIhgWebRequestListeners()
registerMarriottListeners()
registerHyattListeners()

registerWyndhamListeners()

registerChoiceListeners()

registerBestwesternListeners()
registerSonestaListeners()
