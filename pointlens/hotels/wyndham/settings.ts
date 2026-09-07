export const WYNDHAM_VALUE_SETTINGS_KEY = "pointlens:wyndham-value-settings"

export type WyndhamValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
  // Which cash figure to value points against / show on badges.
  taxBasis: "pretax" | "aftertax"
}

export const DEFAULT_WYNDHAM_VALUE_SETTINGS: WyndhamValueSettings = {
  goodValueThreshold: 1.2,
  badValueThreshold: 0.8,
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

export const normalizeWyndhamValueSettings = (
  value?: Partial<WyndhamValueSettings> | null
): WyndhamValueSettings => {
  return {
    goodValueThreshold: coerceNumber(
      value?.goodValueThreshold,
      DEFAULT_WYNDHAM_VALUE_SETTINGS.goodValueThreshold
    ),
    badValueThreshold: coerceNumber(
      value?.badValueThreshold,
      DEFAULT_WYNDHAM_VALUE_SETTINGS.badValueThreshold
    ),
    taxBasis: coerceTaxBasis(
      value?.taxBasis,
      DEFAULT_WYNDHAM_VALUE_SETTINGS.taxBasis
    )
  }
}
