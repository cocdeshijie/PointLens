import { useAtom, useAtomValue } from "jotai"
import { FiArrowLeft, FiMonitor, FiMoon, FiSun } from "react-icons/fi"
import type { IconType } from "react-icons"

import {
  paletteAtom,
  themePrefAtom,
  type ThemePref
} from "../state/theme"

const THEME_OPTIONS: { value: ThemePref; label: string; Icon: IconType }[] = [
  { value: "system", label: "System", Icon: FiMonitor },
  { value: "light", label: "Light", Icon: FiSun },
  { value: "dark", label: "Dark", Icon: FiMoon }
]

function SettingsPage({ onBack }: { onBack?: () => void }) {
  const palette = useAtomValue(paletteAtom)
  const [pref, setPref] = useAtom(themePrefAtom)

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="av-back"
            style={{
              flexShrink: 0,
              width: 34,
              height: 34,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 999,
              border: `1px solid ${palette.border}`,
              background: palette.surface,
              color: palette.textMuted,
              cursor: "pointer",
              transition: "background 0.18s ease, color 0.18s ease"
            }}
            aria-label="Back to all sites">
            <FiArrowLeft size={18} />
          </button>
        ) : null}
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              fontSize: 17,
              fontWeight: 800,
              color: palette.text,
              margin: 0,
              lineHeight: 1.2
            }}>
            Settings
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 600,
              color: palette.textFaint
            }}>
            Preferences for Point Lens
          </p>
        </div>
      </div>

      <div
        style={{
          background: palette.surface,
          borderRadius: 18,
          border: `1px solid ${palette.border}`,
          padding: 18,
          boxShadow: `0 1px 2px ${palette.shadow}`,
          minWidth: 0
        }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 800,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: palette.textFaint,
            marginBottom: 12
          }}>
          Appearance
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 8,
            padding: 4,
            background: palette.surfaceAlt,
            borderRadius: 14,
            border: `1px solid ${palette.border}`
          }}>
          {THEME_OPTIONS.map(({ value, label, Icon }) => {
            const active = pref === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => void setPref(value)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  padding: "12px 4px",
                  borderRadius: 11,
                  border: "1px solid",
                  borderColor: active ? palette.accent : "transparent",
                  background: active ? `${palette.accent}1f` : "transparent",
                  color: active ? palette.accent : palette.textMuted,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  transition: "background 0.16s ease, color 0.16s ease, border-color 0.16s ease"
                }}>
                <Icon size={18} />
                {label}
              </button>
            )
          })}
        </div>

        <p
          style={{
            margin: "12px 2px 0",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: palette.textFaint
          }}>
          “System” follows your operating system’s light or dark setting.
        </p>
      </div>
    </div>
  )
}

export default SettingsPage
