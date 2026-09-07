import { useEffect, useState } from "react"
import { useAtomValue } from "jotai"
import { FiExternalLink } from "react-icons/fi"

import type { ReleaseUpdate } from "../shared/release-updates"
import { paletteAtom } from "../state/theme"

export default function UpdateNotice() {
  const palette = useAtomValue(paletteAtom)
  const [update, setUpdate] = useState<ReleaseUpdate | null>(null)
  useEffect(() => {
    let active = true
    chrome.runtime.sendMessage({ type: "POINTLENS_CHECK_UPDATE" })
      .then((result: ReleaseUpdate | null) => { if (active) setUpdate(result) })
      .catch(() => {})
    return () => { active = false }
  }, [])
  if (!update) return null
  return (
    <div role="status" style={{ flexShrink: 0, padding: "10px 16px", textAlign: "center",
      borderTop: `1px solid ${palette.border}`, background: palette.headerBg }}>
      <a href={update.url} target="_blank" rel="noopener noreferrer"
        aria-label={`Update available: v${update.version}. View GitHub release in a new tab`}
        style={{ display: "inline-flex", alignItems: "center", gap: 7,
          color: palette.accent, fontSize: 12, fontWeight: 700, textUnderlineOffset: 3 }}>
        Update available · v{update.version}<FiExternalLink size={13} aria-hidden="true" />
      </a>
    </div>
  )
}
