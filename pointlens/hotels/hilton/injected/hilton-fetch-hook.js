;(function () {
  if (window.__pointlensHiltonHook) return
  window.__pointlensHiltonHook = true
  const debug = document.currentScript?.dataset.debug === "true"
  const originalFetch = window.fetch
  const pending = new Map()
  const attempted = new Map()
  const observed = new Map()
  const pendingSearch = { cash: new Set(), points: new Set() }
  let blockedUntil = 0
  let sequence = 0
  const allowedFields = new Set(
    "ctyhocn statusCode currencyCode summary lowest hhonors dailyRmPointsRate rateChangeIndicator rateAmount amountAfterTax rateAmountUSD fullAmountAfterTax ratePlanCode ratePlan ratePlanName redemptionType hhonorsMembershipRequired specialRateType serviceChargesAndTaxesIncluded roomTypes roomTypeCode roomTypeName code name quickBookRate moreRatesFromRate bookNowRate roomOnlyRates requestedRoomRates specialRoomRates packageRates redemptionRoomRates hhonorsDiscountRate pointDetails pointsRate totalCostPoints cashRatePlan guarantee nonRefundable advancePurchase".split(
      " "
    )
  )
  function clean(value) {
    if (Array.isArray(value)) return value.slice(0, 200).map(clean)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => allowedFields.has(k))
        .map(([k, v]) => [k, clean(v)])
    )
  }
  function stable(v) {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, stable(v[k])])
      )
    return v
  }
  function describe(url, text) {
    try {
      const u = new URL(url, location.href)
      if (u.origin !== location.origin || u.pathname !== "/graphql/customer")
        return null
      const body = JSON.parse(text)
      const op = body.operationName
      if (
        ![
          "shopMultiPropAvail",
          "shopMultiPropAvailPoints",
          "hotel_shopAvailOptions_shopPropAvail"
        ].includes(op)
      )
        return null
      const input = body.variables?.input || body.variables
      if (!input?.arrivalDate || !input?.departureDate) return null
      if (input.modifyingReservation) return null
      const scope = { ...input }
      for (const k of [
        "cacheId",
        "ctyhocn",
        "language",
        "selectedRoomTypeCode",
        "currentlySelectedRoomTypeCode",
        "currentlySelectedRatePlanCode",
        "roomTypeSortInput"
      ])
        delete scope[k]
      scope.specialRates = { ...scope.specialRates }
      delete scope.specialRates.hhonors
      // Fingerprint stays page-local. No guest identifiers, headers or cookies leave the hook.
      const identity = JSON.stringify(stable(scope))
      return {
        url: u.href,
        body,
        input,
        identity,
        key: JSON.stringify([
          identity,
          body.variables?.ctyhocns || body.variables?.ctyhocn,
          body.query
        ]),
        points: input.specialRates?.hhonors === true
      }
    } catch {
      return null
    }
  }
  let contextIdentity = "",
    contextNumber = 0
  function metadata(req) {
    if (contextIdentity !== req.identity) {
      contextIdentity = req.identity
      contextNumber++
      observed.clear()
      pendingSearch.cash.clear()
      pendingSearch.points.clear()
    }
    const meta = {
      context: contextNumber,
      arrivalDate: req.input.arrivalDate,
      departureDate: req.input.departureDate,
      numAdults: req.input.numAdults,
      numChildren: req.input.numChildren,
      numRooms: req.input.numRooms,
      currency: req.input.displayCurrency,
      language: req.body.variables?.language,
      hotel: req.body.variables?.ctyhocn,
      points: req.points
    }
    window.postMessage({ __AV_HILTON_CONTEXT__: true, meta }, location.origin)
    return meta
  }
  function publish(req, json, meta) {
    const rows = json?.data?.shopMultiPropAvail
    if (Array.isArray(rows))
      for (const row of rows) {
        const old = observed.get(row.ctyhocn) || {}
        observed.set(row.ctyhocn, {
          cash: !!row.summary?.lowest?.rateAmount || old.cash,
          pointsChecked:
            meta.points ||
            !!row.summary?.hhonors?.dailyRmPointsRate ||
            old.pointsChecked
        })
      }
    const hotel = json?.data?.hotel
    const payload = {
      meta,
      hotels: Array.isArray(rows) ? clean(rows) : undefined,
      hotel: hotel?.shopAvail
        ? { ctyhocn: hotel.ctyhocn, shopAvail: clean(hotel.shopAvail) }
        : undefined
    }
    if (!payload.hotels && !payload.hotel) return
    window.postMessage(
      { __AV_HILTON_PRICING__: true, payload },
      location.origin
    )
    if (debug)
      console.debug("[PointLens Hilton pricing] " + JSON.stringify(payload))
  }
  function finished(status, retry) {
    let retryMs =
      Number(retry) * 1000 || Math.max(0, Date.parse(retry) - Date.now()) || 0
    if ([403, 429, 503].includes(status))
      blockedUntil = Date.now() + Math.max(900000, retryMs)
    window.postMessage(
      { __AV_HILTON_FINISHED__: true, status, retryMs },
      location.origin
    )
  }
  function budget() {
    const id = ++sequence
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ allowed: false, waitMs: 0 })
      }, 1500)
      pending.set(id, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      window.postMessage({ __AV_HILTON_BUDGET__: true, id }, location.origin)
    })
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data?.__AV_HILTON_BUDGET_REPLY__) return
    const cb = pending.get(e.data.id)
    pending.delete(e.data.id)
    cb?.({
      allowed: e.data.allowed === true,
      waitMs: Math.min(2000, Number(e.data.waitMs) || 0)
    })
  })
  function needsOther(req, json) {
    if (Array.isArray(json?.data?.shopMultiPropAvail)) {
      return json.data.shopMultiPropAvail.some((r) =>
        req.points
          ? !r.summary?.lowest?.rateAmount && !observed.get(r.ctyhocn)?.cash
          : !r.summary?.hhonors?.dailyRmPointsRate &&
            !observed.get(r.ctyhocn)?.pointsChecked
      )
    }
    const rooms = json?.data?.hotel?.shopAvail?.roomTypes
    return (
      Array.isArray(rooms) &&
      rooms.some((r) =>
        req.points
          ? ![
              r.moreRatesFromRate,
              r.bookNowRate,
              r.quickBookRate,
              ...(r.roomOnlyRates || []),
              ...(r.packageRates || [])
            ].some((c) => c?.rateAmount > 0 && !c?.ratePlan?.redemptionType)
          : !r.redemptionRoomRates?.some(
              (p) =>
                p.totalCostPoints > 0 ||
                p.pointDetails?.some((d) => d.pointsRate > 0)
            )
      )
    )
  }
  async function opposite(req, json, meta) {
    if (
      !needsOther(req, json) ||
      Date.now() < blockedUntil ||
      (attempted.get(req.key) || 0) > Date.now()
    )
      return
    // One attempt per native query for five minutes, including failure and denied budget.
    attempted.set(req.key, Date.now() + 300000)
    for (const [k, t] of attempted) if (t < Date.now()) attempted.delete(k)
    const searchQueue = req.points ? pendingSearch.cash : pendingSearch.points
    if (Array.isArray(req.body.variables?.ctyhocns))
      for (const id of req.body.variables.ctyhocns) searchQueue.add(id)
    let granted = false
    for (let turn = 0; turn < 12; turn++) {
      if (
        meta.context !== contextNumber ||
        Date.now() < blockedUntil ||
        !needsOther(req, json)
      )
        return
      const result = await budget()
      if (result.allowed) {
        granted = true
        break
      }
      if (!result.waitMs) return
      await new Promise((resolve) => setTimeout(resolve, result.waitMs + 50))
    }
    if (!granted) return
    if (meta.context !== contextNumber) {
      finished(0)
      return
    }
    const body = JSON.parse(JSON.stringify(req.body))
    if (Array.isArray(body.variables.ctyhocns)) {
      // Coalesce overlapping native batches, respecting Hilton's 20-hotel cap.
      body.variables.ctyhocns = Array.from(searchQueue)
        .filter((id) =>
          req.points
            ? !observed.get(id)?.cash
            : !observed.get(id)?.pointsChecked
        )
        .slice(0, 20)
      for (const id of body.variables.ctyhocns) searchQueue.delete(id)
      if (!body.variables.ctyhocns.length) {
        finished(0)
        return
      }
    }
    const input = body.variables.input || body.variables
    input.specialRates = { ...input.specialRates, hhonors: !req.points }
    // One hotel response supplies fallback rooms as well as the selected room.
    // Preserve dates, guests, special rates, and all booking inputs.
    if (body.operationName === "hotel_shopAvailOptions_shopPropAvail")
      delete body.variables.selectedRoomTypeCode
    if (
      !req.points &&
      body.operationName.startsWith("shopMultiPropAvail") &&
      !/hhonors\s*\{/.test(body.query || "")
    ) {
      body.query = body.query.replace(
        /summary\s*\{/,
        "summary { hhonors { dailyRmPointsRate rateChangeIndicator ratePlan { ratePlanName } }"
      )
    }
    const url = new URL(req.url)
    if (body.operationName.startsWith("shopMultiPropAvail"))
      url.searchParams.set(
        "originalOpName",
        req.points ? "shopMultiPropAvail" : "shopMultiPropAvailPoints"
      )
    try {
      const response = await originalFetch.call(window, url.href, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      })
      finished(response.status, response.headers.get("retry-after"))
      if (!response.ok) return
      const result = await response.json()
      if (meta.context === contextNumber)
        publish(req, result, { ...meta, points: !req.points })
    } catch {
      finished(0)
    }
  }
  async function observe(req, response, meta) {
    if ([403, 429, 503].includes(response.status)) {
      finished(response.status, response.headers.get("retry-after"))
      return
    }
    if (!response.ok) return
    try {
      const json = await response.json()
      if (meta.context !== contextNumber) return
      publish(req, json, meta)
      await opposite(req, json, meta)
    } catch {}
  }
  window.fetch = function (resource, init) {
    const url =
      typeof resource === "string"
        ? resource
        : resource?.url || String(resource)
    const text = init?.body
    const req = typeof text === "string" ? describe(url, text) : null
    const meta = req ? metadata(req) : null
    // Never delay, modify, or consume Hilton's own response.
    const requestClone =
      resource instanceof Request && !text ? resource.clone() : null
    const result = originalFetch.apply(this, arguments)
    if (req) result.then((r) => observe(req, r.clone(), meta)).catch(() => {})
    else if (
      resource instanceof Request &&
      !text &&
      /\/graphql\/customer/.test(url)
    ) {
      const clone = requestClone
      void clone
        .text()
        .then((t) => {
          const r = describe(url, t)
          if (r) {
            const m = metadata(r)
            return result.then((res) => observe(r, res.clone(), m))
          }
        })
        .catch(() => {})
    }
    return result
  }
  const open = XMLHttpRequest.prototype.open,
    send = XMLHttpRequest.prototype.send
  const urls = new WeakMap()
  XMLHttpRequest.prototype.open = function (method, url) {
    urls.set(this, String(url))
    return open.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (body) {
    const req = typeof body === "string" ? describe(urls.get(this), body) : null
    if (req) {
      const meta = metadata(req)
      this.addEventListener(
        "load",
        () => {
          if ([403, 429, 503].includes(this.status)) {
            finished(this.status, this.getResponseHeader("retry-after"))
            return
          }
          if (this.status !== 200 || meta.context !== contextNumber) return
          try {
            const json =
              this.responseType === "json"
                ? this.response
                : JSON.parse(this.responseText)
            publish(req, json, meta)
            void opposite(req, json, meta)
          } catch {}
        },
        { once: true }
      )
    }
    return send.apply(this, arguments)
  }
})()
