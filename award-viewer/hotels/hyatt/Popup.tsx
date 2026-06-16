import ValueSettingsPanel, {
  type SiteMeta
} from "../../components/ValueSettingsPanel"
import {
  DEFAULT_HYATT_VALUE_SETTINGS,
  HYATT_VALUE_SETTINGS_KEY,
  normalizeHyattValueSettings
} from "./settings"

function HyattPopup({
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
      storageKey={HYATT_VALUE_SETTINGS_KEY}
      defaults={DEFAULT_HYATT_VALUE_SETTINGS}
      normalize={normalizeHyattValueSettings}
    />
  )
}

export default HyattPopup
