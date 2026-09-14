#!/usr/bin/env node
/**
 * dsh-session-check — read-only diagnosis of stored session logs.
 *
 * Reports which sessions the format migration will refuse, and which gate
 * refuses each one, without writing anything.
 *
 *   dsh-session-check scan <sessions-dir> [--no-validator] [--json]
 *
 * Two of the gates are not mirrors of the migration's decision — they call it.
 * When the harness is installed, the scan runs the official
 * `assertReleasedEventPayload` over every format-v0 log and reports its
 * refusals as `v0-unknown-event-type` / `v0-unknown-payload-member`. Without the
 * harness those two gates cannot run, and the scan says so rather than printing
 * a clean-looking result.
 *
 * There is deliberately no repair subcommand. Rewriting a session log is a
 * destructive operation; a tool earns the right to perform one by first
 * proving it can see the problem without touching anything.
 */
import { inventoryReport, loadReleasedValidator, RELEASED_PACKAGE } from '../src/released.mjs'
import { scanRoot } from '../src/scan.mjs'

const USAGE = [
  'usage: dsh-session-check scan <sessions-dir> [--no-validator] [--json]',
  '',
  '  scan             Read-only. Reports every stored session log and the',
  '                   migration gates it fails. Writes nothing.',
  '  --no-validator   Skip the official-validator gates. The two v0 gates are',
  '                   then unavailable and reported as such.',
  '  --json           Machine-readable output.',
  '',
  'The directory is usually $DSH_HOME/sessions (~/.dsh/sessions by default).',
  '',
].join('\n')

const argv = process.argv.slice(2)
const command = argv[0]
if (command !== 'scan') {
  process.stdout.write(USAGE)
  process.exit(2)
}

let target
let useValidator = true
let json = false
for (let index = 1; index < argv.length; index += 1) {
  switch (argv[index]) {
    case '--no-validator': useValidator = false; break
    case '--json': json = true; break
    default:
      if (argv[index].startsWith('-')) { process.stderr.write(`unknown option: ${argv[index]}\n\n${USAGE}`); process.exit(2) }
      target = argv[index]
  }
}
if (target === undefined) {
  process.stdout.write(USAGE)
  process.exit(2)
}

const root = target.replace(/^~/, process.env.HOME ?? '~')

const loaded = useValidator ? await loadReleasedValidator() : { module: undefined, reason: 'disabled by --no-validator' }
const inventory = inventoryReport(loaded.module)

const verdicts = scanRoot(root, json ? undefined : (v, i, n) => {
  process.stdout.write('  [' + i + '/' + n + '] ' + (v.blocked ? 'BLOCKED' : 'ok     ')
    + ' ' + (v.id || v.path.split('/').slice(-2)[0]).slice(0, 40) + '\n')
}, { released: loaded.module })

const blocked = verdicts.filter(v => v.blocked)
const tally = new Map()
for (const v of blocked) for (const f of v.findings) tally.set(f.id, (tally.get(f.id) ?? 0) + 1)

if (json) {
  process.stdout.write(JSON.stringify({
    root,
    validator: { package: RELEASED_PACKAGE, available: loaded.module !== undefined, reason: loaded.reason, inventory },
    scanned: verdicts.length,
    blocked: blocked.length,
    verdicts,
  }, null, 2) + '\n')
  process.exit(0)
}

process.stdout.write('\n')
process.stdout.write('sessions scanned   : ' + verdicts.length + '\n')
process.stdout.write('loader would refuse: ' + blocked.length + '\n')
process.stdout.write('packed chunk runs  : ' + verdicts.reduce((a, v) => a + v.packedRuns, 0) + ' (not session events)\n')
process.stdout.write('format versions    : ' + JSON.stringify(
  verdicts.reduce((a, v) => { a[String(v.formatVersion)] = (a[String(v.formatVersion)] ?? 0) + 1; return a }, {})) + '\n')
process.stdout.write('\n')
process.stdout.write('official validator : ' + (loaded.module === undefined
  ? 'UNAVAILABLE — ' + loaded.reason + '\n'
  : RELEASED_PACKAGE + ' loaded; ran over ' + verdicts.filter(v => v.officialRan).length + ' format-v0 log(s)\n'))
if (inventory !== undefined) {
  process.stdout.write('v0 inventory       : ' + inventory.typeCount + ' types, frozen=' + inventory.frozen
    + ', list-matches-dispositions=' + inventory.consistent + '\n')
  if (!inventory.frozen || !inventory.consistent) {
    process.stdout.write('\n  WARNING: the frozen v0 inventory in this install has been modified.\n'
      + '  Do NOT use a patched inventory to rewrite logs: accepting an event type the\n'
      + '  current build does not understand makes logs readable but turns the failure\n'
      + '  into silent write loss instead of a clear refusal. Reinstall the package.\n')
  }
}
process.stdout.write('\n')
process.stdout.write('gates hit, by session count:\n')
if (tally.size === 0) process.stdout.write('  (none)\n')
for (const [id, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  const provenance = id.startsWith('v0-') ? '  (official validator)' : ''
  process.stdout.write('  ' + String(count).padStart(3) + '  ' + id + provenance + '\n')
}
if (blocked.length > 0) {
  process.stdout.write('\nfirst blocked sessions:\n')
  for (const v of blocked.slice(0, 8)) {
    process.stdout.write('  ' + (v.id || '?') + '  v' + v.formatVersion + '  preset=' + (v.preset || '?') + '\n')
    for (const f of v.findings) {
      process.stdout.write('      ' + f.id + ' x' + f.events + '  ' + JSON.stringify(f.samples[0] ?? {}).slice(0, 110) + '\n')
    }
  }
}
