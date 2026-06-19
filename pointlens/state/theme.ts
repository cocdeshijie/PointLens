import { atom } from "jotai"

// Popup theme state. Per the repo's state rule, this is shared client-state
// consumed by the shell, the settings page, and the per-site panels, so it lives
// in Jotai atoms (not prop-drilled / context).

export type ThemePref = "system" | "light" | "dark"
export type ThemeName = "light" | "dark"

export type Palette = {
  scheme: ThemeName
  bg: string
  headerBg: string
  surface: string
  surfaceHover: string
  surfaceAlt: string
  iconTile: string
  border: string
  text: string
  textMuted: string
  textFaint: string
  shadow: string
  scrollThumb: string
  scrollThumbHover: string
  accent: string
}

export const PALETTES: Record<ThemeName, Palette> = {
  light: {
    scheme: "light",
    bg: "#f4f6f9",
    headerBg: "#ffffff",
    surface: "#ffffff",
    surfaceHover: "#ffffff",
    surfaceAlt: "#f8fafc",
    iconTile: "#ffffff",
    border: "#e7ebf0",
    text: "#0f172a",
    textMuted: "#64748b",
    textFaint: "#94a3b8",
    shadow: "rgba(15, 23, 42, 0.08)",
    scrollThumb: "#dbe1e8",
    scrollThumbHover: "#c3cbd6",
    accent: "#4f46e5"
  },
  dark: {
    scheme: "dark",
    bg: "#0e1320",
    headerBg: "#151c2b",
    surface: "#1a2230",
    surfaceHover: "#202a3a",
    surfaceAlt: "#131a27",
    iconTile: "#f1f5f9",
    border: "#2a3446",
    text: "#e8edf5",
    textMuted: "#9aa7ba",
    textFaint: "#6b7889",
    shadow: "rgba(0, 0, 0, 0.45)",
    scrollThumb: "#2f3a4d",
    scrollThumbHover: "#3c4a60",
    accent: "#7c83ff"
  }
}

const THEME_KEY = "pointlens:theme"

// User preference, loaded from + synced to chrome.storage. onMount hydrates from
// storage and listens for cross-context changes; writes persist back.
const basePrefAtom = atom<ThemePref>("system")
basePrefAtom.onMount = (set) => {
  let active = true
  void chrome?.storage?.local?.get(THEME_KEY).then((r) => {
    const value = r?.[THEME_KEY] as ThemePref | undefined
    if (active && (value === "light" || value === "dark" || value === "system")) {
      set(value)
    }
  })
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string
  ) => {
    if (area === "local" && changes[THEME_KEY]) {
      set((changes[THEME_KEY].newValue as ThemePref) ?? "system")
    }
  }
  chrome?.storage?.onChanged?.addListener(handler)
  return () => {
    active = false
    chrome?.storage?.onChanged?.removeListener(handler)
  }
}

export const themePrefAtom = atom(
  (get) => get(basePrefAtom),
  (_get, set, next: ThemePref) => {
    set(basePrefAtom, next)
    void chrome?.storage?.local?.set({ [THEME_KEY]: next })
  }
)

// Live OS color-scheme, kept in sync via matchMedia.
const systemDarkAtom = atom(false)
systemDarkAtom.onMount = (set) => {
  if (typeof window === "undefined" || !window.matchMedia) return
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  set(mq.matches)
  const handler = (e: MediaQueryListEvent) => set(e.matches)
  mq.addEventListener("change", handler)
  return () => mq.removeEventListener("change", handler)
}

export const resolvedThemeAtom = atom<ThemeName>((get) => {
  const pref = get(themePrefAtom)
  if (pref === "light" || pref === "dark") return pref
  return get(systemDarkAtom) ? "dark" : "light"
})

export const paletteAtom = atom<Palette>((get) => PALETTES[get(resolvedThemeAtom)])
