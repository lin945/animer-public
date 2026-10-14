import { SignJWT, jwtVerify } from 'jose'

export type AdminEnvironment = { ADMIN_ACCESS_TOKEN_HASH?: string; SESSION_SECRET?: string; APP_ORIGIN?: string }
const SESSION_COOKIE='__Host-animer_admin'
const encoder=new TextEncoder()
const cookie=(value:string,seconds:number)=>`${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`
function configuration(env:AdminEnvironment) {
  try {
    const origin=new URL(env.APP_ORIGIN||'')
    const hash=env.ADMIN_ACCESS_TOKEN_HASH || ''
    if(origin.protocol!=='https:'||origin.origin!==env.APP_ORIGIN||! /^[0-9a-f]{64}$/.test(hash)||encoder.encode(env.SESSION_SECRET||'').length<32) return null
    return {origin:origin.origin,hash,secret:env.SESSION_SECRET!,key:encoder.encode(env.SESSION_SECRET!)}
  } catch {return null}
}
export const authConfigured=(env:AdminEnvironment)=>Boolean(configuration(env))
function constantEqual(a:Uint8Array,b:Uint8Array) {
  if(a.length!==b.length)return false
  let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]!^b[i]!
  return difference===0
}
async function credentialVersion(config:NonNullable<ReturnType<typeof configuration>>) {
  const hash=await crypto.subtle.digest('SHA-256',encoder.encode('access-link/v1\0'+config.hash))
  return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')
}
function validToken(token:unknown):token is string {
  if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token))return false
  try {const decoded=atob(token.replace(/-/g,'+').replace(/_/g,'/')+'=');return decoded.length===32&&btoa(decoded).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')===token}catch{return false}
}
function getCookie(request:Request) {
  const matches=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(SESSION_COOKIE+'='))
  return matches.length===1?matches[0]!.slice(SESSION_COOKIE.length+1):null
}
export async function verifyAdmin(request:Request,env:AdminEnvironment) {
  const config=configuration(env)
  if(!config||new URL(request.url).origin!==config.origin) return null
  const value=getCookie(request)
  if(!value||value.length>8192) return null
  try {
    const {payload}=await jwtVerify(value,config.key,{issuer:config.origin,audience:'animer-admin-link-v1',algorithms:['HS256'],requiredClaims:['exp','iat','sub','credentialVersion']})
    if(payload.sub!=='owner'||payload.provider!=='link'||payload.login!=='owner'||payload.credentialVersion!==await credentialVersion(config)) return null
    return {login:'owner',id:'owner',provider:'link' as const}
  } catch {return null}
}
function result(body:unknown,status:number,extra:Record<string,string>={}) {return Response.json(body,{status,headers:{'Cache-Control':'no-store',...extra}})}
async function boundedBody(request:Request) {
  if(Number(request.headers.get('Content-Length')||0)>512||!request.body) throw new Error('invalid body')
  const reader=request.body.getReader();const chunks:Uint8Array[]=[];let size=0
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>512)throw new Error('invalid body');chunks.push(value)}}finally{void reader.cancel().catch(()=>{})}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return JSON.parse(new TextDecoder().decode(bytes))
}
export async function accessLogin(request:Request,env:AdminEnvironment) {
  const config=configuration(env)
  if(!config) return result({error:'Administrator login is not configured'},503)
  if(new URL(request.url).origin!==config.origin||request.headers.get('Origin')!==config.origin||request.headers.get('X-Admin-Request')!=='1') return result({error:'Same-origin admin request required'},403)
  if(request.method!=='POST'||request.headers.get('Content-Type')?.split(';')[0]?.trim()!=='application/json') return result({error:'JSON POST required'},415)
  let body:unknown
  try{body=await boundedBody(request)}catch{return result({error:'Invalid login request'},400)}
  const input=body as {token?:unknown}|null
  if(!input||!validToken(input.token)) return result({error:'Invalid access link'},401)
  try{
    const supplied=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(input.token)))
    const expected=Uint8Array.from(config.hash.match(/../g)!,pair=>parseInt(pair,16))
    if(!constantEqual(supplied,expected))return result({error:'Invalid access link'},401)
    const identity={login:'owner',id:'owner',provider:'link' as const}
    const session=await new SignJWT({...identity,credentialVersion:await credentialVersion(config)}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer(config.origin).setAudience('animer-admin-link-v1').setSubject('owner').setIssuedAt().setExpirationTime('1h').sign(config.key)
    return result({authenticated:true,...identity},200,{'Set-Cookie':cookie(session,3600)})
  }catch{return result({error:'Login temporarily unavailable'},503)}
}
export function accessLogout(){return result({ok:true},200,{'Set-Cookie':cookie('',0)})}
export function managementRequest(path:string,method:string){return path==='/api/admin'||path.startsWith('/api/admin/')||path==='/api/auth/logout'||/^\/api\/(subscriptions(?:\/.*)?|subscription-status|source-health(?:\/.*)?)\/?$/.test(path)||(path.startsWith('/api/media-sources/')&&method!=='GET')}
