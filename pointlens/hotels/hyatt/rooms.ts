import { renderRoomValue, type RoomOffer } from "../../shared/room-value"
import { hyattStayContext } from "./room-pricing"
import { renderHyattRoomStatus } from "./room-status"

let context = ""
let offers: RoomOffer[] = []
let availability = { cash: "pending", points: "pending" }
const clean = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()
export function acceptHyattRooms(data: any) {
  if (
    !data?.__POINTLENS_HYATT_ROOMS__ ||
    data.context !== hyattStayContext(location.href) ||
    !Array.isArray(data.offers)
  )
    return false
  context = data.context
  offers = data.offers
  availability = data.availability ?? { cash: "pending", points: "pending" }
  return true
}
export function updateHyattRooms(
  settings: {
    taxBasis: string
    goodValueThreshold: number
    badValueThreshold: number
  },
  toUsd: (n: number, c: string) => number | undefined
) {
  if (context !== hyattStayContext(location.href)) {
    offers = []
    availability = { cash: "pending", points: "pending" }
  }
  const pointsView =
    new URL(location.href).searchParams.get("rateFilter") === "woh" ||
    !!document.querySelector<HTMLInputElement>('input[aria-label="Use Points"]')
      ?.checked
  const options = {
    brand: "hyatt",
    allowFallback: false,
    pretax: settings.taxBasis === "pretax",
    nightly: true,
    good: settings.goodValueThreshold,
    bad: settings.badValueThreshold,
    toUsd
  }
  const cheapest = (room: string, points = pointsView) =>
    offers
      .filter((o) => o.room === room && !!o.points === points)
      .sort(
        (a, b) =>
          (points ? a.points! : a.base!) - (points ? b.points! : b.base!)
      )[0]
  const apply = (
    host: HTMLElement,
    offer: RoomOffer | undefined,
    points = pointsView
  ) => {
    renderRoomValue(host, offer, offers, options)
    if (host.querySelector(":scope > .pointlens-room-comparison")) {
      renderHyattRoomStatus(host)
      return
    }
    const ownSide = points ? "points" : "cash"
    const opposite = points ? "cash" : "points"
    const label = points ? "Cash" : "Points"
    const state = !offer ? availability[ownSide] : availability[opposite]
    if (state === "pending")
      renderHyattRoomStatus(
        host,
        `Loading ${label.toLowerCase()} comparison`,
        true
      )
    else if (state === "error")
      renderHyattRoomStatus(host, `Couldn’t load ${label.toLowerCase()}`)
    else renderHyattRoomStatus(host, offer ? `${label} unavailable` : undefined)
  }
  const roomFromName = (name: string) =>
    offers.find((o) => clean(o.roomName) === clean(name))?.room ??
    [...document.querySelectorAll<HTMLElement>('[data-locator="room-title"]')]
      .find((el) => clean(el.textContent ?? "") === clean(name))
      ?.id.replace(/-room-title$/, "")
  document
    .querySelectorAll<HTMLElement>(".room-card-divider")
    .forEach((card) => {
      const room = card
        .querySelector('[data-locator="room-title"]')
        ?.id.replace(/-room-title$/, "")
      if (!room) return
      card
        .querySelectorAll<HTMLElement>(".room-rate-content")
        .forEach((row) => {
          const name = clean(row.querySelector("span")?.textContent ?? "")
          const selected =
            offers.find((o) => o.room === room && clean(o.name) === name) ??
            cheapest(room, row.matches('[data-locator="points-rate"]'))
          apply(row, selected, row.matches('[data-locator="points-rate"]'))
        })
    })
  document
    .querySelectorAll<HTMLElement>(
      "#room_rates_modal .slide.selected > .room-rates-frame-container"
    )
    .forEach((frame) => {
      const room = roomFromName(frame.getAttribute("aria-label") ?? "")
      if (!room) return
      frame
        .querySelectorAll<HTMLElement>(".selectors-selector")
        .forEach((row) => {
          const id =
            row.querySelector<HTMLInputElement>('input[name="rate"]')?.value
          apply(
            row,
            offers.find((o) => o.id === `${room}:${id}`)
          )
          const badge = row.querySelector<HTMLElement>(
            ":scope > .pointlens-room-comparison, :scope > .pointlens-hyatt-room-status"
          )
          if (badge) badge.style.margin = "8px 20px 12px"
        })
      const selectedId = frame.querySelector<HTMLInputElement>(
        '[role="radio"][aria-checked="true"] input[name="rate"]'
      )?.value
      const footer =
        frame.querySelector<HTMLElement>(".rate_value")?.parentElement
      if (footer)
        apply(
          footer,
          offers.find((o) => o.id === `${room}:${selectedId}`)
        )
    })
  document
    .querySelectorAll<HTMLElement>(
      ".room-details-container .slide.selected > .room-details-frame-container"
    )
    .forEach((frame) => {
      const room = roomFromName(frame.querySelector("h2")?.textContent ?? "")
      const host = frame.querySelector<HTMLElement>(
        ".room-details-booking-info"
      )
      if (host && room) apply(host, cheapest(room))
    })
}
