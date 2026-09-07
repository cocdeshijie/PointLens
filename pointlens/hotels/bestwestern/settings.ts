export const BESTWESTERN_VALUE_SETTINGS_KEY =
  "pointlens:bestwestern-value-settings"

export type BestwesternValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
  // Which cash figure to value points against / show on badges.
  taxBasis: "pretax" | "aftertax"
}

export const DEFAULT_BESTWESTERN_VALUE_SETTINGS: BestwesternValueSettings = {
  goodValueThreshold: 0.8,
  badValueThreshold: 0.4,
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

export const normalizeBestwesternValueSettings = (
  value?: Partial<BestwesternValueSettings> | null
): BestwesternValueSettings => {
  return {
    goodValueThreshold: coerceNumber(
      value?.goodValueThreshold,
      DEFAULT_BESTWESTERN_VALUE_SETTINGS.goodValueThreshold
    ),
    badValueThreshold: coerceNumber(
      value?.badValueThreshold,
      DEFAULT_BESTWESTERN_VALUE_SETTINGS.badValueThreshold
    ),
    taxBasis: coerceTaxBasis(
      value?.taxBasis,
      DEFAULT_BESTWESTERN_VALUE_SETTINGS.taxBasis
    )
  }
}
