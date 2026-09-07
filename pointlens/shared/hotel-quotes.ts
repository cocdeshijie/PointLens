import type { RoomOffer } from "./room-value"

export type HotelOffer = RoomOffer & {
  hotel: string
  rate: string
  estimated?: boolean
  display?: number
}
export type HotelSnapshot = {
  key: string
  context: string
  start: string
  end: string
  scope: "search" | "rooms"
  hotels: Record<string, { name: string; cash?: boolean; points?: boolean }>
  offers: HotelOffer[]
}

export function stayNights(start: string, end: string) {
  const n = (Date.parse(end) - Date.parse(start)) / 86400000
  return /^\d{4}-\d{2}-\d{2}$/.test(start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(end) &&
    Number.isInteger(n) &&
    n > 0 &&
    n <= 365
    ? n
    : 0
}

export const amount = (value: unknown) => {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  if (value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
