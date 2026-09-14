/**
 * The migration gates that turn one bad row into an unreadable session, plus
 * the wrapper that reports them.
 *
 * Each gate is a pure predicate over one parsed log event. They mirror the
 * validators the migration chain actually runs, which is the only reason a
 * scan can predict what the loader will refuse. Every predicate names the
 * file:line it was read from, so a reader can re-check it against a release.
 *
 * A predicate that is broader than the real validator produces false positives,
 * and a false positive here tells someone their history is broken when it is
 * not. Where a validator targets specific event types, the predicate must
 * target exactly those types.
 *
 * @module dsh-session-repair/gates
 */

/**
 * Message source kinds the v2 to v3 migration accepts.
 * Mirrors SOURCE_KINDS in dsh-session-format-v2-to-v3/lib/index.js:14.
 */
export const SOURCE_KINDS = new Set([
  'user', 'plugin', 'model', 'tool', 'agent-instructions', 'session-reference',
  'team-message', 'goal', 'skill-invocation', 'skill-catalog', 'coordinator',
  'subagent-report', 'subagent-settled', 'webhook', 'agent-message',
])

/**
 * Events whose sources the source validator inspects, and where that source
 * sits inside them.
 * Mirrors the call sites at dsh-session-format-v2-to-v3/lib/index.js:98-107.
 */
const SOURCE_SITES = [
  { event: 'user/message', path: ['source'] },
  { event: 'assistant/message', path: ['message', 'source'] },
  { event: 'tool/result', path: ['message', 'source'] },
  { event: 'agent/inbox/spliced', path: ['inserted', '*', 'source'] },
  { event: 'session/title-llm-request', path: ['messages', '*', 'source'] },
]

/**
 * Collect the message sources one event exposes to the source validator.
 *
 * This is deliberately not a deep walk: a deep walk also finds
 * session/title.data.source.kind, which is how a title was produced (fallback
 * or model) and which the validator never sees. Reporting that as a violation
 * is a false positive.
 * @param event - one parsed log event.
 * @returns the source objects this event contributes, possibly empty.
 */
export function messageSources(event) {
  if (event === null || typeof event !== 'object') return []
  const data = event.data
  if (data === null || typeof data !== 'object') return []
  const site = SOURCE_SITES.find(s => s.event === event.type)
  if (site === undefined) return []
  const out = []
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (path.length === 0) { out.push(node); return }
    const [head, ...rest] = path
    if (head === '*') {
      if (!Array.isArray(node)) return
      for (const item of node) walk(item, rest)
      return
    }
    walk(node[head], rest)
  }
  walk(data, site.path)
  return out
}

/**
 * Gate 1: a retired message source kind.
 *
 * assertSource() throws when the kind is absent from SOURCE_KINDS
 * (dsh-session-format-v2-to-v3/lib/index.js:123-125). A renamed kind carries
 * the same key set, so the repair is a rename rather than a rewrite.
 * @param event - one parsed log event.
 * @returns the offending kind, or undefined.
 */
export function retiredSourceKind(event) {
  for (const source of messageSources(event)) {
    const kind = source.kind
    if (typeof kind === 'string' && !SOURCE_KINDS.has(kind)) return kind
  }
  return undefined
}

/**
 * Gate 2: a subagent descriptor whose version predates the current one.
 *
 * The v0 pass throws for any version other than 3
 * (dsh-session-format-v0-to-v1/lib/index.js:1586), while the runtime consumer
 * ignores such a descriptor outright (dsh-subagent/lib/index.js:1359). The
 * migration is stricter than the code that reads the value it validates.
 * @param event - one parsed log event.
 * @returns the offending version, or undefined.
 */
export function staleDescriptorVersion(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type !== 'subagent/descriptor') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (data.version === 3) return undefined
  return data.version
}

/** Keys messageValue requires, exactly, on an inserted inbox message. */
export const INSERTED_MESSAGE_KEYS = ['id', 'role', 'content', 'source']

/**
 * Gate 3: an inserted inbox message missing a key the validator demands.
 *
 * messageValue (dsh-session-format-v0-to-v1/lib/index.js:715) requires exactly
 * id, role, content and source. The call site at :283 already passes the
 * expected role, so the validator knows the answer it refuses to accept.
 * @param event - one parsed log event.
 * @returns the missing key names, or undefined.
 */
export function incompleteInsertedMessage(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type !== 'agent/inbox/spliced') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (!Array.isArray(data.inserted)) return undefined
  const missing = []
  for (const message of data.inserted) {
    if (message === null || typeof message !== 'object') { missing.push('(not an object)'); continue }
    for (const key of INSERTED_MESSAGE_KEYS) {
      if (message[key] === undefined) missing.push(key)
    }
  }
  return missing.length > 0 ? [...new Set(missing)] : undefined
}

/** One check per gate, in the order the migration chain runs them. */
export const GATES = [
  { id: 'retired-source-kind', label: 'retired message source kind (v2 to v3)', find: retiredSourceKind },
  { id: 'stale-descriptor', label: 'subagent descriptor version is not 3 (v0 to v1)', find: staleDescriptorVersion },
  { id: 'incomplete-inserted', label: 'inserted inbox message missing id/role (v0 to v1)', find: incompleteInsertedMessage },
]
