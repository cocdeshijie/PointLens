import { useEffect, useMemo, useState } from "react"

const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
const IHG_SENT_STORAGE_KEY = "award-viewer:ihg-sent-request"
const IS_DEV =  process.env.NODE_ENV === "development"

type IhgRequestPayload = {
  url?: string
  method?: string
  kind?: string
  bodyType?: string
  bodyText?: string | null
  bookingType?: string
  responseBodyText?: string | null
  responseStatus?: number
  responseStatusText?: string
  responseType?: string
  requestHeaders?: chrome.webRequest.HttpHeader[]
  responseHeaders?: chrome.webRequest.HttpHeader[]
  statusCode?: number
  timestamp?: number
  receivedAt?: string
  completedAt?: string
}

type IhgSentRequest = {
  request: {
    url: string
    method: string
    headers: Record<string, string>
    body: unknown
  }
  response: {
    status: number
    statusText: string
    bodyText: string | null
    bodyParsed: unknown
  } | null
  error?: string | null
  sentAt?: string
}

type TabKey = "detected" | "sent"

const MIN_BODY_RATE_PLAN_CODES = [
  { internal: "IVAN1" },
  { internal: "IVAN3" },
  { internal: "IVAN5" },
  { internal: "IVAN6" },
  { internal: "IVAN7" },
  { internal: "IVANI" }
]

