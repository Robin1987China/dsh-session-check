/**
 * Read-only scan of stored session logs against the migration gates.
 *
 * Nothing here writes: a scan parses each log, runs every gate over the parsed
 * events, and reports which sessions the loader would refuse and why. The
 * repair path is a separate module precisely so that scanning can never be the
 * thing that damages a log.
 *
 * @module dsh-session-repair/scan
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GATES } from './gates.mjs'
import { validateEvents } from './released.mjs'

/** File name of one stored session log, as written by the v0-era releases. */
export const LOG_FILE = 'session.jsonl.zstd'

/**
 * Whether a file name is a stored session log.
 *
 * A stored log's name carries an optional format infix and an optional
 * compression suffix: `session.jsonl.zstd` (the v0-era name), and
 * `session.v3.jsonl.zstd` / `session.v3.jsonl` from later releases. Matching
 * only {@link LOG_FILE} silently omitted every later-generation log — 9 of 41 in
 * the corpus this was checked against — while the version tally still looked
 * complete. A log this scan cannot see is a log it cannot warn about.
 * @param name - the file name.
 * @returns whether it is a stored session log.
 */
export function isLogFile(name) {
  return /^session(\.[A-Za-z0-9-]+)?\.jsonl(\.zstd)?$/u.test(name)
}

/**
 * Find every stored session log under a root.
 * @param root - sessions directory, or a directory containing them.
 * @returns absolute log paths, sorted.
 */
export function findLogs(root) {
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (isLogFile(name)) found.push(full)
    }
  }
  walk(root)
  return found.sort()
}

/**
 * Decompress one multi-frame zstd log to text.
 * @param path - the stored log.
 * @returns the concatenated plain-text log.
 */
export function readLog(path) {
  return execFileSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
}

/**
 * Parse a log into session events.
 *
 * A stored log carries two row kinds, and the migration decodes them on
 * separate paths: session events carry a numeric seq (decodeEvent), while
 * packed chunk runs carry seq0/time0 instead (decodePackedRun,
 * dsh-session-format-v0-to-v1/lib/index.js:1744-1798). Only the first kind is a
 * session event, so only the first kind is offered to the gates. Feeding a
 * packed run to the event validators reports a violation that cannot happen.
 * @param text - the decompressed log.
 * @returns events, the packed-run count, the unparsable count, and the header.
 */
export function parseLog(text) {
  const events = []
  let unparsable = 0
  let packed = 0
  let header
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { unparsable += 1; continue }
    if (header === undefined && event.type === 'session') { header = event; continue }
    if (typeof event.seq !== 'number') { packed += 1; continue }
    events.push(event)
  }
  return { events, unparsable, packed, header }
}

/**
 * Run every gate over one log.
 * @param path - the stored log.
 * @param options - optional `released` official-validator module. When it is
 *   supplied, a format-v0 log additionally runs the official payload validator
 *   and its refusals are reported under `v0-unknown-event-type` and
 *   `v0-unknown-payload-member`. A later generation skips that step: the v0
 *   validator would report the event types and payload members that generation
 *   added, which are not migration refusals at all.
 * @returns a verdict for that session.
 */
export function scanLog(path, options = {}) {
  const { events, unparsable, packed, header } = parseLog(readLog(path))
  const findings = []
  for (const gate of GATES) {
    let hits = 0
    const samples = []
    for (const event of events) {
      const hit = gate.find(event)
      if (hit === undefined) continue
      hits += 1
      if (samples.length < 3) {
        samples.push({ seq: event.seq, type: event.type, detail: hit })
      }
    }
    if (hits > 0) findings.push({ id: gate.id, label: gate.label, events: hits, samples })
  }
  const formatVersion = header && header.version !== undefined ? header.version : null
  let officialRan = false
  if (options.released !== undefined && formatVersion === 0) {
    officialRan = true
    findings.push(...validateEvents(options.released, events))
  }
  return {
    path,
    id: header && header.id ? header.id : '',
    formatVersion,
    preset: header && header.agentPreset ? header.agentPreset : '',
    events: events.length,
    packedRuns: packed,
    unparsable,
    findings,
    officialRan,
    blocked: findings.length > 0,
  }
}

/**
 * Scan a whole sessions root.
 * @param root - sessions directory.
 * @param onProgress - optional per-session callback.
 * @param options - optional `released` official-validator module, passed to {@link scanLog}.
 * @returns one verdict per log, in path order.
 */
export function scanRoot(root, onProgress, options = {}) {
  const logs = findLogs(root)
  const verdicts = []
  for (const path of logs) {
    const verdict = scanLog(path, options)
    verdicts.push(verdict)
    if (onProgress) onProgress(verdict, verdicts.length, logs.length)
  }
  return verdicts
}
