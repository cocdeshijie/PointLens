// Parse JSON hydration, never execute page script text or forward account data.
export function hydration(document: Document): any {
  for (const script of Array.from(document.scripts)) {
    const text = script.src ? "" : script.textContent ?? ""
    const marker = "window.PRELOADED_STATE ="
    const at = text.indexOf(marker)
    if (at < 0) continue
    const source = text.slice(at + marker.length).trimStart()
    let depth = 0,
      quoted = false,
      escaped = false
    for (let i = 0; i < source.length; i++) {
      const c = source[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (c === "\\") escaped = true
        else if (c === '"') quoted = false
      } else if (c === '"') quoted = true
      else if (c === "{" || c === "[") depth++
      else if (c === "}" || c === "]") {
        if (--depth === 0) {
          try {
            return JSON.parse(source.slice(0, i + 1))
          } catch {
            return
          }
        }
      }
    }
  }
}
