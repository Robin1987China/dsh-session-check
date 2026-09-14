/**
 * Projection-cache maintenance for the `session_projcache` storage domain:
 * survey always, write only when explicitly asked.
 *
 * The domain stores one pretty-printed JSON document per session under
 * `<store>/session_projcache/sessions/<sessionId>.json`. Two properties of the
 * shipped packages make offline maintenance safe, and both are the reason this
 * module is allowed to exist at all:
 *
 * 1. The cache is a fold shortcut, never an authority
 *    (`dsh-session-projection-cache/lib/index.js` module doc). A record that is
 *    missing, stale, or version-mismatched costs a longer tail replay on the
 *    next cold read and can never produce a wrong value.
 * 2. A record is only reachable through an identity match built from a live or
 *    stored session header (`session-projection-cache/lib/index.js`,
 *    `identityMatches`). Once a session log is gone, no caller can build that
 *    identity, so the record is unreadable forever while still occupying bytes
 *    and still being parsed at every boot.
 * 3. `titleInput` retains the session's first eligible user message whole
 *    (`dsh-session-title/lib/index.js`, `sessionTitleUserMessageOf`: the text
 *    blocks are joined with no bound), while its only reader wants the leading
 *    words within `fallbackMaxBytes` (shipped config: 5 words / 40 bytes,
 *    `dsh-base/cordis.patch.yml`). The projection registers without a `wire`
 *    view, so these bytes are never served to a client: they exist only to let
 *    a session open skip refolding that prefix.
 *
 * Therefore this module writes at most two things, and proves each one first:
 *
 * - it deletes a record only when its session log is provably absent from the
 *   sessions root it was given, and
 * - it replaces an oversized `titleInput` text with a UTF-8-safe prefix,
 *   preserving `ver`, `seq`, `count`, `lastSeq`, and `first.seq`, and only
 *   after checking that the fallback title derived from the clamped text is
 *   identical to the one derived from the original.
 *
 * Every write is preceded by a byte-exact fidelity gate: the file is parsed and
 * re-serialized unchanged, and if the result is not byte-identical to what is
 * on disk the whole run refuses to write. The document format is
 * `JSON.stringify({ version, record }, null, 2) + '\n'`
 * (`dsh-storage-json/lib/index.js`, `serializeRecord`); a backend that changes
 * it must not silently get rewritten by a stale model of it in this tool.
 *
 * @module dsh-session-check/projcache
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Domain directory name, relative to the storage backend root. */
export const DOMAIN_NAME = 'session_projcache'
/** Table directory holding one document per session. */
export const TABLE_NAME = 'sessions'
/** Suffix of one stored record document. */
export const RECORD_SUFFIX = '.json'
/** Infix of the backup this module writes before it changes anything. */
export const BACKUP_INFIX = '.bak.'
/** Default clamp budget for a stored `titleInput` prefix. */
export const DEFAULT_CLAMP_BYTES = 4096
/** Shipped `fallbackMaxWords` (`dsh-base/cordis.patch.yml`). */
export const DEFAULT_FALLBACK_WORDS = 5
/** Shipped `fallbackMaxBytes` (`dsh-base/cordis.patch.yml`). */
export const DEFAULT_FALLBACK_BYTES = 40
/** Refuse to reap a larger share of records than this unless `--force`. */
export const DEFAULT_MAX_ORPHAN_FRACTION = 0.5
/**
 * One stored session log file name. The harness has used both
 * `session.jsonl.zstd` and `session.v3.jsonl.zstd`, and a lab profile can pin
 * `compression: none`, so the version infix and the compression suffix are both
 * optional. Matching generously here is deliberate: a missed log name would
 * turn a live session's record into a "provable" orphan.
 */
export const SESSION_LOG_RE = /^session(\.[A-Za-z0-9-]+)?\.jsonl(\.zstd)?$/

/**
 * Truncate a string to a UTF-8 byte budget without splitting a code point.
 * Mirrors `truncateTitleUtf8` in
 * `dsh-session-title/lib/index.js` (`src/normalize.ts:39-51`), which is the
 * helper the harness itself uses for every title it truncates.
 * @param input - the text to clamp.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest leading code-point prefix within the budget.
 */
