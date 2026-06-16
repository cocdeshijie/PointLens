export const IHG_VALUE_SETTINGS_KEY = "award-viewer:ihg-value-settings"

export type IhgValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
  // Which cash figure to value points against / show on badges.
  taxBasis: "pretax" | "aftertax"
}

export const DEFAULT_IHG_VALUE_SETTINGS: IhgValueSettings = {
  goodValueThreshold: 0.7,
  badValueThreshold: 0.5,
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

export const normalizeIhgValueSettings = (
  value?: Partial<IhgValueSettings> | null
): IhgValueSettings => {
  return {
    goodValueThreshold: coerceNumber(
      value?.goodValueThreshold,
      DEFAULT_IHG_VALUE_SETTINGS.goodValueThreshold
    ),
    badValueThreshold: coerceNumber(
      value?.badValueThreshold,
      DEFAULT_IHG_VALUE_SETTINGS.badValueThreshold
    ),
    taxBasis: coerceTaxBasis(
      value?.taxBasis,
      DEFAULT_IHG_VALUE_SETTINGS.taxBasis
    )
  }
}
