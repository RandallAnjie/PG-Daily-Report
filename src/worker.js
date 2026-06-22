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

/** Send the success email. The bigrandall send_email binding
 *  doesn't accept attachments — its documented signature is just
 *  `{to, subject, text, html, from?, replyTo?, cc?, bcc?}`. We
 *  inline the whole CSV into both the plain-text and HTML parts
 *  instead. Email clients render the HTML `<pre>` block as a
 *  monospace, scrollable code box that reads well at a few-
 *  hundred-row report size; the plain-text fallback ships the
 *  raw CSV after a summary header so power users / scripts can
 *  pipe the body straight into a file. */
async function sendReportMail (env, report) {
  const date = reportDateString()
  const subject = `[PG-Daily-Report] ${date} — ${report.rowCount} new user${report.rowCount === 1 ? '' : 's'}`

  const summary =
    `Date    : ${date}\n` +
    `Rows    : ${report.rowCount}\n` +
    `Columns : ${report.columns.length}\n` +
    `Query   : ${report.durationMs} ms`

  const text =
    `New-user report for the past 24 h (UTC).\n` +
    `\n` +
    summary +
    `\n` +
    `\n` +
    `--- CSV (UTF-8 with BOM, RFC 4180) ---\n` +
    `\n` +
    report.csv

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2328;">
  <h2 style="margin:0 0 12px;font-weight:600;">PG Daily Report — ${escapeHtml(date)}</h2>
  <p style="margin:0 0 16px;color:#57606a;">New-user report for the past 24 h (UTC).</p>
  <table style="border-collapse:collapse;margin-bottom:20px;font-size:14px;">
    <tbody>
      <tr><td style="padding:2px 16px 2px 0;color:#57606a;">Rows</td><td style="padding:2px 0;font-weight:600;">${report.rowCount}</td></tr>
      <tr><td style="padding:2px 16px 2px 0;color:#57606a;">Columns</td><td style="padding:2px 0;">${report.columns.length}</td></tr>
      <tr><td style="padding:2px 16px 2px 0;color:#57606a;">Query</td><td style="padding:2px 0;">${report.durationMs} ms</td></tr>
    </tbody>
  </table>
  <p style="margin:0 0 8px;color:#57606a;font-size:13px;">CSV (UTF-8 + BOM, RFC 4180 quoting):</p>
  <pre style="margin:0;padding:14px 16px;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:12px;line-height:1.5;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;white-space:pre;overflow-x:auto;">${escapeHtml(report.csv)}</pre>
</body>
</html>`

  await sendStructuredMail(env, { subject, text, html })
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
 *  mail binding (`SEND_EMAIL`). The binding's documented signature
 *  (per `internal/workerd/manager.go::emailSenderShimSource`):
 *
 *    env.SEND_EMAIL.send({
 *      to:       string | string[],   // required
 *      subject:  string,              // required
 *      text:     string,              // text OR html required
 *      html:     string,              // ...
 *      from:     string,              // optional, defaults to bound domain
 *      replyTo:  string,              // optional
 *      cc:       string[],            // optional
 *      bcc:      string[],            // optional
 *    })
 *
 *  No attachments[] field — earlier iterations tried it but the
 *  binding silently dropped the data. */
async function sendStructuredMail (env, { subject, text, html, replyTo, cc, bcc }) {
  const from = env.EMAIL_FROM
  const to = env.EMAIL_TO
  if (!to) {
    throw new Error('EMAIL_TO env var not set')
  }
  if (!subject) {
    throw new Error('subject not set')
  }
  if (!text && !html) {
    throw new Error('text or html body required')
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
    to,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(from ? { from } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {})
  }

  log('info', 'mail:send', {
    to, from: from || '(default-bound-domain)', subject,
    textBytes: text?.length || 0,
    htmlBytes: html?.length || 0
  })

  // Try the RPC `.send()` style first (the documented signature
  // in bigrandall's emailSenderShimSource). If the binding is
  // actually wired up as an `ExternalServer`-type — which only
  // accepts `.fetch()` — workerd throws
  //   "This ExternalServer not configured for RPC."
  // We catch that one specific failure and degrade to a fetch-
  // style POST against the binding. The URL host is meaningless
  // for a worker binding (the runtime ignores it and routes to
  // whatever the binding points at); we just need a valid Request
  // shape with a JSON body the upstream shim can parse.
  try {
    await env.SEND_EMAIL.send(payload)
    log('info', 'mail:sent', { via: 'rpc' })
    return
  } catch (e) {
    const msg = String(e?.message || e)
    if (!/ExternalServer not configured for RPC|not.*RPC/i.test(msg)) {
      throw e
    }
    log('warn', 'mail:send-rpc-failed-falling-back', { error: msg })
  }

  // Fallback: ExternalServer-shaped binding. POST the same payload.
  const candidates = ['https://internal/send', 'https://internal/']
  const errors = []
  for (const url of candidates) {
    try {
      const res = await env.SEND_EMAIL.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const body = await res.text().catch(() => '')
      if (res.ok) {
        log('info', 'mail:sent', { via: 'fetch', url, status: res.status })
        return
      }
      errors.push(`${url} → ${res.status} ${body.slice(0, 160)}`)
    } catch (e) {
      errors.push(`${url} → ${e?.message || e}`)
    }
  }
  throw new Error('mail: ExternalServer fetch fallback exhausted: ' + errors.join(' | '))
}

/** Escape `&`, `<`, `>`, `"`, `'` so a CSV cell with a stray `<`
 *  or `&` doesn't poison the surrounding HTML structure. */
function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c])
}
