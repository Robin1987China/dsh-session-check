/**
 * The validator-backed v0 gates.
 *
 * Two behaviours carry the weight:
 *
 * - a `subagent/descriptor` refusal must be attributed to the existing
 *   `stale-descriptor` gate and then DROPPED here, because reporting it twice
 *   doubles every tally and makes a corpus look twice as broken as it is; and
 * - a refusal this module cannot classify must still be reported, never
 *   silently swallowed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyReleasedFailure,
  inventoryReport,
  UNCLASSIFIED,
  UNKNOWN_EVENT_TYPE,
  UNKNOWN_PAYLOAD_MEMBER,
  validateEvents,
} from '../src/released.mjs'

const UNKNOWN_TYPE_MESSAGE = 'format v0 contains unknown historical event type "notice/banner" at seq 303; '
  + 'migration refuses unknown historical events even when ignorable'
const UNKNOWN_MEMBER_MESSAGE = 'permission/preset 12 data has unexpected member "origin"'
const DESCRIPTOR_MESSAGE = 'subagent/descriptor 0 uses unsupported descriptor version 2'

/** A module whose validator throws `messages[event.type]` when one is set. */
function fakeValidator(messages) {
  return {
    assertReleasedEventPayload: (event) => {
      const message = messages[event.type]
      if (message !== undefined) throw Object.assign(new Error(message), { name: 'SessionFormatError' })
    },
  }
}

test('each official refusal maps to its gate id', () => {
  assert.equal(classifyReleasedFailure(new Error(UNKNOWN_TYPE_MESSAGE)).id, UNKNOWN_EVENT_TYPE)
  assert.equal(classifyReleasedFailure(new Error(UNKNOWN_MEMBER_MESSAGE)).id, UNKNOWN_PAYLOAD_MEMBER)
  assert.equal(classifyReleasedFailure(new Error(DESCRIPTOR_MESSAGE)).id, 'stale-descriptor')
  assert.equal(classifyReleasedFailure(new Error('something else entirely')).id, UNCLASSIFIED)
})

test('an unknown event type is reported with the official message', () => {
  const events = [{ type: 'notice/banner', seq: 303, data: {}, ignorable: true }]
  const findings = validateEvents(fakeValidator({ 'notice/banner': UNKNOWN_TYPE_MESSAGE }), events)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].id, UNKNOWN_EVENT_TYPE)
  assert.equal(findings[0].events, 1)
  assert.equal(findings[0].official, true)
  assert.equal(findings[0].samples[0].seq, 303)
  // The refusal stands even though the event declares itself ignorable — that
  // is the whole point of the v0 edge, and the message says so.
  assert.match(findings[0].samples[0].detail, /even when ignorable/)
})

test('an unknown payload member is reported separately from an unknown type', () => {
  const events = [
    { type: 'permission/preset', seq: 12, data: { preset: 'x', origin: 'default' } },
    { type: 'permission/preset', seq: 13, data: { preset: 'y' } },
  ]
  const findings = validateEvents(fakeValidator({}), events)
  assert.deepEqual(findings, [])
  const withOrigin = validateEvents(
    {
      assertReleasedEventPayload: (event) => {
        if (Object.hasOwn(event.data, 'origin')) throw new Error(UNKNOWN_MEMBER_MESSAGE)
      },
    },
    events,
  )
  assert.equal(withOrigin.length, 1)
  assert.equal(withOrigin[0].id, UNKNOWN_PAYLOAD_MEMBER)
  assert.equal(withOrigin[0].events, 1, 'the clean event must not be counted')
})

test('a descriptor refusal is attributed to the existing gate and not counted twice', () => {
  const events = [{ type: 'subagent/descriptor', seq: 0, data: {} }]
  const findings = validateEvents(fakeValidator({ 'subagent/descriptor': DESCRIPTOR_MESSAGE }), events)
  assert.deepEqual(findings, [], 'stale-descriptor is the existing mirror gate\'s job')
})

test('a clean log produces no findings', () => {
  assert.deepEqual(validateEvents(fakeValidator({}), [
    { type: 'turn/start', seq: 0, data: {} },
    { type: 'turn/end', seq: 1, data: {} },
  ]), [])
})

test('repeated identical refusals collapse to one finding with distinct samples', () => {
  const events = Array.from({ length: 500 }, (_, index) => ({ type: 'x/unknown', seq: index, data: {} }))
  const findings = validateEvents(fakeValidator({ 'x/unknown': UNKNOWN_TYPE_MESSAGE }), events)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].events, 500, 'the count is still exact')
  assert.equal(findings[0].samples.length, 1, 'but the sample list does not repeat itself')
})

test('an unclassifiable refusal is reported, not swallowed', () => {
  const events = [{ type: 'weird/type', seq: 4, data: {} }]
  const findings = validateEvents(fakeValidator({ 'weird/type': 'validator said no for its own reasons' }), events)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].id, UNCLASSIFIED)
  assert.match(findings[0].samples[0].detail, /its own reasons/)
})

test('a module without the validator function reports nothing instead of throwing', () => {
  assert.deepEqual(validateEvents({}, [{ type: 'a', seq: 0, data: {} }]), [])
  assert.deepEqual(validateEvents(undefined, [{ type: 'a', seq: 0, data: {} }]), [])
})

test('inventoryReport exposes the shape that reveals a hand-patched inventory', () => {
  const types = ['turn/start', 'turn/end']
  const frozen = Object.freeze({ 'turn/start': {}, 'turn/end': {} })
  const report = inventoryReport({ RELEASED_V0_EVENT_DISPOSITIONS: frozen, RELEASED_V0_EVENT_TYPES: types })
  assert.deepEqual(report, { dispositionCount: 2, typeCount: 2, frozen: true, consistent: true })

  // A patcher who adds a type to the dispositions but not to the derived list.
  const patched = { ...frozen, 'notice/banner': {} }
  const patchedReport = inventoryReport({
    RELEASED_V0_EVENT_DISPOSITIONS: patched,
    RELEASED_V0_EVENT_TYPES: types,
  })
  assert.equal(patchedReport.frozen, false)
  assert.equal(patchedReport.consistent, false)
})

test('inventoryReport is absent when the module does not expose the inventory', () => {
  assert.equal(inventoryReport({}), undefined)
  assert.equal(inventoryReport(undefined), undefined)
})
