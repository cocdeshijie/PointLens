import type { PlasmoCSConfig } from "plasmo"

import "../hotels/choice/content"

export const config: PlasmoCSConfig = {
  matches: ["https://www.choicehotels.com/*"],
  run_at: "document_start"
}
