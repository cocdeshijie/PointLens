import ValueSettingsPanel, {
  type SiteMeta
} from "../../components/ValueSettingsPanel"
import {
  DEFAULT_SONESTA_VALUE_SETTINGS,
  normalizeSonestaValueSettings,
  SONESTA_VALUE_SETTINGS_KEY
} from "./settings"

function SonestaPopup({
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
      storageKey={SONESTA_VALUE_SETTINGS_KEY}
      defaults={DEFAULT_SONESTA_VALUE_SETTINGS}
      normalize={normalizeSonestaValueSettings}
    />
  )
}

export default SonestaPopup
