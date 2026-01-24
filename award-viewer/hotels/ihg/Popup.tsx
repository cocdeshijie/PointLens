import { useState } from "react"

const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"

type IhgRequestPayload = {
  url?: string
  method?: string
  kind?: string
  bodyType?: string
  bodyText?: string | null
  timestamp?: number
  receivedAt?: string
}

const formatBody = (payload: IhgRequestPayload | null) => {
  if (!payload?.bodyText) {
    return null
  }

  try {
    return JSON.parse(payload.bodyText)
  } catch {
    return payload.bodyText
  }
}

function IhgPopup() {
  const [showDetails, setShowDetails] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [requestDetails, setRequestDetails] = useState<IhgRequestPayload | null>(
    null
  )

  const handleDebugClick = async () => {
    setShowDetails(true)
    setIsLoading(true)

    if (!chrome?.storage?.local) {
      setRequestDetails(null)
      setIsLoading(false)
      return
    }

    const result = await chrome.storage.local.get(IHG_STORAGE_KEY)
    const payload = result[IHG_STORAGE_KEY] as IhgRequestPayload | undefined

    setRequestDetails(payload ?? null)
    setIsLoading(false)
  }

  const formattedBody = formatBody(requestDetails)

  return (
    <div
      style={{
        padding: 16
      }}>
      <p>im current on ihg.com</p>
      <button
        type="button"
        onClick={() => {
          void handleDebugClick()
        }}
        style={{
          marginTop: 12
        }}>
        Debug IHG Request
      </button>
      {showDetails ? (
        <div
          style={{
            border: "1px solid #ccc",
            borderRadius: 8,
            marginTop: 12,
            padding: 12
          }}>
          <h3
            style={{
              fontSize: 14,
              margin: "0 0 8px"
            }}>
            Last detected request
          </h3>
          {isLoading ? (
            <p>Loading…</p>
          ) : requestDetails ? (
            <pre
              style={{
                background: "#f7f7f7",
                borderRadius: 6,
                fontSize: 12,
                margin: 0,
                padding: 8,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word"
              }}>
              {JSON.stringify(
                {
                  ...requestDetails,
                  bodyParsed: formattedBody
                },
                null,
                2
              )}
            </pre>
          ) : (
            <p>No request captured yet.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default IhgPopup
