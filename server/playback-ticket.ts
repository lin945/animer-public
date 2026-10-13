import { SignJWT, jwtVerify } from 'jose'

type PlaybackEnv = { SESSION_SECRET?: string; APP_ORIGIN?: string }
export const PLAYBACK_TTL_SECONDS = 4 * 60 * 60
export type PlaybackGrant = { sourceId: string; url: string; referer: string; expires: number }
async function key(env: PlaybackEnv) {
  if (!env.SESSION_SECRET || new TextEncoder().encode(env.SESSION_SECRET).length < 32 || !env.APP_ORIGIN?.startsWith('https://')) throw new Error('Playback signing not configured')
  const material = await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SESSION_SECRET),'HKDF',false,['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode(env.APP_ORIGIN),info:new TextEncoder().encode('animer/playback-capability/v1')},material,256))
}
export async function createPlaybackSigner(env: PlaybackEnv) {
  const signingKey = await key(env)
  return async (grant: Omit<PlaybackGrant,'expires'> & { expires?: number }) => {
    const expires = grant.expires ?? Math.floor(Date.now()/1000)+PLAYBACK_TTL_SECONDS
    if (expires <= Math.floor(Date.now()/1000) || expires > Math.floor(Date.now()/1000)+PLAYBACK_TTL_SECONDS+5) throw new Error('Invalid playback expiry')
    const ticket = await new SignJWT({sourceId:grant.sourceId,url:grant.url,referer:grant.referer}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer(env.APP_ORIGIN!).setAudience('animer-playback-v1').setIssuedAt().setExpirationTime(expires).sign(signingKey)
    return '/api/play?'+new URLSearchParams({url:grant.url,sourceId:grant.sourceId,referer:grant.referer,ticket})
  }
}
export async function mintPlaybackUrl(env: PlaybackEnv, grant: Omit<PlaybackGrant,'expires'> & { expires?: number }) {
  return (await createPlaybackSigner(env))(grant)
}
export async function verifyPlayback(request: Request, env: PlaybackEnv): Promise<PlaybackGrant | null> {
  try {
    const u=new URL(request.url)
    if (u.origin !== env.APP_ORIGIN) return null
    const ticket=u.searchParams.get('ticket')
    if (!ticket || ticket.length>16384) return null
    const {payload}=await jwtVerify(ticket,await key(env),{issuer:env.APP_ORIGIN,audience:'animer-playback-v1',algorithms:['HS256'],requiredClaims:['exp','iat']})
    if(typeof payload.sourceId!=='string'||typeof payload.url!=='string'||typeof payload.referer!=='string'||typeof payload.exp!=='number'||
      payload.sourceId!==u.searchParams.get('sourceId')||payload.url!==u.searchParams.get('url')||payload.referer!==u.searchParams.get('referer')) return null
    return {sourceId:payload.sourceId,url:payload.url,referer:payload.referer,expires:payload.exp}
  } catch { return null }
}
