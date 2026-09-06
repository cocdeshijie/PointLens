export function renderHyattRoomStatus(
  host: HTMLElement,
  message?: string,
  loading = false
) {
  let status = host.querySelector<HTMLElement>(
    ":scope > .pointlens-hyatt-room-status"
  )
  if (!message) {
    status?.remove()
    return
  }
  if (!document.getElementById("pointlens-hyatt-room-status-style")) {
    const style = document.createElement("style")
    style.id = "pointlens-hyatt-room-status-style"
    style.textContent = `.pointlens-hyatt-room-status{display:flex;align-items:center;gap:7px;margin:7px 0;min-height:25px;clear:both;font:13px/1.4 system-ui,sans-serif;color:#64748b}.pointlens-hyatt-room-status::before{content:"";width:19px;flex-shrink:0}.pointlens-hyatt-room-status span{display:inline-block;padding:2px 6px;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc}.pointlens-hyatt-room-status[aria-busy=true] span{width:160px;height:24px;box-sizing:border-box;background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:pointlens-hyatt-loading 1.5s ease-in-out infinite}@keyframes pointlens-hyatt-loading{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.pointlens-hyatt-room-status[aria-busy=true] span{animation:none}}`
    document.head.append(style)
  }
  const signature = `${loading}:${message}`
  if (status?.dataset.signature === signature) return
  if (!status) {
    status = document.createElement("div")
    status.className = "pointlens-hyatt-room-status"
    status.setAttribute("role", "status")
    status.append(document.createElement("span"))
    host.append(status)
  }
  status.dataset.signature = signature
  status.setAttribute("aria-busy", String(loading))
  status.setAttribute("aria-label", message)
  status.firstElementChild!.textContent = loading ? "" : message
}
