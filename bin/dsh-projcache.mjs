#!/usr/bin/env node
/**
 * dsh-projcache — offline maintenance for the `session_projcache` storage
 * domain: reap records whose session log is gone, and clamp oversized
 * `titleInput` prefixes.
 *
 *   dsh-projcache survey [--store DIR] [--sessions DIR]
 *   dsh-projcache apply  [--store DIR] [--sessions DIR] [options]
 *
 * `survey` writes nothing; `apply` writes, and only after every guard passes.
 * This is a separate binary from `dsh-session-check` on purpose: that tool's
 * whole value is that it cannot damage anything, and it stays that way.
 *
 * Run it while the harness is stopped. The store is a live in-memory table in a
 * running process, so an offline edit made underneath a running process would
 * be re-applied from that process's memory.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CLAMP_BYTES,
  DEFAULT_FALLBACK_BYTES,
  DEFAULT_FALLBACK_WORDS,
  DEFAULT_MAX_ORPHAN_FRACTION,
  maintain,
  survey,
} from '../src/projcache.mjs'

const USAGE = [
  'usage: dsh-projcache survey [options]   # report only; writes nothing',
  '       dsh-projcache apply  [options]   # reap orphans and clamp, with backups',
  '',
  'options:',
  '  --store DIR                storage backend root (default $DSH_HOME/storages)',
  '  --sessions DIR             sessions root       (default $DSH_HOME/sessions)',
  '  --clamp-bytes N            titleInput prefix budget in bytes (default ' + DEFAULT_CLAMP_BYTES + ')',
  '  --fallback-words N         fallbackMaxWords from your composition (default ' + DEFAULT_FALLBACK_WORDS + ')',
  '  --fallback-bytes N         fallbackMaxBytes from your composition (default ' + DEFAULT_FALLBACK_BYTES + ')',
  '  --max-orphan-fraction F    refuse to reap above this share (default ' + DEFAULT_MAX_ORPHAN_FRACTION + ')',
  '  --force                    override the orphan-share guard only; it cannot',
  '                             override a missing or log-free sessions root',
  '  --json                     machine-readable output',
  '',
].join('\n')

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const argv = process.argv.slice(2)
const command = argv[0]

if (command !== 'survey' && command !== 'apply') {
  process.stdout.write(USAGE)
  process.exit(2)
}

const options = {
  storeRoot: join(home, 'storages'),
  sessionsRoot: join(home, 'sessions'),
  clampBytes: DEFAULT_CLAMP_BYTES,
  fallbackWords: DEFAULT_FALLBACK_WORDS,
  fallbackBytes: DEFAULT_FALLBACK_BYTES,
  maxOrphanFraction: DEFAULT_MAX_ORPHAN_FRACTION,
  force: false,
}
let json = false

for (let index = 1; index < argv.length; index += 1) {
  const flag = argv[index]
  const value = argv[index + 1]
  const take = () => {
    if (value === undefined) throw new Error(`${flag} needs a value`)
    index += 1
    return value
  }
  switch (flag) {
    case '--store': options.storeRoot = take().replace(/^~/, homedir()); break
    case '--sessions': options.sessionsRoot = take().replace(/^~/, homedir()); break
    case '--clamp-bytes': options.clampBytes = Number(take()); break
    case '--fallback-words': options.fallbackWords = Number(take()); break
    case '--fallback-bytes': options.fallbackBytes = Number(take()); break
    case '--max-orphan-fraction': options.maxOrphanFraction = Number(take()); break
    case '--force': options.force = true; break
    case '--json': json = true; break
    default: process.stderr.write(`unknown option: ${flag}\n\n${USAGE}`); process.exit(2)
  }
}

const mb = bytes => (bytes / 1048576).toFixed(2)
const pct = (part, whole) => (whole === 0 ? '0.0' : ((part / whole) * 100).toFixed(1))

let report
try {
  report = command === 'apply' ? maintain(options) : survey(options)
} catch (error) {
  process.stderr.write(`dsh-projcache: ${error.message}\n`)
  process.exit(1)
}

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exit(report.guards.ok || command === 'survey' ? 0 : 1)
}

const lines = []
lines.push(`store root        : ${report.storeRoot}`)
lines.push(`sessions root     : ${report.sessionsRoot}${existsSync(report.sessionsRoot) ? '' : '  (missing)'}`)
lines.push(`records           : ${report.records.count}  (${mb(report.records.bytes)} MB)`)
lines.push(`session logs      : ${report.liveLogs.count} live`)
lines.push(`orphaned records  : ${report.orphans.length}  (${mb(report.orphanBytes)} MB)`
  + `  = ${pct(report.orphans.length, report.records.count)}% of records`)
lines.push(`round-trip gate   : ${report.fidelity.checked} checked, ${report.fidelity.mismatches.length} not byte-faithful`)
if (report.unreadable.length > 0) lines.push(`unreadable        : ${report.unreadable.length} (left untouched)`)

lines.push('')
lines.push('largest stored rows:')
for (const row of report.rows.slice(0, 3)) {
  lines.push(`  ${row.key.padEnd(20)} ${mb(row.bytes).padStart(8)} MB  ${pct(row.bytes, report.records.bytes)}%`)
}
lines.push('')
lines.push(`titleInput rows   : ${report.titleInput.recordsWithText} carry text, median `
  + `${report.titleInput.medianChars ?? '-'} chars, max ${report.titleInput.maxChars ?? '-'} chars`)
lines.push(`  over ${report.titleInput.clampBytes} bytes : ${report.titleInput.oversized} records, `
  + `${mb(report.clamps.reduce((total, clamp) => total + (clamp.fromBytes - clamp.toBytes), 0))} MB reclaimable by clamping`)

if (report.clamps.length > 0) {
  lines.push('')
  lines.push('largest clamps:')
  for (const clamp of report.clamps.slice(0, 5)) {
    lines.push(`  ${clamp.id.slice(0, 40).padEnd(42)} ${clamp.fromChars} -> ${clamp.toChars} chars`
      + `   fallback ${clamp.invariantOk ? 'unchanged' : 'WOULD CHANGE'}`)
  }
}

if (!report.guards.ok) {
  lines.push('')
  lines.push('REFUSING TO WRITE:')
  for (const reason of report.guards.reasons) lines.push(`  - ${reason}`)
  lines.push('')
  process.stdout.write(lines.join('\n') + '\n')
  process.exit(command === 'survey' ? 0 : 1)
}

if (command === 'survey') {
  lines.push('')
  lines.push('nothing was written. Re-run with `apply` to reap and clamp.')
  process.stdout.write(lines.join('\n') + '\n')
  process.exit(0)
}

lines.push('')
lines.push(`reaped  : ${report.reaped.length} records`)
lines.push(`clamped : ${report.clamped.length} records`)
if (report.skipped.length > 0) lines.push(`skipped : ${report.skipped.length}`)
lines.push(`verified: ${report.verified.filter(item => item.ok).length}/${report.verified.length} post-write checks passed`)
if (report.errors.length > 0) {
  lines.push('errors:')
  for (const error of report.errors) lines.push(`  - ${error.id}: ${error.action}: ${error.error}`)
}
lines.push(`backups : <record>.json${'.bak.'}<stamp> next to each changed file (stamp ${report.stamp})`)
process.stdout.write(lines.join('\n') + '\n')
process.exit(report.errors.length === 0 ? 0 : 1)
