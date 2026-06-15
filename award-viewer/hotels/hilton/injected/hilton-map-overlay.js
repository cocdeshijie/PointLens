;(function () {
  // Runs in the page MAIN world (needs window.google.maps). Renders our own
  // cents-per-point badges as Google Advanced Markers on the search map.
  //
  // Hilton draws its own price pins on a WebGL canvas (no per-pin DOM), so we
  // cannot annotate them directly the way we do IHG's HTML markers. Instead we
  // place our OWN AdvancedMarkerElement at each hotel's coordinate — the data
  // comes from the page's native `hotelSummaryOptions` GraphQL response, which
  // carries ctyhocn + coordinate + reward points + lowest cash for every hotel
  // in the map viewport (no login or replay needed).

  const BADGE_CLASS = "award-viewer-map-cpp"
  const STYLE_ID = "award-viewer-map-cpp-style"

  // ctyhocn -> { lat, lng, points, cash, cpp, hasReward, name }
  const hotelData = new Map()
  // Authoritative rates from the content script (Hilton's own shopMultiPropAvail,
  // the same source the list cards use). These carry the AFTER-TAX total and the
  // correct CPP, which hotelSummaryOptions (our default map source) cannot give —
  // it only has the pre-tax "lead" rate, often a non-refundable promo. When we
  // have an authoritative entry for a hotel we display it instead, so a map badge
  // matches its list card / pin-click window exactly.
  // ctyhocn -> { points, cash, cpp, hasReward }
  const authRates = new Map()
  // ctyhocn -> { marker, sig }
  const markers = new Map()

  let mapInstance = null
  let AdvancedMarkerElement = null
  let settings = { goodValueThreshold: 0.6, badValueThreshold: 0.45 }

  // Hilton's map has a "Use Points" toggle: cash mode shows blue pins (cash
  // first), points mode shows teal pins (points first). We mirror both.
  let pointsMode = false
  function detectPointsMode() {
    try {
      const labels = document.querySelectorAll("label")
      for (const l of labels) {
        if (/use points/i.test(l.textContent || "")) {
          const cb = l.querySelector("input[type=checkbox]")
          if (cb) return !!cb.checked
        }
      }
    } catch {}
    return false
  }
  function refreshMode() {
    const m = detectPointsMode()
    if (m !== pointsMode) {
      pointsMode = m
      restyleMarkers()
    }
  }
  setInterval(refreshMode, 600)

  // Any graphql/customer URL we've seen — we swap its operationName to replay the
  // quadrant + summary ops ourselves (the queries are hardcoded minimally below).
  let graphqlBaseUrl = null
  let quadrantsRequested = false

  // ----------------------------------------------------------------
  // Settings bridge (content script, ISOLATED world -> here)
  // ----------------------------------------------------------------
  window.addEventListener("message", (event) => {
    if (event.source !== window) return
    const data = event.data
    if (data && data.__AV_HILTON_MAP_SETTINGS__ && data.settings) {
      settings = {
        goodValueThreshold:
          typeof data.settings.goodValueThreshold === "number"
            ? data.settings.goodValueThreshold
            : settings.goodValueThreshold,
        badValueThreshold:
          typeof data.settings.badValueThreshold === "number"
            ? data.settings.badValueThreshold
            : settings.badValueThreshold
      }
      restyleMarkers()
    }

    // Authoritative per-hotel rates from the content script (shopMultiPropAvail).
    if (data && data.__AV_HILTON_AUTH_RATES__ && Array.isArray(data.rates)) {
      let changed = false
      for (const r of data.rates) {
        if (!r || typeof r.id !== "string") continue
        const next = {
          points: typeof r.points === "number" ? r.points : undefined,
          cash: typeof r.cash === "number" ? r.cash : undefined,
          cpp: typeof r.cpp === "number" ? r.cpp : undefined,
          hasReward: r.rewardStatus === "available"
        }
        authRates.set(r.id, next)
        changed = true
      }
      if (changed) scheduleRender()
    }
  })

  // Merge the authoritative (after-tax, list-card-accurate) rate over the
  // hotelSummaryOptions data, keeping coordinates/name/brand from the latter.
  // shopRates (our own date-aware shopMultiPropAvail fetch) wins over authRates
  // (Hilton's captured shop data relayed by the content script) — both beat the
  // generic leadRate baked into hotelData.
  function effective(id, d) {
    const a = shopRates.get(id) || authRates.get(id)
    if (!a) return d
    // Confirmed unavailable for these dates (shopMultiPropAvail returned no cash
    // and no points). Show an explicit "Unavailable" badge — do NOT fall back to
    // the generic leadRate, which would resurrect a wrong "$88 No reward".
    if (a.unavailable) {
      return {
        lat: d.lat,
        lng: d.lng,
        name: d.name,
        brandCode: d.brandCode,
        addr: d.addr,
        points: undefined,
        cash: undefined,
        cpp: null,
        hasReward: false
      }
    }
    return {
      lat: d.lat,
      lng: d.lng,
      name: d.name,
      brandCode: d.brandCode,
      addr: d.addr,
      points: typeof a.points === "number" ? a.points : d.points,
      cash: typeof a.cash === "number" ? a.cash : d.cash,
      cpp: typeof a.cpp === "number" ? a.cpp : d.cpp,
      hasReward: a.hasReward
    }
  }

  // ----------------------------------------------------------------
  // Capture native hotelSummaryOptions responses (fetch + XHR)
  // ----------------------------------------------------------------
  function isSummaryUrl(url) {
    return (
      typeof url === "string" &&
      url.indexOf("/graphql/customer") !== -1 &&
      url.indexOf("hotelSummaryOptions") !== -1
    )
  }
  function isQuadrantsUrl(url) {
    return (
      typeof url === "string" &&
      url.indexOf("/graphql/customer") !== -1 &&
      url.indexOf("hotelQuadrants") !== -1
    )
  }

  function noteGraphqlUrl(url) {
    if (
      !graphqlBaseUrl &&
      typeof url === "string" &&
      url.indexOf("/graphql/customer") !== -1
    ) {
      graphqlBaseUrl = url
    }
  }

  function buildGraphqlUrl(op) {
    if (!graphqlBaseUrl) return null
    try {
      const u = new URL(graphqlBaseUrl, location.origin)
      u.searchParams.set("operationName", op)
      u.searchParams.set("originalOpName", op)
      return u.toString()
    } catch {
      return graphqlBaseUrl
    }
  }

  function handleResponseJson(json) {
    ingest(json)
    ingestQuadrants(json)
  }

  const origFetch = window.fetch
  window.fetch = function (...args) {
    const input = args[0]
    const url = typeof input === "string" ? input : input && input.url
    try {
      noteGraphqlUrl(url)
    } catch {}
    const p = origFetch.apply(this, args)
    try {
      if (isSummaryUrl(url) || isQuadrantsUrl(url)) {
        p.then((res) => {
          res
            .clone()
            .json()
            .then(handleResponseJson)
            .catch(() => {})
        }).catch(() => {})
      }
    } catch {}
    return p
  }

  const origOpen = XMLHttpRequest.prototype.open
  const origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__avUrl = url
    return origOpen.call(this, method, url, ...rest)
  }
  XMLHttpRequest.prototype.send = function (body) {
    const u = this.__avUrl
    try {
      noteGraphqlUrl(u)
    } catch {}
    if (isSummaryUrl(u) || isQuadrantsUrl(u)) {
      this.addEventListener("load", () => {
        try {
          handleResponseJson(JSON.parse(this.responseText))
        } catch {}
      })
    }
    return origSend.call(this, body)
  }

  // Minimal hardcoded queries requesting only the fields we read. Parameter-less
  // hotelQuadrants returns the whole tree; hotelSummaryOptions takes a quadrantId.
  const QUADRANTS_QUERY =
    "query hotelQuadrants { hotelQuadrants { id bounds { northeast { latitude longitude } southwest { latitude longitude } } } }"
  const SUMMARY_QUERY =
    "query hotelSummaryOptions($language: String!, $input: HotelSummaryOptionsInput) { hotelSummaryOptions(language: $language, input: $input) { hotels { ctyhocn name brandCode address { addressLine1 city stateName } localization { coordinate { latitude longitude } } leadRate { lowest { rateAmount(currencyCode: \"USD\") } hhonors { lead { dailyRmPointsRate } min { rateAmount dailyRmPointsRate } max { rateAmount dailyRmPointsRate } } } } } }"

  // Make sure we have the quadrant tree (one parameter-less fetch).
  function ensureQuadrantTree() {
    if (quadrantCells.size > 0 || quadrantsRequested) return
    const url = buildGraphqlUrl("hotelQuadrants")
    if (!url) return
    quadrantsRequested = true
    try {
      origFetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: QUADRANTS_QUERY,
          operationName: "hotelQuadrants",
          variables: {}
        })
      })
        .then((r) => r.json())
        .then(ingestQuadrants)
        .catch(() => {
          quadrantsRequested = false
        })
    } catch {
      quadrantsRequested = false
    }
  }

  // Collect every array of hotel-like objects (have ctyhocn + coordinate/rate)
  // anywhere in a JSON tree. Handles the live fetch shape
  // (data.hotelSummaryOptions.hotels), the geocode shape
  // (data.geocode.hotelSummaryOptions = array), and the SSR __NEXT_DATA__ tree.
  function collectHotelArrays(root) {
    const out = []
    const seen = new Set()
    const stack = [[root, 0]]
    while (stack.length) {
      const [o, d] = stack.pop()
      if (!o || typeof o !== "object" || d > 16 || seen.has(o)) continue
      seen.add(o)
      if (Array.isArray(o)) {
        if (
          o.length &&
          o[0] &&
          typeof o[0] === "object" &&
          o[0].ctyhocn &&
          o[0].localization
        ) {
          out.push(o)
          continue
        }
        for (const x of o) stack.push([x, d + 1])
        continue
      }
      for (const k in o) {
        try {
          if (o[k] && typeof o[k] === "object") stack.push([o[k], d + 1])
        } catch {}
      }
    }
    return out
  }

  function ingest(json) {
    const arrays = json ? collectHotelArrays(json.data) : []
    for (const a of arrays) ingestHotels(a)
  }

  function ingestHotels(hotels) {
    if (!Array.isArray(hotels)) return
    let changed = false
    for (const h of hotels) {
      const id = h && h.ctyhocn
      if (!id) continue

      const coord =
        h.localization && h.localization.coordinate
          ? h.localization.coordinate
          : null
      const lat = coord && coord.latitude
      const lng = coord && coord.longitude
      if (typeof lat !== "number" || typeof lng !== "number") continue

      const lead = h.leadRate || null
      const hhonors = lead && lead.hhonors ? lead.hhonors : null
      const points =
        hhonors && hhonors.lead ? hhonors.lead.dailyRmPointsRate : undefined
      // Cash anchor for ¢/pt = cheapest cash rate. Live hotelSummaryOptions uses
      // leadRate.lowest; the SSR __NEXT_DATA__ shape has no `lowest` and instead
      // exposes the cash on hhonors.min/max — fall back to those (min = cheapest,
      // matching the list-card "lowest cash ÷ standard points" CPP).
      const lowest = lead && lead.lowest ? lead.lowest : null
      let cash = lowest ? lowest.rateAmount : undefined
      if (typeof cash !== "number" && hhonors) {
        if (hhonors.min && typeof hhonors.min.rateAmount === "number") {
          cash = hhonors.min.rateAmount
        } else if (hhonors.max && typeof hhonors.max.rateAmount === "number") {
          cash = hhonors.max.rateAmount
        }
      }

      const hasReward = !!(typeof points === "number" && points > 0)
      const cpp =
        hasReward && typeof cash === "number" && cash > 0
          ? (cash / points) * 100
          : null

      const addr = h.address || null
      const addrText = addr
        ? [addr.addressLine1, addr.city].filter(Boolean).join(", ")
        : ""

      hotelData.set(id, {
        lat,
        lng,
        points,
        cash,
        cpp,
        hasReward,
        name: h.name,
        brandCode: h.brandCode || null,
        addr: addrText
      })
      changed = true
    }

    if (changed) {
      ensureMap()
      renderMarkers()
      schedulePostRates()
      schedulePrices()
    }
  }

  // Share our (comprehensive) hotel rates with the content script so the list
  // cards and the pin-click dialog can show CPP even when Hilton's own
  // shopMultiPropAvail capture is incomplete.
  let postRatesTimer = null
  function schedulePostRates() {
    clearTimeout(postRatesTimer)
    postRatesTimer = setTimeout(postRates, 1000)
  }
  function postRates() {
    const rates = []
    for (const [id, d] of hotelData) {
      rates.push({ id, points: d.points, cash: d.cash, cpp: d.cpp, hasReward: d.hasReward })
    }
    try {
      window.postMessage({ __AV_HILTON_RATES__: true, rates }, "*")
    } catch {}
  }

  // Seed from server-rendered search data. __NEXT_DATA__ carries the search's
  // hotelSummaryOptions (ctyhocn + coordinate + leadRate) for the initial view,
  // so we get correct markers immediately without driving the quadrant-based
  // fetch API. Loads after our document_start script, so retried via the poll.
  let seededNextData = false
  let seedWaits = 0
  function seedFromNextData() {
    if (seededNextData) return
    const el = document.getElementById("__NEXT_DATA__")
    if (!el || !el.textContent) {
      // __NEXT_DATA__ not in the DOM yet — wait a bounded number of polls.
      if (++seedWaits > 40) seededNextData = true
      return
    }
    // Present: parse + deep-walk exactly ONCE (it's a 140KB tree, far too heavy
    // to run every poll). Whatever we find seeds the map; the quadrant replay
    // covers the rest, so we stop regardless of success.
    seededNextData = true
    try {
      const arrays = collectHotelArrays(JSON.parse(el.textContent))
      for (const a of arrays) ingestHotels(a)
    } catch {}
  }

  // ----------------------------------------------------------------
  // Acquire the page's Google Map instance
  // ----------------------------------------------------------------
  function adoptMarkerLib(g) {
    if (AdvancedMarkerElement) return
    if (g && g.maps && g.maps.marker && g.maps.marker.AdvancedMarkerElement) {
      AdvancedMarkerElement = g.maps.marker.AdvancedMarkerElement
      renderMarkers()
      return
    }
    // Marker library loads on demand; pull it in ourselves. Called repeatedly by
    // the poll until it lands — Google caches the library, so retries are cheap
    // and we avoid a sticky in-flight guard that could wedge if a call hangs.
    if (g && g.maps && typeof g.maps.importLibrary === "function") {
      g.maps
        .importLibrary("marker")
        .then((lib) => {
          if (lib && lib.AdvancedMarkerElement && !AdvancedMarkerElement) {
            AdvancedMarkerElement = lib.AdvancedMarkerElement
            renderMarkers()
          }
        })
        .catch(() => {})
    }
  }

  // Lock onto the first *sizeable, visible* map (the page builds several small
  // hidden maps too — gmStyleCount was 8 — so guard on the container size).
  function onMapCreated(inst) {
    if (!inst || mapInstance) return
    try {
      const div = inst.getDiv && inst.getDiv()
      const r = div && div.getBoundingClientRect ? div.getBoundingClientRect() : null
      if (!r || r.width < 250 || r.height < 250) return
    } catch {
      return
    }
    mapInstance = inst
    adoptMarkerLib(window.google)
    renderMarkers()
    installIdleTrigger(inst)
  }

  // Robust, flicker-free coverage by replaying Hilton's own quadrant API instead
  // of nudging the map. `hotelQuadrants` (parameter-less) returns the full
  // quadtree of cells, each with bounds; `hotelSummaryOptions(quadrantId)` returns
  // the hotels in one leaf cell. On idle we find the leaf cells intersecting the
  // viewport and fetch each one we haven't fetched yet.
  const quadrantCells = new Map() // id -> { ne:{lat,lng}, sw:{lat,lng} }
  const fetchedQuadrants = new Set()
  let idleDebounce = null

  function ingestQuadrants(json) {
    const cells = json && json.data && json.data.hotelQuadrants
    if (!Array.isArray(cells)) return
    let added = false
    for (const c of cells) {
      if (!c || !c.id || !c.bounds || quadrantCells.has(c.id)) continue
      const ne = c.bounds.northeast
      const sw = c.bounds.southwest
      if (!ne || !sw) continue
      quadrantCells.set(c.id, {
        ne: { lat: ne.latitude, lng: ne.longitude },
        sw: { lat: sw.latitude, lng: sw.longitude }
      })
      added = true
    }
    if (added) fetchVisibleQuadrants()
  }

  // A cell is a leaf (a real fetch target) if none of its 4 children are present.
  function isLeaf(id) {
    return (
      !quadrantCells.has(id + "::nw") &&
      !quadrantCells.has(id + "::ne") &&
      !quadrantCells.has(id + "::sw") &&
      !quadrantCells.has(id + "::se")
    )
  }

  function intersectsViewport(cell, b) {
    return !(
      cell.sw.lat > b.n ||
      cell.ne.lat < b.s ||
      cell.sw.lng > b.e ||
      cell.ne.lng < b.w
    )
  }

  function replaySummary(quadrantId) {
    const url = buildGraphqlUrl("hotelSummaryOptions")
    if (!url || fetchedQuadrants.has(quadrantId)) return
    fetchedQuadrants.add(quadrantId)
    try {
      origFetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: SUMMARY_QUERY,
          operationName: "hotelSummaryOptions",
          variables: {
            language: "en",
            input: { quadrantId: quadrantId, guestLocationCountry: "US" }
          }
        })
      })
        .then((r) => r.json())
        .then(ingest)
        .catch(() => {
          fetchedQuadrants.delete(quadrantId) // allow retry later
        })
    } catch {
      fetchedQuadrants.delete(quadrantId)
    }
  }

  function fetchVisibleQuadrants() {
    if (!mapInstance || !graphqlBaseUrl || quadrantCells.size === 0) return
    let b
    try {
      const bb = mapInstance.getBounds()
      if (!bb) return
      const ne = bb.getNorthEast()
      const sw = bb.getSouthWest()
      b = { n: ne.lat(), e: ne.lng(), s: sw.lat(), w: sw.lng() }
    } catch {
      return
    }
    let count = 0
    for (const [id, cell] of quadrantCells) {
      if (fetchedQuadrants.has(id)) continue
      if (!isLeaf(id)) continue
      if (!intersectsViewport(cell, b)) continue
      replaySummary(id)
      if (++count >= 24) break // safety cap per pass
    }
  }

  // ----------------------------------------------------------------
  // Date-specific pricing via shopMultiPropAvail
  // ----------------------------------------------------------------
  // hotelSummaryOptions (above) only carries a generic, DATE-INDEPENDENT "from"
  // rate with no points — it literally rejects arrival/departure inputs. Hilton's
  // real per-date prices + reward points (and the after-tax totals the list cards
  // show) come from shopMultiPropAvail, keyed by the search's dates. We replay it
  // for the hotels in view so a map badge matches its list card / pin-click window.
  // Two passes per batch: hhonors:true yields points + the reward room's cash for
  // hotels with award availability; hhonors:false yields the cash "from" price for
  // the rest (e.g. a Spark with no points left for these dates → "$X No reward").
  const PRICE_QUERY =
    'query shopMultiPropAvail($ctyhocns: [String!], $language: String!, $input: ShopMultiPropAvailQueryInput!) { shopMultiPropAvail(input: $input, language: $language, ctyhocns: $ctyhocns) { ctyhocn statusCode summary { hhonors { dailyRmPointsRate ratePlan { ratePlanName } } lowest { rateAmount(currencyCode: "USD") amountAfterTax(currencyCode: "USD") ratePlanCode ratePlan { ratePlanName } } } } }'

  // ctyhocn -> { points, cash, cpp, hasReward } from shopMultiPropAvail (date-aware).
  const shopRates = new Map()
  const pricedKeys = new Set() // `${ctyhocn}@${arrival_departure}` already resolved
  const queuedKeys = new Set() // currently in-flight (prevents duplicate fetches)
  const PRICE_BATCH = 20 // shopMultiPropAvail rejects >20 ctyhocns ("Constraint Violation")
  let priceDebounce = null

  function getSearchInput() {
    try {
      const p = new URLSearchParams(location.search)
      const arrivalDate = p.get("arrivalDate")
      const departureDate = p.get("departureDate")
      if (!arrivalDate || !departureDate) return null
      return {
        arrivalDate,
        departureDate,
        numAdults: parseInt(p.get("numAdults") || "1", 10) || 1,
        numChildren: parseInt(p.get("numChildren") || "0", 10) || 0,
        numRooms: parseInt(p.get("numRooms") || "1", 10) || 1
      }
    } catch {
      return null
    }
  }

  function priceInput(si, useHhonors) {
    return {
      guestId: 0,
      guestLocationCountry: "US",
      arrivalDate: si.arrivalDate,
      departureDate: si.departureDate,
      numAdults: si.numAdults,
      numChildren: si.numChildren,
      numRooms: si.numRooms,
      childAges: [],
      ratePlanCodes: [],
      rateCategoryTokens: [],
      specialRates: {
        aaa: false,
        aarp: false,
        corporateId: "",
        governmentMilitary: false,
        groupCode: "",
        hhonors: useHhonors,
        lta: false,
        pnd: "",
        offerId: null,
        promoCode: "",
        senior: false,
        smb: false,
        travelAgent: false,
        teamMember: false,
        familyAndFriends: false,
        owner: false,
        ownerHGV: false
      }
    }
  }

  function postShop(ctyhocns, si, useHhonors) {
    const url = buildGraphqlUrl("shopMultiPropAvail")
    if (!url) return Promise.resolve(null)
    try {
      return origFetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationName: "shopMultiPropAvail",
          query: PRICE_QUERY,
          variables: { language: "en", input: priceInput(si, useHhonors), ctyhocns }
        })
      })
        .then((r) => r.json())
        .catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }

  function shopRows(json) {
    const rows = json && json.data && json.data.shopMultiPropAvail
    return Array.isArray(rows) ? rows : []
  }
  function lowestAmount(row) {
    const lo = row && row.summary && row.summary.lowest
    if (!lo) return undefined
    if (typeof lo.amountAfterTax === "number") return lo.amountAfterTax
    if (typeof lo.rateAmount === "number") return lo.rateAmount
    return undefined
  }

  function fetchPriceBatch(ctyhocns, si, key) {
    const keys = ctyhocns.map((id) => id + "@" + key)
    keys.forEach((k) => queuedKeys.add(k))
    return Promise.all([
      postShop(ctyhocns, si, true),
      postShop(ctyhocns, si, false)
    ])
      .then(([ptsJson, cashJson]) => {
        const cashById = new Map()
        for (const r of shopRows(cashJson)) {
          if (r && r.ctyhocn) cashById.set(r.ctyhocn, lowestAmount(r))
        }
        // Reward hotels: points + the (after-tax) reward-room cash → CPP.
        for (const r of shopRows(ptsJson)) {
          if (!r || !r.ctyhocn) continue
          const hh = r.summary && r.summary.hhonors
          const points =
            hh && typeof hh.dailyRmPointsRate === "number"
              ? hh.dailyRmPointsRate
              : undefined
          if (typeof points !== "number" || points <= 0) continue
          const cash = lowestAmount(r)
          const anchor = typeof cash === "number" ? cash : cashById.get(r.ctyhocn)
          const cpp =
            typeof anchor === "number" && anchor > 0
              ? (anchor / points) * 100
              : null
          shopRates.set(r.ctyhocn, {
            points,
            cash: anchor,
            cpp,
            hasReward: true
          })
        }
        // The rest: cash "from" price, marked no-reward.
        const cashOk = !!(
          cashJson &&
          cashJson.data &&
          Array.isArray(cashJson.data.shopMultiPropAvail)
        )
        for (const id of ctyhocns) {
          const existing = shopRates.get(id)
          if (existing && existing.hasReward) continue
          const cash = cashById.get(id)
          if (typeof cash === "number") {
            shopRates.set(id, { points: undefined, cash, cpp: null, hasReward: false })
          } else if (cashOk && !(existing && existing.cash != null)) {
            // Cash pass succeeded but this hotel has no cash and no points →
            // sold out / unavailable for these dates. Mark it so we draw an
            // "Unavailable" badge over Hilton's pin instead of leaving the pin.
            shopRates.set(id, { unavailable: true, hasReward: false })
          }
        }
        // Mark a hotel resolved only if we actually learned something (it has a
        // rate now) OR the cash pass succeeded (so "no data" genuinely means
        // unavailable). If the cash pass errored, leave it unpriced so the next
        // idle retries it — otherwise a transient error sticks it on the generic
        // leadRate forever.
        for (const id of ctyhocns) {
          const k = id + "@" + key
          queuedKeys.delete(k)
          if (shopRates.has(id) || cashOk) pricedKeys.add(k)
        }
        scheduleRender()
      })
      .catch(() => {
        keys.forEach((k) => queuedKeys.delete(k)) // allow retry
      })
  }

  function fetchVisiblePrices() {
    if (!mapInstance || !graphqlBaseUrl) return
    const si = getSearchInput()
    if (!si) return
    const key = si.arrivalDate + "_" + si.departureDate
    let b
    try {
      const bb = mapInstance.getBounds()
      if (!bb) return
      const ne = bb.getNorthEast()
      const sw = bb.getSouthWest()
      b = { n: ne.lat(), e: ne.lng(), s: sw.lat(), w: sw.lng() }
    } catch {
      return
    }
    const pending = []
    let moreRemain = false
    for (const [id, d] of hotelData) {
      const k = id + "@" + key
      if (pricedKeys.has(k) || queuedKeys.has(k)) continue
      if (d.lat > b.n || d.lat < b.s || d.lng > b.e || d.lng < b.w) continue
      if (pending.length >= 120) {
        moreRemain = true // cap concurrency per pass; come back for the rest
        break
      }
      pending.push(id)
    }
    for (let i = 0; i < pending.length; i += PRICE_BATCH) {
      fetchPriceBatch(pending.slice(i, i + PRICE_BATCH), si, key)
    }
    // A wide viewport can hold more hotels than one pass prices. Without this,
    // the leftover isolated ones never get a badge and keep showing Hilton's
    // native pin. Re-run once these resolve (queued/priced ones are skipped).
    if (moreRemain) schedulePrices()
  }

  function schedulePrices() {
    clearTimeout(priceDebounce)
    priceDebounce = setTimeout(fetchVisiblePrices, 500)
  }

  // Respect Hilton's clustering: it collapses nearby hotels into count "circles"
  // and only shows individual pins where they're spaced out — density-based, not
  // a fixed zoom. We mirror it by hiding a badge whenever another hotel sits
  // within CLUSTER_RADIUS_PX of it on screen (so isolated hotels keep their badge
  // at any zoom, and crowded ones hide under Hilton's cluster circle).
  const CLUSTER_RADIUS_PX = 30
  function mercator(lat, lng) {
    const siny = Math.min(
      Math.max(Math.sin((lat * Math.PI) / 180), -0.9999),
      0.9999
    )
    return {
      x: 0.5 + lng / 360,
      y: 0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)
    }
  }
  // At/above this zoom Hilton never clusters (all individual, even overlapping).
  const CLUSTER_MAX_ZOOM = 10

  // On a cold fresh-search load, Hilton fitBounds-zooms-out into cluster mode but
  // only paints its canvas cluster circles on a real bounds_changed — so after we
  // hide our badges there's a moment with nothing shown until the user moves the
  // map. The first time we enter cluster mode we fire one imperceptible 1px
  // pan-and-back to trigger Hilton's render (what a user move does). Re-armed in
  // showAll() so a later re-search (zoom in → out) gets nudged again.
  let hiltonNudged = false
  function nudgeHiltonClusters() {
    if (hiltonNudged || !mapInstance) return
    hiltonNudged = true
    setTimeout(() => {
      try {
        mapInstance.panBy(1, 0)
        setTimeout(() => {
          try {
            mapInstance.panBy(-1, 0)
          } catch {}
        }, 60)
      } catch {}
    }, 400)
  }

  function showAll() {
    hiltonNudged = false // back to individual pins — re-arm for the next cluster entry
    for (const [, entry] of markers) {
      if (entry.clustered) {
        entry.clustered = false
        try {
          entry.marker.map = mapInstance
        } catch {}
      }
    }
  }
  function updateClustering() {
    if (!mapInstance || markers.size === 0) return
    let zoom
    try {
      zoom = mapInstance.getZoom()
    } catch {
      return
    }
    if (zoom > CLUSTER_MAX_ZOOM) {
      showAll()
      return
    }
    const scale = 256 * Math.pow(2, zoom)
    const r2 = CLUSTER_RADIUS_PX * CLUSTER_RADIUS_PX
    // Spatial-grid neighbour search (cell = radius): each hotel only compares
    // against the 9 surrounding cells instead of every other hotel — O(n) vs
    // O(n^2), so panning/zooming with hundreds of hotels stays cheap.
    const cell = CLUSTER_RADIUS_PX
    const grid = new Map()
    const pts = []
    for (const [id] of markers) {
      const d = hotelData.get(id)
      if (!d) continue
      const w = mercator(d.lat, d.lng)
      const x = w.x * scale
      const y = w.y * scale
      const p = { id, x, y }
      pts.push(p)
      const key = Math.floor(x / cell) + "," + Math.floor(y / cell)
      const arr = grid.get(key)
      if (arr) arr.push(p)
      else grid.set(key, [p])
    }
    // Hide a badge only when the hotel sits in a genuinely DENSE group — i.e. it
    // has at least 2 other hotels within the radius. A hotel with 0–1 close
    // neighbours is shown, because Hilton renders those as individual pins; if we
    // hid them, Hilton's bare pin would show through (the "$191 / $153" problem).
    // Counting neighbours (not just "any within R") is what separates a real
    // cluster from an isolated pair.
    const CLUSTER_MIN_NEIGHBORS = 2
    const clustered = new Set()
    for (const p of pts) {
      const gx = Math.floor(p.x / cell)
      const gy = Math.floor(p.y / cell)
      let neighbors = 0
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get(gx + dx + "," + (gy + dy))
          if (!arr) continue
          for (let k = 0; k < arr.length; k++) {
            const q = arr[k]
            if (q.id === p.id) continue
            const ddx = p.x - q.x
            const ddy = p.y - q.y
            if (ddx * ddx + ddy * ddy < r2) neighbors++
          }
        }
      }
      if (neighbors >= CLUSTER_MIN_NEIGHBORS) clustered.add(p.id)
    }
    let anyHidden = false
    for (const [id, entry] of markers) {
      const hide = clustered.has(id)
      if (hide) anyHidden = true
      if (entry.clustered === hide) continue
      entry.clustered = hide
      try {
        entry.marker.map = hide ? null : mapInstance
      } catch {}
    }
    // We just hid badges for Hilton to cluster — make sure Hilton actually paints
    // those clusters now instead of waiting for the user to move the map.
    if (anyHidden) nudgeHiltonClusters()
  }

  function installIdleTrigger(inst) {
    const ev = window.google && window.google.maps && window.google.maps.event
    if (!ev) return
    ev.addListener(inst, "idle", () => {
      updateClustering()
      clearTimeout(idleDebounce)
      idleDebounce = setTimeout(fetchVisibleQuadrants, 250)
      schedulePrices()
    })
    // Recompute promptly while zooming, before the map settles.
    ev.addListener(inst, "zoom_changed", updateClustering)
    // The map may already be settled when captured (no 'idle' fires) — also try
    // shortly after capture, and ensure we have the quadrant tree.
    setTimeout(() => {
      ensureQuadrantTree()
      updateClustering()
      fetchVisibleQuadrants()
      schedulePrices()
    }, 1000)
  }

  // Build a constructor that wraps the real Map class so we capture instances.
  function wrapMapClass(OrigMap) {
    if (!OrigMap || OrigMap.__avMapWrapped) return OrigMap
    function AvMap(...args) {
      const inst = new OrigMap(...args)
      try {
        onMapCreated(inst)
      } catch {}
      return inst
    }
    AvMap.prototype = OrigMap.prototype
    Object.setPrototypeOf(AvMap, OrigMap)
    AvMap.__avMapWrapped = true
    return AvMap
  }

  // Wrap google.maps.Map (classic global access path).
  function patchMapConstructor() {
    const g = window.google
    if (!g || !g.maps || !g.maps.Map || g.maps.Map.__avMapWrapped) return false
    g.maps.Map = wrapMapClass(g.maps.Map)
    adoptMarkerLib(g)
    return true
  }

  // Wrap google.maps.importLibrary("maps") — the modern path most apps use to
  // get the Map class (bypasses the google.maps.Map global). Must run before the
  // page awaits importLibrary, hence the fast early poll below.
  function wrapImportLibrary() {
    const g = window.google
    if (!g || !g.maps || typeof g.maps.importLibrary !== "function") return false
    if (g.maps.importLibrary.__avWrapped) return true
    const orig = g.maps.importLibrary
    const wrapped = function (name) {
      const p = orig.apply(this, arguments)
      if (name !== "maps") return p
      return p.then((lib) => {
        try {
          if (lib && lib.Map && !lib.Map.__avMapWrapped) {
            const AvMap = wrapMapClass(lib.Map)
            const clone = Object.assign(
              Object.create(Object.getPrototypeOf(lib)),
              lib
            )
            clone.Map = AvMap
            return clone
          }
        } catch {}
        return lib
      })
    }
    wrapped.__avWrapped = true
    try {
      g.maps.importLibrary = wrapped
      return true
    } catch {
      return false
    }
  }

  // Fallback: if a map already exists (e.g. extension loaded after the page),
  // read the instance off any Advanced Marker the page itself rendered.
  // Patch shared Map.prototype methods. Because importLibrary("maps").Map IS
  // google.maps.Map (same prototype), this captures the page's instance no matter
  // how it obtained the class — the page calls these during setup and on every
  // pan/zoom, so we never lose the race.
  function patchMapProto() {
    const g = window.google
    const M = g && g.maps && g.maps.Map
    if (!M || !M.prototype || M.prototype.__avProtoPatched) return false
    for (const name of ["setCenter", "panTo", "panBy", "fitBounds", "setZoom", "moveCamera"]) {
      const orig = M.prototype[name]
      if (typeof orig !== "function") continue
      M.prototype[name] = function (...a) {
        if (!mapInstance) {
          try {
            onMapCreated(this)
          } catch {}
        }
        return orig.apply(this, a)
      }
    }
    M.prototype.__avProtoPatched = true
    return true
  }

  function tryHooks() {
    seedFromNextData()
    wrapImportLibrary()
    patchMapConstructor()
    patchMapProto()
    if (window.google) adoptMarkerLib(window.google)
    if (!mapInstance) {
      const mk = document.querySelector("gmp-advanced-marker")
      if (mk && mk.map) onMapCreated(mk.map)
    }
  }

  function ensureMap() {
    if (!mapInstance) tryHooks()
  }

  // Fast early poll to win the race: wrap importLibrary before the page awaits
  // it. Backs off to a slow steady poll after the first couple of seconds.
  let fastCount = 0
  const fastPoll = setInterval(() => {
    fastCount += 1
    tryHooks()
    if (mapInstance || fastCount > 150) clearInterval(fastPoll)
  }, 15)

  let pollCount = 0
  const poll = setInterval(() => {
    pollCount += 1
    tryHooks()
    if ((mapInstance && markers.size > 0) || pollCount > 600) {
      clearInterval(poll)
    }
  }, 200)

  // Lightweight status hook (handy for support/debugging from the console).
  window.__AV_HILTON_MAP_DEBUG__ = () => ({
    hasMapInstance: !!mapInstance,
    hasMarkerLib: !!AdvancedMarkerElement,
    dataCount: hotelData.size,
    markerCount: markers.size,
    quadrantCells: quadrantCells.size,
    fetchedQuadrants: fetchedQuadrants.size,
    shopRates: shopRates.size,
    pricedKeys: pricedKeys.size,
    queued: queuedKeys.size,
    searchInput: getSearchInput(),
    rewardCount: (() => { let n = 0; for (const [, v] of shopRates) if (v.hasReward) n++; return n })(),
    noRewardCount: (() => { let n = 0; for (const [, v] of shopRates) if (!v.hasReward && !v.unavailable) n++; return n })(),
    unavailableCount: (() => { let n = 0; for (const [, v] of shopRates) if (v.unavailable) n++; return n })(),
    unavailableIds: (() => { const o = []; for (const [id, v] of shopRates) if (v.unavailable) o.push(id); return o.slice(0, 15) })(),
    zoom: (() => {
      try {
        return mapInstance ? mapInstance.getZoom() : null
      } catch {
        return null
      }
    })(),
    settings
  })



  // ----------------------------------------------------------------
  // Marker rendering
  // ----------------------------------------------------------------
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement("style")
    style.id = STYLE_ID
    style.textContent = `
      .${BADGE_CLASS} {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        line-height: 1.05;
        padding: 2px 7px;
        border-radius: 7px;
        border: 1.5px solid rgba(255, 255, 255, 0.9);
        background: #2f74c8;
        color: #ffffff;
        font-family: -apple-system, Segoe UI, Roboto, sans-serif;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
        box-shadow: 0 2px 6px rgba(15, 23, 42, 0.35);
        /* Badge owns the hover so our custom popup shows on it. */
        pointer-events: auto;
        cursor: default;
      }
      /* Custom hover popup: hotel logo + name + address. */
      .${BADGE_CLASS} .av-pop {
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%) translateY(-8px);
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 180px;
        max-width: 280px;
        background: #ffffff;
        color: #0f172a;
        text-align: left;
        letter-spacing: 0;
        padding: 8px 10px;
        border-radius: 8px;
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.45);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.1s ease;
        z-index: 9;
      }
      .${BADGE_CLASS}:hover .av-pop { opacity: 1; }
      .${BADGE_CLASS} .av-pop-logo {
        width: 34px; height: 34px; flex: 0 0 34px; object-fit: contain;
      }
      .${BADGE_CLASS} .av-pop-name {
        font-size: 12px; font-weight: 700; line-height: 1.2; white-space: normal;
      }
      .${BADGE_CLASS} .av-pop-addr {
        font-size: 10px; font-weight: 500; color: #475569; line-height: 1.2;
        white-space: normal; margin-top: 1px;
      }
      /* Points mode = Hilton's teal pin; cash mode = blue. */
      .${BADGE_CLASS}--points { background: #007a96; }
      .${BADGE_CLASS} .av-big {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.2px;
      }
      .${BADGE_CLASS} .av-small {
        font-size: 9px;
        font-weight: 600;
        opacity: 0.9;
      }
      /* Value rating shows on the ¢/pt text only. */
      .${BADGE_CLASS} .av-cpp { font-size: 10px; font-weight: 800; color: #ffffff; }
      .${BADGE_CLASS}--good .av-cpp { color: #6ee7b7; }
      .${BADGE_CLASS}--mid .av-cpp { color: #fcd34d; }
      .${BADGE_CLASS}--bad .av-cpp { color: #fca5a5; }
      .${BADGE_CLASS}--none {
        background: #64748b;
        font-weight: 600;
      }
      /* Highlighted when its left-list card is hovered. */
      .${BADGE_CLASS}--hl {
        filter: brightness(0.8);
        transform: scale(1.1);
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.75), 0 5px 14px rgba(15, 23, 42, 0.5);
      }
    `
    ;(document.head || document.documentElement).appendChild(style)
  }

  function valueClass(cpp) {
    if (typeof cpp !== "number" || !isFinite(cpp)) return ""
    if (cpp >= settings.goodValueThreshold) return `${BADGE_CLASS}--good`
    if (cpp <= settings.badValueThreshold) return `${BADGE_CLASS}--bad`
    return `${BADGE_CLASS}--mid`
  }

  function formatPoints(points) {
    if (typeof points !== "number" || !isFinite(points)) return ""
    return new Intl.NumberFormat("en-US").format(points)
  }

  function formatCash(amount) {
    if (typeof amount !== "number" || !isFinite(amount)) return ""
    return "$" + amount.toFixed(2)
  }

  function signature(d) {
    return [
      pointsMode ? "p" : "c",
      d.hasReward ? "r" : "n",
      d.cash == null ? "" : Math.round(d.cash),
      d.cpp == null ? "" : d.cpp.toFixed(2),
      d.points || "",
      valueClass(d.cpp)
    ].join("|")
  }

  function lineSpan(cls, text) {
    const s = document.createElement("span")
    s.className = cls
    s.textContent = text
    return s
  }

  // Custom hover popup: brand logo + hotel name + address.
  function addPopup(el, d) {
    if (!d.name && !d.addr) return
    const pop = document.createElement("div")
    pop.className = "av-pop"
    if (d.brandCode) {
      const logo = document.createElement("img")
      logo.className = "av-pop-logo"
      logo.src =
        "https://www.hilton.com/modules/assets/svgs/logos/bug/" +
        d.brandCode +
        ".svg"
      logo.alt = ""
      logo.addEventListener("error", () => logo.remove())
      pop.appendChild(logo)
    }
    const txt = document.createElement("div")
    if (d.name) {
      const n = document.createElement("div")
      n.className = "av-pop-name"
      n.textContent = d.name
      txt.appendChild(n)
    }
    if (d.addr) {
      const a = document.createElement("div")
      a.className = "av-pop-addr"
      a.textContent = d.addr
      txt.appendChild(a)
    }
    pop.appendChild(txt)
    el.appendChild(pop)
  }

  function buildBadge(d) {
    const el = document.createElement("div")
    el.className = BADGE_CLASS
    if (pointsMode) el.classList.add(`${BADGE_CLASS}--points`)

    if (!d.hasReward) {
      el.classList.add(`${BADGE_CLASS}--none`)
      if (typeof d.cash === "number" && isFinite(d.cash)) {
        // No award points, but it's bookable for cash — show the cash price.
        el.appendChild(lineSpan("av-big", formatCash(d.cash)))
        el.appendChild(lineSpan("av-small", "No reward"))
      } else {
        // No cash either — Hilton shows it as unavailable for these dates.
        const label = document.createElement("span")
        label.textContent = "Unavailable"
        el.appendChild(label)
      }
      addPopup(el, d)
      return el
    }

    const vc = valueClass(d.cpp)
    if (vc) el.classList.add(vc)

    const hasCash = typeof d.cash === "number" && isFinite(d.cash)
    const cashText = hasCash ? formatCash(d.cash) : ""
    const ptsText = formatPoints(d.points)
    const cppText = d.cpp != null ? d.cpp.toFixed(2) + "¢/pt" : "—"

    if (pointsMode) {
      // Points first (large), then cash (small), then ¢/pt.
      el.appendChild(lineSpan("av-big", ptsText + " pts"))
      if (hasCash) el.appendChild(lineSpan("av-small", cashText))
      el.appendChild(lineSpan("av-cpp", cppText))
    } else {
      // Cash first (large), then points (small), then ¢/pt.
      if (hasCash) el.appendChild(lineSpan("av-big", cashText))
      el.appendChild(lineSpan("av-small", ptsText + " pts"))
      el.appendChild(lineSpan("av-cpp", cppText))
    }

    addPopup(el, d)
    return el
  }

  const BASE_Z = 10000
  const HOVER_Z = 2000000
  // Raise the hovered marker so its popup renders above neighbouring badges.
  function attachHover(content, marker) {
    content.addEventListener("mouseenter", () => {
      try {
        marker.zIndex = HOVER_Z
      } catch {}
    })
    content.addEventListener("mouseleave", () => {
      try {
        marker.zIndex = BASE_Z
      } catch {}
    })
  }

  function renderMarkers() {
    if (!mapInstance || !AdvancedMarkerElement) return
    ensureStyles()

    for (const [id, raw] of hotelData) {
      // Only draw a badge once we have an AUTHORITATIVE, date-specific price
      // (shopMultiPropAvail via our own fetch or the content-script bridge).
      // The leadRate in hotelData is a generic, date-independent "from" rate —
      // showing it first made badges flip wrong→correct, and every content swap
      // briefly cleared the marker and flashed Hilton's canvas pin underneath.
      // Until real data lands we draw nothing and leave Hilton's native pin.
      const hasReal = shopRates.has(id) || authRates.has(id)
      let entry = markers.get(id)
      if (!hasReal) continue

      const d = effective(id, raw)
      const sig = signature(d)

      if (!entry) {
        try {
          const content = buildBadge(d)
          const marker = new AdvancedMarkerElement({
            map: mapInstance,
            position: { lat: d.lat, lng: d.lng },
            content,
            zIndex: BASE_Z
          })
          attachHover(content, marker)
          markers.set(id, { marker, sig })
        } catch {}
        continue
      }

      if (!entry.marker.map && !entry.clustered) entry.marker.map = mapInstance
      if (entry.sig !== sig) {
        const content = buildBadge(d)
        entry.marker.content = content
        attachHover(content, entry.marker)
        entry.sig = sig
      }
    }
    scheduleClustering()
  }

  let clusterDebounce = null
  function scheduleClustering() {
    clearTimeout(clusterDebounce)
    clusterDebounce = setTimeout(updateClustering, 200)
  }

  // Coalesce bursts of render requests (e.g. several shopMultiPropAvail batches
  // resolving within a few hundred ms) into a single pass so badges appear in
  // one wave instead of flickering in one-by-one.
  let renderDebounce = null
  function scheduleRender() {
    clearTimeout(renderDebounce)
    renderDebounce = setTimeout(renderMarkers, 120)
  }

  function restyleMarkers() {
    // Recompute badge styling (thresholds changed) without rebuilding data.
    for (const [, entry] of markers) entry.sig = ""
    renderMarkers()
  }

  // ----------------------------------------------------------------
  // List ↔ map highlight: hovering a left-list hotel card raises and recolors
  // its map badge (Hilton does this for its own pins, but our badge sits on top
  // and would otherwise hide it).
  // ----------------------------------------------------------------
  const HIGHLIGHT_Z = 3000000
  let highlightedId = null

  function setHighlight(ctyhocn, on) {
    if (!ctyhocn) return
    const entry = markers.get(ctyhocn.toUpperCase())
    if (!entry) return
    try {
      entry.marker.zIndex = on ? HIGHLIGHT_Z : BASE_Z
    } catch {}
    const c = entry.marker.content
    if (c && c.classList) c.classList.toggle(`${BADGE_CLASS}--hl`, on)
  }

  // Cards nest testids: hotel-card-<ctyhocn> (the <li>) wraps hotel-card-image
  // and hotel-card-content. Climb until the suffix matches a real badge.
  function cardCtyhocn(el) {
    let card = el && el.closest ? el.closest("[data-testid^='hotel-card-']") : null
    while (card) {
      const suffix = (card.getAttribute("data-testid") || "").slice(11)
      if (markers.has(suffix.toUpperCase())) return suffix
      const parent = card.parentElement
      card = parent && parent.closest ? parent.closest("[data-testid^='hotel-card-']") : null
    }
    return null
  }

  document.addEventListener("mouseover", (e) => {
    const id = cardCtyhocn(e.target)
    if (id === highlightedId) return
    if (highlightedId) setHighlight(highlightedId, false)
    highlightedId = id
    if (id) setHighlight(id, true)
  })

  // ----------------------------------------------------------------
  // Only our custom popup should show — suppress Hilton's own small hover popup.
  // SAFE: never hides the modal pin-click dialog (checked at hide time, when the
  // node is fully in the DOM), and a rate-limit disconnects the observer if it
  // ever starts hiding rapidly (a re-render loop) so it can't freeze the page.
  // ----------------------------------------------------------------
  const BUG = "/logos/bug/"
  function carriesBug(node) {
    if (!node || node.nodeType !== 1) return false
    const tag = node.tagName
    if (tag === "GMP-ADVANCED-MARKER") return false
    if (node.classList && node.classList.contains(BADGE_CLASS)) return false
    let isBug = false
    if (tag === "IMG") {
      isBug = !!node.src && node.src.indexOf(BUG) !== -1
    } else if (node.querySelector) {
      if (node.querySelector("." + BADGE_CLASS)) return false
      isBug = !!node.querySelector('img[src*="' + BUG + '"]')
    }
    if (!isBug) return false
    return !(
      node.closest &&
      (node.closest("." + BADGE_CLASS) ||
        node.closest("[data-testid='availableHotelsList']"))
    )
  }
  function isProtected(el) {
    // The pin-click MODAL is also role=dialog, so don't protect by role (Google's
    // hover InfoWindow is role=dialog too). Protect only the big modal: aria-modal
    // or large. The small InfoWindow hover popup is neither, so it gets hidden.
    if (el.closest && el.closest("[aria-modal='true']")) return true
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null
    return !!(r && (r.width > 440 || r.height > 380))
  }
  let suppressDisabled = false
  const suppressHits = []
  function hidePopup(node) {
    // Hilton's hover popup is a Google InfoWindow — hide the whole bubble.
    const iw = node.closest && node.closest(".gm-style-iw-a, .gm-style-iw")
    let target = iw
    if (!target) {
      target = node.tagName === "IMG" ? node.parentElement || node : node
    }
    if (isProtected(target)) return
    try {
      target.style.setProperty("display", "none", "important")
    } catch {}
    // Last-resort backstop only for a genuine runaway re-render loop.
    const now = Date.now()
    suppressHits.push(now)
    if (suppressHits.length > 60) suppressHits.shift()
    if (suppressHits.length >= 60 && now - suppressHits[0] < 1000) {
      suppressDisabled = true
      try {
        hiltonPopupObserver.disconnect()
      } catch {}
    }
  }
  const hiltonPopupObserver = new MutationObserver((muts) => {
    if (suppressDisabled) return
    for (const m of muts) {
      const added = m.addedNodes
      for (let i = 0; i < added.length; i++) {
        if (carriesBug(added[i])) hidePopup(added[i])
      }
    }
  })
  try {
    hiltonPopupObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    })
  } catch {}
})()
