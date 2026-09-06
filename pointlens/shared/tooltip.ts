let tooltip: HTMLElement | null = null
let active: HTMLElement | null = null
let lastContent = ""

const hide = () => {
  if (tooltip) {
    tooltip.style.opacity = "0"
    if (tooltip.matches(":popover-open")) tooltip.hidePopover()
  }
  active?.removeAttribute("aria-describedby")
  active = null
}

const getTooltip = () => {
  if (tooltip?.isConnected) return tooltip
  tooltip = document.createElement("div")
  tooltip.id = "pointlens-value-details"
  tooltip.className = "pointlens-tooltip pointlens-shared-tooltip"
  tooltip.setAttribute("role", "tooltip")
  tooltip.setAttribute("popover", "manual")
  const style = document.createElement("style")
  style.textContent = `
    #pointlens-value-details { position:fixed; inset:auto; margin:0;
      box-sizing:border-box; width:max-content; min-width:0;
      max-width:calc(100vw - 16px); max-height:calc(100vh - 16px);
      overflow:auto; padding:12px; border:1px solid #cbd5e1; border-radius:10px;
      background:#fff; color:#0f172a; font:12px/1.5 system-ui,sans-serif;
      font-variant-numeric:tabular-nums; box-shadow:0 8px 28px #0f172a26;
      pointer-events:none; white-space:normal; z-index:2147483647;
      transform:none; transition:none; }
    #pointlens-value-details .pointlens-tooltip-grid { display:grid;
      grid-template-columns:max-content minmax(0,1fr); gap:4px 14px; }
    #pointlens-value-details .pointlens-tooltip-grid:has(.pointlens-tooltip-cell--high) {
      grid-template-columns:max-content minmax(0,1fr) minmax(0,1fr); }
    #pointlens-value-details .pointlens-tooltip-row { display:contents; }
    #pointlens-value-details .pointlens-tooltip-cell {white-space:normal;overflow-wrap:anywhere;}
    #pointlens-value-details .pointlens-tooltip-cell--label {color:#475569;}
    #pointlens-value-details .pointlens-tooltip-divider {grid-column:1/-1;border-top:1px solid #e2e8f0;}
    [data-pointlens-tooltip] > .pointlens-tooltip {display:none !important;}
    [data-pointlens-tooltip]:focus-visible {outline:2px solid #2563eb;outline-offset:3px;border-radius:4px;}
    @media (prefers-reduced-motion:reduce) {.pointlens-skeleton{animation:none!important;}}
  `
  document.head.appendChild(style)
  document.body.appendChild(tooltip)
  window.addEventListener("scroll", hide, true)
  window.addEventListener("resize", hide)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide()
  })
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (active && !active.contains(event.target as Node)) hide()
    },
    true
  )
  return tooltip
}

export function attachTooltip(icon: HTMLElement) {
  if (icon.hasAttribute("data-pointlens-tooltip")) return
  const source = icon.querySelector<HTMLElement>(".pointlens-tooltip")
  if (!source) return
  icon.setAttribute("data-pointlens-tooltip", "")
  // Install styles before the first hover to suppress the old clipped tooltip.
  getTooltip()
  const show = () => {
    if (!icon.isConnected) {
      hide()
      return
    }
    const tip = getTooltip()
    if (active !== icon || lastContent !== source.innerHTML) {
      active?.removeAttribute("aria-describedby")
      active = icon
      lastContent = source.innerHTML
      tip.replaceChildren(
        ...Array.from(source.childNodes).map((node) => node.cloneNode(true))
      )
    }
    icon.setAttribute("aria-describedby", tip.id)
    if (!tip.matches(":popover-open")) tip.showPopover()
    const anchor = icon.getBoundingClientRect()
    const left = Math.max(
      8,
      Math.min(anchor.left, innerWidth - tip.offsetWidth - 8)
    )
    const top =
      anchor.top - tip.offsetHeight - 8 >= 8
        ? anchor.top - tip.offsetHeight - 8
        : anchor.bottom + 8
    tip.style.left = `${left}px`
    tip.style.top = `${Math.max(8, Math.min(top, innerHeight - tip.offsetHeight - 8))}px`
    tip.style.opacity = "1"
  }
  icon.addEventListener("mouseenter", show)
  icon.addEventListener("mouseleave", () => {
    if (document.activeElement !== icon) hide()
  })
  icon.addEventListener("focusin", show)
  icon.addEventListener("focusout", hide)
  // Refresh a visible tooltip when lazy stay totals or FX conversion arrive.
  new MutationObserver(() => {
    if (active === icon) show()
  }).observe(source, { childList: true, subtree: true, characterData: true })
}
