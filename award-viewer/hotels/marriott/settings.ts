export const MARRIOTT_VALUE_SETTINGS_KEY =
  "award-viewer:marriott-value-settings"

export type MarriottValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
  // Which cash figure to value points against / show on badges.
  taxBasis: "pretax" | "aftertax"
}

export const DEFAULT_MARRIOTT_VALUE_SETTINGS: MarriottValueSettings = {
  goodValueThreshold: 0.6,
  badValueThreshold: 0.45,
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

export const normalizeMarriottValueSettings = (
  value?: Partial<MarriottValueSettings> | null
): MarriottValueSettings => {
  return {
    goodValueThreshold: coerceNumber(
      value?.goodValueThreshold,
      DEFAULT_MARRIOTT_VALUE_SETTINGS.goodValueThreshold
    ),
    badValueThreshold: coerceNumber(
      value?.badValueThreshold,
      DEFAULT_MARRIOTT_VALUE_SETTINGS.badValueThreshold
    ),
    taxBasis: coerceTaxBasis(
      value?.taxBasis,
      DEFAULT_MARRIOTT_VALUE_SETTINGS.taxBasis
    )
  }
}
