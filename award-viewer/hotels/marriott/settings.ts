export const MARRIOTT_VALUE_SETTINGS_KEY =
  "award-viewer:marriott-value-settings"

export type MarriottValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
}

export const DEFAULT_MARRIOTT_VALUE_SETTINGS: MarriottValueSettings = {
  goodValueThreshold: 0.6,
  badValueThreshold: 0.45
}

const coerceNumber = (value: unknown, fallback: number) => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

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
    )
  }
}
