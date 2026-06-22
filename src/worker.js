// PG-Daily-Report — a tiny bigrandall worker that runs a daily
// SQL query against an Azure-hosted PostgreSQL database, packs
// the result into a CSV attachment, and sends it via bigrandall's
// `SEND_EMAIL` binding.
//
// Triggered two ways:
//
//   1. POST /__edge_cron  (bigrandall's cron convention — the
//      platform agent posts here at the wall-clock instant the
//      configured cron expression matches, e.g. "0 0 * * *" for
//      UTC midnight). The cron expression itself ships in the
//      `X-Edge-Cron-Expression` request header; we accept any
//      value, this worker only has one scheduled job.
//
//   2. POST /admin/run     (manual trigger gated by the
//      `ADMIN_TOKEN` env var, sent as `Authorization: Bearer
//      <token>`). Lets the operator dry-run the report without
//      waiting for midnight.
//
// Anything else returns a tiny status page so the deploy can be
// poked from a browser to confirm the worker is up.

import postgres from 'postgres'

// Outbound mail goes through the operator-configured bigrandall
// binding (named `SEND_EMAIL` by convention in this repo, but
// anything works — adjust env.SEND_EMAIL in sendMimeMail() if you
// renamed it). Gated on a green DKIM + SPF record for the sender
// domain. NOT the `cloudflare:email` internal module, which
// bigrandall's workerd doesn't ship — see sendMimeMail() for the
// plain-object invocation shape.

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/__edge_cron') {
      // bigrandall's cron agent. Accept any expression — we only
      // have one job here, and if the operator configures the
      // schedule wrong we'd rather still get the report than 400.
      return runReport(env, ctx, { trigger: 'cron', expression: request.headers.get('x-edge-cron-expression') || '' })
    }

    if (url.pathname === '/admin/run') {
      if (!isAdmin(request, env)) {
        return new Response('unauthorized\n', { status: 401 })
      }
      return runReport(env, ctx, { trigger: 'manual', expression: '' })
    }

    if (url.pathname === '/admin/preview') {
      // Same DB + CSV path, but emits the CSV in the response body
      // instead of sending the email. Useful for debugging the
      // query / encoding without burning a mail send. Same auth
      // gate as /admin/run.
      if (!isAdmin(request, env)) {
        return new Response('unauthorized\n', { status: 401 })
      }
      try {
        const { csv, rowCount, durationMs } = await buildReport(env)
        return new Response(csv || '(empty)\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'x-rows': String(rowCount),
            'x-query-ms': String(durationMs)
          }
        })
      } catch (e) {
        return new Response(`error: ${e?.message || e}\n`, { status: 500 })
      }
    }

    return new Response(
      'PG-Daily-Report worker. POST /__edge_cron to run; /admin/run + Bearer for manual.\n',
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    )
  }
}

/**
 * Two ways to authenticate an /admin/* hit, both equivalent:
 *
 *   1. Header — `Authorization: Bearer <ADMIN_TOKEN>`. Right
 *      shape for curl / cron / any programmatic caller.
 *   2. Query string — `?token=<ADMIN_TOKEN>`. Lets the operator
 *      paste a URL into a browser's address bar (GET) and trigger
 *      the report by hand, without futzing with cookies or
 *      DevTools to forge a header.
 *
 * Both compare against the same `ADMIN_TOKEN` env var. When the
 * env var is empty / unset, BOTH paths fail closed — even an
 * empty `?token=` won't unlock anything.
 */
function isAdmin (request, env) {
  const expected = env.ADMIN_TOKEN || ''
  if (!expected) return false
  const auth = request.headers.get('authorization') || ''
  if (auth === `Bearer ${expected}`) return true
  let url
  try { url = new URL(request.url) } catch { return false }
  const tokenParam = url.searchParams.get('token') || ''
  return tokenParam !== '' && tokenParam === expected
}

/** Run the full report pipeline and return a JSON status string.
 *  Wrapped in try/catch so a single failure doesn't take the worker
 *  down — bigrandall will retry on the next cron tick anyway, and
 *  the email body itself carries diagnostics on success / failure. */
