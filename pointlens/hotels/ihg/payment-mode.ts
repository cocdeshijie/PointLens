export type IhgPaymentMode = "cash" | "points" | "mixed"

// Payment toggles can update before (or without) a URL change. The native
// selected control is authoritative; captured API rate plans are not UI state.
export function getIhgPaymentMode(): IhgPaymentMode {
  const selected = document
    .querySelector(
      '[data-testid="btnMoney"][aria-pressed="true"], [data-testid="btnPoints"][aria-pressed="true"], [data-testid="btnPoints + Cash"][aria-pressed="true"]'
    )
    ?.getAttribute("data-testid")
  if (selected === "btnMoney") return "cash"
  if (selected === "btnPoints") return "points"
  if (selected === "btnPoints + Cash") return "mixed"
  const payWith = document
    .querySelector('[role="combobox"][aria-label="Pay with"]')
    ?.textContent?.trim()
    .toLowerCase()
  if (payWith?.includes("points") && payWith.includes("cash")) return "mixed"
  if (payWith?.includes("points")) return "points"
  if (payWith?.includes("money") || payWith?.includes("cash")) return "cash"
  const params = new URLSearchParams(location.search)
  const value = params.get("qPt")
  if (value === "POINTS_CASH") return "mixed"
  if (value === "POINTS") return "points"
  if (value === "CASH") return "cash"
  return params.get("qRtP") === "RWD01" ? "points" : "cash"
}
