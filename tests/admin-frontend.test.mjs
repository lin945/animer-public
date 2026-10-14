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
  '../api': `export const ApiError = globalThis.adminTest.ApiError;` + ['adminSession', 'adminAccess', 'adminLogout', 'adminMediaSources', 'checkSourceHealth', 'updateSource'].map(name => `export const ${name} = (...args) => globalThis.adminTest.api.${name}(...args);`).join('\n'),
  './SubscriptionStatus.vue': 'export default {};',
  '../admin-access': `export const ADMIN_ACCESS_EVENT = 'animer-admin-access'; export const takeAdminAccess = () => { const result = globalThis.adminTest.access || {present:false,token:null}; globalThis.adminTest.access = null; return result }; export const clearAdminAccess = () => {globalThis.adminTest.access = null};`,
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
  globalThis.adminTest.access = null
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

test('Owner logout clears management state immediately and ignores late source responses', async () => {
  let resolveSources
  let resolveLogout
  let requestSignal
  let logoutCalls = 0
  const state = setup({
    adminSession: async () => ({ authenticated: true, login: 'owner', provider: 'link' }),
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
test('capability view contains no credential form, OAuth link, or credential storage', () => {
  const view = readFileSync(new URL('../src/views/AdminView.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(view, /<form|<input|GitHub|Cloudflare Access|localStorage|sessionStorage|adminLogin/)
})
const syntheticToken = 'A'.repeat(43)
function giveAccess() { const access = { present: true, token: syntheticToken }; globalThis.adminTest.access = access; return access }
test('capability exchange uses only same-origin POST JSON, no referrer or cache', async () => {
  const original = globalThis.fetch
  let call
  const signal = new AbortController().signal
  globalThis.fetch = async (url, init) => { call = { url, init }; return Response.json({ authenticated: true }) }
  try {
    await api.adminAccess(syntheticToken, signal)
    assert.equal(call.url, '/api/auth/access')
    assert.deepEqual(JSON.parse(call.init.body), { token: syntheticToken })
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(call.init.cache, 'no-store')
    assert.equal(call.init.referrerPolicy, 'no-referrer')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.signal, signal)
    assert.equal(call.init.headers['X-Admin-Request'], '1')
    globalThis.fetch = async () => Response.json({ error: syntheticToken }, { status: 401 })
    await assert.rejects(api.adminAccess(syntheticToken), error => error.status === 401 && !error.message.includes(syntheticToken))
  } finally { globalThis.fetch = original }
})
test('exchange consumes token immediately, deduplicates, and verifies session before management', async () => {
  let resolveAccess, resolveSession
  let attempts = 0, sourceCalls = 0, sessionCalls = 0
  const state = setup({
    adminAccess: async token => { attempts++; assert.equal(token, syntheticToken); return new Promise(resolve => { resolveAccess = resolve }) },
    adminSession: () => { sessionCalls++; return new Promise(resolve => { resolveSession = resolve }) },
    adminMediaSources: async () => { sourceCalls++; return [] },
  })
  const handoff = giveAccess()
  const pending = state.verify()
  await state.verify()
  assert.equal(attempts, 1)
  assert.equal(handoff.token, null)
  assert.equal(globalThis.adminTest.access, null)
  assert.equal(sessionCalls, 0)
  resolveAccess()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sourceCalls, 0)
  assert.equal(state.authorized.value, false)
  resolveSession({ authenticated: true, login: 'owner', provider: 'link' })
  await pending
  assert.equal(sourceCalls, 1)
  assert.equal(state.authorized.value, true)
})
for (const status of [401, 403, 503]) {
  test(`failed exchange ${status} clears token and never retries it`, async () => {
    let attempts = 0, sourceCalls = 0
    const state = setup({
      adminAccess: async () => { attempts++; throw new api.ApiError(status, 'restricted') },
      adminSession: async () => { throw new api.ApiError(401, 'no session') },
      adminMediaSources: async () => { sourceCalls++; return [] },
    })
    const handoff = giveAccess()
    await state.verify()
    assert.equal(state.authorized.value, false)
    assert.equal(handoff.token, null)
    assert.equal(sourceCalls, 0)
    await state.verify()
    assert.equal(attempts, 1)
    assert.equal(state.authorized.value, false)
  })
}
for (const interrupt of ['unmount', 'logout']) {
  test(`${interrupt} interrupts exchange and rejects late success`, async () => {
    let resolveAccess, signal, sessionCalls = 0
    const state = setup({
      adminAccess: (_token, requestSignal) => { signal = requestSignal; return new Promise(resolve => { resolveAccess = resolve }) },
      adminSession: async () => { sessionCalls++; return { authenticated: true } },
      adminLogout: async () => {},
    })
    giveAccess()
    const pending = state.verify()
    if (interrupt === 'unmount') globalThis.adminTest.unmount()
    else await state.logout()
    assert.equal(signal.aborted, true)
    resolveAccess()
    await pending
    assert.equal(sessionCalls, 0)
    assert.equal(state.authorized.value, false)
    assert.deepEqual(state.sources.value, [])
  })
}
test('malformed link is rejected before any authentication or management request', async () => {
  const state = setup({ adminAccess: () => assert.fail('exchange'), adminSession: () => assert.fail('session') })
  globalThis.adminTest.access = { present: true, token: null }
  await state.verify()
  assert.equal(state.gateStatus.value, 403)
  assert.equal(state.authorized.value, false)
})
test('bootstrap strips fragment before router import and consumes only canonical tokens once', async () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.ok(main.startsWith("import './admin-access'"))
  const code = transformSync(readFileSync(new URL('../src/admin-access.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code
  const old = globalThis.window
  const events = []
  const listeners = new Map()
  globalThis.window = { location: { pathname: '/admin', search: '', hash: '#access=' + syntheticToken }, history: { state: {current: '/admin#access=' + syntheticToken, back: '/admin#access=' + syntheticToken}, replaceState(state, _title, url) { globalThis.window.history.state = state; events.push(url); globalThis.window.location.hash = '' } }, dispatchEvent(event) { events.push(event.type) }, addEventListener(type, handler) { listeners.set(type, handler) } }
  try {
    const access = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
    assert.deepEqual(events, ['/admin', 'animer-admin-access'])
    assert.equal(globalThis.window.history.state, null)
    assert.ok(listeners.has('popstate')); assert.ok(listeners.has('hashchange'))
    assert.deepEqual(access.takeAdminAccess(), { present: true, token: syntheticToken })
    assert.deepEqual(access.takeAdminAccess(), { present: false, token: null })
    for (const token of ['short', 'A'.repeat(42) + 'B', syntheticToken + '&other=1', syntheticToken + '=']) {
      assert.equal(access.captureAdminAccess('/admin', '#access=' + token), true)
      assert.deepEqual(access.takeAdminAccess(), { present: true, token: null })
    }
    assert.equal(access.captureAdminAccess('/', '#access=' + syntheticToken), false)
    globalThis.window.location.hash = '#access=' + syntheticToken
    listeners.get('hashchange')()
    assert.equal(globalThis.window.location.hash, '')
    assert.deepEqual(access.takeAdminAccess(), { present: true, token: syntheticToken })
    globalThis.window.location.hash = '#access=' + syntheticToken
    listeners.get('popstate')()
    assert.equal(globalThis.window.location.hash, '')
    assert.deepEqual(access.takeAdminAccess(), { present: true, token: syntheticToken })
  } finally { globalThis.window = old }
})
test('a newly received link replaces a pending exchange without admitting a stale result', async () => {
  const exchanges = []
  let sourceCalls = 0
  const state = setup({
    adminAccess: (_token, signal) => new Promise(resolve => exchanges.push({ signal, resolve })),
    adminSession: async () => ({ authenticated: true, login: 'owner', provider: 'link' }),
    adminMediaSources: async () => { sourceCalls++; return [] },
  })
  giveAccess()
  const first = state.verify()
  giveAccess()
  state.receiveAccess()
  assert.equal(exchanges.length, 2)
  assert.equal(exchanges[0].signal.aborted, true)
  exchanges[0].resolve()
  await first
  assert.equal(state.authorized.value, false)
  assert.equal(sourceCalls, 0)
  exchanges[1].resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.authorized.value, true)
  assert.equal(sourceCalls, 1)
})
test('new link received during logout is discarded to avoid conflicting session cookie responses', async () => {
  let resolveLogout
  const state = setup({ adminLogout: () => new Promise(resolve => { resolveLogout = resolve }), adminAccess: () => assert.fail('exchange during logout') })
  const pending = state.logout()
  giveAccess()
  state.receiveAccess()
  assert.equal(globalThis.adminTest.access, null)
  resolveLogout()
  await pending
  assert.equal(state.authorized.value, false)
})
