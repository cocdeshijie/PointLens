const PIN_CLASS = "pointlens-choice-map-pin"
const VALUE_CLASS = "pointlens-choice-map-value"
const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
const amount = (text: string) => {
  const match = text.replace(/\s/g, "").match(/(\d[\d,.]*)([KM])?/i)
  if (!match) return undefined
  const scale =
    match[2]?.toUpperCase() === "M"
      ? 1000000
      : match[2]?.toUpperCase() === "K"
        ? 1000
        : 1
  return Number(match[1].replaceAll(",", "")) * scale
}
let nextId = 0

// Google Maps renders Choice's price artwork separately from its transparent
// hit target. Put our two-line label inside that target so it follows native
// pan/zoom/visibility and clicks, without reading Google Maps internals.
export function updateChoiceMap(document: Document) {
  if (!document.getElementById("SearchPageMap")) return
  if (!document.getElementById("pointlens-choice-map-style")) {
    const style = document.createElement("style")
    style.id = "pointlens-choice-map-style"
    // Choice's absolute full-card selection button covers static content.
    // Lift only the info control so the rest of the card still selects a hotel.
    style.textContent = `
      .search-results-map-card .pointlens-choice-room-value button{position:relative;z-index:1}
      .map-flyout .pointlens-room-comparison{font-size:11px;gap:5px}
      .map-flyout .pointlens-room-pill{white-space:nowrap;padding:2px 4px}
      .${PIN_CLASS}{overflow:visible!important}
      .${VALUE_CLASS}{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);box-sizing:border-box;min-width:106px;width:max-content;max-width:160px;padding:3px 7px;border:2px solid #292735;border-radius:16px;background:#fff;color:#292735;box-shadow:0 1px 3px #0002;pointer-events:none;text-align:center;white-space:nowrap;font:600 12px/16px system-ui,sans-serif}
      .${VALUE_CLASS}>span{display:block}
      .${VALUE_CLASS} .pointlens-choice-map-caption{border-radius:4px;padding:0 3px;font-size:10px;line-height:15px;font-weight:600;background:#f1f5f9;color:#64748b}
      .${VALUE_CLASS}.good .pointlens-choice-map-caption{background:#d1fae5;color:#047857}
      .${VALUE_CLASS}.mid .pointlens-choice-map-caption{background:#fef3c7;color:#b45309}
      .${VALUE_CLASS}.bad .pointlens-choice-map-caption{background:#ffe4e6;color:#be123c}
      .${PIN_CLASS}:hover .${VALUE_CLASS},.${PIN_CLASS}:focus-visible .${VALUE_CLASS}{border-color:#ec6b24;box-shadow:0 0 0 2px #fff,0 2px 6px #0003}
      .${VALUE_CLASS}[aria-busy=true] .pointlens-choice-map-caption{color:transparent;background:linear-gradient(90deg,#f1f5f9,#e2e8f0,#f1f5f9);background-size:200% 100%;animation:pointlens-choice-map-loading 1.5s infinite}
      @keyframes pointlens-choice-map-loading{to{background-position:-200% 0}}
      @media(prefers-reduced-motion:reduce){.${VALUE_CLASS}[aria-busy=true] .pointlens-choice-map-caption{animation:none}}
    `
    document.head.append(style)
  }
  const cards = new Map<string, HTMLElement | null>()
  for (const card of document.querySelectorAll<HTMLElement>(
    '[id^="MapListItem-"]'
  )) {
    const name = normalize(card.querySelector("h2,h3,h4")?.textContent ?? "")
    if (!name) continue
    cards.set(name, cards.has(name) ? null : card)
  }
  for (const pin of document.querySelectorAll<HTMLElement>(
    '#SearchPageMap [role="button"][aria-label]'
  )) {
    // Exclude cluster buttons, map controls and unrelated POIs.
    if (
      !pin.querySelector(
        ':scope > img[src="https://maps.gstatic.com/mapfiles/transparent.png"]'
      )
    )
      continue
    const label = normalize(pin.getAttribute("aria-label") ?? "")
    const matches = [...cards].filter(([name]) => label.startsWith(name + ". "))
    const card = matches.length === 1 ? matches[0][1] : undefined
    const price =
      matches.length === 1
        ? label.slice(matches[0][0].length + 2).replace(/\.$/, "")
        : ""
    const pill = card?.querySelector<HTMLElement>(".pointlens-room-pill")
    const status = card?.querySelector<HTMLElement>(".pointlens-choice-status")
    const loading = status?.getAttribute("aria-busy") === "true"
    let overlay = pin.querySelector<HTMLElement>(`:scope > .${VALUE_CLASS}`)
    const remove = () => {
      if (overlay) {
        const ids = (pin.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter((id) => id && id !== overlay!.lastElementChild?.id)
        if (ids.length) pin.setAttribute("aria-describedby", ids.join(" "))
        else pin.removeAttribute("aria-describedby")
        overlay.remove()
      }
      if (pin.classList.contains(PIN_CLASS)) pin.classList.remove(PIN_CLASS)
    }
    const shown =
      card?.querySelector(".main-price .price")?.textContent ??
      card?.querySelector(".main-price")?.textContent ??
      ""
    // During a cash/points toggle the marker and sidebar can update separately.
    // Hide a mismatched annotation until both show the same native amount.
    if (
      !card ||
      /sold out|unavailable/i.test(price) ||
      !price ||
      amount(shown) !== amount(price) ||
      (!pill && !status)
    ) {
      remove()
      continue
    }
    const fullValue =
      pill?.textContent ?? status?.getAttribute("aria-label") ?? ""
    const caption = loading
      ? "Loading value"
      : fullValue.replace(
          /([\d,]+) pts/g,
          (_, number) =>
            `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(number.replaceAll(",", "")))} pts`
        )
    const tier =
      ["good", "mid", "bad"].find((t) => pill?.classList.contains(t)) ?? ""
    const signature = JSON.stringify([price, caption, tier, loading, fullValue])
    if (overlay?.dataset.signature === signature) continue
    if (!overlay) {
      overlay = document.createElement("span")
      overlay.className = VALUE_CLASS
      const native = document.createElement("span")
      native.setAttribute("aria-hidden", "true")
      const value = document.createElement("span")
      value.className = "pointlens-choice-map-caption"
      value.id = `pointlens-choice-map-caption-${++nextId}`
      overlay.append(native, value)
      pin.append(overlay)
      const prior = pin.getAttribute("aria-describedby")
      pin.setAttribute(
        "aria-describedby",
        [prior, value.id].filter(Boolean).join(" ")
      )
    }
    pin.classList.add(PIN_CLASS)
    overlay.className = `${VALUE_CLASS} ${tier}`
    overlay.dataset.signature = signature
    overlay.setAttribute("aria-busy", String(loading))
    overlay.firstElementChild!.textContent = price
    overlay.lastElementChild!.textContent = caption
    overlay.lastElementChild!.setAttribute("aria-label", fullValue)
  }
}