const MIN_BODY_TEMPLATE = {
  radius: 30,
  distanceType: "STRAIGHT_LINE",
  startDate: "",
  endDate: "",
  geoLocation: [{ latitude: 0, longitude: 0 }],
  products: [{ productCode: "SR", startDate: "", endDate: "" }],
  rates: {
    ratePlanCodes: MIN_BODY_RATE_PLAN_CODES
  }
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

const formatResponseBody = (payload: IhgRequestPayload | null) => {
  if (
    payload?.responseBodyText === null ||
    payload?.responseBodyText === undefined
  ) {
    return null
  }

  try {
    return JSON.parse(payload.responseBodyText)
  } catch {
    return payload.responseBodyText
  }
}

const formatResponseText = (text: string | null) => {
  if (text === null) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const saveSentRequest = async (payload: IhgSentRequest | null) => {
  if (!payload || !chrome?.storage?.local) {
    return
  }

  await chrome.storage.local.set({
    [IHG_SENT_STORAGE_KEY]: {
      ...payload,
      savedAt: new Date().toISOString()
    }
  })
}

const toHeaderRecord = (headers: chrome.webRequest.HttpHeader[]) => {
  const record: Record<string, string> = {}
  for (const header of headers) {
    if (!header.name || header.value === undefined) {
      continue
    }

    const normalized = header.name.toLowerCase()
    if (
      normalized === "content-length" ||
      normalized === "host" ||
      normalized === "origin" ||
      normalized === "referer" ||
      normalized === "accept-encoding"
    ) {
      continue
    }

    record[header.name] = header.value
  }
  return record
}

const buildMinimalBody = (requestDetails: IhgRequestPayload | null) => {
  const parsed = formatBody(requestDetails)

  const startDate =
    typeof parsed === "object" && parsed && "startDate" in parsed
      ? String((parsed as { startDate?: string }).startDate ?? "")
      : ""
  const endDate =
    typeof parsed === "object" && parsed && "endDate" in parsed
      ? String((parsed as { endDate?: string }).endDate ?? "")
      : ""
  const geoLocation =
    typeof parsed === "object" && parsed && "geoLocation" in parsed
      ? (parsed as { geoLocation?: { latitude?: number; longitude?: number }[] })
          .geoLocation ?? []
      : []
  const productCode =
    typeof parsed === "object" && parsed && "products" in parsed
      ? (parsed as { products?: { productCode?: string }[] }).products?.[0]
          ?.productCode ?? "SR"
      : "SR"

  return {
    ...MIN_BODY_TEMPLATE,
    startDate,
    endDate,
    geoLocation:
      geoLocation.length > 0
        ? geoLocation.map((entry) => ({
            latitude: entry.latitude ?? 0,
            longitude: entry.longitude ?? 0
          }))
        : MIN_BODY_TEMPLATE.geoLocation,
    products: [
      {
        productCode,
        startDate,
        endDate
      }
    ]
  }
}

const buildSentRequestPayload = (
  requestDetails: IhgRequestPayload | null,
  requestHeaders: chrome.webRequest.HttpHeader[]
): Pick<IhgSentRequest, "request"> => {
  const headers = toHeaderRecord(requestHeaders)
  headers["content-type"] = "application/json; charset=UTF-8"

  return {
    request: {
      url: requestDetails?.url ?? "",
      method: "POST",
      headers,
      body: buildMinimalBody(requestDetails)
    }
  }
}

function IhgPopup() {
  const [showDetails, setShowDetails] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [requestDetails, setRequestDetails] = useState<IhgRequestPayload | null>(
    null
  )
  const [activeTab, setActiveTab] = useState<TabKey>("detected")
  const [isSending, setIsSending] = useState(false)
  const [sentRequest, setSentRequest] = useState<IhgSentRequest | null>(null)

  const handleDebugClick = async () => {
    setShowDetails(true)
    setIsLoading(true)
    setActiveTab("detected")

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
  const formattedResponseBody = formatResponseBody(requestDetails)
  const requestHeaders = requestDetails?.requestHeaders ?? []
  const responseHeaders = requestDetails?.responseHeaders ?? []
  const minimalBody = useMemo(
    () => buildMinimalBody(requestDetails),
    [requestDetails]
  )

  useEffect(() => {
    if (!requestDetails?.url) {
      return
    }

    if (isSending || sentRequest) {
      return
    }

    setActiveTab("sent")
    setIsSending(true)

    const headers = toHeaderRecord(requestHeaders)
    headers["content-type"] = "application/json; charset=UTF-8"
    const body = minimalBody

    const sendRequest = async () => {
      try {
        const response = await fetch(requestDetails.url ?? "", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        })
        const responseBodyText = await response.text()
        const responseParsed = formatResponseText(responseBodyText)
        const nextSentRequest: IhgSentRequest = {
          request: {
            url: requestDetails.url ?? "",
            method: "POST",
            headers,
            body
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            bodyText: responseBodyText,
            bodyParsed: responseParsed
          },
          error: null,
          sentAt: new Date().toISOString()
        }
        setSentRequest(nextSentRequest)
        void saveSentRequest(nextSentRequest)
      } catch (error) {
        const nextSentRequest: IhgSentRequest = {
          request: {
            url: requestDetails.url ?? "",
            method: "POST",
            headers,
            body
          },
          response: null,
          error: error instanceof Error ? error.message : "Request failed",
          sentAt: new Date().toISOString()
        }
        setSentRequest(nextSentRequest)
        void saveSentRequest(nextSentRequest)
      } finally {
        setIsSending(false)
      }
    }

    void sendRequest()
  }, [minimalBody, requestDetails, requestHeaders, isSending, sentRequest])

  return (
    <div
      style={{
        minHeight: 700,
        minWidth: 520,
        width: 520,
        padding: 16
      }}>
      <p>im current on ihg.com</p>
      {IS_DEV ? (
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
      ) : null}
      {showDetails && IS_DEV ? (
        <div
          style={{
            border: "1px solid #ccc",
            borderRadius: 8,
            marginTop: 12,
            padding: 12
          }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              marginBottom: 12
            }}>
            <button
              type="button"
              onClick={() => {
                setActiveTab("detected")
              }}
              style={{
                background: activeTab === "detected" ? "#e7f0ff" : "#f4f4f4",
                border: "1px solid #ccc",
                borderRadius: 6,
                padding: "6px 10px"
              }}>
              Last detected request
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("sent")
              }}
              style={{
                background: activeTab === "sent" ? "#e7f0ff" : "#f4f4f4",
                border: "1px solid #ccc",
                borderRadius: 6,
                padding: "6px 10px"
              }}>
              Last request sent
            </button>
          </div>
          {isLoading ? (
            <p>Loading…</p>
          ) : activeTab === "detected" ? (
            requestDetails ? (
              <div>
                <h4
                  style={{
                    fontSize: 13,
                    margin: "0 0 6px"
                  }}>
                  Request details
                </h4>
                <pre
                  style={{
                    background: "#f7f7f7",
                    borderRadius: 6,
                    fontSize: 12,
                    margin: "0 0 12px",
                    padding: 8,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}>
                  {JSON.stringify(
                    {
                      url: requestDetails.url,
                      method: requestDetails.method,
                      statusCode: requestDetails.statusCode,
                      bodyType: requestDetails.bodyType,
                      bookingType: requestDetails.bookingType,
                      timestamp: requestDetails.timestamp,
                      receivedAt: requestDetails.receivedAt,
                      completedAt: requestDetails.completedAt,
                      responseStatus: requestDetails.responseStatus,
                      responseStatusText: requestDetails.responseStatusText,
                      responseType: requestDetails.responseType
                    },
                    null,
                    2
                  )}
                </pre>
                <h4
                  style={{
                    fontSize: 13,
                    margin: "0 0 6px"
                  }}>
                  Payload
                </h4>
                <pre
                  style={{
                    background: "#f7f7f7",
                    borderRadius: 6,
                    fontSize: 12,
                    margin: "0 0 12px",
                    padding: 8,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}>
                  {JSON.stringify(
                    {
                      bodyParsed: formattedBody,
                      bodyText: requestDetails.bodyText
                    },
                    null,
                    2
                  )}
                </pre>
                <h4
                  style={{
                    fontSize: 13,
                    margin: "0 0 6px"
                  }}>
                  Response body
                </h4>
                <pre
                  style={{
                    background: "#f7f7f7",
                    borderRadius: 6,
                    fontSize: 12,
                    margin: "0 0 12px",
                    padding: 8,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}>
                  {JSON.stringify(
                    {
                      responseParsed: formattedResponseBody,
                      responseBodyText: requestDetails.responseBodyText
                    },
                    null,
                    2
                  )}
                </pre>
                <h4
                  style={{
                    fontSize: 13,
                    margin: "0 0 6px"
                  }}>
                  Request headers
                </h4>
                <pre
                  style={{
                    background: "#f7f7f7",
                    borderRadius: 6,
                    fontSize: 12,
                    margin: "0 0 12px",
                    padding: 8,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}>
                  {JSON.stringify(requestHeaders, null, 2)}
                </pre>
                <h4
                  style={{
                    fontSize: 13,
                    margin: "0 0 6px"
                  }}>
                  Response headers
                </h4>
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
                  {JSON.stringify(responseHeaders, null, 2)}
                </pre>
              </div>
            ) : (
              <p>No request captured yet.</p>
            )
          ) : (
            <div>
              <p
                style={{
                  marginTop: 0
                }}>
                Build and send a new request based on the last detected request
                headers and a minimal body.
              </p>
              <button
                type="button"
                disabled={isSending || !requestDetails?.url}
                onClick={async () => {
                  if (!requestDetails?.url) {
                    setSentRequest({
                      request: {
                        url: "",
                        method: "POST",
                        headers: {},
                        body: minimalBody
                      },
                      response: null,
                      error: "No detected request available."
                    })
                    return
                  }

                  setIsSending(true)
                  const { request } = buildSentRequestPayload(
                    requestDetails,
                    requestHeaders
                  )
                  const body = request.body
                  const headers = request.headers

                  try {
                    const response = await fetch(request.url, {
                      method: request.method,
                      headers,
                      body: JSON.stringify(body)
                    })
                    const responseBodyText = await response.text()
                    const responseParsed = formatResponseText(responseBodyText)
                    const nextSentRequest: IhgSentRequest = {
                      request,
                      response: {
                        status: response.status,
                        statusText: response.statusText,
                        bodyText: responseBodyText,
                        bodyParsed: responseParsed
                      },
                      error: null,
                      sentAt: new Date().toISOString()
                    }
                    setSentRequest(nextSentRequest)
                    void saveSentRequest(nextSentRequest)
                  } catch (error) {
                    const nextSentRequest: IhgSentRequest = {
                      request,
                      response: null,
                      error:
                        error instanceof Error ? error.message : "Request failed",
                      sentAt: new Date().toISOString()
                    }
                    setSentRequest(nextSentRequest)
                    void saveSentRequest(nextSentRequest)
                  } finally {
                    setIsSending(false)
                  }
                }}
                style={{
                  marginBottom: 12
                }}>
                {isSending ? "Sending…" : "Send request"}
              </button>
              <h4
                style={{
                  fontSize: 13,
                  margin: "0 0 6px"
                }}>
                Request details
              </h4>
              <pre
                style={{
                  background: "#f7f7f7",
                  borderRadius: 6,
                  fontSize: 12,
                  margin: "0 0 12px",
                  padding: 8,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word"
                }}>
                {JSON.stringify(
                  {
                    url: sentRequest?.request.url ?? requestDetails?.url ?? "",
                    method: "POST",
                    sentAt: sentRequest?.sentAt ?? null
                  },
                  null,
                  2
                )}
              </pre>
              <h4
                style={{
                  fontSize: 13,
                  margin: "0 0 6px"
                }}>
                Payload
              </h4>
              <pre
                style={{
                  background: "#f7f7f7",
                  borderRadius: 6,
                  fontSize: 12,
                  margin: "0 0 12px",
                  padding: 8,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word"
                }}>
                {JSON.stringify(
                  {
                    bodyParsed: sentRequest?.request.body ?? minimalBody,
                    bodyText: JSON.stringify(sentRequest?.request.body ?? minimalBody)
                  },
                  null,
                  2
                )}
              </pre>
              <h4
                style={{
                  fontSize: 13,
                  margin: "0 0 6px"
                }}>
                Response body
              </h4>
              <pre
                style={{
                  background: "#f7f7f7",
                  borderRadius: 6,
                  fontSize: 12,
                  margin: "0 0 12px",
                  padding: 8,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word"
                }}>
                {JSON.stringify(
                  sentRequest?.response
                    ? {
                        responseParsed: sentRequest.response.bodyParsed,
                        responseBodyText: sentRequest.response.bodyText,
                        responseStatus: sentRequest.response.status,
                        responseStatusText: sentRequest.response.statusText
                      }
                    : null,
                  null,
                  2
                )}
              </pre>
              <h4
                style={{
                  fontSize: 13,
                  margin: "0 0 6px"
                }}>
                Request headers
              </h4>
              <pre
                style={{
                  background: "#f7f7f7",
                  borderRadius: 6,
                  fontSize: 12,
                  margin: "0 0 12px",
                  padding: 8,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word"
                }}>
                {JSON.stringify(sentRequest?.request.headers ?? toHeaderRecord(requestHeaders), null, 2)}
              </pre>
              {sentRequest?.error ? (
                <p
                  style={{
                    color: "#b00020",
                    margin: 0
                  }}>
                  {sentRequest.error}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default IhgPopup
