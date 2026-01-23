# agents.md — Award Viewer Chrome Extension (Plasmo)  
*Instructions for coding agents (e.g., Codex) to follow this repo’s structure and engineering practices.*

> **Goal**: An extension that augments hotel search / booking result pages by displaying **award (points) cost**, **cents-per-point (CPP)**, and related value metrics next to the **cash price** across multiple hotel sites.  
> **Key constraint**: Each hotel site has a different DOM and navigation model, but the extension must support them all in one codebase.

---

## Non‑negotiable principles

1. **One site = one content script entrypoint**  
   Do not run Hilton logic on Marriott pages. Each site gets its own file in `contents/` with `PlasmoCSConfig.matches`.

2. **Site logic must be isolated**  
   DOM parsing/injection for a site lives under `src/sites/<site>/…`.  
   Shared business logic lives in `src/core/…`. Shared UI lives in `src/ui/…`.

3. **Networking + caching belong in `background/`**  
   Content scripts should avoid direct cross-origin networking. Instead they send typed messages to the background service worker which performs fetch/caching and returns normalized results.

4. **Stable contracts over ad‑hoc parsing**  
   Each site adapter implements a consistent “adapter contract” so adding a new site is mechanical and low-risk.

5. **TypeScript strictness is a feature**  
   Prefer explicit types, small modules, and predictable data flow. Avoid `any`. If a value is unknown, model it as `unknown` and narrow.

6. **No brittle DOM assumptions**  
   Prefer robust selectors, multiple fallbacks, and defensive parsing. Assume the site is an SPA and the DOM changes over time.

---

## Repository layout (must be preserved)

```txt
award-viewer/
  contents/
    hilton.tsx
    marriott.tsx
    hyatt.tsx
    ihg.tsx
    ...one per site...
  background/
    index.ts
    messages/
      get-award-quote.ts
      get-settings.ts
      set-settings.ts
      clear-cache.ts
  src/
    core/
      types.ts
      cpp.ts
      money.ts
      format.ts
      logger.ts
    sites/
      hilton/
        adapter.ts
        dom.ts
        parse.ts
      marriott/
        adapter.ts
        dom.ts
        parse.ts
      ...one folder per site...
    ui/
      PriceBadge.tsx
      InlineRow.tsx
      Spinner.tsx
      styles.css
    storage/
      settings.ts
      cache.ts
  options.tsx
  popup.tsx (optional)
```

### Rules
- **Do not** create new top-level folders unless absolutely necessary.
- **Do not** put site-specific selectors or parsing logic into `src/core` or `src/ui`.
- Keep `contents/<site>.tsx` **thin**: wire-up only (match + mount + call adapter + message).

---

## Naming conventions

- **Site folder name**: lowercase, single token if possible (e.g., `marriott`, `hilton`, `hyatt`, `ihg`).
- **Files**
  - `adapter.ts`: orchestration glue + public API for that site.
  - `dom.ts`: DOM querying, locating anchors, observers, navigation handling.
  - `parse.ts`: pure parsing utilities; should be unit-testable with fixtures.
- **Message handlers**: kebab-case filename, verb-first (e.g., `get-award-quote.ts`).
- **Types**: PascalCase (`StayContext`, `AwardQuote`), functions camelCase.

---

## Core data model (single source of truth)

All site adapters and the background worker must use the shared types from:

- `src/core/types.ts`

### Required shapes (do not fork per site)
- `StayContext`  
  Minimal information needed to request or compute an award quote:
  - `site`: which site emitted the request (enum/string union)
  - `program`: loyalty program (enum/string union)
  - `hotelId` / `propertyId` (site-specific but stored in a consistent field)
  - `checkIn`, `checkOut` (ISO dates)
  - `guests`, `rooms` (numbers)
  - `currency` (e.g., USD)
  - `cash`: `{ amount: number, currency: string }` (normalized money)
  - `roomType` / `rateCode` if available (optional)

