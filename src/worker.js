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

import pg from 'pg'
import { CloudflareSocket } from 'pg-cloudflare'

// Outbound mail goes through the operator-configured bigrandall
// binding (named `SEND_EMAIL` by convention in this repo, but
// anything works — adjust env.SEND_EMAIL in sendMimeMail() if you
// renamed it). Gated on a green DKIM + SPF record for the sender
// domain. NOT the `cloudflare:email` internal module, which
// bigrandall's workerd doesn't ship — see sendMimeMail() for the
// plain-object invocation shape.
//
// On the PG side we use `pg` (node-postgres) instead of the
// porsager `postgres` library because workerd's `node:net` on
// bigrandall is a resolve-only stub — `net.connect()` returns
// a Socket-shaped object whose write() instantly times out at
// the TCP layer. `pg-cloudflare`'s `CloudflareSocket` is a
// node-compatible Socket wrapper around `cloudflare:sockets`,
// which IS bridged correctly. We pass it explicitly via the
// `stream` factory option (Client's runtime check for
// `navigator.userAgent === "Cloudflare-Workers"` won't match
// bigrandall, so auto-detection fails and we'd fall back to
// node:net without the manual override).

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

    if (url.pathname === '/admin/probe-email') {
      // Diagnostic: try multiple SEND_EMAIL.send() signatures and
      // report which (if any) didn't throw. Use this to figure out
      // the binding's expected payload shape on bigrandall — the
      // error message body usually names the field it's missing.
      if (!isAdmin(request, env)) {
        return new Response('unauthorized\n', { status: 401 })
      }
      return probeEmailShapes(env)
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
/** Try several common SEND_EMAIL.send() argument shapes against
 *  the bigrandall binding, capturing which one didn't throw and
 *  what the rejection message was for the others. The point isn't
 *  to actually deliver a mail (DKIM gates that anyway in dev) —
 *  it's to figure out which payload shape the binding parser
 *  expects so the real call site can stop iterating on deploys. */
async function probeEmailShapes (env) {
  const from = env.EMAIL_FROM || 'probe@example.com'
  const to = env.EMAIL_TO || 'probe@example.com'
  const subject = 'probe'
  const text = 'probe body'
  // Tiny base64 of "hi\n" for attachment shape probing.
  const b64 = 'aGkK'
  const shapes = [
    // Sanity — known-good
    ['{from,to,subject,text} sanity', () => env.SEND_EMAIL.send({ from, to, subject, text })],
    // Attachment shape variants
    ['attachments:[{filename,contentType,content}]', () => env.SEND_EMAIL.send({ from, to, subject, text, attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: b64 }] })],
    ['attachments:[{filename,content_type,content}]', () => env.SEND_EMAIL.send({ from, to, subject, text, attachments: [{ filename: 'a.txt', content_type: 'text/plain', content: b64 }] })],
    ['attachments:[{filename,contentType,data}]', () => env.SEND_EMAIL.send({ from, to, subject, text, attachments: [{ filename: 'a.txt', contentType: 'text/plain', data: b64 }] })],
    ['attachments:[{name,type,content}] Resend-style', () => env.SEND_EMAIL.send({ from, to, subject, text, attachments: [{ name: 'a.txt', type: 'text/plain', content: b64 }] })],
    ['attachments:[{filename,type,content}]', () => env.SEND_EMAIL.send({ from, to, subject, text, attachments: [{ filename: 'a.txt', type: 'text/plain', content: b64 }] })],
    ['attachments:[{filename,content}]', () => env.SEND_EMAIL.send({ from, to, subject, text, attachments: [{ filename: 'a.txt', content: b64 }] })],
    // Top-level rather than nested
    ['attachment singular {filename,content}', () => env.SEND_EMAIL.send({ from, to, subject, text, attachment: { filename: 'a.txt', content: b64 } })],
    // Files array variant
    ['files:[{filename,content}]', () => env.SEND_EMAIL.send({ from, to, subject, text, files: [{ filename: 'a.txt', content: b64 }] })],
    // Plain-text content (not base64)
    ['attachments:[{filename,contentType,content=plain}]', () => env.SEND_EMAIL.send({ from, to, subject, text, attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: 'hi\n' }] })],
    // Reply-to + cc shape probe
    ['everything-and-the-kitchen-sink', () => env.SEND_EMAIL.send({ from, to, subject, text, html: '<p>' + text + '</p>', reply_to: from, replyTo: from })]
  ]
  const results = []
  for (const [label, fn] of shapes) {
    try {
      await fn()
      results.push({ shape: label, ok: true })
    } catch (e) {
      results.push({ shape: label, ok: false, error: String(e?.message || e).slice(0, 200) })
    }
  }
  return new Response(JSON.stringify({ results }, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

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
 *  the email body itself carries diagnostics on success / failure.
 *
 *  Logs at every stage transition so a tail of the worker's stderr
 *  reads like a single-line per-step audit trail. Keeps the
 *  diagnostic noise inside the worker; the email body itself stays
 *  the operator-facing summary. */
async function runReport (env, ctx, meta) {
  const startedAt = Date.now()
  log('info', 'report:start', { trigger: meta.trigger, expression: meta.expression })

  let report
  try {
    report = await buildReport(env)
    log('info', 'report:built', {
      rows: report.rowCount,
      columns: report.columns.length,
      csvBytes: report.csv.length,
      queryMs: report.durationMs
    })
  } catch (e) {
    const msg = `report build failed (${meta.trigger}): ${e?.message || e}`
    log('error', 'report:build-failed', { error: e?.message || String(e), stack: e?.stack })
    try { await sendFailureMail(env, msg) } catch (mailErr) {
      log('error', 'report:failure-mail-also-failed', { error: mailErr?.message })
    }
    return jsonStatus({ ok: false, stage: 'build', error: msg, durationMs: Date.now() - startedAt })
  }

  try {
    await sendReportMail(env, report)
    log('info', 'report:mail-sent', { to: env.EMAIL_TO })
  } catch (e) {
    const msg = `mail send failed: ${e?.message || e}`
    log('error', 'report:mail-failed', { error: e?.message || String(e), stack: e?.stack })
    return jsonStatus({
      ok: false, stage: 'mail', error: msg,
      rowCount: report.rowCount, csvBytes: report.csv.length,
      durationMs: Date.now() - startedAt
    })
  }

  const totalMs = Date.now() - startedAt
  log('info', 'report:done', { trigger: meta.trigger, rows: report.rowCount, totalMs })
  return jsonStatus({
    ok: true,
    rowCount: report.rowCount,
    columns: report.columns.length,
    csvBytes: report.csv.length,
    queryMs: report.durationMs,
    durationMs: totalMs,
    trigger: meta.trigger
  })
}

/** Single-line JSON log helper. workerd writes whatever you pass
 *  to console.log straight to stderr; JSON keeps the lines easy
 *  to grep + parse in the bigrandall log panel. */
function log (level, event, fields) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(fields || {})
    })
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
  } catch {}
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
  log('info', 'pg:open', { host: env.PG_HOST, port: env.PG_PORT || '5432', database: env.PG_DATABASE, user: env.PG_USER })
  const client = openPg(env)
  const queryStartedAt = Date.now()
  let result
  try {
    log('info', 'pg:connecting')
    await client.connect()
    log('info', 'pg:connected', { connectMs: Date.now() - queryStartedAt })
    const queryAt = Date.now()
    result = await client.query(`
      SELECT users.*, auth_credentials.*
      FROM "public"."users"
      LEFT JOIN auth_credentials
        ON auth_credentials.user_id = users."id"
      WHERE users."created_at" > now() - interval '24 hours'
    `)
    log('info', 'pg:query-done', { rows: result.rowCount ?? result.rows.length, fields: result.fields?.length || 0, queryMs: Date.now() - queryAt })
  } finally {
    // Fire-and-forget the socket close. pg-cloudflare's
    // CloudflareSocket.close() returns a Promise that hangs
    // forever on workerd (we observed this — execution never
    // returned from `await client.end()` after a successful
    // query, dropping the request mid-pipeline with no error
    // visible in the log tail). The socket gets garbage
    // collected when the request scope unwinds; we don't need
    // to wait for the OS-level shutdown to finish.
    try { client.end().catch(() => {}) } catch {}
  }
  const queryDurationMs = Date.now() - queryStartedAt

  // pg returns columns in the field order of the SELECT statement,
  // matching what the SQL author would expect.
  const columns = result.fields ? result.fields.map((f) => f.name) : []
  const csv = rowsToCsv(result.rows, columns)
  return {
    rowCount: result.rows.length,
    columns,
    csv,
    durationMs: queryDurationMs
  }
}