async function runReport (env, ctx, meta) {
  const startedAt = Date.now()
  let report
  try {
    report = await buildReport(env)
  } catch (e) {
    const msg = `report build failed (${meta.trigger}): ${e?.message || e}`
    try { console.error(msg, e?.stack) } catch {}
    // Still attempt to send the operator a failure notice so they
    // notice the DB is sideways — common cause is Azure firewall
    // not whitelisting the bigrandall egress, which the operator
    // would otherwise only notice when the daily mail stops landing.
    try { await sendFailureMail(env, msg) } catch {}
    return jsonStatus({ ok: false, error: msg, durationMs: Date.now() - startedAt })
  }
  try {
    await sendReportMail(env, report)
  } catch (e) {
    const msg = `mail send failed: ${e?.message || e}`
    try { console.error(msg, e?.stack) } catch {}
    return jsonStatus({ ok: false, error: msg, ...report, durationMs: Date.now() - startedAt })
  }
  return jsonStatus({ ok: true, ...report, durationMs: Date.now() - startedAt, trigger: meta.trigger })
}

function jsonStatus (payload) {
  return new Response(JSON.stringify(payload), {
    status: payload.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

// ── DB + CSV ──────────────────────────────────────────────────────

/**
 * Open a one-shot Postgres connection, run the daily query, return
 * { csv, rowCount, columns, queryDurationMs }. The connection is
 * closed before returning so the worker doesn't leak sockets across
 * cron invocations.
 *
 * The query is the canonical one the operator asked for —
 *   SELECT * FROM users LEFT JOIN auth_credentials ON ...
 *   WHERE users.created_at > now() - interval '24 hours'
 * with `now() - interval '24 hours'` rather than a hardcoded date
 * so successive daily reports actually mean "last day", not "every
 * row since deploy day".
 */
async function buildReport (env) {
  const sql = openPg(env)
  const queryStartedAt = Date.now()
  let rows
  try {
    rows = await sql`
      SELECT
        users.*,
        auth_credentials.*
      FROM "public"."users"
      LEFT JOIN auth_credentials
        ON auth_credentials.user_id = users."id"
      WHERE users."created_at" > now() - interval '24 hours'
    `
  } finally {
    // sql.end({ timeout: ... }) on the porsager client closes the
    // socket and waits up to N seconds for in-flight queries — at
    // this point we only have one (just finished), so 2 s is
    // generous.
    try { await sql.end({ timeout: 2 }) } catch {}
  }
  const queryDurationMs = Date.now() - queryStartedAt

  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const csv = rowsToCsv(rows, columns)
  return {
    rowCount: rows.length,
    columns,
    csv,
    durationMs: queryDurationMs
  }
}

/** Open the workerd-native Postgres client. porsager/postgres 3.x
 *  auto-detects workerd and uses `cloudflare:sockets` under the
 *  hood, so no socket-factory wiring is needed — just the standard
 *  connection options. `prepare: false` disables server-side
 *  prepared statement caching which workerd can't store across
 *  isolates anyway, and `fetch_types: false` skips an introspection
 *  round-trip the client otherwise does on first connect. */
function openPg (env) {
  return postgres({
    host: env.PG_HOST,
    port: parseInt(env.PG_PORT || '5432', 10),
    database: env.PG_DATABASE,
    username: env.PG_USER,
    password: env.PG_PASSWORD,
    ssl: 'require',
    prepare: false,
    fetch_types: false,
    connection: {
      // Helps the operator find this worker in pg_stat_activity
      // when debugging slow connections / over-quota.
      application_name: 'pg-daily-report'
    }
  })
}

/**
 * Serialize an array of postgres rows into RFC 4180 CSV. Columns
 * are taken from the first row (postgres preserves SELECT order in
 * its returned object's key order, so the header row matches what
 * the SQL author would expect). Per-cell escaping:
 *   - null / undefined → empty string
 *   - Date             → ISO 8601 (matches Excel + Google Sheets)
 *   - objects / arrays → JSON.stringify
 *   - everything else  → String(v)
 *
 * Cells containing comma, double-quote, CR or LF get wrapped in
 * double quotes with internal quotes doubled — the spec form. Excel
 * BOM is prepended so the first column doesn't render as `﻿id` in
 * some locales when the file is opened by double-click.
 */
function rowsToCsv (rows, columns) {
  if (rows.length === 0) {
    return '﻿' + columns.join(',') + '\n'
  }
  const headerLine = columns.map(csvEscape).join(',')
  const lines = ['﻿' + headerLine]
  for (const row of rows) {
    const cells = columns.map((c) => csvEscape(row[c]))
    lines.push(cells.join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

function csvEscape (value) {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) value = value.toISOString()
  else if (typeof value === 'object') {
    // Buffer / Uint8Array (bytea columns) → base64 so the cell is
    // legible. Other objects → JSON.
    if (value instanceof Uint8Array) {
      let bin = ''
      for (let i = 0; i < value.length; i++) bin += String.fromCharCode(value[i])
      value = btoa(bin)
    } else {
      try { value = JSON.stringify(value) } catch { value = String(value) }
    }
  } else {
    value = String(value)
  }
  if (/[",\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

// ── Email ─────────────────────────────────────────────────────────

function reportDateString () {
  // UTC date the cron-fired for — anchors the email subject + the
  // CSV filename. We use UTC because that's what the cron schedule
  // is anchored to and what the SQL `now()` returns.
  return new Date().toISOString().slice(0, 10)
}

/** Send the success email with the CSV as an attachment. */
async function sendReportMail (env, report) {
  const date = reportDateString()
  const subject = `[PG-Daily-Report] ${date} — ${report.rowCount} new user${report.rowCount === 1 ? '' : 's'}`
  const filename = `daily-users-${date}.csv`
  const body =
    `New-user report for the past 24 h (UTC).\n` +
    `\n` +
    `Date    : ${date}\n` +
    `Rows    : ${report.rowCount}\n` +
    `Columns : ${report.columns.length}\n` +
    `Query   : ${report.durationMs} ms\n` +
    `\n` +
    `See attached CSV (UTF-8 with BOM, RFC 4180 quoting).\n`
  await sendMimeMail(env, {
    subject,
    text: body,
    attachment: {
      filename,
      contentType: 'text/csv; charset="utf-8"',
      bodyUtf8: report.csv
    }
  })
}

/** Send a brief failure notice when the report build blew up. */
async function sendFailureMail (env, errorMessage) {
  const date = reportDateString()
  await sendMimeMail(env, {
    subject: `[PG-Daily-Report] ${date} — FAILED`,
    text:
      `Daily report build failed.\n\n` +
      `Error: ${errorMessage}\n\n` +
      `Check Azure PG firewall rules (worker egress IP needed in allow-list), ` +
      `or the worker's tail logs.\n`
  })
}

/** Build an RFC-5322 / 5321 raw email (multipart/mixed when an
 *  attachment is present, plain text otherwise) and hand it to the
 *  bigrandall outbound mail binding (`SEND_EMAIL`). The binding's
 *  invocation shape mirrors Cloudflare's Email Workers — pass an
 *  object carrying `from`, `to`, and `raw` (the RFC-822 text). We
 *  skip the `cloudflare:email` `EmailMessage` class because that
 *  module doesn't exist on bigrandall's workerd; a plain literal
 *  with the same three properties satisfies the binding. */
async function sendMimeMail (env, { subject, text, attachment }) {
  const from = env.EMAIL_FROM
  const to = env.EMAIL_TO
  if (!from || !to) {
    throw new Error('EMAIL_FROM / EMAIL_TO env vars not set')
  }
  if (!env.SEND_EMAIL || typeof env.SEND_EMAIL.send !== 'function') {
    throw new Error('SEND_EMAIL binding not bound — see RANDALLFLARE.md')
  }

  const raw = attachment
    ? buildMultipart({ from, to, subject, text, attachment })
    : buildPlain({ from, to, subject, text })

  await env.SEND_EMAIL.send({ from, to, raw })
}

function buildPlain ({ from, to, subject, text }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text
  ].join('\r\n')
}

function buildMultipart ({ from, to, subject, text, attachment }) {
  const boundary = `----pgreport-${crypto.randomUUID().replace(/-/g, '')}`
  const attachmentB64 = base64Encode(attachment.bodyUtf8)
  // Fold base64 to 76-char lines per RFC 2045 §6.8 — some mail
  // servers reject a single multi-megabyte line outright.
  const folded = attachmentB64.match(/.{1,76}/g)?.join('\r\n') ?? ''
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    `Content-Type: ${attachment.contentType}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    folded,
    `--${boundary}--`,
    ''
  ].join('\r\n')
}

/** Encode UTF-8 string to base64. workerd has btoa() but it only
 *  accepts Latin-1 bytes — round-trip via TextEncoder first. */
function base64Encode (utf8Str) {
  const bytes = new TextEncoder().encode(utf8Str)
  let bin = ''
  // Chunk the conversion so we don't blow the stack on a multi-MB
  // CSV (apply() arg-count limits are ~64k frames on some engines).
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** Encode a subject (or any header) into RFC 2047 Q-encoded form
 *  when it carries non-ASCII characters, so the receiving MUA
 *  renders 中文 / emoji correctly instead of as `=?...?=` literal. */
function encodeMimeHeader (s) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s
  const b64 = base64Encode(s)
  return `=?utf-8?B?${b64}?=`
}
