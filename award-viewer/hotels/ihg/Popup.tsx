import { useEffect, useMemo, useState } from "react"
import { FiArrowLeft, FiTerminal, FiZap } from "react-icons/fi"

import {
  DEFAULT_IHG_DEAL_SETTINGS,
  IHG_DEAL_SETTINGS_KEY,
  IhgDealSettings,
  normalizeIhgDealSettings
} from "./settings"

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
  bookingType?: string
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

const detectBookingType = (body: unknown): string => {
  if (!body) {
    return "unknown"
  }

  const parsed =
    typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body) as Record<string, unknown>
          } catch {
            return null
          }
        })()
      : (body as Record<string, unknown>)

  if (!parsed || typeof parsed !== "object") {
    return "unknown"
  }

  const rates = parsed.rates as { ratePlanCodes?: unknown } | undefined
  if (Array.isArray(rates?.ratePlanCodes) && rates.ratePlanCodes.length > 0) {
    return "points"
  }

  const products = parsed.products as
    | Array<{ guestCounts?: unknown; quantity?: unknown }>
    | undefined
  if (
    Array.isArray(products) &&
    products.some(
      (product) => product.guestCounts !== undefined || product.quantity !== undefined
    )
  ) {
    return "cash"
  }

  return "unknown"
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

type IhgPopupProps = {
  onBack?: () => void
  site: {
    name: string
    domain: string
  }
}

function IhgPopup({ onBack, site }: IhgPopupProps) {
  const [showDetails, setShowDetails] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [requestDetails, setRequestDetails] = useState<IhgRequestPayload | null>(
    null
  )
  const [activeTab, setActiveTab] = useState<TabKey>("detected")
  const [isSending, setIsSending] = useState(false)
  const [sentRequest, setSentRequest] = useState<IhgSentRequest | null>(null)
  const [dealSettings, setDealSettings] = useState<IhgDealSettings>(
    DEFAULT_IHG_DEAL_SETTINGS
  )

  useEffect(() => {
    const loadSettings = async () => {
      if (!chrome?.storage?.local) {
        setDealSettings(DEFAULT_IHG_DEAL_SETTINGS)
        return
      }

      const stored = await chrome.storage.local.get([IHG_DEAL_SETTINGS_KEY])
      setDealSettings(
        normalizeIhgDealSettings(
          stored[IHG_DEAL_SETTINGS_KEY] as Partial<IhgDealSettings> | undefined
        )
      )
    }

    void loadSettings()
  }, [])

  const updateSetting = async (
    key: keyof IhgDealSettings,
    value: number
  ) => {
    const nextSettings = normalizeIhgDealSettings({
      ...dealSettings,
      [key]: value
    })
    setDealSettings(nextSettings)

    if (!chrome?.storage?.local) {
      return
    }

    await chrome.storage.local.set({
      [IHG_DEAL_SETTINGS_KEY]: nextSettings
    })
  }

  const loadSentRequest = async () => {
    if (!chrome?.storage?.local) {
      setSentRequest(null)
      return
    }

    const result = await chrome.storage.local.get(IHG_SENT_STORAGE_KEY)
    const payload = result[IHG_SENT_STORAGE_KEY] as IhgSentRequest | undefined
    setSentRequest(payload ?? null)
  }

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
    await loadSentRequest()
    setIsLoading(false)
  }

  const formattedBody = formatBody(requestDetails)
  const formattedResponseBody = formatResponseBody(requestDetails)
  const requestHeaders = requestDetails?.requestHeaders ?? []
  const responseHeaders = requestDetails?.responseHeaders ?? []
  const lastBookingType =
    requestDetails?.bookingType ?? detectBookingType(requestDetails?.bodyText ?? null)
  const minimalBody = useMemo(
    () => buildMinimalBody(requestDetails),
    [requestDetails]
  )

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
            Highlight deals on IHG search results automatically when the value
            meets your thresholds.
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
              Good deal threshold (¢/pt)
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={dealSettings.goodDealThreshold}
              onChange={(event) => {
                const parsed = Number.parseFloat(event.target.value)
                const nextValue = Number.isFinite(parsed)
                  ? parsed
                  : DEFAULT_IHG_DEAL_SETTINGS.goodDealThreshold
                void updateSetting("goodDealThreshold", nextValue)
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
              Bad deal threshold (¢/pt)
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={dealSettings.badDealThreshold}
              onChange={(event) => {
                const parsed = Number.parseFloat(event.target.value)
                const nextValue = Number.isFinite(parsed)
                  ? parsed
                  : DEFAULT_IHG_DEAL_SETTINGS.badDealThreshold
                void updateSetting("badDealThreshold", nextValue)
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
            void handleDebugClick()
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
          Debug IHG Request
        </button>
      ) : null}
      {showDetails && IS_DEV ? (
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 16,
            marginTop: 4,
            padding: 16,
            background: "#ffffff"
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
                void loadSentRequest()
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
                      bookingType: detectBookingType(minimalBody),
                      response: null,
                      error: "No detected request available."
                    })
                    return
                  }

                  if (lastBookingType === "points") {
                    setSentRequest({
                      request: {
                        url: requestDetails.url,
                        method: "POST",
                        headers: {},
                        body: minimalBody
                      },
                      bookingType: lastBookingType,
                      response: null,
                      error: "Points booking detected; replay not required."
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
                      bookingType: detectBookingType(request.body),
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
                      bookingType: detectBookingType(request.body),
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
                    sentAt: sentRequest?.sentAt ?? null,
                    bookingType: sentRequest?.bookingType ?? null
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
