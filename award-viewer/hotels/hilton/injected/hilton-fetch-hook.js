;(function () {
  const TARGET = "https://www.hilton.com/graphql/customer"
  const MESSAGE_FLAG = "__AV_HILTON__"
  const CAPTURE_OPERATIONS = new Set([
    "hotelSummaryOptions",
    "shopMultiPropAvail"
  ])

  const origFetch = window.fetch
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args)

    try {
      const req = args[0]
      const url = typeof req === "string" ? req : req?.url

      if (url && url.startsWith(TARGET)) {
        let operationName = null
        try {
          const init = args[1]
          if (init?.body && typeof init.body === "string") {
            const parsed = JSON.parse(init.body)
            operationName = parsed?.operationName ?? null
          }
        } catch {
          operationName = null
        }

        if (operationName && CAPTURE_OPERATIONS.has(operationName)) {
          const cloned = response.clone()
          const text = await cloned.text()
          let body
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }

          window.postMessage(
            {
              [MESSAGE_FLAG]: true,
              payload: {
                url,
                status: response.status,
                operationName,
                body
              }
            },
            "*"
          )
        }
      }
    } catch {
      // no-op
    }

    return response
  }
})()
