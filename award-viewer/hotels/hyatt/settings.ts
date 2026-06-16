export const HYATT_VALUE_SETTINGS_KEY = "award-viewer:hyatt-value-settings"

export type HyattValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
}

// World of Hyatt points are commonly valued around ~1.7¢/pt, so the default
// "good" bar sits a touch above that and "bad" well below. These are ¢/pt in USD
// (CPP is currency-normalized before comparison — see content.ts toUsd()).
export const DEFAULT_HYATT_VALUE_SETTINGS: HyattValueSettings = {
  goodValueThreshold: 1.7,
  badValueThreshold: 1.2
}

const coerceNumber = (value: unknown, fallback: number) => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

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
    )
  }
}
