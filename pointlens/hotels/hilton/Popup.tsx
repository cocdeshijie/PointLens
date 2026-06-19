import ValueSettingsPanel, {
  type SiteMeta
} from "../../components/ValueSettingsPanel"
import {
  DEFAULT_HILTON_VALUE_SETTINGS,
  HILTON_VALUE_SETTINGS_KEY,
  normalizeHiltonValueSettings
} from "./settings"

function HiltonPopup({
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
      storageKey={HILTON_VALUE_SETTINGS_KEY}
      defaults={DEFAULT_HILTON_VALUE_SETTINGS}
      normalize={normalizeHiltonValueSettings}
    />
  )
}

export default HiltonPopup
