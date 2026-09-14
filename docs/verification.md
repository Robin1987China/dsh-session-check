# Verification record — projection-cache maintenance

Every number below came from a real harness run in an isolated lab home
(`~/.dsh-lab`) against a real store, with a control group. Production `~/.dsh`
was never written and its contents were never read (only file counts and
directory listings, recorded in the upstream report).

Run it yourself: the fixture, the pinned profile patch, the runner, and every
raw report are listed under [Reproducing this](#reproducing-this).

## Environment

| item | value |
|---|---|
| harness | `@deepseek-ai/dsh` 0.1.5-rc.1 |
| source read for the `file:line` claims | `deepseek-harness` `aa8262ec091698bae9a6b04773a6b5b06ad4aef2` |
| node | v26.7.0 |
| model | **none** — no API key was used, and no LLM is involved in any step |
| store / sessions | pinned by the lab profile patch to scratch paths |

No LLM is needed because the phenomenon is projection state: appending one
`user/message` and calling the public `sessionProjectionCache.write(session)`
produces exactly the durable row this tool edits.

## 1. The helpers are proven equal to the shipped ones

`src/projcache.mjs` has no runtime dependencies, so it mirrors three helpers
from `dsh-session-title` and the document format from `dsh-storage-json`.
Mirrors are cross-checked against the shipped code rather than assumed:

```
helpers compared : 531 comparisons over 23 strings and 2 stored documents
mismatches       : 0
```

The corpus includes the real stored texts from the lab store plus multibyte
code points, 4-byte emoji, ANSI/OSC escapes, directional overrides, whitespace
runs, and an 8 MiB single token; budgets span `1 … 100000` bytes, and the
fallback is compared at `(5,40)`, `(5,4096)`, `(1,1)`, `(3,17)`, `(10,200)`.

The serializer's mirror is checked against **files the harness itself wrote**:
parse + re-serialize must reproduce the bytes exactly. That is the same check
the tool runs as a write gate (`src/projcache.mjs`, `survey` → `fidelity`).

## 2. The clamp is durable and behaviour-preserving

Two sessions were created through the real public API, differing only in the
first user message: 8,388,608 characters vs 65.

```
projrepro-huge   record 8,392,957 bytes | titleInput row 8,388,683 bytes = 99.95%
projrepro-small  record     4,399 bytes | titleInput row       140 bytes
                 both records carry the same 23 projection rows
```

The huge session's derived title is 43 characters, so the store retained
8.39 MB to produce 43 characters.

Measured through the three real read paths, before and after `dsh-projcache
apply` clamped the stored prefix to 4,096 bytes:

| observation | before | after |
|---|---|---|
| `viewCheckpoint(..., ['title','titleInput']).title` | `"PROJREPRO-HEAD-projrepro-huge-AAAAAAAAAA"` | **identical** |
| `viewCheckpoint` served keys | `["title"]` — `titleInput` has no `wire` view | identical |
| `restore(...).snapshot.values.title` | same string | **identical** |
| `restore(...).checkpoint.titleInput.val.first.text.length` | 8,388,608 | **4,096** |
| `coldSnapshot(...).values.title` | same string | **identical** |
| row `ver` / `seq` / `count` / `lastSeq` / `first.seq` | 3 / 6 / 1 / 4 / 4 | **unchanged** |
| record on disk | 8,392,957 bytes | 8,445 bytes → 7,911 after the harness's own rewrite |

The load-bearing cell is the checkpoint length staying at 4,096 through the
harness's own write-back. A checkpoint row is a fold seed only when
`row.ver === def.stateVersion`, and a usable row makes the fold start **after**
`row.seq` (`dsh-session-projection/lib/index.js`, `restore`), so the projection
does not refold the message and the clamp survives.

The control session was byte-identical throughout: its record hash did not
change (`projrepro-small.json` before `apply` = after `apply`).

## 3. Orphan reaping

Deleting a session's log directory (the only way orphans arise — the harness has
no session-deletion path) makes its record permanently unreadable while it still
occupies bytes:

```
harness cold read with the log gone : session "projrepro-small" not found
record file on disk                 : still present
```

`dsh-projcache apply` reaped it:

```
reaped  : 1 records
clamped : 0 records
live record untouched by the reap   : the other record's hash was unchanged
orphan file removed                 : yes
backup kept                         : projrepro-small.json.bak.<stamp>, 3,865 bytes
harness cold read after the reap    : live session served its title identically
```

The backup name does not end in `.json`, and `loadTableRecords` reads only
`*.json` (`dsh-storage-json/lib/index.js`, `src/per-record-unit.ts:164-178`), so
the loader ignores it. Confirmed live: no `backup-and-skip` / `moved to` log
line appeared while the backup sat next to the record.

