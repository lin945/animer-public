import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { SignJWT } from 'jose'
const bundle = await build({entryPoints:['functions/api/[[route]].ts'],bundle:true,format:'esm',platform:'browser',write:false,minify:true})
const {onRequest} = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const config = {APP_ORIGIN:'https://site.test',GITHUB_CLIENT_ID:'synthetic-client',GITHUB_CLIENT_SECRET:'synthetic-secret',SESSION_SECRET:'synthetic-test-only-key-32-characters-long',ADMIN_GITHUB_ID:'34918880'}
const key = new TextEncoder().encode(config.SESSION_SECRET)
async function token(overrides={}) { return '__Host-animer_admin='+await new SignJWT({login:'lin945',provider:'github',...overrides}).setProtectedHeader({alg:'HS256'}).setIssuer(config.APP_ORIGIN).setAudience('animer-admin').setSubject(overrides.sub || config.ADMIN_GITHUB_ID).setIssuedAt().setExpirationTime('1h').sign(key) }
async function call(path, env={}, headers={}, method='GET', body) {
  return onRequest({request:new Request('https://site.test'+path,{method,headers,body}),env,waitUntil(){},passThroughOnException(){}})
}
function kv() { const values = new Map(); return {values,async get(k,type){const v=values.get(k);return v===undefined?null:type==='json'?JSON.parse(v):v},async put(k,v){values.set(k,v)},async delete(k){values.delete(k)}} }
function db(rows=[]) { const calls=[]; return {calls,prepare(sql){ calls.push(sql);return {bind(){return this},async all(){return {results:rows}},async first(){return rows[0]||null},async run(){throw Error('unexpected D1 write')}}},async batch(){throw Error('unexpected D1 batch')}} }

test('all admin and legacy management routes fail closed without configuration',async()=>{
 for(const [path,method] of [['/api/admin/session','GET'],['/api/admin/media-sources','GET'],['/api/subscriptions','GET'],['/api/subscription-status','GET'],['/api/source-health','GET'],['/api/subscriptions/sync','POST'],['/api/media-sources/1','PATCH']]){
   const r=await call(path,{}, {Cookie:await token()},method); assert.equal(r.status,403,path)
 }
})
test('anonymous public mutations and diagnostic cache bypass fail',async()=>{
 for(const [p,m] of [['/api/danmaku','POST'],['/api/search?fresh=1','GET'],['/api/resolve?debug=1','GET']]) assert.equal((await call(p,{}, {},m)).status,403)
})
test('signed session grants exact owner identity; other ID and forged token fail',async()=>{
 let r=await call('/api/admin/session',config,{Cookie:await token()});assert.equal(r.status,200);assert.equal((await r.json()).login,'lin945')
 r=await call('/api/admin/session',config,{Cookie:await token({sub:'12345'})});assert.equal(r.status,403)
 r=await call('/api/admin/session',config,{Cookie:'__Host-animer_admin=eyJhbGciOiJub25lIn0.e30.'});assert.equal(r.status,403)
 r=await call('/api/admin/session',{...config,SESSION_SECRET:'different-test-key-32-characters-long'},{Cookie:await token()});assert.equal(r.status,403)
})
test('authenticated admin mutation rejects cross-origin and missing CSRF header',async()=>{
 const assertion=await token()
 for(const h of [{Origin:'https://evil.test','X-Admin-Request':'1'},{Origin:'https://site.test'}]){
  const r=await call('/api/admin/subscriptions/sync',config,{Cookie:assertion,'Content-Type':'application/json',...h},'POST','{}');assert.equal(r.status,403)
 }
})
test('expired sessions and alternate Pages hosts fail closed',async()=>{
 const expired=await new SignJWT({login:'lin945',provider:'github'}).setProtectedHeader({alg:'HS256'}).setIssuer(config.APP_ORIGIN).setAudience('animer-admin').setSubject(config.ADMIN_GITHUB_ID).setIssuedAt(1).setExpirationTime(2).sign(key)
 assert.equal((await call('/api/admin/session',config,{Cookie:'__Host-animer_admin='+expired})).status,403)
 const r=await onRequest({request:new Request('https://preview.animer.pages.dev/api/subscriptions',{headers:{Cookie:await token()}}),env:config,waitUntil(){},passThroughOnException(){}});assert.equal(r.status,403)
})
test('public source list strips internal fields and warm request avoids D1',async()=>{
 const DB=db([{id:1,name:'Source',enabled:1,cookie:'DO-NOT-EXPOSE',health_reason:'private',search_config:'{}'}]);const CACHE=kv()
 let r=await call('/api/media-sources',{DB,CACHE});assert.equal(r.status,200);const data=await r.json();assert.equal(data.mediaSources[0].name,'Source');assert.equal(data.mediaSources[0].health_reason,undefined);assert.equal(data.mediaSources[0].cookie,undefined)
 const reads=DB.calls.length;r=await call('/api/media-sources',{DB,CACHE});assert.equal(r.headers.get('X-App-Cache'),'HIT');assert.equal(DB.calls.length,reads)
})
test('empty search response is negatively cached and ordinary search does not write health',async()=>{
 const DB=db([{id:1,name:'Source',enabled:1,search_config:'{}'}]);const CACHE=kv()
 const r=await call('/api/search?sourceId=1&keyword=missing',{DB,CACHE});assert.equal(r.status,200);const data=await r.json();assert.equal(data.debug,undefined)
 const n=DB.calls.length;const hit=await call('/api/search?sourceId=1&keyword=missing',{DB,CACHE});assert.equal(hit.headers.get('X-App-Cache'),'HIT');assert.equal(DB.calls.length,n);assert.ok(DB.calls.every(s=>s.startsWith('SELECT')))
})
test('public anime detail caches response without D1 writes',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({data:{Media:{id:7,title:{romaji:'Title'},coverImage:{}}}})
 try{const DB=db();const CACHE=kv();const r=await call('/api/anime/7',{DB,CACHE});assert.equal(r.status,200);assert.equal((await r.json()).anime.id,7);assert.deepEqual(DB.calls,[])}finally{globalThis.fetch=original}
})

