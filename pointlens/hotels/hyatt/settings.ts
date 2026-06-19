export const HYATT_VALUE_SETTINGS_KEY = "pointlens:hyatt-value-settings"

export type HyattValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
  // Which cash figure to value points against / show on badges.
  taxBasis: "pretax" | "aftertax"
}

// Thresholds are ¢/pt in USD (CPP is currency-normalized before comparison — see
// content.ts toUsd()). World of Hyatt redemptions tend to run higher value than
// the other chains, so the good/bad bars sit higher.
export const DEFAULT_HYATT_VALUE_SETTINGS: HyattValueSettings = {
  goodValueThreshold: 2,
  badValueThreshold: 1.5,
  taxBasis: "aftertax"
}

const coerceNumber = (value: unknown, fallback: number) => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

const coerceTaxBasis = (
  value: unknown,
  fallback: "pretax" | "aftertax"
): "pretax" | "aftertax" =>
  value === "pretax" || value === "aftertax" ? value : fallback

export const normalizeHyattValueSettings = (
  value?: Partial<HyattValueSettings> | null
): HyattValueSettings => {
  return {
    goodValueThreshold: coerceNumber(
      value?.goodValueThreshold,
      DEFAULT_HYATT_VALUE_SETTINGS.goodValueThreshold
    ),
    badValueThreshold: coerceNumber(
      value?.badValueThreshold,
      DEFAULT_HYATT_VALUE_SETTINGS.badValueThreshold
    ),
    taxBasis: coerceTaxBasis(
      value?.taxBasis,
      DEFAULT_HYATT_VALUE_SETTINGS.taxBasis
    )
  }
}
