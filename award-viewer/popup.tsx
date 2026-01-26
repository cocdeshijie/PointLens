import { useEffect, useState } from "react"

import IhgPopup from "./hotels/ihg/Popup"

const POPUP_MIN_WIDTH = 520
const POPUP_MIN_HEIGHT = 700
const SUPPORTED_SITES = [
  {
    id: "ihg",
    label: "IHG",
    domain: "ihg.com"
  }
] as const

type SupportedSiteId = (typeof SUPPORTED_SITES)[number]["id"]

function IndexPopup() {
  const [activeSite, setActiveSite] = useState<SupportedSiteId | null>(null)
  const [selectedSite, setSelectedSite] = useState<SupportedSiteId | null>(null)

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
      } catch {
        setActiveSite(null)
      }
    }

    void checkActiveTab()
  }, [])

  const siteToShow = activeSite ?? selectedSite

  if (siteToShow === "ihg") {
    return (
      <IhgPopup
        isActiveSite={activeSite === "ihg"}
        onBack={
          activeSite ? undefined : () => {
            setSelectedSite(null)
          }
        }
      />
    )
  }

  return (
    <div
      style={{
        minHeight: POPUP_MIN_HEIGHT,
        minWidth: POPUP_MIN_WIDTH,
        width: POPUP_MIN_WIDTH,
        padding: 16
      }}>
      <h2
        style={{
          fontSize: 16,
          margin: "0 0 8px"
        }}>
        Supported sites
      </h2>
      <p
        style={{
          marginTop: 0,
          color: "#475569"
        }}>
        Select a site to configure its popup settings.
      </p>
      <div
        style={{
          display: "grid",
          gap: 12
        }}>
        {SUPPORTED_SITES.map((site) => (
          <button
            key={site.id}
            type="button"
            onClick={() => {
              setSelectedSite(site.id)
            }}
            style={{
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              padding: "10px 12px",
              textAlign: "left",
              background: "#f8fafc"
            }}>
            <strong>{site.label}</strong>
            <div
              style={{
                color: "#64748b",
                fontSize: 12
              }}>
              {site.domain}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default IndexPopup
