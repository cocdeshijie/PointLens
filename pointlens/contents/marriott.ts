import type { PlasmoCSConfig } from "plasmo"

import "../hotels/marriott/content"

// config declared literally (see contents/hilton.ts) so Plasmo restricts this
// content script to marriott.com instead of defaulting to <all_urls>.
export const config: PlasmoCSConfig = {
  matches: ["https://www.marriott.com/*"],
  run_at: "document_start"
}
