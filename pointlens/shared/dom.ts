// Ignore our own badge/tooltip writes, but still notice when a host site
// removes a badge or changes a card's identity, view, or availability.
export const isPointLensNode = (node: Node): boolean => {
  let element = node.nodeType === 1 ? (node as Element) : node.parentElement
  while (element) {
    if (
      Array.from(element.classList).some(
        (name) => name.startsWith("pointlens-") && !name.endsWith("annotated")
      )
    ) {
      return true
    }
    element = element.parentElement
  }
  return false
}

export const hasHostMutation = (mutations: MutationRecord[]): boolean =>
  mutations.some((mutation) => {
    if (isPointLensNode(mutation.target)) return false
    if (mutation.type !== "childList") return true
    if (mutation.removedNodes.length > 0) return true
    return Array.from(mutation.addedNodes).some(
      (node) => !isPointLensNode(node)
    )
  })

export function makeInfoAccessible(icon: HTMLElement) {
  icon.tabIndex = 0
  icon.setAttribute("role", "button")
  icon.setAttribute("aria-label", "PointLens: cash, points and value details")
  icon.addEventListener("keydown", (event) => {
    if (event.key === "Escape") icon.blur()
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      event.stopPropagation()
      icon.dispatchEvent(new FocusEvent("focusin"))
    }
  })
  icon.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    icon.focus()
  })
}
