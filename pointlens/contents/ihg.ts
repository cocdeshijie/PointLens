import type { PlasmoCSConfig } from "plasmo"

import "../hotels/ihg/content"

// config declared literally (see contents/hilton.ts) so Plasmo restricts this
// content script to ihg.com instead of defaulting to <all_urls>.
export const config: PlasmoCSConfig = {
  matches: ["https://www.ihg.com/*"],
  run_at: "document_start"
}
