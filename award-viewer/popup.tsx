import { useEffect, useState } from "react"
import { FiChevronRight, FiGlobe } from "react-icons/fi"

import HiltonPopup from "./hotels/hilton/Popup"
import IhgPopup from "./hotels/ihg/Popup"
import MarriottPopup from "./hotels/marriott/Popup"

const POPUP_MIN_WIDTH = 380
const POPUP_MIN_HEIGHT = 560
const SUPPORTED_SITES = [
  {
    id: "ihg",
    label: "IHG",
    domain: "ihg.com",
    icon: "I"
  },
  {
    id: "hilton",
    label: "Hilton",
    domain: "hilton.com",
    icon: "H"
  },
  {
    id: "marriott",
    label: "Marriott",
    domain: "marriott.com",
    icon: "M"
  }
] as const

type SupportedSiteId = (typeof SUPPORTED_SITES)[number]["id"]

function IndexPopup() {
  const [activeSite, setActiveSite] = useState<SupportedSiteId | null>(null)
  const [selectedSite, setSelectedSite] = useState<SupportedSiteId | null>(null)
  const [forceHome, setForceHome] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const sizeValue = `${POPUP_MIN_WIDTH}px`
    const heightValue = `${POPUP_MIN_HEIGHT}px`

    root.style.minWidth = sizeValue
    root.style.width = sizeValue
    root.style.minHeight = heightValue
    root.style.height = heightValue
    body.style.minWidth = sizeValue
    body.style.width = sizeValue
    body.style.minHeight = heightValue
    body.style.height = heightValue

    const checkActiveTab = async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        })

        const url = tab?.url ?? ""
        const matchedSite = SUPPORTED_SITES.find((site) =>
          url.includes(site.domain)
        )
        setActiveSite(matchedSite?.id ?? null)
        if (!matchedSite) {
          setForceHome(false)
        }
      } catch {
        setActiveSite(null)
        setForceHome(false)
      }
    }

    void checkActiveTab()
  }, [])

  const siteToShow = forceHome ? null : selectedSite ?? activeSite
  const selectedSiteConfig =
    siteToShow === null
      ? null
      : SUPPORTED_SITES.find((site) => site.id === siteToShow) ?? null

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: POPUP_MIN_HEIGHT,
        width: POPUP_MIN_WIDTH,
        minHeight: POPUP_MIN_HEIGHT,
        minWidth: POPUP_MIN_WIDTH,
        width: POPUP_MIN_WIDTH,
        overflow: "hidden",
        border: "1px solid #e2e8f0",
        background: "#f8fafc",
        color: "#1e293b",
        fontFamily: "Inter, system-ui, sans-serif"
      }}>
      <header
        style={{
          flexShrink: 0,
          padding: 16,
          background: "#ffffff",
          borderBottom: "1px solid #e2e8f0",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          boxShadow: "0 1px 2px rgba(15, 23, 42, 0.06)",
          zIndex: 1
        }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8
          }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: "#4f46e5",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              boxShadow: "0 12px 24px rgba(79, 70, 229, 0.2)"
            }}>
            P
          </div>
        </div>
      </header>
      <main
        className="custom-scrollbar"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16
        }}>
        {selectedSiteConfig ? (
          <div className="animate-in fade-in slide-in-from-right-4">
            {selectedSiteConfig.id === "ihg" ? (
              <IhgPopup
                onBack={
                  () => {
                    setSelectedSite(null)
                    setForceHome(true)
                  }
                }
                site={{
                  name: selectedSiteConfig.label,
                  domain: selectedSiteConfig.domain
                }}
              />
            ) : selectedSiteConfig.id === "hilton" ? (
              <HiltonPopup
                onBack={
                  () => {
                    setSelectedSite(null)
                    setForceHome(true)
                  }
                }
                site={{
                  name: selectedSiteConfig.label,
                  domain: selectedSiteConfig.domain
                }}
              />
            ) : selectedSiteConfig.id === "marriott" ? (
              <MarriottPopup
                onBack={
                  () => {
                    setSelectedSite(null)
                    setForceHome(true)
                  }
                }
                site={{
                  name: selectedSiteConfig.label,
                  domain: selectedSiteConfig.domain
                }}
              />
            ) : null}
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-2">
            <div style={{ display: "grid", gap: 8 }}>
              {SUPPORTED_SITES.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => {
                    setSelectedSite(site.id)
                    setForceHome(false)
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: 16,
                    borderRadius: 16,
                    border: "1px solid #e2e8f0",
                    background: "#ffffff",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "all 0.2s ease"
                  }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        background: "#f1f5f9",
                        color: "#475569",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700
                      }}>
                      {site.icon}
                    </div>
                    <div>
                      <div
                        style={{
                          fontWeight: 700,
                          color: "#0f172a"
                        }}>
                        {site.label}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "#94a3b8",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontWeight: 600
                        }}>
                        <FiGlobe size={10} />
                        {site.domain}
                      </div>
                    </div>
                  </div>
                  <FiChevronRight size={18} style={{ color: "#cbd5e1" }} />
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e2e8f0;
          border-radius: 10px;
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slide-in-from-bottom-2 {
          from { transform: translateY(8px); }
          to { transform: translateY(0); }
        }
        @keyframes slide-in-from-right-4 {
          from { transform: translateX(16px); }
          to { transform: translateX(0); }
        }
        .animate-in {
          animation-duration: 0.3s;
          animation-fill-mode: both;
        }
        .fade-in {
          animation-name: fade-in;
        }
        .slide-in-from-bottom-2 {
          animation-name: slide-in-from-bottom-2;
        }
        .slide-in-from-right-4 {
          animation-name: slide-in-from-right-4;
        }
      `}</style>
    </div>
  )
}

export default IndexPopup
