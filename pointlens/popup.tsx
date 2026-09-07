import choiceIcon from "data-base64:~assets/choice.svg"
import ChoicePopup from "./hotels/choice/Popup"
import appIcon from "data-base64:~assets/icon.png"
import hiltonIcon from "data-base64:~assets/hilton.png"
import hyattIcon from "data-base64:~assets/hyatt.png"
import ihgIcon from "data-base64:~assets/ihg.png"
import marriottIcon from "data-base64:~assets/marriott.png"
import wyndhamIcon from "data-base64:~assets/wyndham.svg"
import { useAtomValue } from "jotai"
import { useEffect, useState } from "react"
import { FiChevronRight, FiSettings } from "react-icons/fi"

import SettingsPage from "./components/SettingsPage"
import type { SiteMeta } from "./components/ValueSettingsPanel"
import HiltonPopup from "./hotels/hilton/Popup"
import HyattPopup from "./hotels/hyatt/Popup"
import IhgPopup from "./hotels/ihg/Popup"
import MarriottPopup from "./hotels/marriott/Popup"
import WyndhamPopup from "./hotels/wyndham/Popup"
import { type Palette, paletteAtom } from "./state/theme"

const POPUP_WIDTH = 380
// Compact popup: tall enough to fit the Settings row + all current site cards +
// the in-flow footer on the home view; taller views (and a longer site list)
// scroll, with the footer at the very end of the content. (Chrome caps popups at
// 600px tall.)
const POPUP_HEIGHT = 552

type Site = SiteMeta & { id: string }

const SUPPORTED_SITES: readonly Site[] = [
  { id: "ihg", name: "IHG", domain: "ihg.com", accent: "#C8102E", icon: ihgIcon },
  { id: "hilton", name: "Hilton", domain: "hilton.com", accent: "#1C3D6E", icon: hiltonIcon },
  { id: "marriott", name: "Marriott", domain: "marriott.com", accent: "#9A1C36", icon: marriottIcon },
  { id: "hyatt", name: "Hyatt", domain: "hyatt.com", accent: "#0072CE", icon: hyattIcon },
  { id: "wyndham", name: "Wyndham", domain: "wyndhamhotels.com", accent: "#003c5a", icon: wyndhamIcon },
  { id: "choice", name: "Choice Hotels", domain: "choicehotels.com", accent: "#ec6b24", icon: choiceIcon },
] as const