- `AwardQuote`
  - `points` (integer)
  - `program` (same as input)
  - `cashEquivalent` (optional)
  - `taxesFees` (optional normalized money)
  - `fetchedAt` (timestamp)
  - `source` (which provider logic produced it)

- `ComputedValue`
  - `cpp` (cents per point)
  - `label` (e.g., “Good”, “Bad”, “Neutral” based on user thresholds)
  - `explanation` (optional short text)

### Calculation rules
- CPP should be computed in **cents** (not dollars):
  - `cpp = (cash.amount / points) * 100`
- If `points` is missing/0, CPP is undefined; UI must degrade gracefully.

All CPP and formatting logic must live in:
- `src/core/cpp.ts`
- `src/core/money.ts`
- `src/core/format.ts`

---

## Content scripts (`contents/*.tsx`) — strict boundaries

Each content script must:
1. Export `config: PlasmoCSConfig` with `matches` for **only that site**.
2. Import the site adapter from `src/sites/<site>/adapter`.
3. Locate anchors (cash price nodes) using the adapter.
4. For each anchor:
   - Extract `StayContext` (dates/hotel id/cash)
   - Call background message: `get-award-quote`
   - Render shared UI component(s) next to the price.

### Content script must NOT:
- Perform cross-origin fetches to award endpoints.
- Persist data directly in storage except via the storage module.
- Contain site-specific parsing logic (that belongs in `src/sites/<site>/parse.ts`).

---

## Site adapter contract (how to add a site)

When adding a new site `<site>`:

### 1) Add folder
`src/sites/<site>/` with:
- `adapter.ts`
- `dom.ts`
- `parse.ts`

### 2) Add content script entrypoint
`contents/<site>.tsx` with `matches` and minimal wiring.

### 3) Implement adapter API (required)
Each adapter exports:

- `getSiteId(): SiteId`
- `findAnchors(root: Document | ShadowRoot): Anchor[]`
- `extractStayContext(anchor: Anchor): StayContext | null`
- `mountBadge(anchor: Anchor, props: PriceBadgeProps): void`
- `startObservers(onAnchorsChanged: () => void): () => void`  
  Returns a cleanup function.

### 4) DOM robustness requirements
In `dom.ts`:
- Use resilient selectors and fallback strategies.
- Support SPA navigation:
  - MutationObserver + URL change detection (polling or history hooks if safe).
- Avoid heavy observers:
  - Observe a high-level container, debounce updates, and ignore irrelevant mutations.

In `parse.ts`:
- Parsing must be **pure**, deterministic, and easily unit tested.
- Functions should accept `string`/`Element`/`DocumentFragment` and return typed results.

---

## Background worker (`background/`) — messaging, fetch, cache

### Messaging rules
- Message names are stable API: treat them as public endpoints.
- Every message must have:
  - Request type
  - Response type
  - Explicit error strategy

Example handlers (required):
- `get-award-quote`
- `get-settings`
- `set-settings`
- `clear-cache`

### `get-award-quote` behavior
Input: `StayContext`  
Output: `{ quote: AwardQuote | null, computed: ComputedValue | null, warnings?: string[] }`

Rules:
- Normalize output to shared types.
- Cache results by a stable key derived from:
  - program + hotelId + dates + guests + roomType (+ currency if needed)
- Cache TTL should be configurable (default: 30–120 minutes depending on data stability).
- Apply rate limiting / backoff where appropriate.

### Fetch rules
- All network requests must:
  - Have timeouts
  - Retry only when safe (idempotent)
  - Return structured errors (no thrown raw strings)
- Never log sensitive data.

---

## Storage (`src/storage/`) — settings + cache

### `settings.ts`
- Define `Settings` schema and defaults.
- Provide `loadSettings()` / `saveSettings(partial)` with migration support.
- Settings examples:
  - enabled sites/programs
  - valuation thresholds (cpp cutoffs)
  - display options (show taxes, show “good deal” label, etc.)
  - cache TTL

