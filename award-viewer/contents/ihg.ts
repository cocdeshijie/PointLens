import type { PlasmoCSConfig } from "plasmo"

const IHG_STORAGE_KEY = "award-viewer:ihg-last-request"
const MESSAGE_FLAG = "__AWARD_VIEWER_IHG__"

export const config: PlasmoCSConfig = {
  matches: ["https://www.ihg.com/*"],
  run_at: "document_start"
}

type IhgMessagePayload = {
  kind?: string
  url?: string
  method?: string
  bodyType?: string
  bodyText?: string | null
  timestamp?: number
}

const handleMessage = (event: MessageEvent) => {
  if (event.source !== window) {
    return
  }

  const data = event.data as Record<string, unknown> | undefined
  if (!data || data[MESSAGE_FLAG] !== true) {
    return
  }

  const payload: IhgMessagePayload = {
    kind: data.kind as string | undefined,
    url: data.url as string | undefined,
    method: data.method as string | undefined,
    bodyType: data.bodyType as string | undefined,
    bodyText: (data.bodyText as string | null) ?? null,
    timestamp: data.timestamp as number | undefined
  }

  if (!chrome?.storage?.local) {
    return
  }

  chrome.storage.local.set({
    [IHG_STORAGE_KEY]: {
      ...payload,
      receivedAt: new Date().toISOString()
    }
  })
}

window.addEventListener("message", handleMessage)
