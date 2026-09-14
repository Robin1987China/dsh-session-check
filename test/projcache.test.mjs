/**
 * Projection-cache maintenance behaviour.
 *
 * The load-bearing cases are the destructive ones, so every write test is
 * paired with the case that must NOT write:
 *
 * - a session whose log is present in ANY accepted name must never be reaped
 *   (a missed log name turns a live record into a "provable" orphan), and
 * - a clamp that would change the derived fallback title must be skipped rather
 *   than applied.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CLAMP_BYTES,
  fallbackSessionTitle,
  maintain,
  parseRecordDocument,
  serializeRecordDocument,
  sessionLogIds,
  survey,
  truncateTitleUtf8,
} from '../src/projcache.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'projcache-'))

/** Build one store root with a sessions table and one sessions root. */
function fixture() {
  const root = dir()
  const storeRoot = join(root, 'storages')
  const sessionsRoot = join(root, 'sessions')
  const table = join(storeRoot, 'session_projcache', 'sessions')
  mkdirSync(table, { recursive: true })
  mkdirSync(sessionsRoot, { recursive: true })
  return { root, storeRoot, sessionsRoot, table }
}

/** Write one session log under the workspace/session-dir layout. */
function writeLog(sessionsRoot, id, name = 'session.v3.jsonl.zstd') {
  const sessionDir = join(sessionsRoot, '--workspace--', id)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, name), '')
}

/** Write one projection-cache record as the harness would serialize it. */
function writeRecord(table, id, rows, version = 7, options = {}) {
  const record = { identity: { formatVersion: 3, createdAt: 1, cwd: '/w', isSeeded: false, inheritedEventCount: 0 }, rows }
  const content = serializeRecordDocument(version, record)
  writeFileSync(join(table, `${id}.json`), options.text ?? content)
  return content
}

/** One `titleInput` row holding `text`. */
function titleInputRow(text, { ver = 3, seq = 6, count = 1, lastSeq = 4, firstSeq = 4 } = {}) {
  return { ver, seq, val: { first: { seq: firstSeq, text }, count, lastSeq } }
}

test('truncateTitleUtf8 keeps whole code points within the byte budget', () => {
  assert.equal(truncateTitleUtf8('abcdef', 3), 'abc')
  // A 3-byte code point cannot fit in 2 remaining bytes.
  assert.equal(truncateTitleUtf8('a\u00e9\u00e9', 3), 'a\u00e9')
  // Never splits the 4-byte emoji.
  assert.equal(truncateTitleUtf8('\u{1F600}\u{1F600}', 5), '\u{1F600}')
  // Under budget is returned unchanged, and the byte budget is bytes, not chars.
  assert.equal(truncateTitleUtf8('\u{1F600}', 4), '\u{1F600}')
  assert.equal(truncateTitleUtf8('\u{1F600}', 3), '')
})

test('session log names: every accepted name keeps its session live', () => {
  const { sessionsRoot } = fixture()
  writeLog(sessionsRoot, 'a', 'session.jsonl.zstd')
  writeLog(sessionsRoot, 'b', 'session.v3.jsonl.zstd')
  writeLog(sessionsRoot, 'c', 'session.v3.jsonl')
  const ids = sessionLogIds(sessionsRoot)
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c'])
})

test('a record whose session log is present is NOT an orphan', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  writeRecord(table, 'live', { titleInput: titleInputRow('hello') })
  const report = survey({ storeRoot, sessionsRoot })
  assert.equal(report.orphans.length, 0)
  assert.equal(report.liveLogs.count, 1)
  assert.equal(report.liveLogs.returned, 1)
})

test('a record whose session log is gone IS an orphan, and names the bytes', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  writeRecord(table, 'live', { titleInput: titleInputRow('hello') })
  const orphanText = writeRecord(table, 'gone', { titleInput: titleInputRow('hello') })
  const report = survey({ storeRoot, sessionsRoot })
  assert.deepEqual(report.orphans.map(o => o.id), ['gone'])
  assert.equal(report.orphanBytes, Buffer.byteLength(orphanText))
})

