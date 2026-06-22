# PG-Daily-Report

A tiny [bigrandall](https://bigrandall.io) worker that runs one
SQL query against an external PostgreSQL database every day at UTC
midnight, packs the result into a UTF-8 CSV attachment, and sends
it via the worker's `SEND_EMAIL` binding.

Built for a single, hard-coded report — newly registered users in
the past 24 h, joined with their auth credentials — but the
machinery is small enough to fork-and-tweak for any other
"daily-cron-emails-a-CSV" pipeline.

## What it does

Every UTC midnight (bigrandall's cron agent posts to
`/__edge_cron` with the configured `0 0 * * *` expression):

1. Open one PostgreSQL connection (via [`postgres`](https://github.com/porsager/postgres) over `cloudflare:sockets`).
2. Run:

   ```sql
   SELECT users.*, auth_credentials.*
   FROM "public"."users"
   LEFT JOIN auth_credentials ON auth_credentials.user_id = users."id"
   WHERE users."created_at" > now() - interval '24 hours'
   ```

3. Serialize the rows as RFC 4180 CSV (UTF-8 + BOM so Excel
   double-click doesn't garble Chinese).
4. Send to `EMAIL_TO` via the `SEND_EMAIL` binding with the CSV
   attached as `daily-users-YYYY-MM-DD.csv` and a small plain-text
   summary in the body.
5. Drop the DB socket and return.

On any failure (DB unreachable, query error, etc) it tries to send
a failure-notice email so the operator notices the silence.

## Endpoints

| Path | Auth | What it does |
| --- | --- | --- |
| `POST /__edge_cron` | none (bigrandall agent only) | Cron entry; runs the report once. |
| `GET\|POST /admin/run` | Bearer header **or** `?token=` | Same flow as cron, manually triggered. The `?token=` form lets you paste the URL into a browser address bar — no curl / DevTools needed. |
| `GET\|POST /admin/preview` | Bearer header **or** `?token=` | Runs the DB query and returns the CSV in the response body — does NOT send email. Use this to validate the query + the connection before going live. |
| anything else | none | Status page. |

## Local build

```bash
npm install
npm run build       # → dist/_worker.js (~80 KB)
```

bigrandall pages-mode picks up `dist/_worker.js` automatically.

## Deploy

See [RANDALLFLARE.md](./RANDALLFLARE.md) for the bigrandall
deployment walkthrough — env binding names, send_email binding
setup, Azure firewall rules, cron schedule.

## Env reference

| Name | Required | Notes |
| --- | --- | --- |
| `PG_HOST` | yes | Azure PG endpoint, e.g. `unrush-production.postgres.database.azure.com` |
| `PG_PORT` | no | Default `5432`. |
| `PG_DATABASE` | yes | Database name. |
| `PG_USER` | yes | Login role. For Azure Flexible Server use the bare role, not `user@server`. |
| `PG_PASSWORD` | yes | Password. |
| `EMAIL_FROM` | yes | Sender address. Must match a destination/sender configured for the `SEND_EMAIL` binding. |
| `EMAIL_TO` | yes | Recipient address. |
| `ADMIN_TOKEN` | recommended | Bearer token gating `/admin/*`. Without it the manual endpoints stay locked. |

Bindings (configured in the bigrandall worker control panel,
not in env):

- `SEND_EMAIL` — bigrandall `send_email` binding pointing at the
  destination you want to receive the report.
