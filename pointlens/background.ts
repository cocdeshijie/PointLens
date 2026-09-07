import { registerChoiceListeners } from "./hotels/choice/background"
import { registerHiltonListeners } from "./hotels/hilton/background"
import { registerHyattListeners } from "./hotels/hyatt/background"
import { registerIhgWebRequestListeners } from "./hotels/ihg/background"
import { registerMarriottListeners } from "./hotels/marriott/background"
import { registerWyndhamListeners } from "./hotels/wyndham/background"

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
