# apns-es256

Apple Push Notifications **from scratch** — no SDK, no dependencies. One file.

ES256 JWT signing via WebCrypto (`crypto.subtle`) + a direct HTTP/2 POST to
APNs. Runs anywhere `fetch` and WebCrypto exist: **Deno, Supabase/Cloudflare
edge functions, Node 18+, Bun.**

Extracted from [Yelo](https://yelofamily.com) — an AI voice companion for
elderly, limited-English-speaking parents — where it delivers every push in
production from a Supabase edge function.

## Why

Most APNs guides say "use a library." But the actual protocol is small:

1. Sign a JWT with your `.p8` key — ES256 (P-256 ECDSA), `kid` in the header,
   `iss` = your team ID, `iat` = now.
2. POST the payload to `api.push.apple.com/3/device/<token>` with
   `authorization: bearer <jwt>` and `apns-topic: <bundle id>`.

That's it. ~150 lines covers signing, token caching, error classification,
and environment fallback — small enough to read, audit, and own.

## Usage

```ts
import { sendApns } from './mod.ts'

const result = await sendApns(
  {
    keyPem: Deno.env.get('APNS_KEY_PEM')!,   // contents of AuthKey_XXXX.p8
    keyId: 'ABC123DEFG',
    teamId: 'TEAM123456',
    bundleId: 'com.example.app',
  },
  deviceToken,
  { aps: { alert: { title: 'Hello', body: 'From scratch.' }, sound: 'default' } },
)

if (result.isUnregistered) {
  // app was deleted — drop this token from your DB
}
```

## Details that bite people

- **JWT caching**: Apple rejects tokens older than 60 min and rate-limits
  refreshes under 20 min. This caches for 50.
- **Prod → sandbox fallback**: App Store and TestFlight installs produce
  production tokens; Xcode debug builds produce sandbox tokens. `sendApns`
  tries production, and on `BadDeviceToken` retries sandbox — one code path
  for every install type.
- **`410 Unregistered`** is surfaced as `isUnregistered` so callers can prune
  dead tokens instead of retrying forever.

## License

MIT
