/**
 * CLI contract: exit codes and the promise that `survey` never writes.
 *
 * A maintenance tool that can write is only safe if its default action cannot.
 * These tests pin the exit codes a script depends on and the dry-run guarantee.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeRecordDocument } from '../src/projcache.mjs'

const BIN = new URL('../bin/dsh-projcache.mjs', import.meta.url).pathname

/** Build a store with one live session and one oversized record. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'projcache-cli-'))
  const storeRoot = join(root, 'storages')
  const sessionsRoot = join(root, 'sessions')
  const table = join(storeRoot, 'session_projcache', 'sessions')
  mkdirSync(table, { recursive: true })
  mkdirSync(join(sessionsRoot, '--w--', 'live'), { recursive: true })
  writeFileSync(join(sessionsRoot, '--w--', 'live', 'session.v3.jsonl.zstd'), '')
  const record = {
    identity: { formatVersion: 3, createdAt: 1, cwd: '/w', isSeeded: false, inheritedEventCount: 0 },
    rows: { titleInput: { ver: 3, seq: 6, val: { first: { seq: 4, text: 'HEAD' + 'A'.repeat(20000) }, count: 1, lastSeq: 4 } } },
  }
  writeFileSync(join(table, 'live.json'), serializeRecordDocument(7, record))
  return { root, storeRoot, sessionsRoot, table }
}

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })

test('no command prints usage and exits 2', () => {
  const result = run([])
  assert.equal(result.status, 2)
  assert.match(result.stdout, /usage: dsh-projcache/)
})

test('an unknown option exits 2', () => {
  const result = run(['survey', '--nope'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown option/)
})

test('survey reports and writes nothing', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  const before = readdirSync(table).map(name => readFileSync(join(table, name), 'utf8'))
  const result = run(['survey', '--store', storeRoot, '--sessions', sessionsRoot])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /nothing was written/)
  assert.match(result.stdout, /1 records, 0.00 MB reclaimable by clamping|reclaimable by clamping/)
  assert.deepEqual(readdirSync(table).map(name => readFileSync(join(table, name), 'utf8')), before)
})

test('--json prints a parsable survey', () => {
  const { storeRoot, sessionsRoot } = fixture()
  const result = run(['survey', '--store', storeRoot, '--sessions', sessionsRoot, '--json'])
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.records.count, 1)
  assert.equal(report.guards.ok, true)
})

test('apply clamps and exits 0', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  const result = run(['apply', '--store', storeRoot, '--sessions', sessionsRoot])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /clamped : 1 records/)
  assert.equal(readdirSync(table).filter(name => name.includes('.bak.')).length, 1)
})

test('apply refuses an empty sessions root and exits 1 without writing', () => {
  const { storeRoot, root, table } = fixture()
  const empty = join(root, 'empty-sessions')
  mkdirSync(empty, { recursive: true })
  const before = readdirSync(table).map(name => readFileSync(join(table, name), 'utf8'))
  const result = run(['apply', '--store', storeRoot, '--sessions', empty])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /REFUSING TO WRITE/)
  assert.deepEqual(readdirSync(table).map(name => readFileSync(join(table, name), 'utf8')), before)
})

test('--force cannot override a log-free sessions root', () => {
  const { storeRoot, root, table } = fixture()
  const empty = join(root, 'empty-sessions')
  mkdirSync(empty, { recursive: true })
  const result = run(['apply', '--store', storeRoot, '--sessions', empty, '--force'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /--force cannot override this/)
  assert.equal(readdirSync(table).length, 1)
})