export function truncateTitleUtf8(input, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer')
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * Remove terminal controls and collapse whitespace, as the title service does
 * before it derives anything. Mirrors `cleanTitleText` in
 * `dsh-session-title/lib/index.js` (`src/normalize.ts:22-31`).
 * @param input - untrusted title input.
 * @returns one trimmed, whitespace-normalized line.
 */
export function cleanTitleText(input) {
  return input
    .replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, '')
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001B[@-_]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Derive the deterministic first-prompt fallback. Mirrors
 * `fallbackSessionTitle` in `dsh-session-title/lib/index.js`
 * (`src/normalize.ts:70-74`) — the only reader of the stored `titleInput` text.
 * @param input - text from the first eligible human message.
 * @param maxWords - positive whitespace-delimited word cap.
 * @param maxBytes - positive UTF-8 byte cap.
 * @returns the normalized leading words within both limits.
 */
export function fallbackSessionTitle(input, maxWords, maxBytes) {
  const words = cleanTitleText(input).split(' ').filter(Boolean).slice(0, maxWords)
  return truncateTitleUtf8(words.join(' '), maxBytes).trimEnd()
}

/**
 * Serialize one per-record document exactly as the json backend does. Mirrors
 * `serializeRecord` in `dsh-storage-json/lib/index.js` (`src/format.ts:97-99`).
 * @param version - the unit version stamp to preserve.
 * @param record - the record value.
 * @returns the file content, pretty-printed with one trailing newline.
 */
export function serializeRecordDocument(version, record) {
  return JSON.stringify({ version, record }, null, 2) + '\n'
}

/**
 * Parse one stored record document without interpreting it.
 * @param text - file content.
 * @returns the version stamp and record value.
 * @throws when the document is not an object with a numeric version stamp.
 */
export function parseRecordDocument(text) {
  const document = JSON.parse(text)
  if (typeof document !== 'object' || document === null) throw new Error('record document is not a JSON object')
  if (typeof document.version !== 'number') throw new Error('record document has no numeric version stamp')
  return { version: document.version, record: document.record }
}

/** Directory holding the domain's per-record documents. */
export function tableDir(storeRoot) {
  return join(storeRoot, DOMAIN_NAME, TABLE_NAME)
}

/**
 * Collect every session id that has a stored log under `sessionsRoot`.
 *
 * A directory counts as a session directory when it directly contains a file
 * named like a stored session log. Walking the whole tree rather than assuming
 * `<workspace>/<id>/` keeps this honest for any layout the persistence layer
 * may use.
 * @param sessionsRoot - the sessions directory.
 * @returns the set of session ids that still have a log.
 */
export function sessionLogIds(sessionsRoot) {
  const ids = new Set()
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    let hasLog = false
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && SESSION_LOG_RE.test(entry.name)) {
        hasLog = true
      }
    }
    if (hasLog) ids.add(dir.split('/').pop())
  }
  walk(sessionsRoot)
  return ids
}

/**
 * List every record document in the domain table.
 * @param dir - the table directory.
 * @returns per-record entries, sorted by id.
 */
export function listRecords(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return [] }
  return entries
    .filter(name => name.endsWith(RECORD_SUFFIX))
    .sort()
    .map((name) => {
      const path = join(dir, name)
      return { id: name.slice(0, -RECORD_SUFFIX.length), name, path, bytes: statSync(path).size }
    })
}

/** Read one record file, reporting what could not be interpreted. */
function readRecord(entry) {
  const text = readFileSync(entry.path, 'utf8')
  try {
    const { version, record } = parseRecordDocument(text)
    return { entry, text, version, record }
  } catch (error) {
    return { entry, text, unreadable: error.message }
  }
}

/** The stored `titleInput` row of one record, or `undefined` when absent. */
function titleInputRow(record) {
  const row = record?.rows?.titleInput
  if (row === undefined || row === null || typeof row !== 'object') return undefined
  return row
}

/** The stored `titleInput` text, or `undefined` when the row holds no text. */
function titleInputText(record) {
  const text = titleInputRow(record)?.val?.first?.text
  return typeof text === 'string' ? text : undefined
}

/** Median of a numeric array (upper median for even counts). */
function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * Inspect the store and the sessions root without writing anything.
 *
 * The returned `guards` describe whether a writing run would be allowed, so a
 * dry run and the apply run always agree about what is safe.
 * @param options - `storeRoot`, `sessionsRoot`, `clampBytes`, `fallbackWords`,
 *   `fallbackBytes`, `maxOrphanFraction`, `force`.
 * @returns the full survey, including per-file fidelity and clamp intent.
 */