## 4. Worst case: no record at all — and the limitation this exposes

Deleting a **live** session's record does not break it. What changes is which
read path can answer:

```
openFailed                                   : no
viewCheckpoint (zero-I/O listing read) title  : null      <- the listing loses its title hint
restore / coldSnapshot (full-log read) title  : "PROJREPRO-HEAD-projrepro-huge-AAAAAAAAAA"
record recreated by the harness write-back    : true, 8,392,423 bytes
recreated titleInput text length              : 8,388,608  <- full size again
```

**This is the honest limit of an external fix.** A full replay recreates the
oversized row in full. The clamp holds as long as the record stays usable, which
is the normal case; any event that forces a refold from the log — a deleted
record, a domain version bump, or a `titleInput` `stateVersion` change — restores
the original size. Re-running `apply` reclaims it again, which is why the
read-only boot diagnostic exists: it reports when there is something to reclaim
without changing anything.

Only the real fix, clamping at the capture site in `sessionTitleUserMessageOf`,
removes the regrowth. That is an upstream change; this tool is the mitigation
available today.

## 5. Guard matrix (end-to-end, on a populated store)

| scenario | result |
|---|---|
| `apply` with an **empty** sessions root | exit 1, store byte-identical |
| `apply` with a **missing** sessions root | exit 1, store byte-identical |
| every record orphaned | exit 1 (100% > 50% limit) |
| same, with `--force` | still exit 1 — `--force` cannot override a log-free root |
| `survey` on any of the above | exit 0, reports the refusal, writes nothing |

`--force` overrides the orphan-**share** heuristic only. It cannot override a
missing or log-free sessions root, so no flag combination can delete an entire
store because of a mistyped path. The mass-reap override is exercised in the
unit suite with a populated store (`the orphan-share guard blocks a mass reap,
and --force overrides it`).

## 6. The invariant check has teeth

A clamp must never change the derived fallback title. The check is not
decorative — a prefix cut genuinely can change it when the cut lands inside a
whitespace run wider than the budget:

```
text                                  : "alpha" + 4000 spaces + "beta"
fallbackSessionTitle(text, 5, 40)     : "alpha beta"
fallbackSessionTitle(clamp1024, 5, 40): "alpha"      <- different
```

That record is reported as `invariantOk: false`, the whole run refuses, and the
file is left byte-identical. Pinned by the test `a clamp that would change the
derived fallback title is SKIPPED`.

## 7. Test suite

```
tests 31
pass  31
fail   0
```

Includes 11 CLI-contract tests (exit codes, dry-run writes nothing, `--force`
scope) and 11 unit tests over the guards, the fidelity gate, and the
preservation of every byte outside the clamped text.

## Not verified

- **No heap measurement.** This record covers stored bytes and the retention
  path, not resident memory. No inspector profile was taken, so no
  resident-byte claim is made here.
- **The reporter's orphan rate is not reproduced.** The mechanism is reproduced
  (delete a log → an unreadable record remains); the *rate* depends on how a
  user's logs disappear, which is outside the harness.
- **Other unbounded projections** listed in the upstream report
  (`contextBreakdown.nodes`, `inbox`, `goal.seenGoalIds`, `tmuxContext`) were
  not measured and this tool does not touch them.
- **Only the json backend's `per-record` layout** is handled. A deployment
  routing `session_projcache` to SQLite is refused by the fidelity gate rather
  than guessed at — the tool only edits documents it can reproduce byte-for-byte.

## Reproducing this

| artefact | path |
|---|---|
| fixture (real public APIs only) | `~/.dsh-lab/profiles/projrepro/fixture.mjs` |
| profile patch (pins both scratch roots) | `~/.dsh-lab/profiles/projrepro/cordis.patch.yml` |
| phase runner | `~/workspace/dsh-lab/projrepro/run.sh` |
| mirror cross-check | `~/workspace/dsh-lab/projrepro/crosscheck-format.mjs` |
| raw reports | `~/workspace/dsh-lab/projrepro/reports/*.json` |
| upstream findings write-up | `~/workspace/dsh-lab/findings/host-memory-repro.md` |

```sh
cd ~/workspace/dsh-lab/projrepro
bash run.sh create create                     # write the two sessions
node ~/workspace/dsh-session-check/bin/dsh-projcache.mjs survey \
  --store "$PWD/storages" --sessions "$PWD/sessions"
node ~/workspace/dsh-session-check/bin/dsh-projcache.mjs apply \
  --store "$PWD/storages" --sessions "$PWD/sessions"
bash run.sh cold cold-after-tool              # prove the harness still agrees
```

---

# v0 refusal gates (#6614)

Verified against the official validator on a real corpus and on two fixtures
built from real logs. Nothing below is a hand-written expectation of what the
migration does: the refusals quoted are produced by
`assertReleasedEventPayload` itself.

