// Isolated extension QA. Call launchQa() from a Node session; await save() at
// checkpoints and context.close() before rebuilding/relaunching the extension.
// Captures stay under git-ignored sessions/. No browser cookies are exported.
const { createRequire } = require('node:module')
const path = require('node:path')
const fs = require('node:fs/promises')
const root = path.resolve(__dirname, '..')
const { chromium } = createRequire(path.join(root, 'pointlens/package.json'))('playwright')
async function launchQa({ runName = new Date().toISOString().replace(/[:.]/g, '-'), headless = false } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(runName)) throw Error('Invalid run name')
  const dir = path.join(root, 'sessions', 'live-qa', runName)
  await fs.mkdir(dir, { recursive: true })
  const extension = path.join(root, 'pointlens/build/chrome-mv3-prod')
  const context = await chromium.launchPersistentContext(path.join(root, 'sessions/live-qa/state'), {
    channel: 'chromium', headless, viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  })
  const requests = [], errors = [], pending = new Set()
  context.on('page', page => page.on('pageerror', error => errors.push({ page: page.url(), error: String(error) })))
  context.on('response', response => {
    const request = response.request()
    if (!/graphql\/customer|mi\/query|availability\/v3\/hotels\/offers|search\/hotels|shop\/rooms/.test(response.url())) return
    const item = { url: response.url(), method: request.method(), status: response.status(),
      worker: !!request.serviceWorker(), workerUrl: request.serviceWorker()?.url(), fromServiceWorker: response.fromServiceWorker(),
      postData: request.postData(), time: Date.now(), bodyFile: `response-${requests.length + 1}.txt` }
    requests.push(item)
    const task = response.body().then(body => fs.writeFile(path.join(dir, item.bodyFile), body))
      .catch(() => { delete item.bodyFile }).finally(() => pending.delete(task))
    pending.add(task)
  })
  const save = async () => {
    await Promise.allSettled([...pending])
    await fs.writeFile(path.join(dir, 'requests.json'), JSON.stringify(requests, null, 2))
    await fs.writeFile(path.join(dir, 'errors.json'), JSON.stringify(errors, null, 2))
  }
  return { context, requests, errors, dir, save }
}
module.exports = { launchQa }
