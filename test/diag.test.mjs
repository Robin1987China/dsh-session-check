/**
 * The read-only boot diagnostic.
 *
 * It must report where a person can see it, stay quiet when there is nothing to
 * report, and never throw into start-up — a diagnostic that can break a boot is
 * worse than no diagnostic.
 *
 * The stderr assertion is deliberate. `ctx.logger` alone is not visible in the
 * shipped composition (Cordis's default logger service exports to an in-memory
 * ring buffer and no shipped package registers a console sink), so a test that
 * only asserted the logger call would pass while the row reported nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/diag.mjs'

/** A context whose `inject` fires immediately with a fake storage domain. */
function fakeContext(records, { provideDomain = true } = {}) {
  const logs = []
  const table = {
    size: records.length,
    entries: () => records.map((record, index) => [String(index), record]).values(),
  }
  const domain = { table: () => table }
  const scope = {
    storageDomain: { get: () => (provideDomain ? domain : undefined) },
    logger: { debug: message => logs.push(['debug', message]), info: message => logs.push(['info', message]) },
  }
  const ctx = { inject: (_services, callback) => callback(scope) }
  return { ctx, logs }
}

/** Capture everything the plugin writes to stderr during `body`. */
function captureStderr(body) {
  const original = process.stderr.write
  let captured = ''
  process.stderr.write = chunk => { captured += String(chunk); return true }
  try {
    body()
  } finally {
    process.stderr.write = original
  }
  return captured
}

const bigRecord = () => ({ rows: { titleInput: { ver: 3, seq: 1, val: { first: { seq: 1, text: 'H' + 'A'.repeat(3 * 1024 * 1024) } } } } })
const smallRecord = () => ({ rows: { titleInput: { ver: 3, seq: 1, val: { first: { seq: 1, text: 'short' } } } } })

test('an oversized titleInput is reported on stderr with the reclaim estimate', () => {
  const { ctx, logs } = fakeContext([bigRecord(), smallRecord()])
  const stderr = captureStderr(() => apply(ctx))
  assert.match(stderr, /projection cache: 3\.0 MB reclaimable/)
  // Both records carry a titleInput text; only one is oversized enough to clamp.
  assert.match(stderr, /2 of 2 records store a titleInput text/)
  assert.match(stderr, /npx -y -p dsh-session-check dsh-projcache survey/)
  // The logger is also called, for deployments that do wire a sink.
  assert.equal(logs.some(([level]) => level === 'info'), true)
})

test('nothing is written to stderr when there is nothing worth reporting', () => {
  const { ctx } = fakeContext([smallRecord()])
  const stderr = captureStderr(() => apply(ctx))
  assert.equal(stderr, '')
})

test('a profile without the projection-cache domain reports nothing and does not throw', () => {
  const { ctx } = fakeContext([bigRecord()], { provideDomain: false })
  const stderr = captureStderr(() => apply(ctx))
  assert.equal(stderr, '')
})

test('a table that throws during iteration cannot break start-up', () => {
  const { ctx } = fakeContext([bigRecord()])
  const broken = {
    storageDomain: { get: () => ({ table: () => ({ get size() { throw new Error('boom') }, entries: () => [].values() }) }) },
    logger: { debug: () => {}, info: () => {} },
  }
  const throwing = { inject: (_services, callback) => callback(broken) }
  const stderr = captureStderr(() => apply(throwing))
  assert.equal(stderr, '')
})

test('a missing logger does not prevent the stderr report', () => {
  // A scope with no `logger` property at all. `entries()` yields `[key, value]`
  // pairs, exactly like `KvTable.entries()`.
  const table = { size: 1, entries: () => [['id', bigRecord()]].values() }
  const scope = { storageDomain: { get: () => ({ table: () => table }) } }
  const stderr = captureStderr(() => apply({ inject: (_services, callback) => callback(scope) }))
  assert.match(stderr, /reclaimable/)
})

test('the clamp budget is configurable from the row config', () => {
  const { ctx } = fakeContext([{ rows: { titleInput: { ver: 3, seq: 1, val: { first: { seq: 1, text: 'A'.repeat(2 * 1024 * 1024) } } } } }])
  const stderr = captureStderr(() => apply(ctx, { clampBytes: 1024, minReportBytes: 0 }))
  assert.match(stderr, /first 1024 bytes/)
})
