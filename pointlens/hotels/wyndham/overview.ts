import { SEARCH_ENDPOINT, stayNights } from "./pricing"

// Overview pages can render cached native prices without sending a new request.
// Require an unambiguous property image and explicit stay dates before looking up
// that one hotel. Never guess dates or derive an identity from a hotel name.
export function overviewPricing(document: Document, page: string) {
  const u = new URL(page)
  if (
    !/\/overview\/?$/.test(u.pathname) ||
    !u.searchParams.has("checkInDate") ||
    !u.searchParams.has("checkOutDate") ||
    !stayNights(page)
  )
    return
  const host = document.querySelector<HTMLElement>(
    ".room-pricing-container .pricing"
  )
  if (!host || !/\d/.test(host.querySelector(".price")?.textContent ?? ""))
    return
  const properties = new Set<string>()
  for (const image of document.querySelectorAll("img[src]")) {
    const m = image
      .getAttribute("src")
      ?.match(
        /\/property-images\/[^/]+\/([a-z]{2})\/(?:[^/]+\/)+?(\d+)\/\2[_./]/i
      )
    if (m) properties.add(m[1].toUpperCase() + m[2])
  }
  if (properties.size !== 1) return
  const code = [...properties][0]
  const request = new URL(SEARCH_ENDPOINT, u.origin)
  const q = request.searchParams
  for (const [key, value] of u.searchParams) q.set(key, value)
  q.delete("checkInDate")
  q.delete("checkOutDate")
  q.delete("rateTypeFilter")
  for (const [source, target] of [
    ["checkInDate", "checkin_date"],
    ["checkOutDate", "checkout_date"]
  ]) {
    const [month, day, year] = u.searchParams.get(source)!.split(/[/-]/)
    q.set(target, `${month.padStart(2, "0")}-${day.padStart(2, "0")}-${year}`)
  }
  for (const [key, fallback] of [
    ["adults", "1"],
    ["children", "0"],
    ["rooms", "1"]
  ])
    if (!q.has(key)) q.set(key, fallback)
  q.set("brand_id", code.slice(0, 2))
  q.set("brandId", code.slice(0, 2))
  q.set("properties", code)
  q.set("useWRPoints", "true")
  return {
    host,
    hotel: code.slice(2),
    points: /points|pts/i.test(host.querySelector(".units")?.textContent ?? ""),
    url: request.href
  }
}
