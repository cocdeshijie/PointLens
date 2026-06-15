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

    // We want BOTH the reward clusters (MRW/P17 — carry the redemption points)
    // and STANDARD (cash) in every replay so we can compute CPP. Marriott's
    // native request shape has drifted over time (it used to send
    // STANDARD + CLUSTER E0P; it now sends STANDARD only), so don't gate on a
    // specific incoming shape — just force the reward shape unless it's already
    // exactly that (idempotent, avoids re-patching our own replay).
    const REWARD_SHAPE = [
      { type: "CLUSTER", value: "MRW" },
      { type: "STANDARD", value: "" },
      { type: "CLUSTER", value: "P17" }
    ]
    const alreadyReward =
      rateRequestTypes.length === REWARD_SHAPE.length &&
      REWARD_SHAPE.every((want) =>
        rateRequestTypes.some(
          (entry) => entry?.type === want.type && entry?.value === want.value
        )
      )

    if (!alreadyReward) {
      options.rateRequestTypes = REWARD_SHAPE
    }

    return JSON.stringify(obj)
  }

  function buildReplayHeaders(originalHeaders) {
    const headers = {}
    const ignored = new Set(["content-length", "host"])

    if (originalHeaders && typeof originalHeaders === "object") {
      for (const [key, value] of Object.entries(originalHeaders)) {
        if (!key) continue
        const normalizedKey = key.toLowerCase()
        if (ignored.has(normalizedKey)) continue
        if (typeof value === "string" && value.length > 0) {
          headers[key] = value
        }
      }
    }

    headers["content-type"] = "application/json"
    headers[REPLAY_MARKER_HEADER] = "1"

    return headers
  }

  async function doReplay(replayUrl, bodyText, label, originalHeaders) {
    const patchedBody = patchBodyForClusters(bodyText)
    const res = await fetch(replayUrl, {
      method: "POST",
      credentials: "include",
      headers: buildReplayHeaders(originalHeaders),
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

    const edges =
      parsed?.data?.search?.lowestAvailableRates?.searchByGeolocation?.edges
    if (Array.isArray(edges)) {
      const hotels = edges.map((edge) => ({
        property: edge?.node?.property ?? null,
        rates: edge?.node?.rates ?? null
      }))

      window.postMessage(
        {
          __AV_MARRIOTT_SAVE__: true,
          payload: {
            savedAt: new Date().toISOString(),
            hotels
          }
        },
        "*"
      )
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return

    const data = event.data

    if (data?.__AV_MARRIOTT_DO_REPLAY__) {
      const { url, bodyText, headers } = data.payload || {}
      if (!url || !bodyText) return

      ;(async () => {
        try {
          await doReplay(url, bodyText, "cluster-replay", headers)
        } catch (error) {
          console.error("[Marriott Replay] failed", error)
        }
      })()
    }
  })
})()
