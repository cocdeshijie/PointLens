import ValueSettingsPanel, {
  type SiteMeta
} from "../../components/ValueSettingsPanel"
import {
  CHOICE_VALUE_SETTINGS_KEY,
  DEFAULT_CHOICE_VALUE_SETTINGS,
  normalizeChoiceValueSettings
} from "./settings"

function ChoicePopup({
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
      storageKey={CHOICE_VALUE_SETTINGS_KEY}
      defaults={DEFAULT_CHOICE_VALUE_SETTINGS}
      normalize={normalizeChoiceValueSettings}
    />
  )
}

export default ChoicePopup
