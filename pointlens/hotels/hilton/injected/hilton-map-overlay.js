;(function () {
  // Native metadata supplies coordinates; content supplies date-specific prices.
  // This overlay never requests hotel inventory or pricing itself.
  const BADGE_CLASS = "pointlens-map-cpp"
  const STYLE_ID = "pointlens-map-cpp-style"

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
      authRates.clear()
      let changed = true
      for (const r of data.rates) {
        if (!r || typeof r.id !== "string") continue
        const next = {
          points: typeof r.points === "number" ? r.points : undefined,
          cash: typeof r.cash === "number" ? r.cash : undefined,
          currency: r.currency,
          pointsEstimated: r.pointsEstimated === true,
          cpp: typeof r.cpp === "number" ? r.cpp : undefined,
          hasReward: r.rewardStatus === "available"
        }
        authRates.set(r.id, next)
        changed = true
      }
      if (changed) scheduleRender()
    }
  })

  // Only date-specific prices may be combined with native coordinates.
  function effective(id, d) {
    const a = authRates.get(id)
    if (!a) return { lat: d.lat, lng: d.lng, name: d.name }
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
      points: a.points,
      cash: a.cash,
      currency: a.currency,
      pointsEstimated: a.pointsEstimated,
      cpp: a.cpp,
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
  function handleResponseJson(json) {
    ingest(json)
  }

  const origFetch = window.fetch
  window.fetch = function (...args) {
    const input = args[0]
    const url = typeof input === "string" ? input : input && input.url
    const p = origFetch.apply(this, args)
    try {
      if (isSummaryUrl(url)) {
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
    if (isSummaryUrl(u)) {
      this.addEventListener("load", () => {
        try {
          handleResponseJson(JSON.parse(this.responseText))
        } catch {}
      })
    }
    return origSend.call(this, body)
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

      const addr = h.address || null
      const addrText = addr
        ? [addr.addressLine1, addr.city].filter(Boolean).join(", ")
        : ""

      hotelData.set(id, {
        lat,
        lng,
        name: h.name,
        brandCode: h.brandCode || null,
        addr: addrText
      })
      changed = true
    }

    if (changed) {
      ensureMap()
      renderMarkers()
    }
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
  let markerLibraryPending = false
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
    if (
      !markerLibraryPending &&
      g &&
      g.maps &&
      typeof g.maps.importLibrary === "function"
    ) {
      markerLibraryPending = true
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
      const r =
        div && div.getBoundingClientRect ? div.getBoundingClientRect() : null
      if (!r || r.width < 250 || r.height < 250) return
    } catch {
      return
    }
    mapInstance = inst
    adoptMarkerLib(window.google)
    renderMarkers()
    installIdleTrigger(inst)
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
    })
    // Recompute promptly while zooming, before the map settles.
    ev.addListener(inst, "zoom_changed", updateClustering)
    // The map may already be settled when captured (no 'idle' fires) — also try
    // shortly after capture, and ensure we have the quadrant tree.
    setTimeout(() => {
      updateClustering()
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
    if (!g || !g.maps || typeof g.maps.importLibrary !== "function")
      return false
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
    for (const name of [
      "setCenter",
      "panTo",
      "panBy",
      "fitBounds",
      "setZoom",
      "moveCamera"
    ]) {
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
    if (mapInstance || fastCount > 50) clearInterval(fastPoll)
  }, 15)

  let pollCount = 0
  const poll = setInterval(() => {
    pollCount += 1
    tryHooks()
    if ((mapInstance && markers.size > 0) || pollCount > 120) {
      clearInterval(poll)
    }
  }, 500)

  // Lightweight status hook (handy for support/debugging from the console).
  window.__AV_HILTON_MAP_DEBUG__ = () => ({
    hasMapInstance: !!mapInstance,
    hasMarkerLib: !!AdvancedMarkerElement,
    dataCount: hotelData.size,
    markerCount: markers.size,
    authoritativeRates: authRates.size,
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

  function formatCash(amount, currency) {
    if (typeof amount !== "number" || !isFinite(amount)) return ""
    return currency
      ? new Intl.NumberFormat(undefined, {
          style: "currency",
          currency
        }).format(amount)
      : ""
  }

  function signature(d) {
    return [
      pointsMode ? "p" : "c",
      d.hasReward ? "r" : "n",
      d.cash == null ? "" : d.cash.toFixed(2),
      d.cpp == null ? "" : d.cpp.toFixed(2),
      d.points || "",
      d.currency || "",
      d.pointsEstimated ? "estimated" : "",
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
    if (d.pointsEstimated) el.title = "Estimated CPP using first-night points"
    el.className = BADGE_CLASS
    if (pointsMode) el.classList.add(`${BADGE_CLASS}--points`)

    if (!d.hasReward) {
      el.classList.add(`${BADGE_CLASS}--none`)
      if (typeof d.cash === "number" && isFinite(d.cash)) {
        // No award points, but it's bookable for cash — show the cash price.
        el.appendChild(lineSpan("av-big", formatCash(d.cash, d.currency)))
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
    const cashText = hasCash ? formatCash(d.cash, d.currency) : ""
    const ptsText = formatPoints(d.points)
    const cppText = d.cpp != null ? "≈" + d.cpp.toFixed(2) + "¢/pt" : "—"

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
      const hasReal = authRates.has(id)
      let entry = markers.get(id)
      if (!hasReal) {
        if (entry) {
          entry.marker.map = null
          markers.delete(id)
        }
        continue
      }

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
    let card =
      el && el.closest ? el.closest("[data-testid^='hotel-card-']") : null
    while (card) {
      const suffix = (card.getAttribute("data-testid") || "").slice(11)
      if (markers.has(suffix.toUpperCase())) return suffix
      const parent = card.parentElement
      card =
        parent && parent.closest
          ? parent.closest("[data-testid^='hotel-card-']")
          : null
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
