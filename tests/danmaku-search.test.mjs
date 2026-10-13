import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse, compileScript } from '@vue/compiler-sfc'
import { build } from 'esbuild'

const hooks = ['onMounted', 'onActivated', 'onDeactivated', 'onBeforeUnmount']
const mocks = {
  vue: `export const defineComponent = x => x;
    export const ref = value => ({ value });
    export const computed = fn => ({ get value() { return fn() } });
    export const nextTick = () => Promise.resolve();
    export const watch = (source, callback, options) => { globalThis.uiTest.watches.push({source, callback, options}); };
    ${hooks.map(name => `export const ${name} = cb => { globalThis.uiTest.${name}.push(cb); };`).join('\n')}`,
  'vue-router': 'export const useRouter = () => ({push(){}}); export const useRoute = () => ({query:{}});',
  danmaku: 'export default globalThis.uiTest.Engine;',
  '../api': ['getDanmaku', 'bangumiSearch'].map(name => `export const ${name} = (...args) => globalThis.uiTest.api.${name}(...args);`).join('\n'),
  '../history': 'export const recentWatches = () => []; export const clearRecentWatches = () => {}; export const formatWatchTime = () => "";',
  '../store': 'export const remember = () => {};',
}
class Engine {
  constructor(options) { this.options = options; this.destroyed = false; globalThis.uiTest.engines.push(this) }
  destroy() { this.destroyed = true }
  resize() {}
}
function harness(settings) {
  const storage = new Map(settings ? [['animer:danmaku:settings:v1', JSON.stringify(settings)]] : [])
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  globalThis.uiTest = { Engine, engines: [], watches: [], api: {}, ...Object.fromEntries(hooks.map(name => [name, []])) }
  return { state: globalThis.uiTest, storage }
}
harness()
async function component(path) {
  const file = new URL(path, import.meta.url)
  const descriptor = parse(readFileSync(file, 'utf8')).descriptor
  const result = await build({
    stdin: { contents: compileScript(descriptor, { id: path }).content, loader: 'ts', resolveDir: fileURLToPath(new URL('.', file)) },
    bundle: true, format: 'esm', write: false,
    plugins: [{ name: 'ui-test-mocks', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }],
  })
  return (await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))).default
}
const Danmaku = await component('../src/components/DanmakuOverlay.vue')
const Search = await component('../src/views/SearchView.vue')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }
const comment = (text, mode = 'rtl') => ({ text, mode, time_seconds: 1, color: '#fff' })

test('danmaku: late old response cannot replace newest episode; cancel and destroy on deactivate', async () => {
  const { state } = harness()
  const old = deferred()
  const calls = []
  state.api.getDanmaku = (id, url, signal) => { calls.push({ id, url, signal }); return url === 'old' ? old.promise : Promise.resolve([comment('new')]) }
  const props = { subjectId: 1, episodeUrl: 'old', media: {} }
  const view = Danmaku.setup(props, { expose() {} })
  view.stage.value = {}
  const first = view.setup()
  await tick()
  props.episodeUrl = 'new'
  await view.setup()
  assert.equal(calls[0].signal.aborted, true)
  old.resolve([comment('old')])
  await first
  assert.equal(state.engines.length, 1)
  assert.equal(state.engines[0].options.comments[0].text, 'new')
  state.onDeactivated[0]()
  assert.equal(state.engines[0].destroyed, true)
  assert.equal(state.watches[0].source()[1], 1, 'subject ID participates in reload key')
})

test('danmaku: pending response after unmount never constructs engine or changes status', async () => {
  const { state } = harness()
  const result = deferred()
  state.api.getDanmaku = () => result.promise
  const view = Danmaku.setup({ subjectId: 1, episodeUrl: 'old', media: {} }, { expose() {} })
  view.stage.value = {}
  const pending = view.setup()
  await tick()
  state.onBeforeUnmount[0]()
  result.resolve([comment('late')])
  await pending
  assert.equal(state.engines.length, 0)
  assert.equal(view.message.value, '正在加载弹幕…')
})

test('danmaku: local settings round-trip, clamp corrupt values and block keywords/modes', async () => {
  const { state, storage } = harness({ enabled: false, opacity: 7, fontSize: -4, area: 50, mode: 'top', blocklist: 'spam\n广告' })
  state.api.getDanmaku = async () => [comment('SPAM!', 'top'), comment('广告', 'top'), comment('safe', 'top'), comment('scroll')]
  const view = Danmaku.setup({ subjectId: 1, episodeUrl: 'ep', media: {} }, { expose() {} })
  view.stage.value = {}
  await view.setup()
  assert.equal(view.opacity.value, 1)
  assert.equal(view.fontSize.value, 14)
  assert.equal(state.engines.length, 0)
  view.enabled.value = true
  state.watches[1].callback()
  assert.deepEqual(state.engines.at(-1).options.comments.map(row => row.text), ['safe'])
  assert.equal(state.engines.at(-1).options.comments[0].style.fontSize, '14px')
  const saved = JSON.parse(storage.get('animer:danmaku:settings:v1'))
  assert.deepEqual(saved, { enabled: true, opacity: 1, fontSize: 14, area: 50, mode: 'top', blocklist: 'spam\n广告' })
  globalThis.localStorage.setItem = () => { throw new Error('storage denied') }
  assert.doesNotThrow(() => view.persistSettings())
})

test('search: old failure cannot erase latest success or clear latest loading state', async () => {
  const { state } = harness()
  const old = deferred(); const latest = deferred(); const calls = []
  state.api.bangumiSearch = (q, signal) => { calls.push({ q, signal }); return q === 'old' ? old.promise : latest.promise }
  const view = Search.setup({}, { expose() {} })
  view.q.value = 'old'; const first = view.doSearch()
  view.q.value = 'latest'; const second = view.doSearch()
  old.reject(new Error('old failure')); await first
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(view.loading.value, true)
  assert.equal(view.error.value, '')
  latest.resolve([{ id: 2, tags: [] }]); await second
  assert.equal(view.items.value[0].id, 2)
  assert.equal(view.loading.value, false)
})

test('search: deactivation aborts stale request; activation resumes cancelled search', async () => {
  const { state } = harness()
  const pending = deferred(); let calls = 0; let signal
  state.api.bangumiSearch = (_q, s) => { signal = s; calls++; return calls === 1 ? pending.promise : Promise.resolve([{ id: 3, tags: [] }]) }
  const view = Search.setup({}, { expose() {} })
  view.q.value = 'series'; const first = view.doSearch()
  state.onDeactivated[0]()
  assert.equal(signal.aborted, true)
  pending.resolve([{ id: 1, tags: [] }]); await first
  assert.deepEqual(view.items.value, [])
  state.onActivated[0](); await tick()
  assert.equal(view.items.value[0].id, 3)
  assert.equal(calls, 2)
})

test('public UI has no comment composer, subscription controls or unverified mascot assets', () => {
  const danmaku = readFileSync(new URL('../src/components/DanmakuOverlay.vue', import.meta.url), 'utf8')
  const search = readFileSync(new URL('../src/views/SearchView.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(danmaku, /sendDanmaku|async function submit|发个友善弹幕/)
  assert.doesNotMatch(search, /SubscriptionStatus|播放源与订阅管理|res\/.*\.png|奶龙/)
})
