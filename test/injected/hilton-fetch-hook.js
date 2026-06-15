;(function () {
    const REPLAY_MARKER_HEADER = "x-av-replay"

    function getOriginalOpName(url) {
        try {
            return new URL(url).searchParams.get("originalOpName")
        } catch {
            return null
        }
    }

    function setOriginalOpNameToPoints(url) {
        try {
            const u = new URL(url)

            if (u.searchParams.get("originalOpName") === "shopMultiPropAvail") {
                u.searchParams.set("originalOpName", "shopMultiPropAvailPoints")
            }

            return u.toString()
        } catch {
            return url
        }
    }

    function ensureHhonorsInQuery(query) {
        if (!query || query.includes("hhonors")) return query

        const block = `
      hhonors {
        dailyRmPointsRate
        dailyRmPointsRateFmt
        rateChangeIndicator
        ratePlan { ratePlanName @toTitleCase }
      }
`

        const i = query.indexOf("summary")
        if (i === -1) return query

        const b = query.indexOf("{", i)
        if (b === -1) return query

        return query.slice(0, b + 1) + block + query.slice(b + 1)
    }

    function patchBodyForPoints(bodyText) {
        let obj

        try {
            obj = JSON.parse(bodyText)
        } catch {
            return bodyText
        }

        obj.variables ??= {}
        obj.variables.input ??= {}
        obj.variables.input.specialRates ??= {}

        obj.variables.input.specialRates.hhonors = true

        if (typeof obj.query === "string") {
            obj.query = ensureHhonorsInQuery(obj.query)
        }

        return JSON.stringify(obj)
    }

    function maybeSave(status, body) {
        if (status !== 200) return

        const arr = body?.data?.shopMultiPropAvail
        if (!Array.isArray(arr)) return

        window.postMessage(
            {
                __AV_HILTON_SAVE__: true,
                payload: {
                    status,
                    shopMultiPropAvail: arr
                }
            },
            "*"
        )

        console.log("[Hilton] Sent capture to extension storage")
    }

    async function doReplay(replayUrl, bodyText, label) {
        const res = await fetch(replayUrl, {
            method: "POST",
            credentials: "include",
            headers: {
                "content-type": "application/json",
                [REPLAY_MARKER_HEADER]: "1"
            },
            body: bodyText
        })

        const text = await res.text()

        let parsed
        try {
            parsed = JSON.parse(text)
        } catch {
            parsed = text
        }

        console.log(`[Hilton Replay] ${label}`, {
            status: res.status,
            body: parsed
        })

        maybeSave(res.status, parsed)
    }

    window.addEventListener("message", (ev) => {
        if (ev.source !== window) return

        const d = ev.data

        if (d?.__AV_HILTON_PRINT__) {
            console.log("[Hilton Capture]", d.payload?.meta)
        }

        if (d?.__AV_HILTON_DO_REPLAY__) {
            const { url, bodyText } = d.payload || {}
            if (!url || !bodyText) return

            const op = getOriginalOpName(url)

            ;(async () => {
                try {
                    // cash -> points
                    if (op === "shopMultiPropAvail") {
                        await doReplay(
                            setOriginalOpNameToPoints(url),
                            patchBodyForPoints(bodyText),
                            "cash->points"
                        )
                        return
                    }

                    // points as-is
                    if (op === "shopMultiPropAvailPoints") {
                        await doReplay(url, bodyText, "points-as-is")
                        return
                    }
                } catch (e) {
                    console.error("[Hilton Replay] failed", e)
                }
            })()
        }
    })
})()
