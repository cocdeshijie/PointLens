import type { PlasmoCSConfig } from "plasmo"

import "../hotels/sonesta/content"

export const config: PlasmoCSConfig = {
  matches: ["https://www.sonesta.com/*"],
  run_at: "document_start"
}
