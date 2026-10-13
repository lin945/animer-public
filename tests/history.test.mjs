import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'

const code = transformSync(readFileSync(new URL('../src/history.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code
const { recentWatches, recentFor, rememberEpisode, updateRecentProgress, formatWatchTime } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

function storage() {
  const rows = new Map()
  globalThis.localStorage = { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) }
  return rows
}

test('同一集续播保留进度，换集后从新集开头记录', () => {
  storage()
  const subject = { id: 633836, name_cn: '第四季 夺还篇', name: '第四季', cover: '/poster.jpg' }
  rememberEpisode(subject, { name: '第01集', url: '/ep1' })
  updateRecentProgress(633836, '/ep1', 83, 1800)
  assert.equal(recentFor(633836)?.position, 83)
  rememberEpisode(subject, { name: '第01集', url: '/ep1' })
  assert.equal(recentFor(633836)?.position, 83)
  rememberEpisode(subject, { name: '第02集', url: '/ep2' })
  assert.deepEqual([recentFor(633836)?.episodeName, recentFor(633836)?.position], ['第02集', 0])
  updateRecentProgress(633836, '/ep1', 230, 1800)
  assert.equal(recentFor(633836)?.position, 0)
})

test('接近片尾和播放结束会标记完成，记录最多保留 12 部', () => {
  storage()
  for (let id = 1; id <= 14; id++) rememberEpisode({ id, name_cn: `番剧${id}`, name: '', cover: '' }, { name: '第1集', url: `/ep${id}` })
  assert.equal(recentWatches().length, 12)
  assert.equal(recentFor(1), undefined)
  updateRecentProgress(14, '/ep14', 96, 100)
  assert.equal(recentFor(14)?.completed, true)
  assert.equal(formatWatchTime(96), '01:36')
})

test('存储损坏或浏览器禁止存储时观看页仍能使用', () => {
  const rows = storage()
  rows.set('animer:recent:v1', '{bad')
  assert.deepEqual(recentWatches(), [])
  globalThis.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.deepEqual(recentWatches(), [])
  assert.doesNotThrow(() => rememberEpisode({ id: 1, name_cn: '番剧', name: '', cover: '' }, { name: '第1集', url: '/ep1' }))
})


test('same normalized episode on a different source retains local progress', () => {
  storage()
  const subject={id:5,name_cn:'作品',name:'',cover:''}
  rememberEpisode(subject,{name:'第07集',url:'/source-a/7'})
  updateRecentProgress(5,'/source-a/7',240,1500)
  rememberEpisode(subject,{name:'7',url:'/source-b/7'})
  assert.equal(recentFor(5).position,240)
  assert.equal(recentFor(5).episodeUrl,'/source-b/7')
  updateRecentProgress(5,'/source-a/7',10,1500)
  assert.equal(recentFor(5).position,240)
})
