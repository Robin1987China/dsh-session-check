/**
 * Validator-backed v0 gates.
 *
 * The other gates in this package are *mirrors*: they re-implement one decision
 * each and cite the `file:line` they were read from, because an offline scan
 * must run without the harness installed. These two are not mirrors. They call
 * the decision itself.
 *
 * `@deepseek-ai/dsh-session-format-v0-to-v1` exports
 * `assertReleasedEventPayload(event, version)`, which is the function the
 * v0→v1 migration runs over every event. It refuses:
 *
 * - a `type` outside the frozen v0 inventory (`RELEASED_V0_EVENT_DISPOSITIONS`,
 *   51 types in 0.1.5-rc.1), with
 *   `format v0 contains unknown historical event type "X" at seq N; migration
 *   refuses unknown historical events even when ignorable`, and
 * - a `data` member outside that type's declared `required` + `optional` set,
 *   with `X N data has unexpected member "Y"`.
 *
 * A mirror of the first rule would need the 51-type list copied into this
 * package, and a stale copy produces false positives -- the one failure this
 * tool must never have. Calling the exported function cannot go stale.
 *
 * What it deliberately does NOT report: a `subagent/descriptor` whose version
 * is not 3. The validator refuses that too, under the existing
 * `stale-descriptor` gate, and reporting it twice would double every tally and
 * make a corpus look twice as broken as it is.
 *
 * @module dsh-session-check/released
 */
import { createRequire } from 'node:module'

/** The package holding the authority, and the version its inventory was read at. */
export const RELEASED_PACKAGE = '@deepseek-ai/dsh-session-format-v0-to-v1'

/** Gate ids this module can emit. */
export const BUILTIN_GATE_ID = 'stale-descriptor'

/** Gate id emitted for an event whose type is outside the frozen v0 inventory. */
export const UNKNOWN_EVENT_TYPE = 'v0-unknown-event-type'
/** Gate id emitted for a `data` member the type's v0 disposition does not declare. */
export const UNKNOWN_PAYLOAD_MEMBER = 'v0-unknown-payload-member'
/** Gate id emitted for a refusal this module cannot classify. Never silently dropped. */
export const UNCLASSIFIED = 'v0-unclassified'

const LABELS = {
  [UNKNOWN_EVENT_TYPE]: 'an event type outside the frozen v0 inventory',
  [UNKNOWN_PAYLOAD_MEMBER]: 'a payload member the v0 disposition does not declare',
  [UNCLASSIFIED]: 'refused by the official validator for another reason',
}

/**
 * Load the official validator.
 *
 * Resolution failure is returned, never thrown: this package must keep working
 * where the harness is not installed, and a scan that silently reported "no
 * problems" because it could not load its authority would be worse than one
 * that says so.
 * @returns the module, or the reason it is unavailable.
 */
export async function loadReleasedValidator() {
  try {
    const require = createRequire(import.meta.url)
    return { module: require(RELEASED_PACKAGE), reason: undefined }
  } catch (error) {
    // Fall back to a plain dynamic import: the package may be ESM-only in a
    // future release, which `require` cannot load.
    try {
      return { module: await import(RELEASED_PACKAGE), reason: undefined }
    } catch {
      return { module: undefined, reason: `${RELEASED_PACKAGE} is not installed (${error.code ?? 'unresolved'})` }
    }
  }
}

/**
 * Describe the inventory the validator is actually using.
 *
 * This is the practical form of the "never hand-patch the frozen v0 inventory"
 * warning: the release freezes the dispositions object
 * (`Object.freeze(RELEASED_V0_EVENT_DISPOSITIONS)`) and derives the type list
 * from it, so a modified inventory is detectable without keeping a copy of the
 * 51 names here -- which would go stale and cry wolf.
 * @param module - the official validator module.
 * @returns the resolved inventory's shape, or `undefined` when it is absent.
 */
export function inventoryReport(module) {
  const dispositions = module?.RELEASED_V0_EVENT_DISPOSITIONS
  const types = module?.RELEASED_V0_EVENT_TYPES
  if (dispositions === undefined || types === undefined) return undefined
  const compare = (left, right) => left.localeCompare(right, 'en')
  const keys = Object.keys(dispositions)
  const derived = [...keys].sort(compare)
  // Compared as SETS, not sequences: the release sorts its list, but a future
  // release legitimately might not, and a warning that cries wolf on a sort
  // change is worse than no warning. Only a genuine derivation mismatch counts.
  const declared = Array.isArray(types) ? [...types].sort(compare) : undefined
  return {
    dispositionCount: keys.length,
    typeCount: Array.isArray(types) ? types.length : null,
    frozen: Object.isFrozen(dispositions),
    // A patcher who adds a type to one of the two must add it to the other; a
    // mismatch means the inventory was edited.
    consistent: declared !== undefined
      && derived.length === declared.length
      && derived.every((type, index) => type === declared[index]),
  }
}

/**
 * Map one official refusal onto a gate id and its concrete message.
 * @param error - the thrown validator error.
 * @returns the gate id and message.
 */
export function classifyReleasedFailure(error) {
  const message = String(error?.message ?? error)
  if (/unsupported descriptor version/u.test(message)) return { id: BUILTIN_GATE_ID, message }
  if (/contains unknown historical event type/u.test(message)) return { id: UNKNOWN_EVENT_TYPE, message }
  if (/has unexpected member/u.test(message)) return { id: UNKNOWN_PAYLOAD_MEMBER, message }
  return { id: UNCLASSIFIED, message }
}

/**
 * Run the official validator over one log's events.
 *
 * The caller must pass session events only. A packed chunk run carries
 * `seq0`/`time0` instead of `seq`, is decoded on a separate path, and feeding it
 * to the event validator invents failures that cannot happen.
 * @param module - the official validator module.
 * @param events - session events, in stored order.
 * @returns findings keyed by gate id, in the shape the other gates use.
 */
export function validateEvents(module, events) {
  const validate = module?.assertReleasedEventPayload
  if (typeof validate !== 'function') return []
  const byGate = new Map()
  for (const event of events) {
    let failure
    try {
      validate(event, 0)
      continue
    } catch (error) {
      failure = classifyReleasedFailure(error)
    }
    // The descriptor gate is the existing mirror's job; counting it here too
    // would report every affected session twice.
    if (failure.id === BUILTIN_GATE_ID) continue
    const bucket = byGate.get(failure.id) ?? { id: failure.id, label: LABELS[failure.id] ?? LABELS[UNCLASSIFIED], hits: 0, samples: [], seen: new Set() }
    bucket.hits += 1
    // One sample per distinct message: 14,000 repetitions of one payload member
    // is one finding, not 14,000 lines of output.
    if (bucket.seen.size < 3 && !bucket.seen.has(failure.message)) {
      bucket.seen.add(failure.message)
      bucket.samples.push({ seq: event.seq, type: event.type, detail: failure.message })
    }
    byGate.set(failure.id, bucket)
  }
  return [...byGate.values()].map(bucket => ({
    id: bucket.id,
    label: bucket.label,
    events: bucket.hits,
    samples: bucket.samples,
    official: true,
  }))
}
