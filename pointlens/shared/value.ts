// All cash inputs must use the same currency and period as the points price.
export function calculateCpp(
  cash: number | undefined,
  points: number | undefined,
  copay = 0
): number | undefined {
  if (
    cash === undefined ||
    points === undefined ||
    !Number.isFinite(cash) ||
    !Number.isFinite(points) ||
    !Number.isFinite(copay) ||
    cash <= 0 ||
    points <= 0 ||
    copay < 0
  )
    return undefined
  return ((cash - copay) / points) * 100
}