export function survey(options) {
  const {
    storeRoot,
    sessionsRoot,
    clampBytes = DEFAULT_CLAMP_BYTES,
    fallbackWords = DEFAULT_FALLBACK_WORDS,
    fallbackBytes = DEFAULT_FALLBACK_BYTES,
    maxOrphanFraction = DEFAULT_MAX_ORPHAN_FRACTION,
    force = false,
  } = options
  const dir = tableDir(storeRoot)
  const records = listRecords(dir)
  const liveIds = sessionLogIds(sessionsRoot)

  const orphans = []
  const clamps = []
  const unreadable = []
  const fidelityMismatches = []
  const rowBytes = new Map()
  const textLengths = []
  let recordBytes = 0
  let liveReturned = 0

  for (const entry of records) {
    recordBytes += entry.bytes
    const read = readRecord(entry)
    if (read.unreadable !== undefined) {
      unreadable.push({ id: entry.id, path: entry.path, bytes: entry.bytes, error: read.unreadable })
      continue
    }
    // Fidelity gate: the tool may only write a document it can reproduce
    // byte-for-byte. A mismatch means the backend's format moved.
    const roundTrip = serializeRecordDocument(read.version, read.record)
    const fiducial = roundTrip === read.text
    if (!fiducial) fidelityMismatches.push({ id: entry.id, path: entry.path })

    if (liveIds.has(entry.id)) liveReturned += 1
    else orphans.push({ id: entry.id, path: entry.path, bytes: entry.bytes })

    const rows = read.record?.rows
    if (rows !== undefined && rows !== null && typeof rows === 'object') {
      for (const [key, value] of Object.entries(rows)) {
        rowBytes.set(key, (rowBytes.get(key) ?? 0) + Buffer.byteLength(JSON.stringify(value)))
      }
    }

    const text = titleInputText(read.record)
    if (text !== undefined) {
      textLengths.push(text.length)
      const clamped = truncateTitleUtf8(text, clampBytes)
      if (clamped.length !== text.length) {
        const row = titleInputRow(read.record)
        const before = fallbackSessionTitle(text, fallbackWords, fallbackBytes)
        const after = fallbackSessionTitle(clamped, fallbackWords, fallbackBytes)
        clamps.push({
          id: entry.id,
          path: entry.path,
          fileBytes: entry.bytes,
          fromChars: text.length,
          toChars: clamped.length,
          fromBytes: Buffer.byteLength(text, 'utf8'),
          toBytes: Buffer.byteLength(clamped, 'utf8'),
          ver: row.ver,
          seq: row.seq,
          count: row.val?.count,
          lastSeq: row.val?.lastSeq,
          firstSeq: row.val?.first?.seq,
          fallbackBefore: before,
          fallbackAfter: after,
          // The clamp may only ever change bytes the fallback does not read.
          invariantOk: before === after,
          fiducial,
        })
      }
    }
  }

  const reasons = []
  // These two are absolute: a sessions root that does not exist, or that holds
  // no log at all, means the caller pointed at the wrong place far more often
  // than it means every session was deleted. `--force` deliberately cannot
  // override them, so no flag combination can delete a whole store from a typo.
  if (!existsSync(sessionsRoot)) reasons.push(`sessions root does not exist: ${sessionsRoot} (--force cannot override this)`)
  else if (!statSync(sessionsRoot).isDirectory()) reasons.push(`sessions root is not a directory: ${sessionsRoot} (--force cannot override this)`)
  else if (liveIds.size === 0) reasons.push(`no stored session log was found under ${sessionsRoot}; refusing to treat every record as an orphan (--force cannot override this)`)
  const orphanFraction = records.length === 0 ? 0 : orphans.length / records.length
  if (!force && orphanFraction > maxOrphanFraction) {
    reasons.push(`orphans are ${(orphanFraction * 100).toFixed(1)}% of records, above the ${(maxOrphanFraction * 100).toFixed(1)}% limit; pass --force to override`)
  }
  if (fidelityMismatches.length > 0) {
    reasons.push(`${fidelityMismatches.length} record document(s) do not round-trip byte-for-byte; this tool's writer is stale for this backend and it will not write`)
  }
  const brokenInvariants = clamps.filter(clamp => !clamp.invariantOk)
  if (brokenInvariants.length > 0) {
    reasons.push(`${brokenInvariants.length} clamp(s) would change the derived fallback title; refusing those`)
  }

  return {
    storeRoot,
    sessionsRoot,
    tableDir: dir,
    records: { count: records.length, bytes: recordBytes },
    liveLogs: { count: liveIds.size, returned: liveReturned },
    orphans,
    orphanBytes: orphans.reduce((total, entry) => total + entry.bytes, 0),
    orphanFraction,
    unreadable,
    fidelity: { checked: records.length - unreadable.length, mismatches: fidelityMismatches },
    rows: [...rowBytes.entries()].sort((a, b) => b[1] - a[1]).map(([key, bytes]) => ({ key, bytes })),
    titleInput: {
      recordsWithText: textLengths.length,
      oversized: clamps.length,
      medianChars: median(textLengths),
      maxChars: textLengths.length === 0 ? null : Math.max(...textLengths),
      totalChars: textLengths.reduce((total, length) => total + length, 0),
      clampBytes,
    },
    clamps,
    guards: { ok: reasons.length === 0, reasons },
  }
}

