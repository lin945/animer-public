import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['functions/api/[[route]].ts'], bundle: true, format: 'esm', platform: 'browser', external: ['node:crypto'], write: false, minify: true })
const { onRequest } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

const ticketBundle = await build({entryPoints:['server/playback-ticket.ts'],bundle:true,format:'esm',platform:'browser',external:['node:crypto'],write:false})
const {mintPlaybackUrl, verifyPlayback} = await import('data:text/javascript;base64,' + Buffer.from(ticketBundle.outputFiles[0].text).toString('base64'))
const signing = {APP_ORIGIN:'https://site.test', SESSION_SECRET:'synthetic-playback-only-key-32-bytes-long'}

async function requestPlay(mediaUrl, headers, upstream, options = {}) {
  const original = globalThis.fetch
  let seen
  globalThis.fetch = async (url, options) => {
    seen = { url, headers: options.headers }
    return upstream
  }
  try {
    const proxyUrl = await mintPlaybackUrl(signing,{url:mediaUrl,sourceId:options.sourceId || '1',referer:options.referer || mediaUrl})
    const request = new Request('https://site.test'+proxyUrl,{headers})
    const response = await onRequest({ request, env: { ...signing, ...(options.env || { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 1, name: 'Synthetic source', enabled: 1, search_config: '{}' }) }) }) } }) }, waitUntil() {}, passThroughOnException() {} })
    return { response, seen }
  } finally {
    globalThis.fetch = original
  }
}

test('视频 Range 请求透传 206、Content-Range，并在响应体结束前返回', async () => {
  let closeBody
  let closed = false
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([0, 0, 0, 1]))
    closeBody = () => { if (!closed) { closed = true; controller.close() } }
  } })
  const upstream = new Response(stream, { status: 206, headers: {
    'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/800000000', 'accept-ranges': 'bytes'
  } })
  let timer
  try {
    const { response, seen } = await Promise.race([
      requestPlay('https://media.test/movie.mp4', { Range: 'bytes=0-3' }, upstream),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('代理缓冲了完整视频')), 400) })
    ])
    assert.equal(seen.headers.Range, 'bytes=0-3')
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 0-3/800000000')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    closeBody()
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 0, 0, 1])
  } finally {
    clearTimeout(timer)
    closeBody()
  }
})

test('重定向后的 HLS 相对分片和密钥按最终清单地址改写', async () => {
  const upstream = new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="enc.key"\nsegment.ts', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
  Object.defineProperty(upstream, 'url', { value: 'https://cdn.test/new/list.m3u8' })
  const { response } = await requestPlay('https://media.test/old/list.m3u8', {}, upstream)
  const text = await response.text()
  assert.equal(response.status, 200)
  assert.match(text, /url=https%3A%2F%2Fcdn\.test%2Fnew%2Fenc\.key/)
  assert.match(text, /url=https%3A%2F%2Fcdn\.test%2Fnew%2Fsegment\.ts/)
})

test('媒体代理保留公共播放提示但不转发历史存储的认证 Cookie', async () => {
  const row = { id: 55, homepage: 'https://source.test', ua: 'source-UA', cookie: 'sid=example', search_config: JSON.stringify({ matchVideo: { addHeadersToVideo: { userAgent: 'video-UA' } } }) }
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) } }
  const upstream = new Response(new Uint8Array([1]), { headers: { 'content-type': 'video/mp4' } })
  const { response, seen } = await requestPlay('https://media.test/file.mp4', {}, upstream, { sourceId: '55', referer: 'https://source.test/episode', env })
  assert.equal(response.status, 200)
  assert.equal(seen.headers['User-Agent'], 'video-UA')
  assert.equal(seen.headers.Cookie, undefined)
  assert.equal(seen.headers.Referer, 'https://source.test/episode')
})

test('源站返回空 HLS 清单时给出失败而不是伪装为播放成功', async () => {
  const upstream = new Response('', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
  const { response } = await requestPlay('https://media.test/empty.m3u8', {}, upstream)
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error, 'Service temporarily unavailable')
})


test('媒体代理拒绝凭据 URL、本机地址和非 HTTP 协议', async () => {
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1/private', 'https://user:pass@media.test/video', 'http://[::1]/video', 'http://local.internal/video']) {
    const {response, seen} = await requestPlay(url, {}, new Response('unused'))
    assert.equal(response.status, 400)
    assert.equal(seen, undefined)
  }
})

