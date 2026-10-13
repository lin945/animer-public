import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { jwtVerify } from 'jose'
const bundle=await build({entryPoints:['server/admin-auth.ts'],bundle:true,format:'esm',platform:'browser',write:false})
const {githubLogin,githubCallback,verifyAdmin,githubLogout,authConfigured}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const env={APP_ORIGIN:'https://site.test',GITHUB_CLIENT_ID:'test-client',GITHUB_CLIENT_SECRET:'test-only-client-secret',SESSION_SECRET:'test-only-session-secret-at-least-32-bytes',ADMIN_GITHUB_ID:'34918880'}
async function begin(){const response=await githubLogin(new Request(env.APP_ORIGIN+'/api/auth/github/login'),env);const cookie=response.headers.get('Set-Cookie').split(';')[0];const url=new URL(response.headers.get('Location'));return{response,cookie,url}}
function req(start,state=start.url.searchParams.get('state')){return new Request(env.APP_ORIGIN+'/api/auth/github/callback?'+new URLSearchParams({code:'synthetic-one-time-code',state}),{headers:{Cookie:start.cookie}})}
function sessionCookie(r){return r.headers.getSetCookie().find(c=>c.startsWith('__Host-animer_admin=')).split(';')[0]}

test('login fails closed without secrets; authorization requests identity only and PKCE',async()=>{
 assert.equal(authConfigured({}),false);assert.equal((await githubLogin(new Request(env.APP_ORIGIN),{})).status,503)
 const {response,cookie,url}=await begin();assert.equal(url.origin,'https://github.com');assert.equal(url.searchParams.get('scope'),'');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),env.APP_ORIGIN+'/api/auth/github/callback')
 assert.match(response.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Lax; Max-Age=600/)
 const flow=(await jwtVerify(cookie.split('=')[1],new TextEncoder().encode(env.SESSION_SECRET),{issuer:env.APP_ORIGIN,audience:'animer-oauth'})).payload
 const expected=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(flow.verifier))).toString('base64url');assert.equal(url.searchParams.get('code_challenge'),expected)
})
test('callback exchanges exact PKCE code then allows stable owner ID and stores no provider token',async()=>{
 const start=await begin();const calls=[];const old=globalThis.fetch
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return url.includes('access_token')?Response.json({access_token:'synthetic-access-token',token_type:'bearer',scope:''}):Response.json({id:34918880,login:'owner-renamed'})}
 try{const r=await githubCallback(req(start),env);assert.equal(r.headers.get('Location'),env.APP_ORIGIN+'/admin');assert.equal(calls.length,2);assert.equal(calls[0].options.body.get('client_secret'),env.GITHUB_CLIENT_SECRET);assert.ok(calls[0].options.body.get('code_verifier'));assert.equal(calls[1].url,'https://api.github.com/user');assert.ok(!r.headers.get('Set-Cookie').includes('synthetic-access-token'));const identity=await verifyAdmin(new Request(env.APP_ORIGIN+'/api/admin/session',{headers:{Cookie:sessionCookie(r)}}),env);assert.equal(identity.id,'34918880');assert.equal(identity.login,'owner-renamed')}finally{globalThis.fetch=old}
})
test('mismatched or absent state never exchanges code',async()=>{
 const start=await begin();const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('must not fetch')}
 try{let r=await githubCallback(req(start,'wrong-state'),env);assert.match(r.headers.get('Location'),/auth=failed/);r=await githubCallback(new Request(env.APP_ORIGIN+'/api/auth/github/callback?code=one&state=two'),env);assert.match(r.headers.get('Location'),/auth=failed/)}finally{globalThis.fetch=old}
})
test('non-owner and inherited elevated scopes never receive a session',async()=>{
 for(const scope of ['', 'repo']){const start=await begin();const old=globalThis.fetch;globalThis.fetch=async url=>url.includes('access_token')?Response.json({access_token:'fake',token_type:'bearer',scope}):Response.json({id:999,login:'lin945'})
 try{const r=await githubCallback(req(start),env);assert.match(r.headers.get('Location'),/auth=(denied|failed)/);assert.equal(sessionCookie(r),'__Host-animer_admin=')}finally{globalThis.fetch=old}}
})
test('logout expires cookie; callback does not accept alternative hostname',async()=>{
 assert.match(githubLogout().headers.get('Set-Cookie'),/Max-Age=0/)
 assert.equal((await githubCallback(new Request('https://animer.pages.dev/api/auth/github/callback'),env)).status,404)
})
