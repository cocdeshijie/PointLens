import type { PlasmoCSConfig } from "plasmo"

// MAIN-world hook for Hyatt's Next.js (App Router) search results.
//
// Hyatt delivers hotel + rate data as React Server Components ("Flight") payload,
// NOT a clean JSON API. The data arrives by two paths, BOTH handled here:
//   1. Initial load / full SSR navigation (date change, points toggle): streamed
//      into `self.__next_f` as `[type, string]` chunks.
//   2. Soft updates ("Search this area", map pan): returned from a Next.js Server
//      Action — a `POST` to the page route whose flight-stream response carries
//      `hotelSummaries[].leadingRate` (but NOT the `"hotelData":` wrapper).
//
// A single extractor covers both: every `leadingRate` object carries its own
// `spiritCode`, so we scan for `"leadingRate":{...}`, balance-extract, JSON.parse,
// and key by `spiritCode`. We then postMessage the merged map to the ISOLATED
// content script (which holds chrome.storage / overlay logic).

export const config: PlasmoCSConfig = {
  matches: ["https://www.hyatt.com/*"],
  run_at: "document_start",
  world: "MAIN"
}

const MESSAGE_FLAG = "__AV_HYATT_RATES__"

type LeadingRate = {
  spiritCode?: string
  status?: string
  rate?: number
  rateAfterTax?: number
  points?: number
  currencyCode?: string
}

type RateOut = {
  rate?: number
  rateAfterTax?: number
  points?: number
  currency?: string
  status?: string
}

// spiritCode (lowercased) -> rate. Accumulated across the page lifetime so a
// soft update that returns only the changed hotels still merges with what we
// already learned on load.
const ratesByHotel = new Map<string, RateOut>()

// Balance-extract the `{...}` object that follows each `"leadingRate":` in `text`,
// JSON.parse it, and fold into `ratesByHotel`. Returns how many NEW/updated.
const extractInto = (text: string): number => {
  if (!text || typeof text !== "string" || text.indexOf("leadingRate") < 0) {
    return 0
  }
  const KEY = '"leadingRate":'
  let changed = 0
  let idx = 0
  while ((idx = text.indexOf(KEY, idx)) >= 0) {
    let i = text.indexOf("{", idx + KEY.length)
    if (i < 0) break
    let depth = 0
    let end = -1
    let inStr = false
    let esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === "\\") esc = true
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === "{") depth++
      else if (c === "}") {
        depth--
        if (depth === 0) {
          end = j + 1
          break
        }
      }
    }
    if (end < 0) break
    try {
      const o = JSON.parse(text.slice(i, end)) as LeadingRate
      const spirit = o?.spiritCode?.toLowerCase()
      if (spirit) {
        ratesByHotel.set(spirit, {
          rate: typeof o.rate === "number" ? o.rate : undefined,
          rateAfterTax:
            typeof o.rateAfterTax === "number" ? o.rateAfterTax : undefined,
          points: typeof o.points === "number" ? o.points : undefined,
          currency: o.currencyCode,
          status: o.status
        })
        changed++
      }
    } catch {
      /* ignore a malformed / partially-streamed object */
    }
    idx = end
  }
  return changed
}

let postScheduled = false
const postRates = () => {
  if (postScheduled) return
  postScheduled = true
  // Coalesce bursts (streaming pushes / multiple fetches) into one message.
  Promise.resolve().then(() => {
    postScheduled = false
    if (ratesByHotel.size === 0) return
    const rates: Record<string, RateOut> = {}
    for (const [k, v] of ratesByHotel) rates[k] = v
    window.postMessage({ [MESSAGE_FLAG]: true, rates }, "*")
  })
}

// Join all `__next_f` flight chunks and extract from the full buffer (a single
// leadingRate object can be split across chunks, so always scan the whole thing).
const scanNextF = () => {
  const nf = (window as unknown as { __next_f?: unknown[] }).__next_f
  if (!Array.isArray(nf)) return
  let joined = ""
  for (const e of nf) {
    if (Array.isArray(e) && typeof e[1] === "string") joined += e[1]
  }
  if (extractInto(joined) > 0) postRates()
}

// `__next_f` is filled progressively via `self.__next_f.push([type, str])`. Wrap
// push so we re-scan as chunks stream in, whether the array already exists or is
// assigned after we run (document_start can beat the bootstrap script).
const hookNextF = () => {
  const win = window as unknown as { __next_f?: unknown[] }
  const wrap = (arr: unknown[]) => {
    if (!Array.isArray(arr) || (arr as { __avHooked?: boolean }).__avHooked) {
      return arr
    }
    ;(arr as { __avHooked?: boolean }).__avHooked = true
    const origPush = arr.push.bind(arr)
    arr.push = (...args: unknown[]) => {
      const r = origPush(...args)
      scanNextF()
      return r
    }
    return arr
  }

  let current = win.__next_f
  if (Array.isArray(current)) wrap(current)
  try {
    Object.defineProperty(win, "__next_f", {
      configurable: true,
      get() {
        return current
      },
      set(v) {
        current = Array.isArray(v) ? wrap(v) : v
      }
    })
  } catch {
    /* property may be non-configurable in some builds — push hook above still
       covers the common case */
  }
}

// Wrap fetch so soft Server-Action responses (which don't touch __next_f) are
// scanned too. Clone before reading so we never consume the page's body.
const hookFetch = () => {
  const orig = window.fetch
  window.fetch = function (...args: Parameters<typeof fetch>) {
    return orig.apply(this, args).then((res) => {
      try {
        res
          .clone()
          .text()
          .then((t) => {
            if (extractInto(t) > 0) postRates()
          })
          .catch(() => {})
      } catch {
        /* opaque / unreadable response */
      }
      return res
    })
  }
}

hookNextF()
hookFetch()
scanNextF()

// Belt-and-suspenders: re-scan after the document settles in case the flight
// finished streaming before our hooks attached.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scanNextF, { once: true })
}
window.addEventListener("load", scanNextF, { once: true })
