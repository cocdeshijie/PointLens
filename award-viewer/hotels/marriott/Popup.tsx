import { useEffect, useState } from "react"
import { FiArrowLeft, FiZap } from "react-icons/fi"

import {
  DEFAULT_MARRIOTT_VALUE_SETTINGS,
  MARRIOTT_VALUE_SETTINGS_KEY,
  MarriottValueSettings,
  normalizeMarriottValueSettings
} from "./settings"

type MarriottPopupProps = {
  onBack?: () => void
  site: {
    name: string
    domain: string
  }
}

function MarriottPopup({ onBack, site }: MarriottPopupProps) {
  const [valueSettings, setValueSettings] = useState<MarriottValueSettings>(
    DEFAULT_MARRIOTT_VALUE_SETTINGS
  )

  useEffect(() => {
    const loadSettings = async () => {
      if (!chrome?.storage?.local) {
        setValueSettings(DEFAULT_MARRIOTT_VALUE_SETTINGS)
        return
      }

      const stored = await chrome.storage.local.get([
        MARRIOTT_VALUE_SETTINGS_KEY
      ])
      setValueSettings(
        normalizeMarriottValueSettings(
          stored[MARRIOTT_VALUE_SETTINGS_KEY] as
            | Partial<MarriottValueSettings>
            | undefined
        )
      )
    }

    void loadSettings()
  }, [])

  const updateSetting = async (
    key: keyof MarriottValueSettings,
    value: number
  ) => {
    const nextSettings = normalizeMarriottValueSettings({
      ...valueSettings,
      [key]: value
    })
    setValueSettings(nextSettings)

    if (!chrome?.storage?.local) {
      return
    }

    await chrome.storage.local.set({
      [MARRIOTT_VALUE_SETTINGS_KEY]: nextSettings
    })
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            style={{
              padding: 8,
              borderRadius: 999,
              border: "none",
              background: "#e2e8f0",
              color: "#64748b",
              cursor: "pointer"
            }}
            aria-label="Back">
            <FiArrowLeft size={18} />
          </button>
        ) : null}
        <div>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "#0f172a",
              margin: 0
            }}>
            {site.name} settings
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 600,
              color: "#94a3b8"
            }}>
            Configuration for {site.domain}
          </p>
        </div>
      </div>
      <div
        style={{
          background: "#ffffff",
          borderRadius: 20,
          border: "1px solid #e2e8f0",
          padding: 20,
          boxShadow: "0 1px 2px rgba(15, 23, 42, 0.06)"
        }}>
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 999,
              background: "#eef2ff",
              color: "#4f46e5",
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}>
            <FiZap size={16} />
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: "#64748b",
              lineHeight: 1.5
            }}>
            Highlight values on Marriott search results automatically when the
            value meets your thresholds.
          </p>
        </div>
        <div style={{ display: "grid", gap: 16 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "#94a3b8",
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                marginLeft: 4
              }}>
              Good value threshold (¢/pt)
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={valueSettings.goodValueThreshold}
              onChange={(event) => {
                const parsed = Number.parseFloat(event.target.value)
                const nextValue = Number.isFinite(parsed)
                  ? parsed
                  : DEFAULT_MARRIOTT_VALUE_SETTINGS.goodValueThreshold
                void updateSetting("goodValueThreshold", nextValue)
              }}
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: 14,
                border: "1px solid #e2e8f0",
                background: "#f8fafc",
                fontWeight: 600
              }}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "#94a3b8",
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                marginLeft: 4
              }}>
              Bad value threshold (¢/pt)
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={valueSettings.badValueThreshold}
              onChange={(event) => {
                const parsed = Number.parseFloat(event.target.value)
                const nextValue = Number.isFinite(parsed)
                  ? parsed
                  : DEFAULT_MARRIOTT_VALUE_SETTINGS.badValueThreshold
                void updateSetting("badValueThreshold", nextValue)
              }}
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: 14,
                border: "1px solid #e2e8f0",
                background: "#f8fafc",
                fontWeight: 600
              }}
            />
          </label>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            flexWrap: "wrap"
          }}>
          <span
            style={{
              padding: "6px 10px",
              background: "#d1fae5",
              color: "#047857",
              borderRadius: 10,
              fontSize: 10,
              fontWeight: 700,
              border: "1px solid #a7f3d0",
              display: "flex",
              alignItems: "center",
              gap: 6
            }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "#10b981"
              }}
            />
            Good
          </span>
          <span
            style={{
              padding: "6px 10px",
              background: "#fef3c7",
              color: "#b45309",
              borderRadius: 10,
              fontSize: 10,
              fontWeight: 700,
              border: "1px solid #fde68a",
              display: "flex",
              alignItems: "center",
              gap: 6
            }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "#f59e0b"
              }}
            />
            Fair
          </span>
          <span
            style={{
              padding: "6px 10px",
              background: "#ffe4e6",
              color: "#be123c",
              borderRadius: 10,
              fontSize: 10,
              fontWeight: 700,
              border: "1px solid #fecdd3",
              display: "flex",
              alignItems: "center",
              gap: 6
            }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "#f43f5e"
              }}
            />
            Bad
          </span>
        </div>
      </div>
    </div>
  )
}

export default MarriottPopup
