const { test, expect, chromium } = require('@playwright/test')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

test('popup update footer links to release notes, persists across views, and disappears after updating', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'pointlens-updates-'))
  const extension = path.resolve('build/chrome-mv3-prod')
  let context
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
    const info = await worker.evaluate(async () => {
      await chrome.storage.local.clear()
      globalThis.updateRequests = 0
      globalThis.fetch = async () => {
        globalThis.updateRequests++
        return new Response(JSON.stringify({ tag_name: 'v99.0.0', draft: false, prerelease: false }))
      }
      return { id: chrome.runtime.id, popup: chrome.runtime.getManifest().action.default_popup }
    })
    const page = await context.newPage()
    await page.setViewportSize({ width: 380, height: 552 })
    const url = `chrome-extension://${info.id}/${info.popup}`
    await page.goto(url)
    const link = page.getByRole('link', { name: 'Update available: v99.0.0. View GitHub release in a new tab', exact: true })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', 'https://github.com/cocdeshijie/PointLens/releases/tag/v99.0.0')
    await expect(link).toHaveAttribute('target', '_blank')
    const bounds = await link.boundingBox()
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(552)
    expect(bounds.y).toBeGreaterThan(500)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(link).toBeVisible()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.screenshot({ path: '/tmp/pointlens-update-dark.png' })
    await page.getByRole('button', { name: 'Back to all sites', exact: true }).click()
    await page.getByRole('button', { name: 'Hyatt hyatt.com', exact: true }).click()
    await expect(link).toBeVisible()
    await page.reload()
    await expect(link).toBeVisible()
    expect(await worker.evaluate(() => globalThis.updateRequests)).toBe(1)
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ 'pointlens:release-update': { nextCheck: Date.now() + 86400000, tag: `v${chrome.runtime.getManifest().version}` } })
    })
    await page.reload()
    await expect(link).toHaveCount(0)
    expect(await worker.evaluate(() => globalThis.updateRequests)).toBe(1)
  } finally {
    await context?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
