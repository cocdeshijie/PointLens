import { renderRoomValue, type RoomOffer } from "../../shared/room-value"

let context = "",
  offers: RoomOffer[] = [],
  selectedId = ""
const product = (link: Element | null) => {
  try {
    return (
      new URL(link?.getAttribute("href") ?? "", location.href).searchParams.get(
        "productId"
      ) ?? ""
    )
  } catch {
    return ""
  }
}
document.addEventListener(
  "click",
  (event) => {
    const link = (event.target as Element)?.closest?.('a[href*="productId="]')
    if (link) selectedId = product(link)
  },
  true
)
export function acceptMarriottRooms(data: any) {
  if (
    !data?.__POINTLENS_MARRIOTT_ROOMS__ ||
    data.context !== location.href ||
    !Array.isArray(data.offers)
  )
    return false
  context = data.context
  offers = data.offers
  return true
}
export function updateMarriottRooms(
  settings: {
    taxBasis: string
    goodValueThreshold: number
    badValueThreshold: number
  },
  toUsd: (n: number, c: string) => number | undefined
) {
  if (context !== location.href) offers = []
  const options = {
    brand: "marriott",
    pretax: settings.taxBasis === "pretax",
    nightly: false,
    good: settings.goodValueThreshold,
    bad: settings.badValueThreshold,
    toUsd
  }
  const apply = (host: HTMLElement, id: string) =>
    renderRoomValue(
      host,
      offers.find((o) => o.id === id),
      offers,
      options
    )
  document
    .querySelectorAll<HTMLElement>('[data-testid="RateCardV2"]')
    .forEach((card) => {
      const id = product(card.querySelector(".room-detail-link"))
      const host = card.querySelector<HTMLElement>(".room-desc .rate-details")
      if (host) apply(host, id)
    })
  document
    .querySelectorAll<HTMLElement>('a[data-testid="rate-modal"]')
    .forEach((link) => {
      const host = link.parentElement
      if (host) apply(host, product(link))
    })
  document
    .querySelectorAll<HTMLElement>("#rateDetailsContent,#room-details-modal")
    .forEach((modal) => {
      const heading = modal.querySelector<HTMLElement>("h1")
      if (!heading) return
      let host = modal.querySelector<HTMLElement>(
        ".pointlens-marriott-dialog-value"
      )
      if (!host) {
        host = document.createElement("div")
        host.className = "pointlens-marriott-dialog-value"
        const title = modal.querySelector(".rate-container .rate-desc")
        if (title) {
          title.after(host)
          host.style.margin = "8px 0 16px"
        } else {
          const style = getComputedStyle(heading)
          host.style.padding = `0 ${style.paddingRight} 16px ${style.paddingLeft}`
          host.style.marginTop =
            parseFloat(style.paddingBottom) >= 16 ? "-16px" : "8px"
          heading.after(host)
        }
      }
      apply(host, selectedId)
    })
}
