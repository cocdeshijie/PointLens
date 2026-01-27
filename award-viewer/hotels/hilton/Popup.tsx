import { useEffect, useState } from "react"
import { FiArrowLeft, FiTerminal, FiZap } from "react-icons/fi"

import {
  DEFAULT_HILTON_VALUE_SETTINGS,
  HILTON_VALUE_SETTINGS_KEY,
  HiltonValueSettings,
  normalizeHiltonValueSettings
} from "./settings"

const IS_DEV = process.env.NODE_ENV === "development"
const HILTON_SUMMARY_STORAGE_KEY =
  "award-viewer:hilton-last-hotel-summary-options"
const HILTON_SHOP_STORAGE_KEY =
  "award-viewer:hilton-last-shop-multi-prop-avail"

type HiltonCapturePayload = {
  url?: string
  status?: number
  operationName?: string | null
  body?: unknown
  receivedAt?: string
  tabId?: number
}

type HiltonPopupProps = {
  onBack?: () => void
  site: {
    name: string
    domain: string
  }
}

function HiltonPopup({ onBack, site }: HiltonPopupProps) {
  const [valueSettings, setValueSettings] = useState<HiltonValueSettings>(
    DEFAULT_HILTON_VALUE_SETTINGS
  )
  const [showDebug, setShowDebug] = useState(false)
  const [latestCapture, setLatestCapture] =
    useState<HiltonCapturePayload | null>(null)
  const [latestCaptureSource, setLatestCaptureSource] = useState<string | null>(
    null
  )

  useEffect(() => {
    const loadSettings = async () => {
      if (!chrome?.storage?.local) {
        setValueSettings(DEFAULT_HILTON_VALUE_SETTINGS)
        return
      }

      const stored = await chrome.storage.local.get([HILTON_VALUE_SETTINGS_KEY])
      setValueSettings(
        normalizeHiltonValueSettings(
          stored[HILTON_VALUE_SETTINGS_KEY] as
            | Partial<HiltonValueSettings>
            | undefined
        )
      )
    }

    void loadSettings()
  }, [])

  useEffect(() => {
    if (!IS_DEV || !showDebug) {
      return
    }

    if (!chrome?.storage?.local) {
      setLatestCapture(null)
      setLatestCaptureSource(null)
      return
    }

    const toTimestamp = (value?: string) => {
      if (!value) {
        return 0
      }
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? 0 : parsed
    }

    const selectLatest = (
      summary?: HiltonCapturePayload,
      shop?: HiltonCapturePayload
    ) => {
      const summaryTime = toTimestamp(summary?.receivedAt)
      const shopTime = toTimestamp(shop?.receivedAt)
      if (summaryTime === 0 && shopTime === 0) {
        return { capture: null, source: null }
      }
      if (summaryTime >= shopTime) {
        return {
          capture: summary ?? null,
          source: summary ? "hotelSummaryOptions" : null
        }
      }
      return {
        capture: shop ?? null,
        source: shop ? "shopMultiPropAvail" : null
      }
    }

    const loadCaptures = async () => {
      const stored = await chrome.storage.local.get([
        HILTON_SUMMARY_STORAGE_KEY,
        HILTON_SHOP_STORAGE_KEY
      ])
      const latest = selectLatest(
        stored[HILTON_SUMMARY_STORAGE_KEY] as HiltonCapturePayload | undefined,
        stored[HILTON_SHOP_STORAGE_KEY] as HiltonCapturePayload | undefined
      )
      setLatestCapture(latest.capture)
      setLatestCaptureSource(latest.source)
    }

    void loadCaptures()

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== "local") {
        return
      }
      if (
        changes[HILTON_SUMMARY_STORAGE_KEY] ||
        changes[HILTON_SHOP_STORAGE_KEY]
      ) {
        void loadCaptures()
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange)

    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange)
    }
  }, [showDebug])

  const updateSetting = async (
    key: keyof HiltonValueSettings,
    value: number
  ) => {
    const nextSettings = normalizeHiltonValueSettings({
      ...valueSettings,
      [key]: value
    })
    setValueSettings(nextSettings)

    if (!chrome?.storage?.local) {
      return
    }

    await chrome.storage.local.set({
      [HILTON_VALUE_SETTINGS_KEY]: nextSettings
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
            Highlight values on Hilton search results automatically when the
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
                  : DEFAULT_HILTON_VALUE_SETTINGS.goodValueThreshold
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
                  : DEFAULT_HILTON_VALUE_SETTINGS.badValueThreshold
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
      {IS_DEV ? (
        <button
          type="button"
          onClick={() => {
            setShowDebug(true)
          }}
          style={{
            width: "100%",
            padding: "14px 16px",
            borderRadius: 14,
            border: "none",
            background: "#0f172a",
            color: "#ffffff",
            fontWeight: 700,
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            boxShadow: "0 16px 24px rgba(15, 23, 42, 0.2)",
            cursor: "pointer"
          }}>
          <FiTerminal size={16} />
          Debug Hilton Request
        </button>
      ) : null}
      {showDebug && IS_DEV ? (
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 16,
            marginTop: 4,
            padding: 16,
            minHeight: 80,
            background: "#ffffff"
          }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "#94a3b8",
              marginBottom: 12
            }}>
            Latest Hilton capture
          </div>
          {latestCapture ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
                  {latestCaptureSource ?? latestCapture.operationName ?? "Unknown"}
                </div>
                <div style={{ fontSize: 11, color: "#64748b" }}>
                  {latestCapture.url ?? "Missing URL"}
                </div>
                <div style={{ fontSize: 11, color: "#64748b" }}>
                  Status: {latestCapture.status ?? "—"} • Received:{" "}
                  {latestCapture.receivedAt ?? "—"}
                </div>
              </div>
              <div
                style={{
                  background: "#f8fafc",
                  borderRadius: 12,
                  border: "1px solid #e2e8f0",
                  padding: 12,
                  fontSize: 11,
                  color: "#0f172a",
                  fontFamily: "SFMono-Regular, ui-monospace, Menlo, monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 180,
                  overflow: "auto"
                }}>
                {JSON.stringify(latestCapture.body ?? null, null, 2)}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#64748b" }}>
              No Hilton requests captured yet.
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default HiltonPopup
