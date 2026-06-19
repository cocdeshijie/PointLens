import type { PlasmoCSConfig } from "plasmo"

import "../hotels/hilton/content"

// config MUST be declared literally here (not re-exported from the hotel content
// module) — Plasmo statically analyses this file for the manifest, and a
// re-export silently falls back to <all_urls>, which made every site's content
// script run on every site (e.g. Hilton's badge showed up on Marriott).
export const config: PlasmoCSConfig = {
  matches: ["https://www.hilton.com/*"],
  run_at: "document_start"
}
