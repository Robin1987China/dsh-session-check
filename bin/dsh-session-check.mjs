#!/usr/bin/env node
/**
 * dsh-session-check — read-only diagnosis of stored session logs.
 *
 * Reports which sessions the format migration will refuse, and which gate
 * refuses each one, without writing anything.
 *
 *   dsh-session-check scan <sessions-dir>
 *
 * There is deliberately no repair subcommand. Rewriting a session log is a
 * destructive operation; a tool earns the right to perform one by first
 * proving it can see the problem without touching anything.
 */
import { scanRoot } from '../src/scan.mjs'

const [, , command, target] = process.argv

if (command !== 'scan' || target === undefined) {
  process.stdout.write([
    'usage: dsh-session-check scan <sessions-dir>',
    '',
    '  scan   Read-only. Reports every stored session log and the migration',
    '         gates it fails. Writes nothing.',
    '',
    'The directory is usually $DSH_HOME/sessions (~/.dsh/sessions by default).',
    '',
  ].join('\n'))
  process.exit(2)
}

const root = target.replace(/^~/, process.env.HOME ?? '~')
const verdicts = scanRoot(root, (v, i, n) => {
  process.stdout.write('  [' + i + '/' + n + '] ' + (v.blocked ? 'BLOCKED' : 'ok     ')
    + ' ' + (v.id || v.path.split('/').slice(-2)[0]).slice(0, 40) + '\n')
})

const blocked = verdicts.filter(v => v.blocked)
const tally = new Map()
for (const v of blocked) for (const f of v.findings) tally.set(f.id, (tally.get(f.id) ?? 0) + 1)

process.stdout.write('\n')
process.stdout.write('sessions scanned   : ' + verdicts.length + '\n')
process.stdout.write('loader would refuse: ' + blocked.length + '\n')
process.stdout.write('packed chunk runs  : ' + verdicts.reduce((a, v) => a + v.packedRuns, 0) + ' (not session events)\n')
process.stdout.write('format versions    : ' + JSON.stringify(
  verdicts.reduce((a, v) => { a[String(v.formatVersion)] = (a[String(v.formatVersion)] ?? 0) + 1; return a }, {})) + '\n')
process.stdout.write('\n')
process.stdout.write('gates hit, by session count:\n')
if (tally.size === 0) process.stdout.write('  (none)\n')
for (const [id, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  process.stdout.write('  ' + String(count).padStart(3) + '  ' + id + '\n')
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
