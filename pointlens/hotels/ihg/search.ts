// Cash and award requests differ in rate-plan selection. Every other input
// that affects price belongs in the identity, including hotel-list searches
// (the live site now sends geoLocation: null), rooms, guests and currency.
export const extractSearchSignature = (body: unknown): string | null => {
  let parsed: Record<string, unknown>
  try {
    parsed =
      typeof body === "string"
        ? JSON.parse(body)
        : (body as Record<string, unknown>)
  } catch {
    return null
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.startDate ||
    !parsed.endDate
  )
    return null
  const { rates, radius, maxRadius, minHotels, incrementRadiusBy, ...search } =
    parsed
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, stable(v)])
      )
    }
    return value
  }
  return JSON.stringify(stable(search))
}
