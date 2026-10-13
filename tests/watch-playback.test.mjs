import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse, compileScript } from '@vue/compiler-sfc'
import { build } from 'esbuild'

// 执行真实组件的播放流程；只替换网络、浏览器媒体元素和 Vue 挂载环境。
const mocks = {
  vue: `export const defineComponent = value => value;
    export const ref = value => ({ value });
    export const computed = getter => ({ get value() { return getter() } });
    export const onMounted = fn => globalThis.watchTest.hooks.mounted = fn;
    export const onActivated = fn => globalThis.watchTest.hooks.activated = fn;
    export const onDeactivated = fn => globalThis.watchTest.hooks.deactivated = fn;
    export const onBeforeUnmount = fn => globalThis.watchTest.hooks.unmount = fn;`,
  'vue-router': 'export const useRouter = () => ({ push() {} });',
  'hls.js': 'export default globalThis.watchTest.Hls;',
  '../api': ['mediaSources', 'sourceSearch', 'sourceEpisodes', 'resolveStream', 'updateSource', 'checkSourceHealth', 'bangumiSubject']
    .map(name => `export const ${name} = (...args) => globalThis.watchTest.api.${name}(...args);`).join('\n'),
  '../store': 'export const recall = () => null; export const remember = () => {};',
  '../components/DanmakuOverlay.vue': 'export default {};',
}

class FakeVideo extends EventTarget {
  readyState = 0
  paused = true
  error = null
  currentTime = 0
  _src = ''
  set src(value) {
    this._src = value
    this.readyState = 0
    this.error = null
    queueMicrotask(() => {
      if (this._src !== value) return
      if (value.includes('broken-file') || (globalThis.watchTest.proxyFileFails && value.startsWith('/api/play?'))) {
        this.error = { code: 4 }
        this.dispatchEvent(new Event('error'))
      } else {
        this.readyState = 4
        this.dispatchEvent(new Event('loadeddata'))
      }
    })
  }
  get src() { return this._src }
  pause() { const wasPlaying = !this.paused; this.paused = true; if (wasPlaying) this.dispatchEvent(new Event('pause')) }
  load() { this.readyState = 0 }
  removeAttribute(name) { if (name === 'src') this._src = '' }
  canPlayType() { return '' }
  async play() {
    if (globalThis.watchTest.autoplayBlocked) throw new DOMException('Click required', 'NotAllowedError')
    this.paused = false
  }
}

class FakeHls {
  static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' }
  static isSupported() { return true }
  stopLoad() {}
  startLoad() {}
  callbacks = new Map()
  destroyed = false
  constructor() { globalThis.watchTest.players.push(this) }
  on(name, callback) { this.callbacks.set(name, callback) }
  emit(name, data) { if (!this.destroyed) this.callbacks.get(name)?.(name, data) }
  loadSource(url) { this.url = new URL(url, 'https://app.test').searchParams.get('url') || url }
  attachMedia(video) {
    queueMicrotask(() => {
      if (this.destroyed) return
      if (this.url.includes('broken')) return this.fail()
      this.emit('manifest')
      video.readyState = 4
      video.dispatchEvent(new Event('loadeddata'))
    })
  }
  fail() { this.emit('error', { fatal: true, details: 'manifestLoadError', response: { code: 502 } }) }
  destroy() { this.destroyed = true }
}

globalThis.watchTest = { Hls: FakeHls }
const descriptor = parse(readFileSync(new URL('../src/views/WatchView.vue', import.meta.url), 'utf8')).descriptor
const compiled = await build({
  stdin: { contents: compileScript(descriptor, { id: 'watch-test' }).content, loader: 'ts', resolveDir: fileURLToPath(new URL('../src/views', import.meta.url)) },
  bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'playback-test-dependencies', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
const { default: Watch } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))

const title = '测试番 第四季'
const source = id => ({ id, name: `源${id}`, enabled: 1, health: 'ok' })
const episode = (url, channel = '主线', name = '第07集') => ({ name, url, channel })
const result = channels => ({ channels, items: channels.flatMap(channel => channel.items) })
const playable = url => ({ streamUrl: `https://media.test/${url}.m3u8`, kind: 'hls', headers: {} })