test('媒体代理拒绝重定向到私有地址', async () => {
  const {response} = await requestPlay('https://media.test/video', {}, new Response(null, {status:302,headers:{Location:'http://127.0.0.1/private'}}))
  assert.equal(response.status, 502)
})

test('有效票据也不能代理 HTML SVG XML 或 JavaScript 为本站可执行内容', async () => {
  for(const type of ['text/html','Text/HTML; charset=utf-8','image/svg+xml','application/xhtml+xml','application/xml','application/javascript','text/javascript']) {
    const {response}=await requestPlay('https://media.test/deceptive.mp4',{},new Response('<script>alert(1)</script>',{headers:{'content-type':type}}))
    assert.equal(response.status,415,type)
    assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff')
    assert.match(response.headers.get('Content-Security-Policy'),/^sandbox;/)
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin')
  }
})
test('文本误标和无 MIME 的密钥仅以不可执行二进制输出', async () => {
  for(const type of ['text/plain','application/octet-stream']) {
    const {response}=await requestPlay('https://media.test/key',{},new Response(new Uint8Array([1,2,3]),{headers:{'content-type':type}}))
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff')
  }
})
test('HLS 子清单、密钥和分片票据绑定各自 URL 且不能换目标', async () => {
  const {response}=await requestPlay('https://media.test/master.m3u8',{},new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/key"\nhttps://cdn.test/child.m3u8\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}}))
  assert.equal(response.status,200);assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff')
  const body=await response.text();const proxy=body.split('\n').find(x=>x.startsWith('/api/play'))
  const req=new Request('https://site.test'+proxy);const grant=await verifyPlayback(req,signing);assert.equal(grant.url,'https://cdn.test/child.m3u8')
  const changed=new URL(req.url);changed.searchParams.set('url','https://attacker.test/payload.html');assert.equal(await verifyPlayback(new Request(changed),signing),null)
  changed.searchParams.set('url',grant.url);changed.searchParams.set('sourceId','999');assert.equal(await verifyPlayback(new Request(changed),signing),null)
})
test('无票据和过期票据拒绝且错误响应同样加沙箱头', async () => {
  const noTicket=await onRequest({request:new Request('https://site.test/api/play?url=https://media.test/file.mp4&sourceId=1'),env:signing,waitUntil(){},passThroughOnException(){}})
  assert.equal(noTicket.status,403);assert.equal(noTicket.headers.get('X-Content-Type-Options'),'nosniff')
  const original=Date.now;const now=original();Date.now=()=>now-5*60*60*1000
  let expired
  try{expired=await mintPlaybackUrl(signing,{sourceId:'1',url:'https://media.test/file.mp4',referer:'https://source.test'})}finally{Date.now=original}
  assert.equal(await verifyPlayback(new Request('https://site.test'+expired),signing),null)
})
test('不能用任意外站页面或伪造扩展名铸造媒体能力', async () => {
  const env={...signing,DB:{prepare:()=>({bind:()=>({first:async()=>({id:1,name:'Source',enabled:1,homepage:'https://trusted.test',search_config:'{}'})})})}}
  for(const path of ['/api/resolve?sourceId=1&episodeUrl=https://attacker.test/file.mp4','/api/episodes?sourceId=1&subjectUrl=https://attacker.test/subject']) {
    const response=await onRequest({request:new Request('https://site.test'+path),env,waitUntil(){},passThroughOnException(){}})
    assert.equal(response.status,403);assert.equal((await response.json()).proxyUrl,undefined)
  }
})

test('未配置代理签名时仍可返回可信源直链，但不能调用无票据代理', async () => {
  const env={DB:{prepare:()=>({bind:()=>({first:async()=>({id:1,name:'Source',enabled:1,homepage:'https://trusted.test',search_config:'{}'})})})}}
  const response=await onRequest({request:new Request('https://site.test/api/resolve?sourceId=1&episodeUrl=https://trusted.test/video.mp4'),env,waitUntil(){},passThroughOnException(){}})
  assert.equal(response.status,200);const data=await response.json();assert.equal(data.streamUrl,'https://trusted.test/video.mp4');assert.equal(data.proxyUrl,null)
})
