import test from 'node:test'
import assert from 'node:assert/strict'
import { createReleaseChecker, newerRelease, RELEASE_API, UPDATE_INTERVAL } from '../shared/release-updates.ts'
const release = (tag_name, rest = {}) => new Response(JSON.stringify({ tag_name, draft: false, prerelease: false, ...rest }))
function harness(fetch) {
  let cache = null, time = 100000
  const deps = { load: async () => cache, save: async (value) => { cache = structuredClone(value) }, fetch, now: () => time }
  return { deps, check: createReleaseChecker(deps), advance: () => { time += UPDATE_INTERVAL + 1 }, cache: () => cache }
}
test('release comparison handles numeric versions, installed updates and unsafe tags', () => {
  assert.equal(newerRelease('v1.0.10', '1.0.9')?.version, '1.0.10')
  for (const [tag, installed] of [['v1.0.10','1.0.10'], ['v1.0.9','1.0.10'], ['1.0.10','1.0.10.1']]) assert.equal(newerRelease(tag, installed), null)
  for (const tag of ['v2.0.0-beta.1', '../../download/file', 'https://evil.example', null]) assert.equal(newerRelease(tag, '1.0.10'), null)
  assert.equal(newerRelease('v1.0.11', '1.0.10')?.url, 'https://github.com/cocdeshijie/PointLens/releases/tag/v1.0.11')
})
test('concurrent popup opens share one anonymous request and persist the daily cache', async () => {
  let calls = 0
  const h = harness(async (url, options) => {
    calls++
    assert.equal(url, RELEASE_API)
    assert.equal(options.credentials, 'omit')
    assert.equal(options.headers.Authorization, undefined)
    assert.ok(h.cache().nextCheck > 100000)
    return release('v1.0.11')
  })
  const [older, installed] = await Promise.all([h.check('1.0.10'), h.check('1.0.11')])
  assert.equal(older.version, '1.0.11')
  assert.equal(installed, null)
  await createReleaseChecker(h.deps)('1.0.10')
  assert.equal(calls, 1)
  h.advance(); await h.check('1.0.10'); assert.equal(calls, 2)
})
test('offline and private-repository failures remain silent and do not retry on reopen', async () => {
  for (const response of [() => { throw new Error('offline') }, () => new Response('', { status: 404 })]) {
    let calls = 0
    const h = harness(async () => { calls++; return response() })
    assert.equal(await h.check('1.0.10'), null)
    assert.equal(await createReleaseChecker(h.deps)('1.0.10'), null)
    assert.equal(calls, 1)
  }
})
test('failed refresh preserves a known release and honors longer rate-limit backoff', async () => {
  let calls = 0
  const h = harness(async () => ++calls === 1 ? release('v1.0.11') : new Response('', { status: 429, headers: { 'retry-after': String(3 * UPDATE_INTERVAL / 1000) } }))
  await h.check('1.0.10'); h.advance()
  assert.equal((await h.check('1.0.10')).version, '1.0.11')
  h.advance(); await createReleaseChecker(h.deps)('1.0.10'); assert.equal(calls, 2)
})
test('drafts, prereleases, malformed data and non-GitHub URLs never create notices', async () => {
  for (const response of [release('v9.0.0', { draft: true }), release('v9.0.0', { prerelease: true }), release('v9.0.0-beta'), release('https://evil.example'), new Response('{broken')]) {
    assert.equal(await harness(async () => response).check('1.0.10'), null)
  }
  const h = harness(async () => release('v1.0.11', { html_url: 'https://evil.example' }))
  assert.equal((await h.check('1.0.10')).url, 'https://github.com/cocdeshijie/PointLens/releases/tag/v1.0.11')
})
