import { useEffect, useState } from "react"

import IhgPopup from "./hotels/ihg/Popup"

const POPUP_MIN_WIDTH = 520
const POPUP_MIN_HEIGHT = 700

function IndexPopup() {
  const [isIhg, setIsIhg] = useState(false)

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
        minHeight: POPUP_MIN_HEIGHT,
        minWidth: POPUP_MIN_WIDTH,
        width: POPUP_MIN_WIDTH,
        padding: 16
      }}>
      <p>Open ihg.com to see the IHG popup.</p>
    </div>
  )
}

export default IndexPopup
