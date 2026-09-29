# Cursor Agent CLI

## Transcript, chat view and context link

Leaf: `src/core/cursor-chat.ts`. Measured on `cursor-agent` 2026.09.23 and 2026.09.28 (macOS), against
real chats (a `-p` run with a shell turn and a write/read/grep turn, plus an older subagent chat).

**Storage.** `<config>/chats/<md5(physical cwd)>/<chatId>/store.db`, where `<config>` is
`$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor` (the CLI's own rule).
`<chatId>` is a UUID: the `--resume` id and the stream-json `session_id` (stable across resume).
2026.09.28 also writes a `meta.json` sidecar; an empty chat's `store.db` is deleted, the sidecar stays.
The store is SQLite (WAL): `meta` key `0` = hex(JSON) with `latestRootBlobId` and `name`; `blobs` is
content addressed (sha256). The root blob is protobuf (`ConversationStateStructure`): field 1 lists the
ordered ids of the model-context messages, each an AI-SDK-shaped JSON blob (system / user / assistant
parts `text`, `reasoning`, `redacted-reasoning`, `tool-call` / tool `tool-result`). The typed prompt is
`<user_query>` inside a user text part; everything else in user messages is injected context. Also in
the root (not used): field 5 has `used / window` context tokens (26794 / 200000 in one chat), a
candidate for the usage leaf.
Not used: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`. Its text reads `[REDACTED]`, it
has no tool results and lost the user line of a failed turn.

**Reading.** Built-in `node:sqlite`, read-only (Electron 42 = Node 24.19; `engines` floor has it). No new
dependency. Found strictly by the whole-UUID id; the cwd only orders the bucket search. There is no cwd
fallback, so another chat is never shown. One page, `olderCursor: null`. Newest 16 MiB of messages
are read. Compaction replaces the model context, so pre-compaction turns are not shown.

| Capability | Desktop | Server Edition | Mobile | SSH-remote node |
|---|---|---|---|---|
| ⌘M chat (`CHAT_CAPABLE`) | yes | yes (core handler) | yes, via relay `chat.page` | refused: "not supported yet" (`CHAT_LOCAL_ONLY`), never the local disk |
| Context link, both directions (`CONTEXT_LINK_CAPABLE`) | yes | yes | N/A | no transcript for a remote node ("no conversation transcript yet") |
| Transfer source (`TRANSFER_SOURCE_CAPABLE`) | yes | N/A (handoff is desktop main) | N/A | refused with its own sentence |
| Session name read (`TITLE_READ_CAPABLE`) | yes | sweep to the mirror only (the IPC read is stubbed there for every agent) | via mirror | none (node keeps its title) |

`get-linked-context` discovery needs no installer: cursor-agent lists `~/.claude/skills/get-linked-context`
in its own `<agent_skills>` (measured), like grok. The composer's model label, effort, plan/question
cards and `at` timestamps are not supported. `/rename` is not in `RENAME_CAPABLE` (typed form unmeasured).

## Device checklist (not verified)

1. ⌘M on a live interactive node after hooks supply the chat id (this leaf assumes the node's session id is it).
2. A chat with a very long history (compaction) and one over 16 MiB.
3. Title chip after cursor auto-names an interactive chat (print mode leaves `New Agent`).
4. Server Edition on Linux and Windows path hashing of the cwd bucket (only the id scan is relied on).
