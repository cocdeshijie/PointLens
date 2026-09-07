import type { PlasmoCSConfig } from "plasmo"

import "../hotels/bestwestern/content"

export const config: PlasmoCSConfig = {
  matches: ["https://www.bestwestern.com/*"],
  run_at: "document_start"
}