/** One backup path for a record, alongside it. The loader ignores the name:
 * `loadTableRecords` reads only `*.json` (`dsh-storage-json/lib/index.js`,
 * `src/per-record-unit.ts:164-178`). */
function backupPath(entry, stamp) {
  return join(entry.path.slice(0, -RECORD_SUFFIX.length) + RECORD_SUFFIX + BACKUP_INFIX + stamp)
}

/**
 * Apply the surveyed maintenance: reap provable orphans, clamp oversized
 * `titleInput` prefixes. Writes nothing when a guard fails.
 *
 * Every change copies the original to `<id>.json.bak.<stamp>` first, then
 * verifies what landed: the new file must parse, must re-serialize to exactly
 * what was written, and must preserve every field the clamp promises to keep.
 * @param options - the `survey` options plus `stamp` (backup suffix).
 * @returns the survey plus per-file outcomes and verification results.
 */
export function maintain(options) {
  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/gu, '-')
  const report = survey(options)
  const result = { ...report, stamp, applied: false, reaped: [], clamped: [], skipped: [], errors: [], verified: [] }
  if (!report.guards.ok) return result

  result.applied = true
  const dir = report.tableDir
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  for (const orphan of report.orphans) {
    try {
      copyFileSync(orphan.path, backupPath(orphan, stamp))
      rmSync(orphan.path)
      result.reaped.push({ ...orphan, backup: backupPath(orphan, stamp) })
    } catch (error) {
      result.errors.push({ id: orphan.id, action: 'reap', error: error.message })
    }
  }

  for (const clamp of report.clamps) {
    if (!clamp.invariantOk || !clamp.fiducial) {
      result.skipped.push({ id: clamp.id, reason: clamp.invariantOk ? 'not byte-faithful' : 'would change the derived fallback title' })
      continue
    }
    try {
      const original = readFileSync(clamp.path, 'utf8')
      const { version, record } = parseRecordDocument(original)
      const before = titleInputText(record)
      record.rows.titleInput.val.first.text = truncateTitleUtf8(before, report.titleInput.clampBytes)
      const content = serializeRecordDocument(version, record)
      copyFileSync(clamp.path, backupPath(clamp, stamp))
      writeFileSync(clamp.path, content)

      // Verify what actually landed, rather than trusting the write.
      const landed = readFileSync(clamp.path, 'utf8')
      const parsed = parseRecordDocument(landed)
      const after = titleInputText(parsed.record)
      const row = titleInputRow(parsed.record)
      const checks = {
        roundTrip: serializeRecordDocument(parsed.version, parsed.record) === landed,
        versionPreserved: parsed.version === version,
        verPreserved: row?.ver === clamp.ver,
        seqPreserved: row?.seq === clamp.seq,
        countPreserved: row?.val?.count === clamp.count,
        lastSeqPreserved: row?.val?.lastSeq === clamp.lastSeq,
        firstSeqPreserved: row?.val?.first?.seq === clamp.firstSeq,
        textClamped: after !== undefined && after.length === clamp.toChars,
        fallbackUnchanged: after !== undefined
          && fallbackSessionTitle(after, options.fallbackWords ?? DEFAULT_FALLBACK_WORDS, options.fallbackBytes ?? DEFAULT_FALLBACK_BYTES)
            === fallbackSessionTitle(before, options.fallbackWords ?? DEFAULT_FALLBACK_WORDS, options.fallbackBytes ?? DEFAULT_FALLBACK_BYTES),
      }
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
      result.verified.push({ id: clamp.id, checks, ok: failed.length === 0, failed })
      if (failed.length === 0) result.clamped.push({ id: clamp.id, fromBytes: clamp.fileBytes, toBytes: statSync(clamp.path).size, backup: backupPath(clamp, stamp) })
      else result.errors.push({ id: clamp.id, action: 'clamp', error: `post-write verification failed: ${failed.join(', ')}` })
    } catch (error) {
      result.errors.push({ id: clamp.id, action: 'clamp', error: error.message })
    }
  }
  return result
}