## The corpus, and a bug my first cross-check had

Corpus: 41 stored logs under `~/workspace/dsh-lab/corpus` (a lab copy).
`node ~/workspace/dsh-lab/v0/crosscheck-v0.mjs ~/workspace/dsh-lab/corpus`:

```
logs (all generations)      : 41
logs at format v0           : 32   (skipped 9 at a later generation)
official validator refuses  : 20
dsh-session-check refuses   : 20
disagreements               : 0
```

**The first run of that script reported 26 refusals and 6 disagreements, and
both numbers were wrong.** Two defects, both mine:

1. It ran the *v0* validator over 9 logs at later generations. Those logs
   legitimately contain event types and payload members introduced after v0
   (`system/message`, `request/context.systemPromptUpdate`,
   `assistant/message.stream`), and the v0 validator refuses all of them. Not a
   migration refusal at all. Restricted to `header.version === 0`: 26 -> 20.
2. It compared the two verdicts keyed by the log header's `id`. A log whose
   header has no `id` produced `undefined` on one side, which is neither blocked
   nor clean, and was printed as a disagreement. Keyed by path: 6 -> 0.

The same defect existed in the shipped scanner, and it was worse there: `findLogs`
matched only the v0-era file name `session.jsonl.zstd`, so **9 of 41 logs were
never scanned at all** while the version tally still looked complete. Fixed --
`isLogFile` now accepts `session.jsonl.zstd`, `session.v3.jsonl.zstd`, and
`session.v3.jsonl`. After the fix: `sessions scanned : 41`, `format versions :
{"0":32,"3":9}`, `loader would refuse: 20` (unchanged, so the 9 extra logs
produced no new refusal), and the official v0 gates ran on exactly the 32 v0
logs.

## The two failure shapes, built from real logs

Hand-built events would risk failing the validator for the wrong reason (a
missing required member, a bad semantic type). Instead
`~/workspace/dsh-lab/v0/build-v0-fixtures.mjs` starts from a log the validator
accepts -- 12 of the 32 v0 logs are clean -- and changes exactly one thing.

| fixture | change | official validator says |
|---|---|---|
| `v0-unknown-event-type` | appends `notice/banner` with `ignorable: true` | `format v0 contains unknown historical event type "notice/banner" at seq 4; migration refuses unknown historical events even when ignorable` |
| `v0-unknown-payload-member` | adds `origin` to a real `permission/preset` event's `data` | `permission/preset 0 data has unexpected member "origin"` |
| `v0-control-clean` | nothing | no refusals |

This independently confirms both causes in #6614, including the part the
reporter called out: **the v0 edge refuses an unknown event type even when the
event declares `ignorable: true`.**

`dsh-session-check scan ~/workspace/dsh-lab/v0/fixtures`:

```
sessions scanned   : 3
loader would refuse: 2
official validator : @deepseek-ai/dsh-session-format-v0-to-v1 loaded; ran over 3 format-v0 log(s)
v0 inventory       : 51 types, frozen=true, list-matches-dispositions=true

gates hit, by session count:
    1  v0-unknown-event-type  (official validator)
    1  v0-unknown-payload-member  (official validator)
```

The control log is reported `ok`, each real failure is reported once, and the
descriptor-version refusal is *not* double counted (pinned by the test `a
descriptor refusal is attributed to the existing gate and not counted twice`).

## The "never hand-patch the frozen v0 inventory" guardrail

The reporter measured that patching the frozen v0 inventory makes logs readable
but then appends return success while nothing lands on disk and no v3 is
derived. **I did not reproduce that end-to-end experiment**, so it is quoted as
theirs. What I did verify is the mechanism that makes it credible, in the
shipped code:

- `dsh-session/lib/index.js:270` -- an event whose type is not in
  `KNOWN_SESSION_EVENT_TYPES` is retained only when it carries
  `ignorable: true`; otherwise the later generation refuses the log it was
  derived into. So accepting an unknown type at the v0 edge does not remove the
  refusal, it moves the refusal to the write path, where it is silent.
- The migration's own policy note: `SessionEventMap` members are required on
  read, so a build that does not know a type refuses the log.

The tool prints the inventory's shape and warns when it is not frozen or its
derived list no longer matches its dispositions. The check is order-insensitive
on purpose: the release happens to sort its list, and a warning that fires on a
future sort change would be worse than no warning.

## Not verified

- The reporter's 243-session / 128-affected measurement. My corpus is a
  different population and contains neither failure shape; the shapes above were
  constructed.
- Their sandbox write-back experiment (quoted as theirs).
- Whether a supported recovery path for already-written v0 logs exists; that is
  an upstream design question, not a scanner question.