### `cache.ts`
- Provide:
  - `get(key)`
  - `set(key, value, ttlMs)`
  - `clear()`
- Prefer an in-memory cache with an optional persisted layer if needed.
- Never store personally identifying information.

---

## UI components (`src/ui/`) — shared and site-agnostic

- Components must be **site-agnostic**: no site selectors, no site-specific assumptions.
- Keep components small and composable:
  - `PriceBadge`
  - `InlineRow`
  - `Spinner`
- Accessibility:
  - Use semantic elements
  - Provide `aria-label` where needed
- Styling:
  - Centralize shared styles in `src/ui/styles.css` or component-level styles.
  - Avoid conflicting with host page CSS (prefer scoped classes; consider shadow root mounting if used by the framework).

---

## Error handling & UX

- If award cost can’t be determined:
  - Show a subtle placeholder (“—” or “Not available”)
  - Do not break the page
- If parsing fails:
  - Fail silently + log in debug mode
- Use warnings in message responses for non-fatal problems (e.g., “dates not found”).

---

## Logging (`src/core/logger.ts`)

- Default: minimal logs.
- Debug mode controlled via settings.
- Never log:
  - full page HTML
  - user account data
  - booking details beyond what is required for quote requests

---

## Performance requirements

- Content scripts must:
  - Avoid scanning the entire DOM repeatedly
  - Debounce mutation handling (e.g., 200–500ms)
  - Cache parsed anchors per page load if possible
- Do not inject large React trees per row; reuse simple components and avoid unnecessary rerenders.

---

## Security & permissions

- Request the minimum Chrome permissions needed.
- Avoid broad host permissions unless required; prefer per-site `matches`.
- Treat all DOM input as untrusted.
- Do not store credentials. Do not attempt to bypass paywalls or authentication.

---

## Testing strategy (must follow)

- Unit tests for:
  - `src/core/cpp.ts`, `money.ts`, `format.ts`
  - `src/sites/<site>/parse.ts` with DOM/string fixtures
- Optional integration tests:
  - Simulated DOM pages for each site to validate anchor finding/injection

Parsing modules should be written to make tests easy (pure functions).

---

## Dev workflow (Plasmo)

Required scripts (expected in `package.json`):
- `pnpm dev` — development build
- `pnpm build` — production build
- `pnpm package` — outputs distributable bundle

When developing:
- Load unpacked from `build/chrome-mv3-dev/`.

---

## Code style rules (enforce consistently)

- Prefer `const` over `let`.
- Use early returns and small functions.
- No nested callbacks > 2 levels.
- No `any` unless there is a strong reason; document the reason.
- Always validate and narrow `unknown`.
- Keep PR diffs small and localized to a single site when possible.

---

## “Add a new site” checklist (copy/paste)

1. Create `src/sites/<site>/{adapter.ts,dom.ts,parse.ts}`
2. Add `contents/<site>.tsx` with correct `matches`
3. Implement adapter contract
4. Add/extend program provider in background (if needed)
5. Add parsing fixtures + unit tests
6. Verify on:
   - search results list page
   - hotel detail page
   - SPA navigation (filters, date changes)
7. Confirm no excessive permissions were added

---

## Agent operating rules (for Codex)

- **Do not** restructure the repo without explicit instruction.
- **Do not** mix site code into shared modules.
- **Do not** implement networking in content scripts.
- **Do** add types and reuse shared formatting/cpp utilities.
- **Do** keep `contents/<site>.tsx` thin.
- **Do** add tests for parsing and core calculations.

If you need a new shared capability:
1) Propose it as a `src/core/*` utility or `src/ui/*` component,
2) Use it from multiple sites,
3) Keep it site-agnostic.

---

*Last updated:* 2026-01-23 (America/Chicago)
