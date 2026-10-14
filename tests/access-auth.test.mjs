import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
const bundle=await build({entryPoints:['server/admin-auth.ts'],bundle:true,format:'esm',platform:'browser',write:false})
const {accessLogin,verifyAdmin,accessLogout,authConfigured}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const token=Buffer.alloc(32,7).toString('base64url')
const base={APP_ORIGIN:'https://site.test',ADMIN_ACCESS_TOKEN_HASH:createHash('sha256').update(token).digest('hex'),SESSION_SECRET:'synthetic-test-only-session-key-32-bytes-long'}
const request=(body={token},headers={})=>new Request(base.APP_ORIGIN+'/api/auth/access',{method:'POST',headers:{Origin:base.APP_ORIGIN,'X-Admin-Request':'1','Content-Type':'application/json',...headers},body:JSON.stringify(body)})
const admin=cookie=>new Request(base.APP_ORIGIN+'/api/admin/session',{headers:{Cookie:cookie}})
const cookie=response=>response.headers.get('Set-Cookie').split(';')[0]
test('access requires exact digest and secure configuration; no database required',async()=>{
 assert.equal(authConfigured({}),false);assert.equal(authConfigured(base),true)
 assert.equal((await accessLogin(request(),{})).status,503)
 assert.equal(authConfigured({...base,ADMIN_ACCESS_TOKEN_HASH:'a'.repeat(63)}),false)
 const response=await accessLogin(request(),base);assert.equal(response.status,200)
 assert.match(response.headers.get('Set-Cookie'),/Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600/)
 assert.deepEqual(await verifyAdmin(admin(cookie(response)),base),{login:'owner',id:'owner',provider:'link'})
 assert.equal((await accessLogin(request({token:Buffer.alloc(32,8).toString('base64url')}),base)).status,401)
})
test('malformed and noncanonical tokens fail uniformly without storing credentials',async()=>{
 for(const value of ['', 'a'.repeat(42),'a'.repeat(44),token+'=',token.slice(0,-1)+'d',null,{},7]){
  const response=await accessLogin(request({token:value}),base);assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'Invalid access link'})
 }
})
test('CSRF, wrong media type and bounded bodies fail closed',async()=>{
 assert.equal((await accessLogin(request(undefined,{Origin:'https://evil.test'}),base)).status,403)
 assert.equal((await accessLogin(request(undefined,{'X-Admin-Request':''}),base)).status,403)
 assert.equal((await accessLogin(request(undefined,{'Content-Type':'text/plain'}),base)).status,415)
 assert.equal((await accessLogin(request({token:'x'.repeat(600)}),base)).status,400)
})
test('hash and signing-secret rotation revoke sessions; alternate host and forged cookies fail',async()=>{
 const session=cookie(await accessLogin(request(),base))
 assert.equal(await verifyAdmin(admin(session),{...base,ADMIN_ACCESS_TOKEN_HASH:'a'.repeat(64)}),null)
 assert.equal(await verifyAdmin(admin(session),{...base,SESSION_SECRET:'different-synthetic-key-32-characters-long'}),null)
 assert.equal(await verifyAdmin(new Request('https://preview.pages.dev/api/admin/session',{headers:{Cookie:session}}),base),null)
 assert.equal(await verifyAdmin(admin('__Host-animer_admin=forged'),base),null)
 assert.equal(await verifyAdmin(admin(session+'; '+session),base),null)
 assert.match(accessLogout().headers.get('Set-Cookie'),/Max-Age=0/)
})
