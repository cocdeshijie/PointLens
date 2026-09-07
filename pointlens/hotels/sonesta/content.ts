import {
  comparisonHost,
  installHotelContent,
  type ComparisonTarget
} from "../../shared/hotel-content"
import type { HotelSnapshot } from "../../shared/hotel-quotes"
import {
  DEFAULT_SONESTA_VALUE_SETTINGS,
  normalizeSonestaValueSettings,
  SONESTA_VALUE_SETTINGS_KEY
} from "./settings"

const normalize = (text: string) =>
  text.replace(/&amp;/gi, "&").toLowerCase().replace(/\s+/g, " ").trim()
const dateMatches = (id: string, date: string) => {
  const input = document.querySelector<HTMLInputElement>(id)
  if (!input?.value) return true
  const formatted = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit"
  })
  return (
    input.value === formatted || input.value === formatted.replace(/ 0/, " ")
  )
}
const findHotel = (snapshots: HotelSnapshot[], name: string) => {
  const matches = snapshots
    .flatMap((s) => Object.entries(s.hotels))
    .filter(([, h]) => normalize(h.name) === normalize(name))
  const ids = [...new Set(matches.map(([id]) => id))]
  return ids.length === 1 ? ids[0] : `pending:${name}`
}

installHotelContent({
  brand: "sonesta",
  storageKey: SONESTA_VALUE_SETTINGS_KEY,
  defaults: DEFAULT_SONESTA_VALUE_SETTINGS,
  normalize: normalizeSonestaValueSettings,
  immediateSelector: ".leaflet-marker-icon.hotel-icon",
  current: (s) =>
    dateMatches("#checkin-date", s.start) &&
    dateMatches("#checkout-date", s.end),
  targets: (snapshots) => {
    const targets: ComparisonTarget[] = []
    document
      .querySelectorAll<HTMLElement>('[id="hotel-room-price"]')
      .forEach((card) => {
        const button = card.querySelector('[aria-label^="Select for "]')
        const name = button
          ?.getAttribute("aria-label")
          ?.replace(/^Select for /, "")
        const parent = card.querySelector(".price-div")
        if (!name || !parent) return
        targets.push({
          host: comparisonHost(parent, "sonesta"),
          hotel: findHotel(snapshots, name),
          points: false
        })
      })
    const title = document.querySelector("#hotel-name")?.textContent?.trim()
    const hotel = title
      ? findHotel(snapshots, title)
      : document.querySelector("main")?.textContent?.match(/crsCode=(\d+)/)?.[1]
    if (hotel) {
      document
        .querySelectorAll<HTMLButtonElement>("button[data-room]")
        .forEach((button) => {
          if (button.disabled) return
          const card = button.closest('[id^="room-card-"]')
          const parent = card?.querySelector(".PriceWrapper")
          if (!parent) return
          const room = button.dataset.room!,
            display = Number(button.dataset.roomprice)
          const offers = snapshots
            .flatMap((s) => s.offers)
            .filter((o) => o.hotel === hotel && o.room === room)
          const rate = offers.find(
            (o) =>
              !o.points &&
              o.display !== undefined &&
              Math.abs(o.display - display) < 0.01
          )?.rate
          targets.push({
            host: comparisonHost(parent, "sonesta"),
            hotel,
            room,
            rate,
            points: false
          })
        })
      // Checkout's rate list identifies each rate, while the reservation summary
      // names the selected room. Never match a similarly named room or suite.
      const roomName = document
        .querySelector('svg[data-icon="bed"] + div')
        ?.textContent?.trim()
      const rooms = [
        ...new Set(
          snapshots
            .flatMap((s) => s.offers)
            .filter(
              (o) =>
                o.hotel === hotel &&
                normalize(o.roomName) === normalize(roomName ?? "")
            )
            .map((o) => o.room)
        )
      ]
      const room =
        rooms.length === 1 ? rooms[0] : `pending:${roomName ?? "room"}`
      document
        .querySelectorAll<HTMLElement>(".rate-card-list-group-item")
        .forEach((card) => {
          const total = card.querySelector('[id^="rate-total-"]')
          const rate = total?.id.match(/^rate-total-(.+)-offer-\d+$/)?.[1]
          const parent = card.querySelector(".rate-fees-coloumn")
          if (!rate || !parent) return
          targets.push({
            host: comparisonHost(parent, "sonesta"),
            hotel,
            room,
            rate,
            points: /pts|points/i.test(
              card.querySelector(".rate-fees")?.textContent ?? ""
            )
          })
        })
      document
        .querySelectorAll<HTMLElement>(
          ".modal.show #rate-card-modal-title,.modal.show #total-stay-summary-modal-title"
        )
        .forEach((title) => {
          const offer = snapshots
            .flatMap((s) => s.offers)
            .find(
              (o) =>
                o.hotel === hotel &&
                o.room === room &&
                normalize(o.name) === normalize(title.textContent ?? "")
            )
          if (offer)
            targets.push({
              host: comparisonHost(title.parentElement!, "sonesta"),
              hotel,
              room,
              rate: offer.rate,
              points: !!offer.points,
              nightly: title.id !== "total-stay-summary-modal-title"
            })
        })
    }
    document
      .querySelectorAll<HTMLElement>(".leaflet-marker-icon.hotel-icon")
      .forEach((marker) => {
        const name = marker.querySelector("img")?.alt
        if (
          !name ||
          /sold out/i.test(marker.querySelector(".price")?.textContent ?? "")
        )
          return
        const host = comparisonHost(marker, "sonesta")
        host.classList.add(
          "pointlens-sonesta-map-host",
          "pointlens-hotel-map-host"
        )
        targets.push({
          host,
          hotel: findHotel(snapshots, name),
          points: false,
          compact: true
        })
      })
    if (!document.getElementById("pointlens-sonesta-layout")) {
      const style = document.createElement("style")
      style.id = "pointlens-sonesta-layout"
      style.textContent = `.price-div>.pointlens-sonesta-host{width:100%;order:2}.leaflet-marker-icon.hotel-icon:has(>.pointlens-sonesta-map-host){width:max-content!important;min-width:84px;height:auto!important;box-sizing:border-box;align-items:center;padding:4px 5px;gap:0;border:2px solid transparent}.leaflet-marker-icon.hotel-icon.active:has(>.pointlens-sonesta-map-host){border-color:#707070}.leaflet-marker-icon.hotel-icon:has(>.pointlens-sonesta-map-host)>.price{width:100%;white-space:nowrap;font-size:14px;line-height:18px}.leaflet-marker-icon.hotel-icon:has(>.pointlens-sonesta-map-host)>div:has(>img){width:64px;height:28px;display:flex;align-items:center;justify-content:center}.leaflet-marker-icon.hotel-icon:has(>.pointlens-sonesta-map-host)>div>img{max-width:64px;max-height:28px!important;width:auto;height:auto;object-fit:contain}.pointlens-sonesta-map-host{position:static!important;transform:none;width:max-content!important;flex-shrink:0;margin-top:3px}.leaflet-marker-icon.hotel-icon:hover,.leaflet-marker-icon.hotel-icon.active,.leaflet-marker-icon.hotel-icon:focus-visible{z-index:1000!important}`
      document.head.append(style)
    }
    return targets
  }
})
