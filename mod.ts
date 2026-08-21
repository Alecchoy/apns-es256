// apns-es256 — Apple Push Notification service client from scratch.
// ES256 JWT signing via WebCrypto + HTTP/2 POST to APNs. No SDK, no deps.
// Runs anywhere WebCrypto + fetch exist: Deno, edge functions, Node 18+, Bun.

const APNS_PROD = 'https://api.push.apple.com/3/device'
const APNS_SANDBOX = 'https://api.sandbox.push.apple.com/3/device'

let cachedJwt: { token: string; expiresAt: number } | null = null

export interface ApnsConfig {
  /** Contents of the .p8 key file from developer.apple.com (PEM). */
  keyPem: string
  /** Key ID shown next to the key in the developer portal. */
  keyId: string
  /** Your Apple Developer Team ID. */
  teamId: string
  /** The app's bundle identifier (becomes the apns-topic header). */
  bundleId: string
}

export interface ApnsPayload {
  aps: {
    alert: { title: string; body: string }
    sound?: string
    badge?: number
  }
  [k: string]: unknown
}

export interface ApnsResult {
  status: number
  reason?: string
  ok: boolean
  /** Token is gone (app deleted) — remove it from your database. */
  isUnregistered: boolean
  /** Token belongs to the other environment (prod vs sandbox). */
  isBadToken: boolean
}

function pemToCryptoKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey(
    'pkcs8',
    raw.buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function signJwt(keyPem: string, keyId: string, teamId: string): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', kid: keyId })))
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    iss: teamId,
    iat: Math.floor(Date.now() / 1000),
  })))
  const signingInput = `${header}.${payload}`
  const key = await pemToCryptoKey(keyPem)
  const sigRaw = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64url(new Uint8Array(sigRaw))}`
}

// Apple rejects tokens older than 60 minutes and rate-limits refreshes
// under 20 minutes — 50 minutes sits safely between the two.
async function getJwt(config: ApnsConfig): Promise<string> {
  const now = Date.now()
  if (cachedJwt && cachedJwt.expiresAt > now) return cachedJwt.token
  const token = await signJwt(config.keyPem, config.keyId, config.teamId)
  cachedJwt = { token, expiresAt: now + 50 * 60 * 1000 }
  return token
}

async function sendOne(
  config: ApnsConfig,
  jwt: string,
  base: string,
  deviceToken: string,
  payload: ApnsPayload,
): Promise<ApnsResult> {
  const r = await fetch(`${base}/${deviceToken}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  let reason: string | undefined
  if (!r.ok) {
    try {
      const j = await r.json() as { reason?: string }
      reason = j.reason
    } catch { /* non-JSON error body */ }
  }
  return {
    status: r.status,
    reason,
    ok: r.ok,
    isUnregistered: r.status === 410 || reason === 'Unregistered',
    isBadToken: r.status === 400 && reason === 'BadDeviceToken',
  }
}

/**
 * Send one alert push. Tries production first (App Store + TestFlight
 * tokens), falls back to sandbox on BadDeviceToken (Xcode debug builds) —
 * so one code path serves every kind of install.
 */
export async function sendApns(
  config: ApnsConfig,
  deviceToken: string,
  payload: ApnsPayload,
): Promise<ApnsResult> {
  const jwt = await getJwt(config)
  const prod = await sendOne(config, jwt, APNS_PROD, deviceToken, payload)
  if (prod.ok || !prod.isBadToken) return prod
  return sendOne(config, jwt, APNS_SANDBOX, deviceToken, payload)
}
