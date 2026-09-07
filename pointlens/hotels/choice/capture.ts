import { observeNativeJson } from "../../shared/native-json"
import {
  requestPricingBudget,
  requestPricingBudgetDecision
} from "../../shared/pricing-budget"
import { hydration } from "./bootstrap"
import {
  choiceContext,
  choiceHotel,
  parseChoice,
  pricingOperation,
  type ChoiceSnapshot
} from "./pricing"
import { LOWEST_ROOMS_QUERY, ROOMS_QUERY, SEARCH_QUERY } from "./queries"

export function installChoiceCapture() {
  const nativeFetch = window.fetch
  type Batch = { snapshot: ChoiceSnapshot; revision: number; captured: number }
  type Job = { body: any; page: string; batch: Batch }
  const batches = new Map<string, Batch>(),
    jobs = new Map<string, Job>()
  let context = choiceContext(location.href),
    running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = () =>
    window.postMessage(
      {
        __POINTLENS_CHOICE__: true,
        context,
        snapshots: [...batches.values()].map((b) => b.snapshot)
      },
      location.origin
    )
  const reset = () => {
    const next = choiceContext(location.href)
    if (context === next) return
    context = next
    batches.clear()
    jobs.clear()
    clearTimeout(timer)
  }
  const keyFor = (s: ChoiceSnapshot) =>
    `${s.scope}:${Object.keys(s.hotels).sort().join(",")}`
  const run = async () => {
    if (running || !jobs.size) return
    reset()
    const entry = jobs.entries().next().value
    if (!entry) return
    const [key, job] = entry
    running = true
    const lease = crypto.randomUUID()
    let acquired = false,
      delayed = false
    try {
      const decision = await requestPricingBudgetDecision("choice", undefined, {
        lease
      })
      acquired = decision.allowed
      if (
        choiceContext(job.page) !== choiceContext(location.href) ||
        jobs.get(key) !== job
      )
        return
      if (!acquired) {
        if ((decision.retryAt ?? 0) - Date.now() > 60000)
          throw Error("Pricing cooldown")
        delayed = true
        timer = setTimeout(
          () => void run(),
          Math.max(500, (decision.retryAt ?? Date.now() + 2000) - Date.now())
        )
        return
      }
      const response = await nativeFetch(
        `/dxapi/graphql?q=${job.body.operationName}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(job.body),
          signal: AbortSignal.timeout(15000)
        }
      )
      if (!response.ok) {
        void requestPricingBudget("choice", response.status, {
          retryAfter: response.headers.get("retry-after") ?? undefined
        })
        throw Error("Pricing unavailable")
      }
      const parsed = parseChoice(
        await response.json(),
        job.page,
        job.body.variables
      )
      if (!parsed) throw Error("Invalid pricing")
      if (
        choiceContext(job.page) !== choiceContext(location.href) ||
        batches.get(key) !== job.batch
      )
        return
      const prior = job.batch.snapshot
      for (const o of parsed.offers)
        if (prior.hotels[o.hotel]?.[o.points ? "points" : "cash"] === "pending")
          prior.offers.push(o)
      for (const [hotel, state] of Object.entries(prior.hotels))
        for (const side of ["cash", "points"] as const)
          if (state[side] === "pending")
            state[side] = parsed.hotels[hotel]?.[side] ?? "error"
    } catch {
      if (batches.get(key) === job.batch)
        for (const state of Object.values(job.batch.snapshot.hotels))
          for (const side of ["cash", "points"] as const)
            if (state[side] === "pending") state[side] = "error"
    } finally {
      if (acquired)
        void requestPricingBudget("choice", undefined, { release: lease })
      if (!delayed && jobs.get(key) === job) jobs.delete(key)
      running = false
      publish()
      if (!delayed) void run()
    }
  }
  const receive = (data: any, page: string, body: any, revision: number) => {
    if (choiceContext(page) !== choiceContext(location.href)) return
    reset()
    const parsed = parseChoice(data, page, body?.variables)
    if (!parsed) return
    const key = keyFor(parsed),
      old = batches.get(key)
    if (old && old.revision > revision) return
    if (old && Date.now() - old.captured < 300000)
      for (const [hotel, state] of Object.entries(parsed.hotels))
        for (const side of ["cash", "points"] as const) {
          if (
            state[side] === "pending" &&
            old.snapshot.hotels[hotel]?.[side] === "ready"
          ) {
            state[side] = "ready"
            parsed.offers.push(
              ...old.snapshot.offers.filter(
                (o) => o.hotel === hotel && !!o.points === (side === "points")
              )
            )
          }
        }
    // Latest native batch wins for overlapping hotel IDs, including map/list updates.
    for (const [otherKey, other] of batches)
      if (otherKey !== key && other.snapshot.scope === parsed.scope) {
        for (const hotel of Object.keys(parsed.hotels)) {
          delete other.snapshot.hotels[hotel]
          other.snapshot.offers = other.snapshot.offers.filter(
            (o) => o.hotel !== hotel
          )
        }
        if (!Object.keys(other.snapshot.hotels).length) {
          batches.delete(otherKey)
          jobs.delete(otherKey)
        }
      }
    const batch = { snapshot: parsed, revision, captured: Date.now() }
    batches.set(key, batch)
    jobs.delete(key)
    if (
      body?.query &&
      Object.values(parsed.hotels).some(
        (s) => s.cash === "pending" || s.points === "pending"
      )
    ) {
      jobs.set(key, {
        batch,
        page,
        body: {
          ...body,
          variables: {
            ...body.variables,
            ratePlanCodes: [
              ...new Set([
                ...(body.variables?.ratePlanCodes ?? []),
                "RACK",
                "SRD"
              ])
            ]
          }
        }
      })
      clearTimeout(timer)
      // Give native requests a chance to provide the complementary rates first.
      timer = setTimeout(() => void run(), 1600)
    }
    publish()
  }
  observeNativeJson(
    (url) => !!pricingOperation(url),
    (data, _url, page, body, _request, revision = 0) => {
      let parsedBody: any
      try {
        parsedBody = JSON.parse(body ?? "{}")
      } catch {
        return
      }
      receive(data, page, parsedBody, revision)
    },
    (status, retryAfter) => {
      void requestPricingBudget("choice", status, {
        retryAfter: retryAfter ?? undefined
      })
    }
  )
  let bootstrapped = false
  const bootstrap = () => {
    if (bootstrapped) return
    const state = hydration(document)
    if (!state) return
    bootstrapped = true
    const result = state.searchResults
    const form = result?.searchForm
    if (
      form?.checkInDate &&
      result.hotels?.length &&
      !choiceHotel(location.href)
    ) {
      const variables = {
        adults: form.adults,
        ageOfMinors: form.ageOfMinors ?? [],
        minors: form.minors,
        rooms: form.rooms,
        checkInDate: form.checkInDate,
        checkOutDate: form.checkOutDate,
        hotelCodes: result.hotels.map((h: any) => h.code),
        ratePlanCodes: [form.ratePlanCode || "RACK"],
        ratePlanCategories: ["PREPD", "PROMO", "FENCD", "PACKAGE", "SMFLX"],
        currencyCode: form.currencyCode,
        corporateId: form.corporateId,
        travelAgentId: form.travelAgentId,
        city: form.city,
        country: form.country,
        latitude: form.lat,
        longitude: form.lon,
        placeId: form.placeId,
        placeName: form.placeName,
        placeType: form.placeType,
        radiusInMiles: form.searchRadius,
        searchText: form.destinationEntered,
        subdivision: form.subdivision
      }
      receive(
        {
          data: {
            getHotelAvailabilityLowestRate: result.hotels
              .map((h: any) => h.startingRates)
              .filter(Boolean)
          }
        },
        location.href,
        {
          query: SEARCH_QUERY,
          operationName: "GetSearchResultsRatesWithRoomPolicy",
          variables
        },
        -1
      )
    }
    // Direct property/rate entries may have pricing embedded instead of fetched.
    const visit = (node: any, depth = 0) => {
      if (!node || typeof node !== "object" || depth > 5) return
      if (node.hotelCode && node.roomRates && node.nights) {
        const full = Array.isArray(node.roomRates?.[0]?.value)
        receive(
          {
            data: {
              [full
                ? "getHotelAvailabilityRoomRates"
                : "getHotelAvailabilityLowestRoomRates"]: node
            }
          },
          location.href,
          {
            query: full ? ROOMS_QUERY : LOWEST_ROOMS_QUERY,
            operationName: full ? "GetRoomRates" : "GetLowestRoomRates",
            variables: {
              ...state.search,
              hotelId: node.hotelCode,
              checkInDate: node.startDate,
              checkOutDate: node.endDate,
              ratePlanCodes: [state.search?.ratePlanCode || "RACK"],
              ratePlanCategories: [
                "PREPD",
                "PROMO",
                "FENCD",
                "PACKAGE",
                "SMFLX"
              ]
            }
          },
          -1
        )
        return
      }
      for (const [key, value] of Object.entries(node))
        if (!/profile|account|member|images|strings|history|recent/i.test(key))
          visit(value, depth + 1)
    }
    if (choiceHotel(location.href)) visit(state)
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true })
  else bootstrap()
  window.addEventListener("message", (e) => {
    if (
      e.source === window &&
      e.origin === location.origin &&
      e.data?.__POINTLENS_CHOICE_READY__
    )
      publish()
  })
}
