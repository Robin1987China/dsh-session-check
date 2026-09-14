# dsh-session-check

English | [中文](README.zh.md)

**Read-only** diagnosis for stored DeepSeek Harness sessions: which ones the format migration will refuse, and which gate refuses each one. Ships a second binary, `dsh-projcache`, that reclaims space in the session projection cache.

Maintained by [@Robin1987China](https://github.com/Robin1987China)

Two commands, two promises:

| command | promise |
|---|---|
| `dsh-session-check scan` | **reads only.** Which sessions a format migration will refuse, and the gate that refuses each one. |
| `dsh-projcache survey` | **reads only.** What the session projection cache is storing, and what could be reclaimed. |
| `dsh-projcache apply` | writes, after every guard passes, with a per-file backup. |

## Symptoms this diagnoses

**English:** a session will not open after upgrading · the sidebar lists the session but clicking it fails · `SessionFormatUnsupportedMigrationError` · `source v0 artifact remains unchanged` · `format v0 contains unknown historical event type` · `uses unsupported descriptor version` · history seems to have disappeared after an upgrade

**中文：** 升级后老会话打不开 · 列表里有但点开就失败 · 升级后历史像没了 · `SessionFormatUnsupportedMigrationError` · `source v0 artifact remains unchanged` · 会话格式迁移失败

## What it does

It reads every `session.jsonl.zstd` under a sessions directory, parses it, and reports which migration gates each log fails.

**It writes nothing.** There is no repair subcommand: rewriting a session log is destructive, and a diagnostic that cannot damage your history is the one you can safely run first.

## What it does NOT do

- It does **not** repair, migrate, or move any file.
- It does **not** prove a session is readable — it reports the gates it knows about. A clean scan is necessary, not sufficient.
- It is **not** an upstream tool.

## Usage

```sh
npx dsh-session-check scan ~/.dsh/sessions
```

`scan` finds every stored log name, not just the v0-era `session.jsonl.zstd`. It previously matched only that one name and silently omitted `session.v3.jsonl.zstd` -- 9 of 41 logs in the corpus this was checked against -- while the version tally still looked complete. A log the scan cannot see is a log it cannot warn about.

Example output:

```text
sessions scanned   : 32
loader would refuse: 20
packed chunk runs  : 8562 (not session events)
format versions    : {"0":32}

gates hit, by session count:
   20  stale-descriptor
```

## The projection cache (`dsh-projcache`)

`scan` above looks at session logs. `dsh-projcache` looks at the other durable session store: `<DSH_HOME>/storages/session_projcache/sessions/`, one pretty-printed JSON document per session.

**Symptoms this addresses:** the harness process grows over time · `storages/` keeps growing although sessions were deleted · a session's first message was enormous and now every boot pays for it

```sh
dsh-projcache survey    # report only; writes nothing
dsh-projcache apply     # reap provable orphans and clamp oversized rows
```

It does exactly two things:

1. **Reaps records whose session log is gone.** A record is reachable only through an identity match built from a live or stored session header, so once the log is gone no caller can ever read it — it just occupies bytes and is parsed at every boot. The record is deleted only when the log is provably absent from the sessions root you pass, and only after a backup is written next to it.
2. **Clamps an oversized `titleInput` prefix.** That row stores the session's first eligible user message *whole*, while its only reader wants 5 words / 40 bytes (`fallbackMaxWords` / `fallbackMaxBytes` in your composition). The stored text is replaced with a UTF-8-safe prefix (default 4096 bytes) — never a suffix, never splitting a code point.

### What it will not do

- **It never writes unless you run `apply`.** `survey` is byte-for-byte read-only, and the test suite pins that.
- **It refuses to write a document it cannot reproduce byte-for-byte.** The store format is `JSON.stringify({version, record}, null, 2) + '\n'`; if a record does not round-trip through that, the tool's model of the backend is stale and it stops. This is also why a non-JSON backend is refused rather than guessed at.
- **It refuses a sessions root that does not exist or holds no log at all.** `--force` cannot override that, so a mistyped path cannot delete your store.
- **It does not clamp a row when the clamp would change the derived fallback title.** It computes the fallback from the original and from the clamped text and skips the record unless they are equal.
- **It is not a permanent fix.** A full replay from the log — a deleted record, a domain version bump, a `titleInput` `stateVersion` change — recreates the oversized row at full size. Re-run `apply`, or watch for it with the boot diagnostic. The permanent fix has to clamp at the capture site, which is upstream.

Run it with the harness stopped: the store is an in-memory table while the process is running.

### Options

| flag | default | meaning |
|---|---|---|
| `--store DIR` | `$DSH_HOME/storages` | storage backend root |
| `--sessions DIR` | `$DSH_HOME/sessions` | sessions root used to decide what is an orphan |
| `--clamp-bytes N` | `4096` | prefix budget for a stored `titleInput` |
| `--fallback-words N` | `5` | your composition's `fallbackMaxWords`, for the invariant check |
| `--fallback-bytes N` | `40` | your composition's `fallbackMaxBytes`, for the invariant check |
| `--max-orphan-fraction F` | `0.5` | refuse to reap above this share |
| `--force` | off | override the orphan-share guard only |
| `--json` | off | machine-readable output |

Every changed file gets a `<id>.json.bak.<stamp>` sibling. The loader reads only `*.json`, so backups are ignored until you delete them.

The evidence for all of this — the clamp surviving the harness's own write-back, the reap, the missing-record worst case, and the guard matrix — is in [`docs/verification.md`](docs/verification.md), with the raw JSON reports.

## Boot diagnostic (`dsh-session-check/diag`)

A read-only Cordis plugin that prints one line at start when the projection cache holds enough reclaimable bytes to matter (default threshold: 1 MiB):

```text
projection cache: 8.0 MB reclaimable — 2 of 2 records store a titleInput text (largest 8388608 chars,
8.0 MB total), while the fallback title reads only the first 4096 bytes. Reclaim offline with:
npx -y -p dsh-session-check dsh-projcache survey  (then `apply`)
```

Mount it as a bundle row:

```yaml
- insert:
    - id: projcache-diag
      name: 'dsh-session-check/diag'
```

The `dsh-community-fixes` bundle already mounts it, and it is the only reason this plugin exists in a CLI package: the report and the reclaim should share one implementation.

It reads the live domain table with `KvTable.entries()` and never writes. It measures against a deadline (default 50 ms) and says `(partial scan: …)` rather than reporting a half-scan as a total.

### Why it writes to stderr and not only to `ctx.logger`

Because `ctx.logger` is not visible in the shipped composition. Cordis's built-in `LoggerService` installs exactly one exporter — an in-memory ring buffer (`@deepseek-ai/cordis`, `LoggerService` constructor) — and no shipped package registers a console sink. Measured on 0.1.5-rc.1: a `logger.warn` from this row produced no output on stdout or stderr in a `dsh web` run, while the same callback's `process.stderr.write` did. The logger call is kept so a deployment that does wire a sink still receives the message.

This is worth knowing independently of this tool: **a plugin that reports a problem only through `ctx.logger` is reporting it to nobody** in a stock install.

## The gates

Each gate mirrors one validator in the migration chain, read from the installed packages. The `file:line` is part of the output contract: re-read it before trusting the gate against a new release.

| gate | what it detects | validator it mirrors |
|---|---|---|
| `retired-source-kind` | a message source kind no longer in the accepted set | `dsh-session-format-v2-to-v3/lib/index.js:123` |
| `stale-descriptor` | a `subagent/descriptor` whose version is not 3 | `dsh-session-format-v0-to-v1/lib/index.js:1586` |
| `incomplete-inserted` | an inserted inbox message missing id/role/content/source | `dsh-session-format-v0-to-v1/lib/index.js:283 and :715` |
| `v0-unknown-event-type` | an event type outside the frozen v0 inventory, which the v0→v1 migration refuses **even when the event carries `ignorable: true`** | **calls** `assertReleasedEventPayload` from `dsh-session-format-v0-to-v1` |
| `v0-unknown-payload-member` | a `data` member the type's v0 disposition does not declare (e.g. `permission/preset` + `origin`) | **calls** `assertReleasedEventPayload` from `dsh-session-format-v0-to-v1` |

## Two of these gates are not mirrors

The first three gates re-implement one decision each and cite the `file:line` they were read from, because the scan must work where the harness is not installed. The two `v0-*` gates do not re-implement anything: they **call** the official `assertReleasedEventPayload(event, 0)`, which is the function the v0→v1 migration itself runs over every event, and report its refusals by class.

That matters because the alternative -- copying the frozen v0 inventory (51 event types in 0.1.5-rc.1) into this package -- goes stale, and a stale copy produces false positives, which is the one failure this tool must never have.

Consequences you should know about:

- **`scan` says so when it cannot run them.** If `@deepseek-ai/dsh-session-format-v0-to-v1` is not installed, or `--no-validator` is passed, the output says `official validator : UNAVAILABLE -- <reason>` instead of printing a clean-looking result.
- **They only run over format-v0 logs.** A later generation is not going through the v0→v1 migration, and running the v0 validator over it reports the event types and payload members that generation added -- none of which is a refusal.
- **A `subagent/descriptor` refusal is attributed to `stale-descriptor` and dropped here.** The validator refuses that too; counting it in both places would double every tally.
- **`scan` reports the inventory it used**, and warns if that inventory is not frozen or its derived type list no longer matches its dispositions.

### Never hand-patch the frozen v0 inventory

If a log is refused because it contains an event type your build does not know, the tempting fix is to edit the inventory in the installed package so the log opens. **Do not.** A hand-patched inventory makes the log *readable* and turns the failure into a worse one:

- `dsh-session/lib/index.js:270` retains an unknown event type only when the event carries `ignorable: true`, and otherwise the later generation refuses the log it was derived into. So accepting an unknown type at the v0 edge moves the refusal to the write path, where it is silent instead of loud.
- A first-hand report on #6614 measured exactly that: after patching the frozen v0 inventory in a sandbox, appends returned success while nothing landed on disk and no v3 was derived. A clear refusal is strictly safer than a half-fixed state.

`scan` prints the inventory's shape (`51 types, frozen=true, list-matches-dispositions=true`) and warns when it has been modified, so you can tell. The documented upstream surface for this is the `ignorable` writer option proposed in upstream #1538; reinstall the package rather than editing it.

## Why the gates are narrower than they look

Two obvious implementations are wrong, and both were caught by cross-checking against the official validator:

1. **`session/title` also carries a `data.source.kind`**, but it records how the title was produced (fallback or model). `assertSource` never sees it. A deep walk over every `source` object reports violations that cannot happen.
2. **A stored log has two row kinds.** Session events carry a numeric `seq`; packed chunk runs carry `seq0` and `time0` and are decoded on a separate path (`decodePackedRun`). Feeding a packed run to the event validators invents a failure.

On a real corpus of 32 logs, getting either one wrong turned **20** genuinely blocked sessions into **30** reported ones — a tool that tells people their history is broken when it is not.

## Cross-checking against the official validator

The scanner predicts refusal; the harness decides it. To confirm the two agree on your machine, feed the official validator the events that carry a numeric `seq`:

```js
import { assertReleasedEventPayload } from '@deepseek-ai/dsh-session-format-v0-to-v1'

for (const event of events) assertReleasedEventPayload(event, 0)
```

A blocked log must throw at the event the scanner names; a clean log must accept every event.

## How this differs from `dsh-session-doctor`

Two tools scan stored sessions. They cover **different failure classes**, and the difference is measurable rather than a matter of opinion.

| | dsh-session-check (this tool) | dsh-session-doctor |
|---|---|---|
| failure class | **format migration gates** — `SessionFormatUnsupportedMigrationError` | message-shape corruption — `SessionPersistenceCorruptionError` |
| typical trigger | upgrading from an older release | a plugin writing a malformed tool result |
| what it reports | `unsupported descriptor version`, `unknown historical event type`, `cannot safely transform unclassified message source` | `must contain one tool-result block` |
| writes | nothing | repairs, with per-file backup |

On one real corpus of 32 logs, `dsh-session-doctor@0.2.1 scan` reported `scanned=32 clean=32 corrupt=0`, while this tool reported **20 blocked** — every one on the `stale-descriptor` gate. Neither result is wrong: they look for different things, and a session can pass one check and fail the other.

If your symptom is "history unavailable … must contain one tool-result block", this tool is not what you want.

## Requirements

- Node `>=22.19`
- the `zstd` CLI on `PATH`
- the harness packages installed, for the gate constants and any cross-check

## Development

```sh
npm test
```

The suite runs on synthetic events, so it needs no real session log.

## License

MIT
