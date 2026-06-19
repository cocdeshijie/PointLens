import ValueSettingsPanel, {
  type SiteMeta
} from "../../components/ValueSettingsPanel"
import {
  DEFAULT_MARRIOTT_VALUE_SETTINGS,
  MARRIOTT_VALUE_SETTINGS_KEY,
  normalizeMarriottValueSettings
} from "./settings"

function MarriottPopup({
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
      storageKey={MARRIOTT_VALUE_SETTINGS_KEY}
      defaults={DEFAULT_MARRIOTT_VALUE_SETTINGS}
      normalize={normalizeMarriottValueSettings}
    />
  )
}

export default MarriottPopup