/** Open a one-shot node-postgres Client wired to use
 *  `cloudflare:sockets` for the underlying TCP connection.
 *
 *  We pass `stream` as a factory function so pg's Connection
 *  layer calls it lazily AT connect-time and uses the result as
 *  its socket instead of the default `new net.Socket()`. That
 *  avoids workerd's broken `node:net` stub entirely. `ssl: true`
 *  enables TLS — pg will negotiate it via the helper's
 *  `startTls()` method, which forwards to the same socket. */
function openPg (env) {
  return new pg.Client({
    host: env.PG_HOST,
    port: parseInt(env.PG_PORT || '5432', 10),
    database: env.PG_DATABASE,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    ssl: { rejectUnauthorized: false },
    application_name: 'pg-daily-report',
    stream: (config) => new CloudflareSocket(config.ssl),
    // Hard cap so a bad firewall / wrong port doesn't keep the
    // worker invocation alive for the workerd wall-time limit.
    connectionTimeoutMillis: 10000,
    statement_timeout: 25000,
    query_timeout: 25000
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
  await sendStructuredMail(env, {
    subject,
    text: body,
    attachments: [
      {
        filename,
        contentType: 'text/csv; charset=utf-8',
        contentBase64: base64Encode(report.csv)
      }
    ]
  })
}

/** Send a brief failure notice when the report build blew up. */
async function sendFailureMail (env, errorMessage) {
  const date = reportDateString()
  await sendStructuredMail(env, {
    subject: `[PG-Daily-Report] ${date} — FAILED`,
    text:
      `Daily report build failed.\n\n` +
      `Error: ${errorMessage}\n\n` +
      `Check Azure PG firewall rules (worker egress IP needed in allow-list), ` +
      `or the worker's tail logs.\n`
  })
}

/** Hand a structured email payload to the bigrandall outbound
 *  mail binding (`SEND_EMAIL`). The binding accepts a Resend /
 *  Mailgun-style object — top-level `subject`, `text`, `html`
 *  fields and an `attachments[]` array — and assembles the
 *  RFC 5322 frame itself. This is NOT Cloudflare's Email Workers
 *  raw-RFC-822 shape (an earlier draft tried `{from,to,raw}` and
 *  got "send(): missing subject" back).
 *
 *  Attachment object shape we send:
 *    { filename, contentType, contentBase64 }
 *  Common alternatives across mail-API providers:
 *    { filename, type, content }              (Resend)
 *    { filename, content, contentType }       (Mailgun-ish)
 *    { filename, content_type, data }         (snake_case)
 *  We pass `filename` + `contentType` + both `content` and
 *  `contentBase64` so whichever shape the binding parses against,
 *  it'll find what it's looking for. */
async function sendStructuredMail (env, { subject, text, html, attachments }) {
  const from = env.EMAIL_FROM
  const to = env.EMAIL_TO
  if (!from || !to) {
    throw new Error('EMAIL_FROM / EMAIL_TO env vars not set')
  }
  if (!env.SEND_EMAIL) {
    throw new Error('SEND_EMAIL binding not bound — see RANDALLFLARE.md')
  }
  // NOTE on the missing `typeof env.SEND_EMAIL.send === "function"`
  // guard: bigrandall's service-binding stubs are RPC-shaped, and
  // any property access on them (even a typeof check) triggers a
  // platform warning about "__es_marker__ might appear to be an
  // RPC method". So we trust the binding exists and let .send()
  // throw at call time if it doesn't.

  const payload = {
    from,
    to,
    subject,
    text: text || '',
    ...(html ? { html } : {}),
    ...(attachments && attachments.length
      ? {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            // Belt-and-braces field aliases — bigrandall's binding
            // may key on any of these.
            content: a.contentBase64,
            content_type: a.contentType,
            data: a.contentBase64
          }))
        }
      : {})
  }

  log('info', 'mail:send', {
    to, from, subject,
    textBytes: text?.length || 0,
    attachments: attachments?.length || 0,
    firstAttachmentB64Bytes: attachments?.[0]?.contentBase64?.length || 0
  })
  await env.SEND_EMAIL.send(payload)
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
