;(function () {
  const REPLAY_MARKER_HEADER = "x-av-replay"

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
      ? options.rateRequestTypes
      : []

    const isDefaultRequest =
      rateRequestTypes.length === 2 &&
      rateRequestTypes.some((entry) => entry?.type === "STANDARD") &&
      rateRequestTypes.some(
        (entry) => entry?.type === "CLUSTER" && entry?.value === "E0P"
      )

    if (isDefaultRequest) {
      options.rateRequestTypes = [
        { type: "CLUSTER", value: "MRW" },
        { type: "STANDARD", value: "" },
        { type: "CLUSTER", value: "P17" }
      ]
    }

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
