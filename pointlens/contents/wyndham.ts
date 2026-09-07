import type { PlasmoCSConfig } from "plasmo"

import "../hotels/wyndham/content"

export const config: PlasmoCSConfig = {
  matches: ["https://www.wyndhamhotels.com/*"],
  run_at: "document_start"
}
