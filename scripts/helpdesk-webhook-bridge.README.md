# Helpdesk webhook bridge

The bridge receives `ticket.created` and `ticket.updated` events at
`POST /webhooks/helpdesk`. It then relays their minimal metadata to the active
Chrome extension through Server-Sent Events at `GET /events`. It listens only
on `127.0.0.1:39543`; publish that local address through an HTTPS reverse
tunnel, not by opening a local firewall.

Set the one-time secret from Helpdesk in the gitignored `.env_my` file:

```env
HELPDESK_WEBHOOK_SECRET=...
```

Start the receiver:

```bash
node scripts/helpdesk-webhook-bridge.mjs
```

Use `https://<public-tunnel-domain>/webhooks/helpdesk` as the Helpdesk URL.
The bridge verifies Avada's exact `X-Avada-Signature` / `X-Avada-Timestamp`
contract: `sha256=HMAC-SHA256(secret, "${timestamp}.${raw JSON body}")`.
It rejects missing, stale (over five minutes), malformed, or mismatched
signatures.

Check the local receiver without sending any Helpdesk event:

```bash
node scripts/helpdesk-webhook-bridge.mjs --self-test
```

Then check its status without exposing event payloads:

```bash
curl http://127.0.0.1:39543/health
```

The bridge stores only event metadata and hashes in
`runtime/helpdesk-webhook-bridge-state.json`; it never stores the webhook
secret or raw ticket payload. The SSE endpoint only permits the current
unpacked extension origin. The widget uses the event stream for realtime
refresh plus a 30-minute reconciliation fetch in case Chrome was disconnected.

## Tunnel recovery on this workstation

The local receiver and the public tunnel are separate processes. A healthy
`127.0.0.1:39543` does not prove that Helpdesk can deliver to the public URL.
After the September 15 reboot the receiver restarted, but the manually started
tunnel did not; the existing URL returned `503 - Tunnel Unavailable`.

The user service `andrew-helpdesk-webhook-tunnel.service` now starts at user
login and runs `scripts/helpdesk-webhook-tunnel.mjs`. It requests the existing
`https://ninety-friends-sing.loca.lt` hostname and refuses a different hostname.
It checks the public `/health` every 30 seconds and exits after three failures;
systemd restarts it after 10 seconds. The existing localtunnel installation is
copied to `~/.local/share/andrew-helpdesk-tunnel/node_modules` so npm cache
cleanup will not remove its runtime dependency.

```bash
systemctl --user status andrew-helpdesk-webhook-tunnel.service
journalctl --user -u andrew-helpdesk-webhook-tunnel.service -n 30
curl --max-time 15 -H 'bypass-tunnel-reminder: 1' https://ninety-friends-sing.loca.lt/health
```

To disable automatic tunnel startup:

```bash
systemctl --user disable --now andrew-helpdesk-webhook-tunnel.service
```

This tunnel service is independent of the extension's **Tự kết nối local**
setting. The receiver still starts through that extension setting. The laptop
must be awake and online, and localtunnel must grant the requested hostname.
This recovery does not reserve that hostname or replay failed deliveries.
During the restart check, LocalTunnel temporarily assigned other hostnames;
the supervisor recovered the configured URL after about one minute. Public
health then returned 200. Non-event POST probes confirmed that unsigned input
returned 401 and correctly signed `null` reached body validation (400), without
creating a ticket event. At 13:30:30 (UTC+7), the live bridge also logged an
authenticated `ticket.updated` delivery for `ytobP0Cqw84X4e446V54` as `accepted`,
confirming a real delivery after recovery. Historical failed deliveries were
not manually replayed.
