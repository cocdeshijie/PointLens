// Marriott adds these presentation parameters after a search starts. They do
// not change the stay or the rates; native request generations handle sorting
// and pagination without relying on the map/list hash.
export function marriottSearchContext(href: string) {
  const url = new URL(href)
  url.hash = ""
  for (const key of ["view", "deviceType"]) url.searchParams.delete(key)
  url.searchParams.sort()
  return url.href
}
