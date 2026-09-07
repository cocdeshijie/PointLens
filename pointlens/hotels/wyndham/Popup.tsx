import ValueSettingsPanel, {
  type SiteMeta
} from "../../components/ValueSettingsPanel"
import {
  DEFAULT_WYNDHAM_VALUE_SETTINGS,
  normalizeWyndhamValueSettings,
  WYNDHAM_VALUE_SETTINGS_KEY
} from "./settings"

function WyndhamPopup({
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
      storageKey={WYNDHAM_VALUE_SETTINGS_KEY}
      defaults={DEFAULT_WYNDHAM_VALUE_SETTINGS}
      normalize={normalizeWyndhamValueSettings}
    />
  )
}

export default WyndhamPopup
