import { useAtomValue } from "jotai"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { FiArrowLeft } from "react-icons/fi"

import { type Palette, paletteAtom } from "../state/theme"

// Shared settings UI for every hotel popup. Each site differs only in its
// storage key + defaults + normalizer, so those are injected; the layout,
// styling, theming, and (critically) the box-sizing/containment live here once.
export type TaxBasis = "pretax" | "aftertax"

export type ValueSettings = {
  goodValueThreshold: number
  badValueThreshold: number
  taxBasis: TaxBasis
}

export type SiteMeta = {
  name: string
  domain: string
  accent: string
  icon: string
}

type ValueSettingsPanelProps = {
  site: SiteMeta
  onBack?: () => void
  storageKey: string
  defaults: ValueSettings
  normalize: (value?: Partial<ValueSettings> | null) => ValueSettings
  /** Extra content rendered below the settings card (e.g. IHG's dev panel). */
  children?: ReactNode
}

function ValueSettingsPanel({
  site,
  onBack,
  storageKey,
  defaults,
  normalize,
  children
}: ValueSettingsPanelProps) {
  const palette = useAtomValue(paletteAtom)
  const s = makeStyles(palette)
  const [settings, setSettings] = useState<ValueSettings>(defaults)
  const [focused, setFocused] = useState<keyof ValueSettings | null>(null)

  useEffect(() => {
    const load = async () => {
      if (!chrome?.storage?.local) {
        setSettings(defaults)
        return
      }
      const stored = await chrome.storage.local.get([storageKey])
      setSettings(
        normalize(stored[storageKey] as Partial<ValueSettings> | undefined)
      )
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const persist = async (next: ValueSettings) => {
    setSettings(next)
    if (!chrome?.storage?.local) return
    await chrome.storage.local.set({ [storageKey]: next })
  }

  const updateSetting = async (key: keyof ValueSettings, raw: string) => {
    const parsed = Number.parseFloat(raw)
    const value = Number.isFinite(parsed) ? parsed : (defaults[key] as number)
    await persist(normalize({ ...settings, [key]: value }))
  }

  const setBasis = (basis: TaxBasis) =>
    void persist(normalize({ ...settings, taxBasis: basis }))

  const field = (
    key: keyof ValueSettings,
    label: string,
    hint: string,
    dot: string
  ) => {
    const isFocused = focused === key
    return (
      <label style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <span style={s.fieldLabel}>
          <span style={{ ...s.fieldDot, background: dot }} />
          {label}
        </span>
        <div
          style={{
            ...s.inputWrap,
            borderColor: isFocused ? site.accent : palette.border,
            boxShadow: isFocused ? `0 0 0 3px ${site.accent}33` : "none"
          }}>
          <input
            type="number"
            min={0}
            step={0.1}
            value={settings[key]}
            onFocus={() => setFocused(key)}
            onBlur={() => setFocused(null)}
            onChange={(event) => void updateSetting(key, event.target.value)}
            style={s.input}
          />
          <span style={s.inputSuffix}>¢/pt</span>
        </div>
        <span style={s.fieldHint}>{hint}</span>
      </label>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={s.headerRow}>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="av-back"
            style={s.backButton}
            aria-label="Back to all sites">
            <FiArrowLeft size={18} />
          </button>
        ) : null}
        <div style={s.headerIcon} aria-hidden="true">
          <img
            src={site.icon}
            alt=""
            width={22}
            height={22}
            style={{ display: "block", borderRadius: 5 }}
          />
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 style={s.headerTitle}>{site.name}</h2>
          <p style={s.headerSubtitle}>{site.domain}</p>
        </div>
      </div>

      <div style={s.card}>
        <p style={s.cardIntro}>
          Highlight redemptions on <strong>{site.name}</strong> search results by
          their cents-per-point value.
        </p>

        <div style={{ marginBottom: 16 }}>
          <span style={{ ...s.fieldLabel, marginBottom: 8, display: "flex" }}>
            Value points against
          </span>
          <div style={s.segment}>
            {(
              [
                { value: "aftertax", label: "After tax" },
                { value: "pretax", label: "Pre-tax" }
              ] as const
            ).map(({ value, label }) => {
              const active = settings.taxBasis === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setBasis(value)}
                  style={{
                    ...s.segmentBtn,
                    borderColor: active ? site.accent : "transparent",
                    background: active ? `${site.accent}1f` : "transparent",
                    color: active ? site.accent : palette.textMuted
                  }}>
                  {label}
                </button>
              )
            })}
          </div>
          <span style={{ ...s.fieldHint, display: "block", marginTop: 6 }}>
            {settings.taxBasis === "aftertax"
              ? "CPP and badge price use the taxes-included total."
              : "CPP and badge price use the pre-tax room rate."}
          </span>
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          {field(
            "goodValueThreshold",
            "Good value at or above",
            "Great redemption — shown green.",
            "#10b981"
          )}
          {field(
            "badValueThreshold",
            "Poor value at or below",
            "Weak redemption — shown red.",
            "#f43f5e"
          )}
        </div>

        <div style={s.legend}>
          <span style={{ ...s.chip, ...chipColors.good }}>
            <span style={{ ...s.chipDot, background: "#10b981" }} />
            Good
          </span>
          <span style={{ ...s.chip, ...chipColors.fair }}>
            <span style={{ ...s.chipDot, background: "#f59e0b" }} />
            Fair
          </span>
          <span style={{ ...s.chip, ...chipColors.bad }}>
            <span style={{ ...s.chipDot, background: "#f43f5e" }} />
            Bad
          </span>
        </div>
      </div>

      {children}
    </div>
  )
}

