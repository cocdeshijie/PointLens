type HiltonPopupProps = {
  onBack?: () => void
  site: {
    name: string
    domain: string
  }
}

function HiltonPopup({ onBack, site }: HiltonPopupProps) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
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
            ←
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
            {site.name} capture
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 600,
              color: "#94a3b8"
            }}>
            Sample capture mode for {site.domain}
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
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: "#64748b",
            lineHeight: 1.6
          }}>
          This build keeps only the Hilton capture/replay sample. No value
          thresholds or rating UI are active in the popup.
        </p>
      </div>
    </div>
  )
}

export default HiltonPopup
