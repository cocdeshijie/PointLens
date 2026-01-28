;(function () {
  const REPLAY_MARKER_HEADER = "x-av-replay"

  function ensureClusterRateType(types, value) {
    if (!Array.isArray(types)) return
    const exists = types.some(
      (entry) => entry?.type === "CLUSTER" && entry?.value === value
    )
    if (!exists) {
      types.push({ type: "CLUSTER", value })
    }
  }

  function patchBodyForClusters(bodyText) {
    let obj
    try {
      obj = JSON.parse(bodyText)
    } catch {
      return bodyText
    }

    obj.variables ??= {}
    obj.variables.search ??= {}
    obj.variables.search.options ??= {}

    const options = obj.variables.search.options
    const rateRequestTypes = Array.isArray(options.rateRequestTypes)
      ? [...options.rateRequestTypes]
      : []

    ensureClusterRateType(rateRequestTypes, "E0G")
    ensureClusterRateType(rateRequestTypes, "MRW")

    options.rateRequestTypes = rateRequestTypes

    return JSON.stringify(obj)
  }

  async function doReplay(replayUrl, bodyText, label) {
    const patchedBody = patchBodyForClusters(bodyText)
    const res = await fetch(replayUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        [REPLAY_MARKER_HEADER]: "1"
      },
      body: patchedBody
    })

    const text = await res.text()

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }

    console.log(`[Marriott Replay] ${label}`, {
      status: res.status,
      body: parsed
    })
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return

    const data = event.data

    if (data?.__AV_MARRIOTT_DO_REPLAY__) {
      const { url, bodyText } = data.payload || {}
      if (!url || !bodyText) return

      ;(async () => {
        try {
          await doReplay(url, bodyText, "cluster-replay")
        } catch (error) {
          console.error("[Marriott Replay] failed", error)
        }
      })()
    }
  })
})()
