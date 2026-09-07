import ValueSettingsPanel, {
  type SiteMeta
} from "../../components/ValueSettingsPanel"
import {
  BESTWESTERN_VALUE_SETTINGS_KEY,
  DEFAULT_BESTWESTERN_VALUE_SETTINGS,
  normalizeBestwesternValueSettings
} from "./settings"

function BestwesternPopup({
  onBack,
  site
}: {
  onBack?: () => void
  site: SiteMeta
}) {
  return (
    <ValueSettingsPanel
      site={site}
      onBack={onBack}
      storageKey={BESTWESTERN_VALUE_SETTINGS_KEY}
      defaults={DEFAULT_BESTWESTERN_VALUE_SETTINGS}
      normalize={normalizeBestwesternValueSettings}
    />
  )
}

export default BestwesternPopup
