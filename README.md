# dsh-session-check

English | [中文](README.zh.md)

**Read-only** diagnosis for stored DeepSeek Harness sessions: which ones the format migration will refuse, and which gate refuses each one.

Maintained by [@Robin1987China](https://github.com/Robin1987China)

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

Example output:

```text
sessions scanned   : 32
loader would refuse: 20
packed chunk runs  : 8562 (not session events)
format versions    : {"0":32}

gates hit, by session count:
   20  stale-descriptor
```

## The gates

Each gate mirrors one validator in the migration chain, read from the installed packages. The `file:line` is part of the output contract: re-read it before trusting the gate against a new release.

| gate | what it detects | validator it mirrors |
|---|---|---|
| `retired-source-kind` | a message source kind no longer in the accepted set | `dsh-session-format-v2-to-v3/lib/index.js:123` |
| `stale-descriptor` | a `subagent/descriptor` whose version is not 3 | `dsh-session-format-v0-to-v1/lib/index.js:1586` |
| `incomplete-inserted` | an inserted inbox message missing id/role/content/source | `dsh-session-format-v0-to-v1/lib/index.js:283 and :715` |

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
