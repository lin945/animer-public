import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse, compileScript } from '@vue/compiler-sfc'
import { build, transformSync } from 'esbuild'

const apiCode = transformSync(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code
const api = await import('data:text/javascript;base64,' + Buffer.from(apiCode).toString('base64'))

test('public APIs forward cancellation and discard operational source fields', async () => {
  const signal = new AbortController().signal
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return Response.json(url.includes('media-sources') ? { mediaSources: [{ id: 1, name: 'source', health: 'blocked', has_credentials: true, fail_count: 5 }] } : { list: [], items: [] })
  }
  try {
    await api.bangumiSearch('test', signal)
    await api.bangumiSubject(1, signal)
    await api.getDanmaku(1, 'https://example.test/ep', signal)
    const sources = await api.mediaSources(signal)
    assert.ok(calls.every(call => call.init.signal === signal))
    assert.equal(sources[0].health, 'unknown')
    assert.equal(sources[0].has_credentials, false)
    assert.equal(sources[0].fail_count, 0)
  } finally { globalThis.fetch = original }
})

test('management requests exclusively use admin endpoints and mutation CSRF headers', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ authenticated: true, ok: true, mediaSources: [] }) }
  try {
    await api.adminSession()
    await api.subscriptionStatus()
    await api.syncSubscriptions()
    await api.adminMediaSources()
    await api.updateSource(1, { enabled: false })
    await api.checkSourceHealth()
    await api.sourceHealthList()
    assert.ok(calls.every(call => call.url.startsWith('/api/admin/')))
    for (const { init } of calls) {
      assert.equal(init.cache, 'no-store')
      assert.equal(init.redirect, 'error')
      if (init.method) {
        assert.equal(init.headers['X-Admin-Request'], '1')
        assert.equal(init.headers['Content-Type'], 'application/json')
        assert.ok(init.body)
      }
    }
    globalThis.fetch = async () => Response.json({ error: 'denied' }, { status: 403 })
    await assert.rejects(api.adminSession(), error => error instanceof api.ApiError && error.status === 403)
    globalThis.fetch = async () => Response.json({ ok: true })
    await assert.rejects(api.adminSession(), error => error.status === 403)
  } finally { globalThis.fetch = original }
})

