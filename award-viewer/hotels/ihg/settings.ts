export const IHG_DEAL_SETTINGS_KEY = "award-viewer:ihg-deal-settings"

export type IhgDealSettings = {
  goodDealThreshold: number
  badDealThreshold: number
}

export const DEFAULT_IHG_DEAL_SETTINGS: IhgDealSettings = {
  goodDealThreshold: 0.7,
  badDealThreshold: 0.5
}

const coerceNumber = (value: unknown, fallback: number) => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export const normalizeIhgDealSettings = (
  value?: Partial<IhgDealSettings> | null
): IhgDealSettings => {
  return {
    goodDealThreshold: coerceNumber(
      value?.goodDealThreshold,
      DEFAULT_IHG_DEAL_SETTINGS.goodDealThreshold
    ),
    badDealThreshold: coerceNumber(
      value?.badDealThreshold,
      DEFAULT_IHG_DEAL_SETTINGS.badDealThreshold
    )
  }
}