function IndexPopup() {
  const palette = useAtomValue(paletteAtom)
  const s = makeStyles(palette)
  const year = new Date().getFullYear()
  const version = chrome?.runtime?.getManifest?.().version ?? ""
  const [activeSite, setActiveSite] = useState<string | null>(null)
  const [selectedSite, setSelectedSite] = useState<string | null>(null)
  const [forceHome, setForceHome] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    for (const el of [root, body]) {
      el.style.width = `${POPUP_WIDTH}px`
      el.style.minWidth = `${POPUP_WIDTH}px`
      el.style.height = `${POPUP_HEIGHT}px`
      el.style.minHeight = `${POPUP_HEIGHT}px`
      el.style.margin = "0"
    }

    const checkActiveTab = async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        })
        const url = tab?.url ?? ""
        const matched = SUPPORTED_SITES.find((site) => url.includes(site.domain))
        setActiveSite(matched?.id ?? null)
        if (!matched) setForceHome(false)
      } catch {
        setActiveSite(null)
        setForceHome(false)
      }
    }
    void checkActiveTab()
  }, [])

  // Keep the document background + native color-scheme in sync with the theme so
  // the popup chrome, scrollbars, and number-spinners match.
  useEffect(() => {
    document.documentElement.style.background = palette.bg
    document.body.style.background = palette.bg
    document.documentElement.style.colorScheme = palette.scheme
  }, [palette])

  const siteToShow = forceHome ? null : selectedSite ?? activeSite
  const current =
    siteToShow && !showSettings
      ? SUPPORTED_SITES.find((site) => site.id === siteToShow) ?? null
      : null

  const goHome = () => {
    setSelectedSite(null)
    setForceHome(true)
    setShowSettings(false)
  }

  const renderSite = (site: Site) => {
    const meta: SiteMeta = {
      name: site.name,
      domain: site.domain,
      accent: site.accent,
      icon: site.icon
    }
    switch (site.id) {
      case "choice":
        return <ChoicePopup onBack={goHome} site={meta} />
      case "wyndham":
        return <WyndhamPopup onBack={goHome} site={meta} />
      case "ihg":
        return <IhgPopup onBack={goHome} site={meta} />
      case "hilton":
        return <HiltonPopup onBack={goHome} site={meta} />
      case "marriott":
        return <MarriottPopup onBack={goHome} site={meta} />
      case "hyatt":
        return <HyattPopup onBack={goHome} site={meta} />
      default:
        return null
    }
  }

  let body: JSX.Element
  if (showSettings) {
    body = (
      <div key="settings" className="av-fade-slide">
        <SettingsPage onBack={() => setShowSettings(false)} />
      </div>
    )
  } else if (current) {
    body = (
      <div key={current.id} className="av-fade-slide">
        {renderSite(current)}
      </div>
    )
  } else {
    body = (
      <div className="av-fade-up">
        <button
          type="button"
          className="av-row"
          onClick={() => setShowSettings(true)}
          style={s.settingsRow}>
          <span style={s.settingsIcon}>
            <FiSettings size={17} />
          </span>
          <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 14 }}>
            Settings
          </span>
          <FiChevronRight size={18} style={{ color: palette.textFaint, flexShrink: 0 }} />
        </button>

        <div style={s.sectionLabel}>Choose a hotel program</div>
        <div style={{ display: "grid", gap: 10 }}>
          {SUPPORTED_SITES.map((site) => {
            const isActive = site.id === activeSite
            return (
              <button
                key={site.id}
                type="button"
                className="av-row"
                onClick={() => {
                  setSelectedSite(site.id)
                  setForceHome(false)
                }}
                style={{
                  ...s.siteCard,
                  borderColor: isActive ? `${site.accent}66` : palette.border
                }}>
                <span style={s.siteIcon}>
                  <img
                    src={site.icon}
                    alt=""
                    width={26}
                    height={26}
                    style={{ display: "block", borderRadius: 6 }}
                  />
                </span>
                <span style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
                  <span style={s.siteName}>{site.name}</span>
                  <span style={s.siteDomain}>{site.domain}</span>
                </span>
                {isActive ? (
                  <span
                    style={{
                      ...s.activePill,
                      color: site.accent,
                      background: `${site.accent}1f`,
                      borderColor: `${site.accent}40`
                    }}>
                    On this tab
                  </span>
                ) : null}
                <FiChevronRight
                  size={18}
                  style={{ color: palette.textFaint, flexShrink: 0 }}
                />
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div style={s.shell}>
      <header style={s.header}>
        <img src={appIcon} alt="" width={34} height={34} style={s.logo} />
        <div style={{ minWidth: 0 }}>
          <div style={s.brand}>Point Lens</div>
          <div style={s.tagline}>Points value, at a glance</div>
        </div>
      </header>

      <main className="av-scroll" style={s.main}>
        {body}
        <footer style={s.footer}>
          <span>© {year} cocdeshijie</span>
          <span style={s.footerVersion}>v{version}</span>
        </footer>
      </main>

      <style>{`
        * { box-sizing: border-box; }
        html, body { margin: 0; }
        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button { opacity: 0.4; }
        .av-scroll::-webkit-scrollbar { width: 6px; }
        .av-scroll::-webkit-scrollbar-track { background: transparent; }
        .av-scroll::-webkit-scrollbar-thumb {
          background: ${palette.scrollThumb}; border-radius: 999px;
        }
        .av-scroll::-webkit-scrollbar-thumb:hover { background: ${palette.scrollThumbHover}; }
        .av-row {
          transition: transform 0.16s ease, box-shadow 0.16s ease,
            border-color 0.16s ease, background 0.16s ease;
        }
        .av-row:hover {
          transform: translateY(-1px);
          box-shadow: 0 8px 20px ${palette.shadow};
          background: ${palette.surfaceHover};
        }
        .av-row:active { transform: translateY(0); }
        .av-back:hover { filter: brightness(0.97); }
        @keyframes avFadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes avFadeSlide {
          from { opacity: 0; transform: translateX(14px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .av-fade-up { animation: avFadeUp 0.26s ease both; }
        .av-fade-slide { animation: avFadeSlide 0.26s ease both; }
      `}</style>
    </div>
  )
}

const makeStyles = (p: Palette): Record<string, React.CSSProperties> => ({
  shell: {
    display: "flex",
    flexDirection: "column",
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    overflow: "hidden",
    background: p.bg,
    color: p.text,
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
  },
  header: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 11,
    padding: "14px 16px",
    background: p.headerBg,
    borderBottom: `1px solid ${p.border}`
  },
  logo: {
    width: 34,
    height: 34,
    borderRadius: 10,
    flexShrink: 0,
    display: "block",
    boxShadow: "0 6px 14px rgba(79, 70, 229, 0.28)"
  },
  brand: { fontSize: 15, fontWeight: 800, color: p.text, lineHeight: 1.2 },
  tagline: { fontSize: 11, fontWeight: 600, color: p.textFaint },
  main: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: 16
  },
  footer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 1,
    marginTop: 16,
    padding: "2px 8px",
    background: "transparent",
    fontSize: 9.5,
    lineHeight: 1.3,
    color: p.textFaint
  },
  footerVersion: { color: p.textFaint, opacity: 0.8 },
  settingsRow: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: 13,
    borderRadius: 14,
    border: `1px solid ${p.border}`,
    background: p.surface,
    color: p.text,
    cursor: "pointer",
    marginBottom: 16
  },
  settingsIcon: {
    flexShrink: 0,
    width: 32,
    height: 32,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: p.surfaceAlt,
    border: `1px solid ${p.border}`,
    color: p.textMuted
  },
  sectionLabel: {
    fontSize: 10.5,
    fontWeight: 800,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: p.textFaint,
    margin: "2px 2px 12px"
  },
  siteCard: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 16,
    border: `1px solid ${p.border}`,
    background: p.surface,
    color: p.text,
    cursor: "pointer"
  },
  siteIcon: {
    flexShrink: 0,
    width: 40,
    height: 40,
    borderRadius: 12,
    background: p.iconTile,
    border: `1px solid ${p.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  siteName: { display: "block", fontWeight: 700, fontSize: 14, color: p.text },
  siteDomain: {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: p.textFaint,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  },
  activePill: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid transparent",
    whiteSpace: "nowrap"
  }
})

export default IndexPopup