test('admin media source list succeeds with verified identity and preserves diagnostics only there',async()=>{
 const DB=db([{id:1,name:'Source',enabled:1,health:'ok',health_reason:'admin detail',search_config:'{}'}])
 const r=await call('/api/admin/media-sources',{...config,DB},{Cookie:await token()})
 assert.equal(r.status,200);assert.equal((await r.json()).mediaSources[0].health_reason,'admin detail');assert.equal(r.headers.get('Cache-Control'),'no-store')
})
test('unchanged subscription sync batches only timestamp and preserves source IDs/settings',async()=>{
 const statements=[];let batch
 const searchConfig={rawBaseUrl:'https://source.example.com',searchUrl:'https://source.example.com/search'}
 const source={id:7,name:'Source',homepage:searchConfig.rawBaseUrl,icon_url:null,match_video_url:null,search_config:JSON.stringify(searchConfig),enabled:0,manual_disabled:1}
 const DB={prepare(sql){const item={sql,args:[],bind(...args){this.args=args;return this},async first(){return {id:3,url:'https://feeds.example.com/feed.json'}},async all(){return {results:[source]}}};statements.push(item);return item},async batch(items){batch=items;return []}}
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({mediaSources:[{arguments:{name:'Source',searchConfig}}]})
 try{
  const r=await call('/api/admin/subscriptions/3/sync',{...config,DB,CACHE:kv()},{Cookie:await token(),Origin:'https://site.test','X-Admin-Request':'1','Content-Type':'application/json'},'POST','{}')
  assert.equal(r.status,200);assert.equal((await r.json()).synced,1);assert.equal(batch.length,1);assert.match(batch[0].sql,/UPDATE subscription_sources/);assert.ok(statements.every(x=>!x.sql.includes('DELETE')))
 }finally{globalThis.fetch=original}
})
test('invalid empty subscription feed performs no database batch',async()=>{
 let batched=false;const DB={prepare(){return {bind(){return this},async first(){return {id:3,url:'https://feeds.example.com/feed.json'}}}},async batch(){batched=true}}
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({mediaSources:[]})
 try{const r=await call('/api/admin/subscriptions/3/sync',{...config,DB},{Cookie:await token(),Origin:'https://site.test','X-Admin-Request':'1','Content-Type':'application/json'},'POST','{}');assert.equal(r.status,502);assert.equal(batched,false)}finally{globalThis.fetch=original}
})
test('admin mutations require bounded valid JSON and reject storing personal cookies',async()=>{
 const headers={Cookie:await token(),Origin:'https://site.test','X-Admin-Request':'1','Content-Type':'application/json'}
 assert.equal((await call('/api/admin/media-sources/1',config,headers,'PATCH',JSON.stringify({cookie:'personal-cookie'}))).status,400)
 assert.equal((await call('/api/admin/media-sources/1',config,headers,'PATCH',JSON.stringify({padding:'x'.repeat(17000)}))).status,400)
})