test('survey refuses to write when the sessions root holds no log at all', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeRecord(table, 'a', { titleInput: titleInputRow('hello') })
  writeRecord(table, 'b', { titleInput: titleInputRow('hello') })
  const report = survey({ storeRoot, sessionsRoot })
  assert.equal(report.orphans.length, 2)
  assert.equal(report.guards.ok, false)
  assert.match(report.guards.reasons.join('\n'), /no stored session log was found/)
})

test('survey refuses a missing sessions root', () => {
  const { storeRoot, root, table } = fixture()
  writeRecord(table, 'a', { titleInput: titleInputRow('hello') })
  const report = survey({ storeRoot, sessionsRoot: join(root, 'nope') })
  assert.equal(report.guards.ok, false)
  assert.match(report.guards.reasons.join('\n'), /does not exist/)
})

test('the orphan-share guard blocks a mass reap, and --force overrides it', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  writeRecord(table, 'live', {})
  for (let index = 0; index < 9; index += 1) writeRecord(table, `gone-${index}`, {})
  const guarded = survey({ storeRoot, sessionsRoot })
  assert.equal(guarded.guards.ok, false)
  assert.match(guarded.guards.reasons.join('\n'), /above the 50\.0% limit/)
  assert.equal(survey({ storeRoot, sessionsRoot, force: true }).guards.ok, true)
})

test('the fidelity gate refuses to write a document it cannot reproduce', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  // Same content, different serialization (compact): the backend's format moved.
  const compact = JSON.stringify({
    version: 7,
    record: { identity: {}, rows: { titleInput: titleInputRow('x'.repeat(9000)) } },
  })
  writeRecord(table, 'live', {}, 7, { text: compact })
  const report = survey({ storeRoot, sessionsRoot })
  assert.equal(report.fidelity.mismatches.length, 1)
  assert.equal(report.guards.ok, false)
  assert.match(report.guards.reasons.join('\n'), /round-trip byte-for-byte/)
  const applied = maintain({ storeRoot, sessionsRoot })
  assert.equal(applied.applied, false)
  assert.equal(readFileSync(join(table, 'live.json'), 'utf8'), compact)
})

test('maintain reaps an orphan with a backup and clamps an oversized prefix', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  const big = 'HEAD' + 'A'.repeat(20000) + '-TAIL'
  writeRecord(table, 'live', { titleInput: titleInputRow(big), other: { ver: 1, seq: 2, val: { keep: 'me' } } })
  const orphanBefore = writeRecord(table, 'gone', { titleInput: titleInputRow('small') })

  const result = maintain({ storeRoot, sessionsRoot, clampBytes: DEFAULT_CLAMP_BYTES })
  assert.equal(result.guards.ok, true)
  assert.equal(result.applied, true)
  assert.deepEqual(result.reaped.map(r => r.id), ['gone'])
  assert.deepEqual(result.clamped.map(c => c.id), ['live'])
  assert.deepEqual(result.errors, [])

  // The orphan file is gone; its backup holds the original bytes.
  assert.equal(readdirSync(table).includes('gone.json'), false)
  assert.equal(readFileSync(result.reaped[0].backup, 'utf8'), orphanBefore)

  // The clamp preserved everything it promised to.
  const after = parseRecordDocument(readFileSync(join(table, 'live.json'), 'utf8'))
  const row = after.record.rows.titleInput
  assert.equal(row.val.first.text.length, DEFAULT_CLAMP_BYTES)
  assert.equal(row.ver, 3)
  assert.equal(row.seq, 6)
  assert.equal(row.val.count, 1)
  assert.equal(row.val.lastSeq, 4)
  assert.equal(row.val.first.seq, 4)
  assert.equal(row.val.first.text.startsWith('HEAD'), true)
  assert.deepEqual(after.record.rows.other, { ver: 1, seq: 2, val: { keep: 'me' } })
  assert.equal(result.verified.every(v => v.ok), true)
})