const chipColors = {
  good: { background: "#d1fae5", color: "#047857", borderColor: "#a7f3d0" },
  fair: { background: "#fef3c7", color: "#b45309", borderColor: "#fde68a" },
  bad: { background: "#ffe4e6", color: "#be123c", borderColor: "#fecdd3" }
}

const makeStyles = (p: Palette): Record<string, React.CSSProperties> => ({
  headerRow: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  backButton: {
    flexShrink: 0,
    width: 34,
    height: 34,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    border: `1px solid ${p.border}`,
    background: p.surface,
    color: p.textMuted,
    cursor: "pointer",
    transition: "background 0.18s ease, color 0.18s ease"
  },
  headerIcon: {
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: 11,
    background: p.iconTile,
    border: `1px solid ${p.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: 800,
    color: p.text,
    margin: 0,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  },
  headerSubtitle: {
    margin: 0,
    fontSize: 11,
    fontWeight: 600,
    color: p.textFaint,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  },
  card: {
    background: p.surface,
    borderRadius: 18,
    border: `1px solid ${p.border}`,
    padding: 18,
    boxShadow: `0 1px 2px ${p.shadow}`,
    minWidth: 0
  },
  cardIntro: {
    margin: "0 0 16px",
    fontSize: 12.5,
    lineHeight: 1.5,
    color: p.textMuted
  },
  fieldLabel: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 12,
    fontWeight: 700,
    color: p.text
  },
  fieldDot: { width: 7, height: 7, borderRadius: 999, flexShrink: 0 },
  segment: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
    padding: 4,
    background: p.surfaceAlt,
    border: `1px solid ${p.border}`,
    borderRadius: 12
  },
  segmentBtn: {
    padding: "8px 4px",
    borderRadius: 9,
    border: "1px solid transparent",
    background: "transparent",
    fontSize: 12.5,
    fontWeight: 700,
    cursor: "pointer",
    transition: "background 0.16s ease, color 0.16s ease, border-color 0.16s ease"
  },
  inputWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 12px",
    borderRadius: 12,
    border: `1px solid ${p.border}`,
    background: p.surfaceAlt,
    transition: "border-color 0.18s ease, box-shadow 0.18s ease"
  },
  input: {
    flex: 1,
    minWidth: 0,
    width: "100%",
    padding: "11px 0",
    border: "none",
    outline: "none",
    background: "transparent",
    fontSize: 15,
    fontWeight: 700,
    color: p.text
  },
  inputSuffix: { flexShrink: 0, fontSize: 12, fontWeight: 700, color: p.textFaint },
  fieldHint: { fontSize: 11, color: p.textFaint, lineHeight: 1.4 },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
    flexWrap: "wrap"
  },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 10px",
    borderRadius: 999,
    fontSize: 10.5,
    fontWeight: 700,
    border: "1px solid transparent"
  },
  chipDot: { width: 6, height: 6, borderRadius: 999 }
})

export default ValueSettingsPanel
