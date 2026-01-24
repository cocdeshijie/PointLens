# Agents.md — AwardViewer

## Rules
- Each hotel site must live under `/hotels/<site>/...` with a dedicated folder per site (e.g., `/hotels/ihg/`).
- The extension popup should render a site-specific component from the matching `/hotels/<site>/...` folder when the active tab is on that site’s domain.
- For IHG, the popup should display: "im current on ihg.com" when the active tab is on ihg.com.
- Keep site-specific popup UI isolated to its site folder so future hotel sites can be added without mixing concerns.
