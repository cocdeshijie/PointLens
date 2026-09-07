import {
  comparisonHost,
  installHotelContent,
  type ComparisonTarget
} from "../../shared/hotel-content"
import { installBudgetBridge } from "../../shared/pricing-budget"
import {
  BESTWESTERN_VALUE_SETTINGS_KEY,
  DEFAULT_BESTWESTERN_VALUE_SETTINGS,
  normalizeBestwesternValueSettings
} from "./settings"

installBudgetBridge("bestwestern")
const hotelId = (url: string) => url.match(/propertyCode\.([\w-]+)\.html/i)?.[1]
const date = (id: string) => {
  const value = document.querySelector<HTMLInputElement>(id)?.value
  if (!value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? undefined
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
installHotelContent({
  brand: "bestwestern",
  storageKey: BESTWESTERN_VALUE_SETTINGS_KEY,
  defaults: DEFAULT_BESTWESTERN_VALUE_SETTINGS,
  normalize: normalizeBestwesternValueSettings,
  current: (s) =>
    (!date("#checkin") || date("#checkin") === s.start) &&
    (!date("#checkout") || date("#checkout") === s.end),
  targets: () => {
    const targets: ComparisonTarget[] = []
    if (!document.getElementById("pointlens-bestwestern-layout")) {
      const style = document.createElement("style")
      style.id = "pointlens-bestwestern-layout"
      style.textContent = `.ctaContainer:has(>.pointlens-bestwestern-host){flex-wrap:wrap}.ctaContainer>.pointlens-bestwestern-host{flex-basis:100%;width:100%}.ctaContainer>.pointlens-bestwestern-host>.pointlens-room-comparison,.ctaContainer>.pointlens-bestwestern-host>.pointlens-hotel-status{justify-content:flex-end}.markerText>.pointlens-bestwestern-host{background:white;border-radius:4px;padding:0 3px}.mapMarker>.pointlens-bestwestern-map-host{position:absolute!important;top:-24px;left:0;transform:translateX(-50%);width:max-content;pointer-events:auto;cursor:pointer;z-index:901!important;filter:drop-shadow(0 1px 2px #0003)}.pointlens-bestwestern-map-host[hidden]{display:none!important}gmp-advanced-marker:has(.pointlens-bestwestern-map-host):hover,gmp-advanced-marker:has(.pointlens-bestwestern-map-host):focus-within{z-index:1000!important}`
      document.head.append(style)
    }
    document.querySelectorAll<HTMLElement>(".ctaContainer").forEach((card) => {
      const price = card.querySelector<HTMLElement>(".priceSection")
      const link = card.querySelector<HTMLAnchorElement>(
        'a[href*="propertyCode."]'
      )
      const hotel = link && hotelId(link.href)
      if (!price || !hotel) return
      targets.push({
        host: comparisonHost(card, "bestwestern"),
        hotel,
        points: /points/i.test(price.textContent ?? ""),
        scope: "search"
      })
    })
    const points = /points/i.test(
      document.querySelector(".ctaContainer .currencyCode")?.textContent ?? ""
    )
    document
      .querySelectorAll<HTMLElement>(".mapMarker:not(.unavailable) .markerText")
      .forEach((parent) => {
        const hotel = parent
          .closest(".mapMarker")
          ?.querySelector(".placeId")
          ?.textContent?.trim()
        if (hotel) {
          targets.push({
            host: comparisonHost(parent, "bestwestern"),
            hotel,
            points,
            scope: "search"
          })
          // The native markerText is hidden in Pins mode until selection.
          // Attach the glanceable value outside it, anchored to the same pin.
          const host = comparisonHost(
            parent.closest(".mapMarker")!,
            "bestwestern"
          )
          host.classList.add(
            "pointlens-bestwestern-map-host",
            "pointlens-hotel-map-host"
          )
          const expanded = getComputedStyle(parent).display !== "none"
          if (host.hidden !== expanded) host.hidden = expanded
          targets.push({ host, hotel, points, scope: "search", compact: true })
        }
      })
    const hotel = hotelId(location.href)
    if (hotel)
      document
        .querySelectorAll<HTMLElement>(
          ".roomDetailsRates .rateBox[data-rate-code]"
        )
        .forEach((row) => {
          const room = row
            .closest(".roomDetailsRates")
            ?.id.replace("room-details-rates-", "")
          const parent = row.querySelector(".ratePriceWrapper")
          if (!room || !parent) return
          targets.push({
            host: comparisonHost(parent, "bestwestern"),
            hotel,
            room,
            rate: row.dataset.rateCode,
            points: row.dataset.amountCode?.toLowerCase() === "points",
            scope: "rooms"
          })
        })
    return targets
  }
})