function setup(sources, episodes, resolve) {
  const storage = new Map()
  const calls = []
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  globalThis.watchTest = {
    Hls: FakeHls, players: [], hooks: {}, autoplayBlocked: false,
    api: {
      sourceSearch: async id => ({ items: [{ name: title, url: `/subject/${id}` }] }),
      sourceEpisodes: async id => episodes[id],
      resolveStream: async (id, url, opts) => { calls.push({ id, url, signal: opts.signal }); const value = await resolve(id, url, opts); return value?.streamUrl ? { ...value, proxyUrl: `/api/play?url=${encodeURIComponent(value.streamUrl)}&sourceId=${id}&referer=${encodeURIComponent(url)}&ticket=synthetic-test-ticket` } : value },
    },
  }
  const view = Watch.setup({ id: 633836 }, { expose() {} })
  view.videoEl.value = new FakeVideo()
  view.sources.value = sources
  view.sourceId.value = sources[0].id
  view.kwInput.value = title
  return { view, calls, storage, harness: globalThis.watchTest }
}

async function until(condition) {
  for (let i = 0; i < 30 && !condition(); i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(condition(), '播放流程没有到达预期状态')
}

test('真实组件：两个不支持的主线后自动播放第三条 HLS 备用线，并保存成功线路', async () => {
  const channels = ['主线1', '主线2', '备用'].map((name, i) => ({ name, items: [episode(`/line/${i + 1}/7`, name)] }))
  const { view, calls, storage, harness } = setup([source(1)], { 1: result(channels) }, (_id, url) => url.includes('/3/')
    ? playable('good') : { streamUrl: 'https://media.test/broken-file.mp4', kind: 'file', headers: { 'User-Agent': 'custom' } })
  harness.autoplayBlocked = true
  await view.openSubject(title)
  assert.deepEqual(calls.map(call => call.url), ['/line/1/7', '/line/2/7', '/line/3/7'])
  assert.equal(view.currentEp.value.url, '/line/3/7')
  assert.equal(view.selectedChannel.value, '备用')
  assert.equal(view.playbackStates.value[1].state, 'ready')
  assert.equal(view.error.value, '')
  assert.equal(JSON.parse(storage.get('animer:playback:633836')).channel, '备用')
  calls.length = 0
  await view.openSubject(title)
  assert.deepEqual(calls.map(call => call.url), ['/line/3/7'])
  view.clearVideo()
})

test('真实组件：前五源能解析 URL 但媒体 502，必须继续到第六个源', async () => {
  const sources = Array.from({ length: 6 }, (_, i) => source(i + 1))
  const episodes = Object.fromEntries(sources.map(s => [s.id, result([{ name: '主线', items: [episode(`/source/${s.id}/7`)] }])]))
  const { view, calls } = setup(sources, episodes, id => playable(id === 6 ? 'good' : 'broken'))
  await view.openSubject(title)
  assert.deepEqual(calls.map(call => call.id), [1, 2, 3, 4, 5, 6])
  assert.equal(view.sourceId.value, 6)
  assert.equal(view.error.value, '')
  assert.match(view.triedLog.value[0].why, /HTTP 502/)
  view.clearVideo()
})

test('真实组件：播放中 fatal 先换同集备用线，再换源，保留第七集', async () => {
  const { view, calls, harness } = setup([source(1), source(2)], {
    1: result([{ name: '主线', items: [episode('/a/7')] }, { name: '备用', items: [episode('/b/7', '备用')] }]),
    2: result([{ name: '主线', items: [episode('/c/1', '主线', '第01集'), episode('/c/7')] }]),
  }, () => playable('good'))
  await view.openSubject(title)
  harness.players.at(-1).fail()
  await until(() => view.currentEp.value?.url === '/b/7' && !view.loading.value)
  harness.players.at(-1).fail()
  await until(() => view.sourceId.value === 2 && view.currentEp.value?.url === '/c/7' && !view.loading.value)
  assert.deepEqual(calls.map(call => call.url), ['/a/7', '/b/7', '/c/7'])
  assert.equal(view.error.value, '')
  view.clearVideo()
})

test('真实组件：快速换集后，迟到的旧解析结果不能覆盖最后选择', async () => {
  let finishOld
  const oldResult = new Promise(resolve => { finishOld = resolve })
  const old = episode('/line/3', '主线', '第03集')
  const latest = episode('/line/7')
  const { view, calls } = setup([source(1)], {}, (_id, url) => url === old.url ? oldResult : playable('good'))
  view.setEpisodes(result([{ name: '主线', items: [old, latest] }]))
  const first = view.playEpisode(old)
  const second = view.playEpisode(latest)
  await second
  finishOld(playable('old'))
  await first
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(view.currentEp.value.url, latest.url)
  assert.equal(view.error.value, '')
  assert.equal(view.loading.value, false)
  view.clearVideo()
})

test('真实组件：全部源失败后用户重试会重新探测，不能被上轮失败记录永久跳过', async () => {
  let recovered = false
  const { view, calls } = setup([source(1)], { 1: result([{ name: '主线', items: [episode('/line/7')] }]) }, () => playable(recovered ? 'good' : 'broken'))
  await view.openSubject(title)
  assert.match(view.error.value, /HTTP 502/)
  recovered = true
  await view.retryOtherSources()
  assert.equal(calls.length, 2)
  assert.equal(view.error.value, '')
  assert.equal(view.currentEp.value.url, '/line/7')
  view.clearVideo()
})

test('真实组件：不把宽泛的系列搜索结果当成指定电影播放', async () => {
  const { view, calls, harness } = setup([source(1), source(2)], {
    1: result([{ name: '主线', items: [episode('/wrong/1')] }]),
    2: result([{ name: '主线', items: [episode('/right/1')] }]),
  }, () => playable('good'))
  const movie = '鬼灭之刃 兄妹的羁绊'
  view.kwInput.value = movie
  harness.api.sourceSearch = async id => ({ items: [{ name: id === 1 ? '鬼灭之刃' : movie, url: `/subject/${id}` }] })
  await view.openSubject(movie)
  assert.equal(view.sourceId.value, 2)
  assert.deepEqual(calls.map(call => call.id), [2])
  assert.match(view.triedLog.value[0].why, /没找到这部番/)
  view.clearVideo()
})

test('真实组件：需要专用 UA 的 MP4 先试代理，代理失败时直链仍可播放', async () => {
  const { view, harness } = setup([source(1)], {
    1: result([{ name: '主线', items: [episode('/movie/1')] }]),
  }, () => ({ streamUrl: 'https://media.test/movie.mp4', kind: 'file', headers: { 'User-Agent': 'custom' } }))
  harness.proxyFileFails = true
  await view.openSubject(title)
  assert.equal(view.videoEl.value.src, 'https://media.test/movie.mp4')
  assert.equal(view.videoEl.value.readyState, 4)
  assert.equal(view.error.value, '')
  assert.equal(view.playbackStates.value[1].state, 'playing')
  view.clearVideo()
})

test('真实组件：专用 UA 文件的代理成功时保持站内视频地址', async () => {
  const { view } = setup([source(1)], {
    1: result([{ name: '主线', items: [episode('/movie/1')] }]),
  }, () => ({ streamUrl: 'https://media.test/movie.mp4', kind: 'file', headers: { 'User-Agent': 'custom' } }))
  await view.openSubject(title)
  assert.match(view.videoEl.value.src, /^\/api\/play\?url=/)
  assert.equal(view.error.value, '')
  view.clearVideo()
})


test('manual source changes preserve the selected episode instead of playing episode one', async () => {
  const { view, calls } = setup([source(1), source(2)], {
    1: result([{ name: '主线', items: [episode('/a/7')] }]),
    2: result([{ name: '主线', items: [episode('/b/1', '主线', '第01集'), episode('/b/7')] }]),
  }, () => playable('good'))
  await view.openSubject(title)
  view.sourceId.value = 2
  view.onSourceChange()
  await until(() => !view.loading.value)
  assert.equal(view.currentEp.value.url, '/b/7')
  assert.equal(calls.at(-1).url, '/b/7')
  view.clearVideo()
})

test('deactivation preserves playing intent while explicit pause stays paused', async () => {
  const { view, harness } = setup([source(1)], { 1: result([{name:'主线',items:[episode('/a/7')]}]) }, () => playable('good'))
  await view.openSubject(title)
  view.initialized = true
  const video = view.videoEl.value
  video.addEventListener('pause', view.onVideoPause)
  view.onVideoPlay()
  harness.hooks.deactivated()
  assert.equal(video.paused, true)
  harness.hooks.activated()
  assert.equal(video.paused, false)
  video.pause()
  harness.hooks.deactivated(); harness.hooks.activated()
  assert.equal(video.paused, true)
  view.clearVideo()
})

test('leaving during metadata load prevents later sources and playback requests', async () => {
  const { view, harness, calls } = setup([source(1)], {}, () => playable('good'))
  let finish
  let sourceLoads = 0
  harness.api.bangumiSubject = () => new Promise(resolve => { finish = resolve })
  harness.api.mediaSources = async () => { sourceLoads++; return [source(1)] }
  const loading = view.initialize()
  harness.hooks.deactivated()
  finish({id:633836,name:title,name_cn:title,tags:[],rating:{score:null,total:null}})
  await loading
  assert.equal(sourceLoads, 0)
  assert.equal(calls.length, 0)
  assert.equal(view.subject.value, null)
})

test('auto-next defaults off; enabled countdown can be cancelled without episode requests', async () => {
  const { view, calls } = setup([source(1)], {}, () => playable('good'))
  view.setEpisodes(result([{name:'主线',items:[episode('/a/7'),episode('/a/8','主线','第08集')]}]))
  await view.playEpisode(episode('/a/7'))
  assert.equal(view.autoNext.value, false)
  view.onVideoEnded()
  assert.equal(view.countdown.value, 0)
  view.autoNext.value = true
  view.onVideoEnded()
  assert.equal(view.countdown.value, 5)
  view.cancelAutoNext()
  assert.equal(view.countdown.value, 0)
  assert.equal(view.nextTimer, null)
  assert.equal(calls.length, 1)
  view.clearVideo()
})

test('speed, auto-next and manual OP duration persist locally; shortcuts ignore inputs', async () => {
  const { view, storage } = setup([source(1)], {}, () => playable('good'))
  view.playbackRate.value = 1.5; view.autoNext.value = true; view.opSeconds.value = 90
  view.saveSettings()
  assert.deepEqual(JSON.parse(storage.get('animer:player-settings:v1')), {rate:1.5,autoNext:true})
  assert.equal(JSON.parse(storage.get('animer:show-settings:633836')).opSeconds,90)
  assert.equal(view.videoEl.value.playbackRate,1.5)
  let prevented=false
  view.currentEp.value=episode('/a/7'); view.videoEl.value.currentTime=50
  view.onShortcut({key:'ArrowRight',target:{closest:()=>true},preventDefault(){prevented=true}})
  assert.equal(view.videoEl.value.currentTime,50);assert.equal(prevented,false)
  view.onShortcut({key:'ArrowRight',target:{closest:()=>false},preventDefault(){prevented=true}})
  assert.equal(view.videoEl.value.currentTime,60);assert.equal(prevented,true)
})

test('a sole direct-load failure cannot be reported as ready without a proxy ticket', async () => {
  const { view, harness } = setup([source(1)], {}, () => null)
  harness.api.resolveStream = async () => ({streamUrl:'https://media.test/broken-file.mp4',kind:'file',headers:{},proxyUrl:null})
  const ok=await view.playEpisode(episode('/direct/7'))
  assert.equal(ok,false)
  assert.equal(view.playbackStates.value[1].state,'failed')
  assert.match(view.error.value,/媒体加载失败/)
})
