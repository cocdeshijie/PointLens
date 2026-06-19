import { registerHiltonListeners } from "./hotels/hilton/background"
import { registerHyattListeners } from "./hotels/hyatt/background"
import { registerIhgWebRequestListeners } from "./hotels/ihg/background"
import { registerMarriottListeners } from "./hotels/marriott/background"

registerHiltonListeners()
registerIhgWebRequestListeners()
registerMarriottListeners()
registerHyattListeners()
