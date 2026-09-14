/**
 * Gate behaviour, exercised on synthetic events.
 *
 * The load-bearing case is the negative one: a false positive tells someone
 * their history is broken when it is not, so every test that asserts a hit is
 * paired with a shape that must stay clean.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GATES, retiredSourceKind, staleDescriptorVersion, incompleteInsertedMessage, messageSources } from '../src/gates.mjs'

const at = id => GATES.find(g => g.id === id).find

test('a retired kind on a message event is reported', () => {
  const event = { type: 'user/message', seq: 4, data: { source: { kind: 'instruction-hint', plugin: 'x' } } }
  assert.equal(at('retired-source-kind')(event), 'instruction-hint')
})

test('an accepted kind on a message event is not reported', () => {
  const event = { type: 'user/message', seq: 4, data: { source: { kind: 'user', rpcId: 'r' } } }
  assert.equal(at('retired-source-kind')(event), undefined)
})

test('a title source kind is NOT treated as a message source', () => {
  // session/title.data.source.kind records how the title was produced
  // (fallback or model). assertSource never sees it, so reporting it here
  // would be a false positive that condemns a healthy session.
  const event = { type: 'session/title', seq: 12, data: { title: 't', source: { kind: 'fallback' } } }
  assert.deepEqual(messageSources(event), [])
  assert.equal(at('retired-source-kind')(event), undefined)
})

test('sources are read from the exact sites the validator inspects', () => {
  assert.equal(messageSources({ type: 'user/message', data: { source: { kind: 'user' } } }).length, 1)
  assert.equal(messageSources({ type: 'assistant/message', data: { message: { source: { kind: 'model' } } } }).length, 1)
  assert.equal(messageSources({ type: 'tool/result', data: { message: { source: { kind: 'tool' } } } }).length, 1)
  assert.equal(messageSources({ type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user' } }, { source: { kind: 'plugin' } }] } }).length, 2)
  assert.equal(messageSources({ type: 'session/title-llm-request', data: { messages: [{ source: { kind: 'plugin' } }] } }).length, 1)
})

test('a descriptor pinned to an older version is reported', () => {
  assert.equal(at('stale-descriptor')({ type: 'subagent/descriptor', seq: 0, data: { version: 2 } }), 2)
})

test('a current descriptor version is not reported', () => {
  assert.equal(at('stale-descriptor')({ type: 'subagent/descriptor', seq: 0, data: { version: 3 } }), undefined)
})

test('an inserted message missing keys is reported with the missing names', () => {
  const event = { type: 'agent/inbox/spliced', seq: 5, data: { inserted: [{ content: [], source: { kind: 'user' } }] } }
  assert.deepEqual(at('incomplete-inserted')(event), ['id', 'role'])
})

test('a complete inserted message is not reported', () => {
  const event = { type: 'agent/inbox/spliced', seq: 5, data: { inserted: [{ id: 'i', role: 'user', content: [], source: { kind: 'user' } }] } }
  assert.equal(at('incomplete-inserted')(event), undefined)
})

test('a spliced event with an empty inserted list is not reported', () => {
  assert.equal(at('incomplete-inserted')({ type: 'agent/inbox/spliced', seq: 7, data: { inserted: [] } }), undefined)
})

test('every gate tolerates a malformed event without throwing', () => {
  for (const gate of GATES) {
    for (const event of [null, {}, { type: 'x' }, { type: 'x', data: null }, { type: 'x', data: 5 }]) {
      assert.doesNotThrow(() => gate.find(event))
    }
  }
})
