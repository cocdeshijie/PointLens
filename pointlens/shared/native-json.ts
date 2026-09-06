// Observe only a brand's pricing endpoints. Native responses are never changed.
export function observeNativeJson(
  eligible: (url: string) => boolean,
  receive: (
    data: unknown,
    url: string,
    page: string,
    requestBody?: string,
    request?: Request,
    revision?: number
  ) => void,
  failed?: (status: number, retryAfter: string | null) => void
) {
  let revision = 0
  const nativeFetch = window.fetch
  window.fetch = function (...args) {
    const input = args[0]
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const page = location.href
    const requestRevision = eligible(url) ? ++revision : 0
    let request: Request | undefined
    if (eligible(url)) {
      try {
        request = new Request(
          input instanceof Request
            ? input.clone()
            : new URL(url, location.href),
          args[1]
        )
      } catch {}
    }
    return nativeFetch.apply(this, args).then((response) => {
      if (eligible(url)) {
        if (response.ok)
          void Promise.all([
            response.clone().json(),
            request
              ?.clone()
              .text()
              .catch(() => undefined)
          ])
            .then(([data, body]) =>
              receive(data, url, page, body, request, requestRevision)
            )
            .catch(() => {})
        else failed?.(response.status, response.headers.get("retry-after"))
      }
      return response
    })
  }
  const open = XMLHttpRequest.prototype.open,
    send = XMLHttpRequest.prototype.send,
    setHeader = XMLHttpRequest.prototype.setRequestHeader
  const requests = new WeakMap<
    XMLHttpRequest,
    { url: string; page: string; method: string; headers: Headers }
  >()
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: any[]
  ) {
    if (eligible(String(url)))
      requests.set(this, {
        url: String(url),
        page: location.href,
        method,
        headers: new Headers()
      })
    else requests.delete(this)
    return (open as any).call(this, method, url, ...rest)
  }
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // Some site scripts copy browser-managed headers into XHR. Chrome ignores
    // these but attributes the warnings to this wrapper. Leave cookies,
    // referrer, user agent and fetch metadata to the browser, including replays.
    if (
      this.readyState === XMLHttpRequest.OPENED &&
      /^(cookie2?|referer|user-agent|sec-.+)$/i.test(name)
    )
      return
    const result = setHeader.call(this, name, value)
    requests.get(this)?.headers.append(name, value)
    return result
  }
  XMLHttpRequest.prototype.send = function (body) {
    const request = requests.get(this)
    const requestRevision = request ? ++revision : 0
    if (request && eligible(request.url))
      this.addEventListener(
        "load",
        () => {
          if (this.status < 200 || this.status >= 300) {
            failed?.(this.status, this.getResponseHeader("retry-after"))
            return
          }
          try {
            receive(
              this.responseType === "json"
                ? this.response
                : JSON.parse(this.responseText),
              request.url,
              request.page,
              typeof body === "string" ? body : undefined,
              new Request(new URL(request.url, location.href), {
                method: request.method,
                headers: request.headers,
                credentials: this.withCredentials ? "include" : "same-origin",
                body: typeof body === "string" ? body : undefined
              }),
              requestRevision
            )
          } catch {}
        },
        { once: true }
      )
    return send.call(this, body)
  }
  return () => revision
}
