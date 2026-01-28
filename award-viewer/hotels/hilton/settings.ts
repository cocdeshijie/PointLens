export const HILTON_VALUE_SETTINGS_KEY = "award-viewer:hilton-value-settings"

export type HiltonValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
}

export const DEFAULT_HILTON_VALUE_SETTINGS: HiltonValueSettings = {
  goodValueThreshold: 0.6,
  badValueThreshold: 0.45
}

const coerceNumber = (value: unknown, fallback: number) => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export const normalizeHiltonValueSettings = (
  value?: Partial<HiltonValueSettings> | null
): HiltonValueSettings => {
  return {
    goodValueThreshold: coerceNumber(
      value?.goodValueThreshold,
      DEFAULT_HILTON_VALUE_SETTINGS.goodValueThreshold
    ),
    badValueThreshold: coerceNumber(
      value?.badValueThreshold,
      DEFAULT_HILTON_VALUE_SETTINGS.badValueThreshold
    )
  }
}
