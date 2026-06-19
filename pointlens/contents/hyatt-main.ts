import type { PlasmoCSConfig } from "plasmo"

import "../hotels/hyatt/content-main"

// config declared literally (see contents/hilton.ts) so Plasmo restricts this
// MAIN-world content script to hyatt.com instead of defaulting to <all_urls>.
export const config: PlasmoCSConfig = {
  matches: ["https://www.hyatt.com/*"],
  run_at: "document_start",
  world: "MAIN"
}
