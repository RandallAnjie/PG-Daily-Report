# PG-Daily-Report on RandallFlare Workers

This worker runs one daily cron job that queries an Azure
PostgreSQL database, builds a CSV, and emails it. Below is the
end-to-end deploy walkthrough on bigrandall.

## Build config

Console → *Workers* → new worker → connect GitHub repo
`RandallAnjie/PG-Daily-Report`, branch `main`.

- **Build command**: `npm install && npm run build`
- **Output directory**: `dist`  (bigrandall picks up `dist/_worker.js` automatically in pages-mode)
- **Compatibility flags**: `nodejs_compat`

> If pnpm 24h-age supply-chain blocking trips on the
> `postgres@3.4.5` install, swap to a version older than 24 h in
> `package.json` and re-deploy. Same trick we used for the
> Meting-API deploys — pin, don't `^`.

## Env bindings (runtime — *not* gitBuildEnv)

| Name | Required | Value / Notes |
| --- | --- | --- |
| `PG_HOST` | yes | `unrush-production.postgres.database.azure.com` |
| `PG_PORT` | no | `5432` (default) |
| `PG_DATABASE` | yes | the target database name |
| `PG_USER` | yes | the login role |
| `PG_PASSWORD` | yes | the password |
| `EMAIL_FROM` | yes | sender address allowed by the `SEND_EMAIL` binding |
| `EMAIL_TO` | yes | recipient |
| `ADMIN_TOKEN` | recommended | a long random string — gates `/admin/run` + `/admin/preview` |

## `SEND_EMAIL` binding

Worker control panel → *Bindings* → add a new binding of type
*Email* / *send_email*, name **`SEND_EMAIL`**, point at the
destination you want the daily mail to land in. The worker calls
`env.SEND_EMAIL.send(new EmailMessage(from, to, raw))` — the
binding handles relay, SPF / DKIM, etc.

If your bigrandall deploy doesn't ship `send_email` (older
versions don't), swap in a Resend / Mailgun fetch-based send.
Roughly: replace `sendMimeMail()`'s `env.SEND_EMAIL.send(...)`
with `fetch('https://api.resend.com/emails', { ... })` and add a
`RESEND_API_KEY` env var.

## Cron schedule

Worker control panel → *Triggers* → add cron `0 0 * * *`.

The bigrandall agent posts to `/__edge_cron` with the cron
expression in the `X-Edge-Cron-Expression` header at the moment
the schedule fires. The worker accepts any expression — we only
have one job in here.

## Azure PG firewall

Azure Database for PostgreSQL ships with all external connections
blocked. Open one of:

- **Allow Azure services + a fixed IP range**:
  Portal → Connection Security → add bigrandall's egress IP/CIDR
  to the allowlist. Find the egress IPs by curling
  `https://ifconfig.me` from `/admin/preview` once with the
  firewall off, then locking it down to just those IPs.
- **Allow all (`0.0.0.0/0`)**:
  Quicker but relies entirely on `PG_PASSWORD` for security. Fine
  for a read-only role on a non-sensitive DB; not great for
  anything with PII.
- **Private endpoint + bigrandall outbound through a Tailscale
  sidecar**:
  See the equivalent setup in the Emby-API / EM playbooks.

SSL is required by default on Azure PG; the worker passes
`ssl: 'require'` so this matches up automatically.

## Verifying after deploy

The `/admin/*` endpoints accept either a Bearer header or a
`?token=…` query string — pick whichever's convenient.

```bash
# Status page (no auth needed):
curl https://<your-worker>.edge.bigrandall.io/

# Preview the CSV without sending mail (admin token gated):
curl https://<your-worker>.edge.bigrandall.io/admin/preview \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Trigger the full pipeline manually:
curl https://<your-worker>.edge.bigrandall.io/admin/run \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'
```

Or from a browser address bar (just paste — both work as GET):

```
https://<your-worker>.edge.bigrandall.io/admin/preview?token=<ADMIN_TOKEN>
https://<your-worker>.edge.bigrandall.io/admin/run?token=<ADMIN_TOKEN>
```

If `/admin/preview` returns CSV, the DB + query are good. If
`/admin/run` lands an email, the full path is wired. After that,
the daily cron just lets the agent fire at UTC midnight.