test('the clamp preserves every byte outside the titleInput text', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  const rows = {
    title: { ver: 1, seq: 6, val: 'the title' },
    titleInput: titleInputRow('HEAD' + 'B'.repeat(9000)),
    turnOutline: { ver: 2, seq: 6, val: { previews: ['a', 'b'] } },
  }
  writeRecord(table, 'live', rows)
  maintain({ storeRoot, sessionsRoot, clampBytes: 128 })
  const after = parseRecordDocument(readFileSync(join(table, 'live.json'), 'utf8'))
  assert.deepEqual(after.record.rows.title, rows.title)
  assert.deepEqual(after.record.rows.turnOutline, rows.turnOutline)
  assert.deepEqual(after.record.identity, {
    formatVersion: 3, createdAt: 1, cwd: '/w', isSeeded: false, inheritedEventCount: 0,
  })
  assert.equal(after.record.rows.titleInput.val.first.text, 'HEAD' + 'B'.repeat(124))
})

test('a clamp that would change the derived fallback title is SKIPPED', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  // With a whitespace run wider than the clamp budget, a raw prefix cut drops
  // the second word; the fallback for this text genuinely would change.
  const text = 'alpha' + ' '.repeat(4000) + 'beta'
  assert.equal(fallbackSessionTitle(text, 5, 40), 'alpha beta')
  assert.equal(fallbackSessionTitle(truncateTitleUtf8(text, 1024), 5, 40), 'alpha')
  const original = writeRecord(table, 'live', { titleInput: titleInputRow(text) })

  const report = survey({ storeRoot, sessionsRoot, clampBytes: 1024 })
  assert.equal(report.clamps.length, 1)
  assert.equal(report.clamps[0].invariantOk, false)
  assert.equal(report.guards.ok, false)

  const result = maintain({ storeRoot, sessionsRoot, clampBytes: 1024 })
  assert.equal(result.applied, false)
  assert.equal(readFileSync(join(table, 'live.json'), 'utf8'), original)
})

test('a record with no titleInput text is left alone', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  const original = writeRecord(table, 'live', { titleInput: { ver: 3, seq: 6, val: { first: null, count: 0, lastSeq: null } } })
  const result = maintain({ storeRoot, sessionsRoot })
  assert.deepEqual(result.clamps, [])
  assert.equal(readFileSync(join(table, 'live.json'), 'utf8'), original)
  assert.equal(result.clamped.length, 0)
})

test('an unreadable record is reported and never touched', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  const broken = '{ not json'
  writeFileSync(join(table, 'broken.json'), broken)
  const report = survey({ storeRoot, sessionsRoot })
  assert.deepEqual(report.unreadable.map(u => u.id), ['broken'])
  assert.equal(report.orphans.some(o => o.id === 'broken'), false)
  maintain({ storeRoot, sessionsRoot })
  assert.equal(readFileSync(join(table, 'broken.json'), 'utf8'), broken)
})

test('survey writes nothing at all', () => {
  const { storeRoot, sessionsRoot, table } = fixture()
  writeLog(sessionsRoot, 'live')
  writeRecord(table, 'live', { titleInput: titleInputRow('A'.repeat(9000)) })
  writeRecord(table, 'gone', { titleInput: titleInputRow('A'.repeat(9000)) })
  const before = readdirSync(table).sort().map(name => [name, statSync(join(table, name)).mtimeMs, readFileSync(join(table, name), 'utf8')])
  survey({ storeRoot, sessionsRoot })
  const after = readdirSync(table).sort().map(name => [name, statSync(join(table, name)).mtimeMs, readFileSync(join(table, name), 'utf8')])
  assert.deepEqual(after, before)
})
