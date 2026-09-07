export const SONESTA_VALUE_SETTINGS_KEY = "pointlens:sonesta-value-settings"

export type SonestaValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
  // Which cash figure to value points against / show on badges.
  taxBasis: "pretax" | "aftertax"
}

export const DEFAULT_SONESTA_VALUE_SETTINGS: SonestaValueSettings = {
  goodValueThreshold: 1.0,
  badValueThreshold: 0.7,
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

export const normalizeSonestaValueSettings = (
  value?: Partial<SonestaValueSettings> | null
): SonestaValueSettings => {
  return {
    goodValueThreshold: coerceNumber(
      value?.goodValueThreshold,
      DEFAULT_SONESTA_VALUE_SETTINGS.goodValueThreshold
    ),
    badValueThreshold: coerceNumber(
      value?.badValueThreshold,
      DEFAULT_SONESTA_VALUE_SETTINGS.badValueThreshold
    ),
    taxBasis: coerceTaxBasis(
      value?.taxBasis,
      DEFAULT_SONESTA_VALUE_SETTINGS.taxBasis
    )
  }
}
