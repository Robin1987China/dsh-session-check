/**
 * Projection-cache footprint diagnostic: one read-only line, once per start.
 *
 * This ships no fix. It reports the one storage-domain fact a person cannot
 * otherwise see without an inspector, and that accumulates silently: how much
 * of the persisted projection cache is an oversized `titleInput` prefix, and
 * how many bytes an offline `dsh-projcache apply` would give back.
 *
 * It reads the live domain table (`ctx.storageDomain.get('session_projcache')`)
 * and nothing else. `KvTable.entries()` is a snapshot iterator, so this holds no
 * reference to a record after the loop, and it never calls `put`/`delete`. A
 * record value is plain JSON by contract (`checkpointRow.val` is `z.json()` and
 * `put` requires a losslessly serializable snapshot), which is why measuring one
 * with `JSON.stringify` is legitimate here.
 *
 * Two decisions keep it cheap and honest:
 *
 * - It waits for `sessionProjectionCache` rather than `storageDomain` alone: the
 *   cache service opens the domain in its `init`, so that injection firing is
 *   proof the table exists. Nothing polls, and a profile without the cache
 *   simply never reports.
 * - Measuring is deadline-bounded. A store large enough to matter is also large
 *   enough to make a full scan expensive at start, so measurement stops at
 *   `budgetMs` and says so instead of silently reporting a partial number as a
 *   total.
 *
 * Injection is deliberately NOT declared in the module's `inject` export. A
 * hard dependency makes the whole boot fail when the service is absent, and this
 * row can be mounted in profiles of every shape; `ctx.inject` activates when the
 * service appears and is a no-op otherwise.
 *
 * Mount as a bundle row:
 *
 *   - insert:
 *       - id: projcache-diag
 *         name: 'dsh-session-check/diag'
 *
 * The `dsh-community-fixes` bundle already does this.
 *
 * @module dsh-session-check/diag
 */
import { truncateTitleUtf8 } from './projcache.mjs'

/** Cordis plugin name. */
export const name = 'projcache-diag'

/** The one domain this reports on. */
const DOMAIN = 'session_projcache'
/** Its single table. */
const TABLE = 'sessions'

/** Defaults; every one is overridable from the row's `config`. */
const DEFAULTS = {
  /** Report only when at least this many bytes look reclaimable. */
  minReportBytes: 1 << 20,
  /** Prefix budget to assume for a clamp. */
  clampBytes: 4096,
  /** Longest measurement window, in milliseconds. */
  budgetMs: 50,
}

/**
 * Measure the resident projection cache.
 * @param table - the domain's `sessions` table handle.
 * @param options - resolved thresholds.
 * @returns the measured totals and whether the deadline cut the scan short.
 */
function measure(table, options) {
  const deadline = Date.now() + options.budgetMs
  let measured = 0
  let truncated = false
  let titleInputRecords = 0
  let titleInputChars = 0
  let largestChars = 0
  let reclaimable = 0

  for (const [, record] of table.entries()) {
    if (Date.now() > deadline) { truncated = true; break }
    measured += 1
    const text = record?.rows?.titleInput?.val?.first?.text
    if (typeof text !== 'string') continue
    titleInputRecords += 1
    titleInputChars += text.length
    if (text.length > largestChars) largestChars = text.length
    const clamped = truncateTitleUtf8(text, options.clampBytes)
    if (clamped.length !== text.length) {
      reclaimable += Buffer.byteLength(text, 'utf8') - Buffer.byteLength(clamped, 'utf8')
    }
  }

  return { measured, truncated, titleInputRecords, titleInputChars, largestChars, reclaimable, total: table.size }
}

/**
 * The one-line report prefix, so the message is attributable in a terminal.
 */
const TAG = 'projection cache: '

/**
 * Emit one diagnostic line where a person can actually see it.
 *
 * `ctx.logger` alone is not enough in the shipped composition: Cordis's built-in
 * `LoggerService` installs exactly one exporter — an in-memory ring buffer — and
 * no shipped package registers a console sink, so a `logger.warn` from a plugin
 * reaches neither stdout nor stderr. Measured: this row's `logger.warn` produced
 * no output in a `dsh web` run, while the same callback's `process.stderr.write`
 * did. The logger call is kept so a deployment that does wire a sink receives
 * the message too.
 *
 * @param scoped - the injected context.
 * @param message - the report body, without the tag.
 */
function report(scoped, message) {
  try {
    scoped.logger?.info?.(TAG + message)
  } catch {
    // The logger is optional and must never be able to break the report.
  }
  process.stderr.write(TAG + message + '\n')
}

/**
 * Report once, when the projection cache service is up.
 * @param ctx - plugin context.
 * @param config - optional row configuration.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...config }
  ctx.inject(['storageDomain', 'sessionProjectionCache'], (scoped) => {
    // A diagnostic must never affect start-up.
    try {
      const domain = scoped.storageDomain.get(DOMAIN)
      const table = domain?.table(TABLE)
      if (table === undefined) return
      const measured = measure(table, options)
      const mb = (measured.reclaimable / 1048576).toFixed(1)
      const scope = measured.truncated ? ` (partial scan: first ${measured.measured} of ${measured.total} records)` : ''
      if (measured.reclaimable < options.minReportBytes) {
        // Below the threshold this is not worth a line on every start.
        scoped.logger?.debug?.(`${TAG}${measured.total} records, ${mb} MB reclaimable by clamping${scope}`)
        return
      }
      report(
        scoped,
        `${mb} MB reclaimable — ${measured.titleInputRecords} of ${measured.total} records store a `
        + `titleInput text (largest ${measured.largestChars} chars, ${(measured.titleInputChars / 1048576).toFixed(1)} MB total), `
        + `while the fallback title reads only the first ${options.clampBytes} bytes${scope}. `
        + 'Reclaim offline with: npx -y -p dsh-session-check dsh-projcache survey  (then `apply`)',
      )
    } catch (error) {
      scoped.logger?.debug?.(`${TAG}diagnostic failed: ${String(error)}`)
    }
  })
}
