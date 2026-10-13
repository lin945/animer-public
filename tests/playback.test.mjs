import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'

const code = transformSync(readFileSync(new URL('../src/playback.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code
const { bestSubject, episodeAlternatives, orderedSources, sameEpisodeName, waitForMediaReady } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

test('同一番的精确季度和分篇优先，不自动选第二季或 SP', () => {
  const second = { name: 'Re：从零开始的异世界生活 第二季', url: '/s2' }
  const fourth = { name: 'Re：从零开始的异世界生活第四季', url: '/s4' }
  const exact = { name: 'Re：从零开始的异世界生活 第四季 夺还篇', url: '/s4-part2' }
  assert.equal(bestSubject([second, fourth, exact], exact.name), exact)
  assert.equal(bestSubject([second, fourth], exact.name), fourth)
  assert.equal(bestSubject([second, { name: 'Re：从零开始的异世界生活 SP', url: '/sp' }], exact.name), undefined)
  assert.equal(bestSubject([{ name: 'Re：从零开始的异世界生活 第四季 丧失篇', url: '/s4-part1' }], exact.name), undefined)
  assert.equal(bestSubject([{ name: '鬼灭之刃 柱训练篇', url: '/different' }, { name: '鬼灭之刃', url: '/first-season' }], '鬼灭之刃 兄妹的羁绊'), undefined)
  assert.equal(bestSubject([{ name: '鬼灭之刃兄妹羁绊', url: '/movie' }], '鬼灭之刃 兄妹的羁绊')?.url, '/movie')
  assert.equal(bestSubject([{ name: '鬼滅の刃 兄妹の絆', url: '/original' }], '鬼灭之刃 兄妹的羁绊', ['鬼滅の刃 兄妹の絆'])?.url, '/original')
})

test('第 7 集在主线失败后能试到第三条备用线路，且不会混入第 1 集或 SP07', () => {
  const target = { name: '第07集', url: '/a/7', channel: '主线1' }
  const channels = [
    { name: '主线1', items: [{ name: '第01集', url: '/a/1' }, target] },
    { name: '主线2', items: [{ name: '7', url: '/b/7' }] },
    { name: '备用', items: [{ name: '第7集', url: '/c/7' }, { name: 'SP07', url: '/c/sp7' }] },
    { name: '缺集线路', items: [{ name: '第01集', url: '/d/1' }] },
  ]
  assert.deepEqual(episodeAlternatives(channels, target).map(ep => ep.url), ['/a/7', '/b/7', '/c/7'])
  assert.deepEqual(episodeAlternatives(channels, target, '备用').map(ep => ep.url), ['/c/7', '/a/7', '/b/7'])
  assert.equal(sameEpisodeName('第07集', '第7集'), true)
  assert.equal(sameEpisodeName('SP07', '第07集'), false)
})

test('能尝试第 6 个以后的源，上次成功源优先且当前轮不重复失败源', () => {
  const sources = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `源${i + 1}`, health: 'ok' }))
  assert.equal(orderedSources(sources, undefined, 1, []).length, 8)
  assert.deepEqual(orderedSources(sources, '源8', 1, [2, 3]).map(s => s.id), [8, 1, 4, 5, 6, 7])
  assert.deepEqual(orderedSources(sources, '源8', 1, sources.map(s => s.id)), [])
})

class FakeMedia extends EventTarget {
  readyState = 0
  error = null
}

test('解析到 URL 或元数据不算成功，必须有可解码的媒体数据', async () => {
  const video = new FakeMedia()
  const controller = new AbortController()
  let resolved = false
  const ready = waitForMediaReady(video, controller.signal).then(() => { resolved = true })
  video.readyState = 1
  video.dispatchEvent(new Event('loadedmetadata'))
  await Promise.resolve()
  assert.equal(resolved, false)
  video.readyState = 2
  video.dispatchEvent(new Event('loadeddata'))
  await ready
  assert.equal(resolved, true)
})

test('媒体错误、HLS fatal 和超时都会失败，允许调用方继续换线', async () => {
  const video = new FakeMedia()
  const ready = waitForMediaReady(video, new AbortController().signal)
  video.error = { code: 4 }
  video.dispatchEvent(new Event('error'))
  await assert.rejects(ready, /媒体加载失败/)
  const controller = new AbortController()
  const hls = waitForMediaReady(new FakeMedia(), controller.signal)
  controller.abort(new Error('manifestLoadError（HTTP 502）'))
  await assert.rejects(hls, /HTTP 502/)
  await assert.rejects(waitForMediaReady(new FakeMedia(), new AbortController().signal, 10), /超时/)
})

test('新选择取消旧播放等待，旧视频事件不能把请求重新判成成功', async () => {
  const video = new FakeMedia()
  const controller = new AbortController()
  const ready = waitForMediaReady(video, controller.signal)
  controller.abort()
  video.readyState = 4
  video.dispatchEvent(new Event('canplay'))
  await assert.rejects(ready, { name: 'AbortError' })
})

