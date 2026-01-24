import { useEffect, useState } from "react"

import IhgPopup from "./hotels/ihg/Popup"

function IndexPopup() {
  const [isIhg, setIsIhg] = useState(false)

  useEffect(() => {
    const checkActiveTab = async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        })

        const url = tab?.url ?? ""
        setIsIhg(url.includes("ihg.com"))
      } catch {
        setIsIhg(false)
      }
    }

    void checkActiveTab()
  }, [])

  if (isIhg) {
    return <IhgPopup />
  }

  return (
    <div
      style={{
        minHeight: 600,
        minWidth: 420,
        padding: 16
      }}>
      <p>Open ihg.com to see the IHG popup.</p>
    </div>
  )
}

export default IndexPopup
