import type { HotelSnapshot } from "../../shared/hotel-quotes"
import { observeNativeJson } from "../../shared/native-json"
import { parseSonesta } from "./pricing"

export function installSonestaCapture() {
  let context = "",
    revision = 0
  const snapshots = new Map<string, HotelSnapshot>()
  const publish = () =>
    window.postMessage(
      { __POINTLENS_SONESTA__: true, snapshots: [...snapshots.values()] },
      location.origin
    )
  observeNativeJson(
    (url) => {
      try {
        const u = new URL(url, location.href)
        return (
          u.origin === "https://gapi.sonesta.com" &&
          u.pathname === "/guest/graphql"
        )
      } catch {
        return false
      }
    },
    (data, _url, _page, body, _request, sequence = 0) => {
      const snapshot = parseSonesta(data, body)
      if (!snapshot) return
      if (snapshot.context !== context) {
        if (sequence < revision) return
        context = snapshot.context
        snapshots.clear()
      }
      revision = Math.max(revision, sequence)
      snapshots.set(snapshot.key, snapshot)
      publish()
    }
  )
  window.addEventListener("message", (e) => {
    if (
      e.source === window &&
      e.origin === location.origin &&
      e.data?.__POINTLENS_SONESTA_READY__
    )
      publish()
  })
}
