# Ring integration recon

Facts verified against live Ring traffic on 2026-10-06, from the `quiet-porch.service` journal,
`~/.local/state/quiet-porch/`, and a read-only `GET /v1/devices`. Anything not marked verified is
open. Replaces the lost `recon-facts.md`.

## Linking is started from the Ring AppStore, not the console

Clicking **Connect Ring account** in the developer console only authorizes a Ring account to see
the private app (console then shows "Connect (1 out of 10)"). It sends nothing to our endpoints:
the journal stayed empty from 10-05 21:23 until the AppStore step below.

The flow that actually ran (CDT, 2026-10-06):

```
Ring mobile app: Ring AppStore -> Quiet Porch -> approve scopes
        |
        v
16:28:42  Ring backend POST /ring/token-exchange   fields=[code,client_id]
16:28:43  we exchange the code, store UNCLAIMED tokens (scope=ava.v1:read)
        |
        v  (user picks devices in the Ring app)
16:29:22  browser GET /ring/link                    params=[nonce,time]
16:30:53  wrong password (1/5)
16:31:36  webhook app_integration_added
16:31:37  webhook device_added x2
16:31:37  link: COMPLETED, devices=2
```

Order matches Ring's api-documentation.html: token exchange is backend-to-backend and arrives
before the user is redirected to the Account Link URL.

## Token exchange

- **Verified:** Ring POSTs exactly two fields, `code` and `client_id`. `extractCode` in
  `src/server.ts` also accepts `authorization_code` and `auth_code`; those fallbacks were never
  needed.
- **Verified:** the code exchange at `https://oauth.ring.com/oauth/token` succeeds with
  `grant_type=authorization_code`.
- **Verified:** granted scope is `ava.v1:read` (read-only).
- **Verified:** access token lifetime is 14400 s (4 h), from `expires_at - issued_at` in
  `tokens.json`.
- **Open:** whether the refresh loop renews real tokens. First renewal is due before
  2026-10-06 20:28 CDT; check for `refresh: renewed` in the journal.
- **Open:** request content type (JSON vs form). `parseFields` handles both and does not log which.

## Account link nonce

- **Verified:** Ring appends `nonce` and `time` (no other params) to the Account Link URL.
- **Verified:** the nonce check in `src/crypto.ts`
  (`base64url(HMAC-SHA256(RING_HMAC_KEY, "<time>:<account_id>"))`) matched the real account,
  since the link reached `COMPLETED`.

## Webhooks

- **Verified:** real Ring webhooks pass `verifyWebhookSignature`
  (`hex(HMAC-SHA256(RING_HMAC_KEY, raw body))`). The code accepts the header with or without a
  `sha256=` prefix; which form Ring sends is not logged.
- **Verified event types seen:** `app_integration_added` (`source_type: users`) and
  `device_added` (`source_type: devices`, one per shared device, with a
  `relationships.devices.links.self` path of `/v1/devices/<id>`).

## Linked account and devices

Account: `ava1.ring.account.REDACTED`

`GET https://api.amazonvision.com/v1/devices` returned:

| Name       | Device ID                                                                                                           | Role (unconfirmed) |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Front Door | `ava1.ring.device.FRONT_DOOR` | doorbell           |
| Ring Cam 1 | `ava1.ring.device.RING_CAM_1` | outdoor cam        |

`listDevices` in `src/ring.ts` keeps only `id` and `attributes.name`, so other device attributes
(model, kind) were not inspected. The role column is inferred from the names and needs Matthew to
confirm.

## Service state

- `quiet-porch.service` (systemd --user) enabled at boot on 2026-10-06; linger is on.
- Funnel `/ring` proxies to `http://127.0.0.1:3460` and is stored in tailscaled's serve config.