const mocks = {
  vue: `export const defineComponent = value => value; export const ref = value => ({ value }); export const computed = getter => ({ get value() { return getter() } }); export const onMounted = callback => { globalThis.adminTest.mount = callback }; export const onBeforeUnmount = callback => { globalThis.adminTest.unmount = callback };`,
  '../api': `export const ApiError = globalThis.adminTest.ApiError;` + ['adminSession', 'adminLogout', 'adminMediaSources', 'checkSourceHealth', 'updateSource'].map(name => `export const ${name} = (...args) => globalThis.adminTest.api.${name}(...args);`).join('\n'),
  './SubscriptionStatus.vue': 'export default {};',
}
globalThis.adminTest = { ApiError: api.ApiError }
const descriptor = parse(readFileSync(new URL('../src/views/AdminView.vue', import.meta.url), 'utf8')).descriptor
const compiled = await build({
  stdin: { contents: compileScript(descriptor, { id: 'admin-test' }).content, loader: 'ts', resolveDir: fileURLToPath(new URL('../src/views', import.meta.url)) },
  bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'admin-mocks', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
const { default: Admin } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
function setup(apiMocks) {
  globalThis.adminTest.api = apiMocks
  return Admin.setup({}, { expose() {} })
}
for (const status of [401, 403, 503]) {
  test(`admin denial ${status} never requests source management data`, async () => {
    let calls = 0
    const state = setup({ adminSession: async () => { throw new api.ApiError(status, 'denied') }, adminMediaSources: async () => { calls++; return [] } })
    await globalThis.adminTest.mount()
    assert.equal(calls, 0)
    assert.equal(state.authorized.value, false)
    assert.equal(state.gateStatus.value, status)
  })
}
test('admin waits for authentication, clears state on expiry, and cancels on unmount', async () => {
  let resolveSession
  let signal
  let requests = 0
  const state = setup({
    adminSession: async value => { signal = value; return new Promise(resolve => { resolveSession = resolve }) },
    adminMediaSources: async () => { requests++; return [{ id: 1, name: 'private-source' }] },
  })
  const mounting = globalThis.adminTest.mount()
  assert.equal(requests, 0)
  assert.equal(state.authorized.value, false)
  resolveSession()
  await mounting
  assert.equal(requests, 1)
  assert.equal(state.authorized.value, true)
  state.handleError(new api.ApiError(401, 'expired'))
  assert.equal(state.authorized.value, false)
  assert.deepEqual(state.sources.value, [])
  assert.equal(signal.aborted, true)
  globalThis.adminTest.unmount()
})
test('admin route is lazy and excluded from sensitive keep-alive caching', () => {
  const router = readFileSync(new URL('../src/router/index.ts', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(router, /component: \(\) => import\('@\/views\/AdminView.vue'\).*sensitive: true/)
  assert.match(app, /<keep-alive[^>]*>\s*<component v-if="!current.meta.sensitive"/)
})

async function compileView(filename, dependencies) {
  const descriptor = parse(readFileSync(new URL(`../src/views/${filename}`, import.meta.url), 'utf8')).descriptor
  const result = await build({
    stdin: { contents: compileScript(descriptor, { id: filename }).content, loader: 'ts', resolveDir: fileURLToPath(new URL('../src/views', import.meta.url)) },
    bundle: true, format: 'esm', write: false,
    plugins: [{ name: 'view-mocks', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(dependencies, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: dependencies[args.path], loader: 'js' }))
    } }],
  })
  return (await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))).default
}
test('subscription component cannot issue a management request without explicit authenticated mount', async () => {
  let calls = 0
  const Subscription = await compileView('SubscriptionStatus.vue', {
    vue: mocks.vue,
    '../api': `export const ApiError = globalThis.adminTest.ApiError; export const subscriptionStatus = () => globalThis.adminTest.request(); export const syncSubscriptions = () => globalThis.adminTest.request();`,
  })
  globalThis.adminTest.request = () => { calls++; return { ok: true, subscriptions: [], totalSources: 0 } }
  const state = Subscription.setup({}, { expose() {}, emit() {} })
  await globalThis.adminTest.mount()
  await state.refresh()
  assert.equal(calls, 0)
  globalThis.adminTest.unmount()
})
test('calendar ignores interrupted response and reloads on activation', async () => {
  const hooks = {}
  const requests = []
  globalThis.calendarTest = { hooks, request: signal => new Promise(resolve => requests.push({ signal, resolve })) }
  const Calendar = await compileView('CalendarView.vue', {
    vue: `export const defineComponent = value => value; export const ref = value => ({ value }); export const computed = getter => ({ get value() { return getter() } });` + ['Mounted', 'Activated', 'Deactivated', 'BeforeUnmount'].map(name => `export const on${name} = callback => { globalThis.calendarTest.hooks.${name} = callback };`).join('\n'),
    'vue-router': 'export const useRouter = () => ({ push() {} });',
    '../api': 'export const bangumiCalendar = signal => globalThis.calendarTest.request(signal);',
    '../store': 'export const remember = () => {};',
  })
  const state = Calendar.setup({}, { expose() {} })
  const first = hooks.Mounted()
  hooks.Activated()
  assert.equal(requests.length, 1)
  hooks.Deactivated()
  assert.equal(requests[0].signal.aborted, true)
  hooks.Activated()
  assert.equal(requests.length, 2)
  requests[0].resolve([{ weekday: { id: 1 }, items: [] }])
  await first
  assert.deepEqual(state.days.value, [])
  requests[1].resolve([{ weekday: { id: 2 }, items: [] }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.days.value[0].weekday.id, 2)
  hooks.BeforeUnmount()
})

test('GitHub logout clears management state immediately and ignores late source responses', async () => {
  let resolveSources
  let resolveLogout
  let requestSignal
  let logoutCalls = 0
  const state = setup({
    adminSession: async () => ({ authenticated: true, login: 'owner', provider: 'github' }),
    adminMediaSources: signal => { requestSignal = signal; return new Promise(resolve => { resolveSources = resolve }) },
    adminLogout: () => { logoutCalls++; return new Promise(resolve => { resolveLogout = resolve }) },
  })
  const mounted = globalThis.adminTest.mount()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.authorized.value, true)
  const logout = state.logout()
  await state.logout()
  assert.equal(logoutCalls, 1)
  assert.equal(requestSignal.aborted, true)
  assert.equal(state.authorized.value, false)
  assert.equal(state.login.value, '')
  assert.deepEqual(state.sources.value, [])
  resolveSources([{ id: 1, name: 'late private source' }])
  await mounted
  assert.deepEqual(state.sources.value, [])
  resolveLogout()
  await logout
  assert.equal(state.loggingOut.value, false)
  assert.equal(state.logoutFailed.value, false)
})
test('subscription requests cancel synchronously with parent session and discard late data', async () => {
  const Subscription = await compileView('SubscriptionStatus.vue', {
    vue: mocks.vue,
    '../api': `export const ApiError = globalThis.adminTest.ApiError; export const subscriptionStatus = signal => globalThis.adminTest.subscriptionRequest(signal); export const syncSubscriptions = () => {};`,
  })
  let resolveRequest
  let childSignal
  globalThis.adminTest.subscriptionRequest = signal => { childSignal = signal; return new Promise(resolve => { resolveRequest = resolve }) }
  const session = new AbortController()
  const state = Subscription.setup({ authenticated: true, sessionSignal: session.signal }, { expose() {}, emit() {} })
  const loading = globalThis.adminTest.mount()
  session.abort()
  assert.equal(childSignal.aborted, true)
  resolveRequest({ ok: true, subscriptions: [{ name: 'private' }] })
  await loading
  assert.equal(state.status.value, null)
  globalThis.adminTest.unmount()
})
test('GitHub login uses direct navigation and logout uses same-origin CSRF protection', async () => {
  const view = readFileSync(new URL('../src/views/AdminView.vue', import.meta.url), 'utf8')
  assert.match(view, /href="\/api\/auth\/github\/login"/)
  assert.doesNotMatch(view, /Cloudflare Access|localStorage|sessionStorage/)
  const original = globalThis.fetch
  let call
  globalThis.fetch = async (url, init) => { call = { url, init }; return Response.json({ ok: true }) }
  try {
    await api.adminLogout()
    assert.equal(call.url, '/api/auth/logout')
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(call.init.headers['X-Admin-Request'], '1')
    assert.equal(call.init.headers['Content-Type'], 'application/json')
    assert.equal(call.init.body, '{}')
  } finally { globalThis.fetch = original }
})
