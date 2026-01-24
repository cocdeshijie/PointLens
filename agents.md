# Agents.md — AwardViewer

## Rules
- Each hotel site must live under `/hotels/<site>/...` with a dedicated folder per site.
- The extension popup should render a site-specific component from the matching `/hotels/<site>/...` folder when the active tab is on that site’s domain.
- Keep site-specific popup UI isolated to its site folder so future hotel sites can be added without mixing concerns.
- Each brand's debug UI should live in its own component under that brand's folder and only render in development builds.

## IHG
- The popup should display: "im current on ihg.com" when the active tab is on ihg.com.
- Keep IHG background/content logic in `/hotels/ihg/`, with `contents/ihg*.ts` as thin entry points that import from that folder.
