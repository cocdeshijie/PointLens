import { requestPricingBudget } from "../../shared/pricing-budget"
import { marriottSearchContext } from "./search-context"

export function installMarriottSearchCapture() {
  const native = window.fetch
  const attempted = new Set<string>()
  let latest: any
  let generation = 0
  const publish = (
    data: any,
    page: string,
    revision: number,
    replay = false
  ) => {
    if (
      page !== marriottSearchContext(location.href) ||
      revision !== generation
    )
      return
    const results = data?.data?.search?.lowestAvailableRates
    const edges = (results?.searchByGeolocation ?? results?.searchByDestination)
      ?.edges
    if (!Array.isArray(edges)) return
    let hotels = edges.map(({ node }: any) => ({
      property: node.property,
      rates: node.rates
    }))
    if (replay && latest?.payload.context === page) {
      const byId = new Map(
        hotels.map((hotel: any) => [hotel.property?.id, hotel])
      )
      hotels = latest.payload.hotels.map(
        (hotel: any) => byId.get(hotel.property?.id) ?? hotel
      )
    }
    latest = {
      __AV_MARRIOTT_SAVE__: true,
      payload: {
        context: page,
        hotels
      }
    }
    window.postMessage(latest, location.origin)
  }
  window.fetch = function (...args) {
    const input = args[0]
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      location.href
    )
    if (
      url.origin !== location.origin ||
      ![
        "/mi/query/phoenixShopDatedSearchByGeoQuery",
        "/mi/query/phoenixShopDatedSearchByDestinationQuery"
      ].includes(url.pathname)
    )
      return native.apply(this, args)
    const page = marriottSearchContext(location.href)
    const revision = ++generation
    let request: Request | undefined
    try {
      request = new Request(
        input instanceof Request ? input.clone() : url.href,
        args[1]
      )
    } catch {}
    return native.apply(this, args).then((response) => {
      if (!response.ok) {
        void requestPricingBudget("marriott", response.status, {
          retryAfter: response.headers.get("retry-after") ?? undefined
        })
        return response
      }
      void response
        .clone()
        .json()
        .then(async (data) => {
          publish(data, page, revision)
          if (
            !request ||
            marriottSearchContext(location.href) !== page ||
            revision !== generation
          )
            return
          let body: any
          try {
            body = JSON.parse(await request.clone().text())
          } catch {
            return
          }
          const options = body?.variables?.search?.options
          if (!Array.isArray(options?.rateRequestTypes)) return
          const hasCash = options.rateRequestTypes.some(
            (r: any) => r.type === "STANDARD"
          )
          const hasPoints = options.rateRequestTypes.some(
            (r: any) => r.type === "CLUSTER" && ["MRW", "P17"].includes(r.value)
          )
          if (hasCash && hasPoints) return
          const wanted = [
            { type: "STANDARD", value: "" },
            { type: "CLUSTER", value: "MRW" },
            { type: "CLUSTER", value: "P17" }
          ]
          const missing = wanted.filter(
            (w) =>
              !options.rateRequestTypes.some(
                (r: any) => r.type === w.type && r.value === w.value
              )
          )
          if (!missing.length) return
          // Preserve corporate, AAA and other native rate inputs.
          options.rateRequestTypes.push(...missing)
          const text = JSON.stringify(body),
            key = url.href + text
          if (attempted.has(key)) return
          attempted.add(key)
          const lease = crypto.randomUUID()
          if (!(await requestPricingBudget("marriott", undefined, { lease })))
            return
          try {
            if (
              page !== marriottSearchContext(location.href) ||
              revision !== generation
            )
              return
            const replay = await native(url.href, {
              method: request.method,
              headers: request.headers,
              credentials: request.credentials,
              body: text,
              signal: AbortSignal.timeout(15000)
            })
            if (!replay.ok) {
              void requestPricingBudget("marriott", replay.status, {
                retryAfter: replay.headers.get("retry-after") ?? undefined
              })
              return
            }
            publish(await replay.json(), page, revision, true)
          } finally {
            void requestPricingBudget("marriott", undefined, { release: lease })
          }
        })
        .catch(() => {})
      return response
    })
  }
  window.addEventListener("message", (e) => {
    if (
      e.source === window &&
      e.origin === location.origin &&
      e.data?.__POINTLENS_MARRIOTT_SEARCH_READY__ &&
      latest
    )
      window.postMessage(latest, location.origin)
  })
}
