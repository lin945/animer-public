import { SignJWT, jwtVerify } from 'jose'

export type AdminEnvironment = {
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  SESSION_SECRET?: string
  APP_ORIGIN?: string
  ADMIN_GITHUB_ID?: string
}
const SESSION_COOKIE = '__Host-animer_admin'
const FLOW_COOKIE = '__Host-animer_oauth'
const encoder = new TextEncoder()
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`

function configuration(env: AdminEnvironment) {
  try {
    const origin = new URL(env.APP_ORIGIN || '')
    if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !/^\d+$/.test(env.ADMIN_GITHUB_ID || '') || encoder.encode(env.SESSION_SECRET || '').length < 32) return null
    return { origin: origin.origin, id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET, owner: env.ADMIN_GITHUB_ID!, key: encoder.encode(env.SESSION_SECRET!) }
  } catch { return null }
}
export const authConfigured = (env: AdminEnvironment) => Boolean(configuration(env))
function getCookie(request: Request, name: string) {
  const matches = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='))
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null
}
function random() { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
function equal(a: string, b: string) { if (a.length !== b.length) return false; let diff = 0; for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0 }
function response(location: string, cookies: string[]) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  for (const item of cookies) headers.append('Set-Cookie', item)
  return new Response(null, { status: 302, headers })
}
async function signed(payload: Record<string, unknown>, config: NonNullable<ReturnType<typeof configuration>>, audience: string, seconds: number) {
  return new SignJWT(payload).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer(config.origin).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+seconds).sign(config.key)
}
export async function verifyAdmin(request: Request, env: AdminEnvironment) {
  const config = configuration(env)
  if (!config || new URL(request.url).origin !== config.origin) return null
  const value = getCookie(request, SESSION_COOKIE)
  if (!value || value.length > 8192) return null
  try {
    const {payload} = await jwtVerify(value, config.key, {issuer:config.origin,audience:'animer-admin',algorithms:['HS256'],requiredClaims:['exp','iat','sub']})
    if (payload.sub !== config.owner || payload.provider !== 'github' || typeof payload.login !== 'string') return null
    return { login: payload.login, id: payload.sub, provider: 'github' as const }
  } catch { return null }
}

/** Login-only OAuth: never requests repository, organization, email or refresh scopes. */
export async function githubLogin(request: Request, env: AdminEnvironment) {
  const config = configuration(env)
  if (!config) return Response.json({error:'GitHub sign-in is not configured'}, {status:503,headers:{'Cache-Control':'no-store'}})
  if (new URL(request.url).origin !== config.origin) return new Response('Not found',{status:404})
  const state = random(), verifier = random()
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier))))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
  const flow = await signed({state,verifier},config,'animer-oauth',600)
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({client_id:config.id,redirect_uri:config.origin+'/api/auth/github/callback',scope:'',state,code_challenge:challenge,code_challenge_method:'S256',allow_signup:'false'}).toString()
  return response(url.href,[cookie(FLOW_COOKIE,flow,600)])
}

export async function githubCallback(request: Request, env: AdminEnvironment) {
  const config = configuration(env)
  if (!config || new URL(request.url).origin !== config.origin) return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}})
  const clear = [cookie(FLOW_COOKIE,'',0),cookie(SESSION_COOKIE,'',0)]
  const fail = (reason='failed') => response(config.origin+'/admin?auth='+reason,clear)
  const url = new URL(request.url)
  const state = url.searchParams.get('state'), code = url.searchParams.get('code'), flow = getCookie(request,FLOW_COOKIE)
  if (url.searchParams.has('error') || !flow || flow.length > 8192 || !state || state.length > 128 || !code || code.length > 512) return fail()
  try {
    const {payload} = await jwtVerify(flow,config.key,{issuer:config.origin,audience:'animer-oauth',algorithms:['HS256'],requiredClaims:['exp','iat']})
    if (typeof payload.state !== 'string' || typeof payload.verifier !== 'string' || !equal(state,payload.state)) return fail()
    const result = await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.id,client_secret:config.secret,code,redirect_uri:config.origin+'/api/auth/github/callback',code_verifier:payload.verifier}),signal:AbortSignal.timeout(10000),redirect:'error'})
    if (!result.ok) return fail()
    const token = await result.json<{access_token?:string;token_type?:string;scope?:string}>()
    if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer') return fail()
    // A dedicated login-only OAuth app must not inherit elevated authorizations.
    if (token.scope && token.scope.trim()) return fail()
    const userResult = await fetch('https://api.github.com/user',{headers:{Authorization:'Bearer '+token.access_token,Accept:'application/vnd.github+json','User-Agent':'animer-admin-login','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(10000),redirect:'error'})
    if (!userResult.ok) return fail()
    const user = await userResult.json<{id?:number;login?:string}>()
    if (!Number.isSafeInteger(user.id) || String(user.id) !== config.owner || typeof user.login !== 'string') return fail('denied')
    // Discard GitHub's token: only a short-lived first-party session cookie remains.
    const session = await signed({sub:String(user.id),login:user.login,provider:'github'},config,'animer-admin',3600)
    return response(config.origin+'/admin',[cookie(FLOW_COOKIE,'',0),cookie(SESSION_COOKIE,session,3600)])
  } catch { return fail() }
}
export function githubLogout() { return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':cookie(SESSION_COOKIE,'',0)}}) }
export function managementRequest(path: string, method: string) {
  return path === '/api/admin' || path.startsWith('/api/admin/') || path === '/api/auth/logout' ||
    /^\/api\/(subscriptions(?:\/.*)?|subscription-status|source-health(?:\/.*)?)\/?$/.test(path) ||
    (path.startsWith('/api/media-sources/') && method !== 'GET')
}
