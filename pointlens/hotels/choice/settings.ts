export const CHOICE_VALUE_SETTINGS_KEY = "pointlens:choice-value-settings"

export type ChoiceValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
  // Which cash figure to value points against / show on badges.
  taxBasis: "pretax" | "aftertax"
}

export const DEFAULT_CHOICE_VALUE_SETTINGS: ChoiceValueSettings = {
  goodValueThreshold: 1.0,
  badValueThreshold: 0.6,
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

export const normalizeChoiceValueSettings = (
  value?: Partial<ChoiceValueSettings> | null
): ChoiceValueSettings => {
  return {
    goodValueThreshold: coerceNumber(
      value?.goodValueThreshold,
      DEFAULT_CHOICE_VALUE_SETTINGS.goodValueThreshold
    ),
    badValueThreshold: coerceNumber(
      value?.badValueThreshold,
      DEFAULT_CHOICE_VALUE_SETTINGS.badValueThreshold
    ),
    taxBasis: coerceTaxBasis(
      value?.taxBasis,
      DEFAULT_CHOICE_VALUE_SETTINGS.taxBasis
    )
  }
}
