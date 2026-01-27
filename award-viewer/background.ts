import { registerHiltonMessageListeners } from "./hotels/hilton/background"
import { registerIhgWebRequestListeners } from "./hotels/ihg/background"

registerHiltonMessageListeners()
registerIhgWebRequestListeners()
