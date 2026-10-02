# Cursor Agent CLI (`cursor-agent`) as a nodeterm agent

Builtin id `cursor` (`AGENT_CONFIG.cursor`, launch `cursor-agent`, prompt behind the `agent`
subcommand). This document covers the status-hook leaf: `cursor` is a member of
`AGENT_HOOK_TARGETS`, so a Cursor node gets the RUNNING badge, the unread dot, the completion
notification, `--after` dependencies and trigger targets. Sibling write-ups:
`docs/antigravity-agent.md` (closest precedent), `docs/grok-agent.md`.

**Where the facts come from.** Measured on `cursor-agent` 2026.09.28-64d2043 (macOS): five headless
(`-p`) runs on a paid account, two zero-cost interactive TUI launches, and the shipped JS bundle
(`~/.local/share/cursor-agent/versions/*/`). The installed CLI auto-updated from 2026.09.23 during
the work. Fixture: `src/shared/agents/__fixtures__/cursor/hook-payloads.json`.

## 1. The recorded id (for the resume work)

Every hook payload carries **`conversation_id`** and a duplicate **`session_id`** (equal in every
capture). `normalizeCursor` records `conversation_id` (falling back to `session_id`) as the event's
`sessionId`, which is how every agent's id reaches `agentStatus`. **Verified with zero cost:**
`cursor-agent --resume <conversation_id>` opens that chat with its history. `cursor-agent
create-chat` prints a new empty chat id. The transcript path is
`~/.cursor/projects/<workspace path with non-alphanumerics as "-">/agent-transcripts/<id>/<id>.jsonl`
(JSONL; the last line is `{"type":"turn_ended","status":"success"|"error"}`), and the payload's
`transcript_path` names it once the first turn is written (null before).

## 2. Hook config

- Files read: `~/.cursor/hooks.json`, `<workspace>/.cursor/hooks.json`, enterprise/team files, and
  **`~/.claude/settings.json` (+ project `.claude/settings*.json`)** as Claude compat.
- Shape: `{"version":1,"hooks":{"<camelCaseEvent>":[{"command":"...","timeout":5}]}}`, flat entries.
- 21 events exist. We subscribe five (`CURSOR_HOOK_EVENTS`): `beforeSubmitPrompt`, `preToolUse`,
  `postToolUse`, `postToolUseFailure`, `stop`.
- Payload envelope (all events): `conversation_id`, `session_id`, `generation_id`, `model`,
  `hook_event_name`, `cursor_version`, `workspace_roots[]`, `user_email`, `transcript_path`. Tool
  events add `tool_name` (`Shell`, ...), `tool_input`, `tool_use_id`, `cwd` (was `""`), and
  `postToolUse` adds `tool_output`, `duration`. Hook env carries `CURSOR_PROJECT_DIR`,
  `CURSOR_VERSION`, `CURSOR_TRANSCRIPT_PATH`, `CLAUDE_PROJECT_DIR`, and the parent's env
  (so `NODETERM_NODE_ID` reaches our script).
- `sessionStart` fires once at startup, **not on `--resume`** (measured in the TUI and in the bundle).

## 3. Is the hook a gate? Yes, for some events; silence is the safe default

From the bundle (`executeCommandHook`) and confirmed by runs:

| hook result | effect |
|---|---|
| empty stdout, exit 0 | no-op; the tool ran (measured on `preToolUse`) |
| exit 2 | DENY on gating events (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `subagentStart`) |
| any other non-zero exit, timeout | logged as failed, fail-open unless the entry sets `failClosed` |
| stdout that is not valid JSON | DENY on gating events ("blocked for safety") |

So the installed command is `sh <script> >/dev/null 2>&1 || :` (`buildManagedHookCommand`
`silent`): a broken script can never print garbage or exit 2. Our script prints nothing anyway.

Traps found:
- Cursor strips `//...` from hooks.json as JSONC comments **ignoring quotes**, before parsing. A
  command containing `//` corrupts the whole file for every tool. The installer refuses to write one.
- **A headless run subscribed to 18 events (incl. `afterAgentResponse`, `afterAgentThought`,
  shell/MCP/file events) plus a claude-format project file lost its agent stream after the first
  reply three times ("Connection lost... WritableIterable is closed"); the same run with the five
  events plus sessionStart/sessionEnd finished clean.** Which difference broke it is unknown, so the
  extra events are not subscribed. Device item 3.
- Server tells the client which steps have hooks (`hooksConfig.configuredSteps`) and calls only those.

## 4. State mapping (`normalizeCursor`, pure, closed set of exact names)

| event | result |
|---|---|
| `beforeSubmitPrompt` | `working`, `newTurn` |
| `preToolUse` / `postToolUse` / `postToolUseFailure` | `working`; null if `parent_tool_call_id` is set (subagent) |
| `stop` | `done`; `interrupted` if `status==="aborted"`, `errored` if `"error"` |
| anything else | null |

**No NEEDS YOU from the normalizer.** Measured: the `AskQuestion` tool fires no tool hook (headless
and TUI); Cursor's own approval prompt has no hook either. Guessing one from events would strobe
(rule 7). The approval prompt is detected from the pane instead: see "NEEDS YOU, SSH hooks and lost
stop" below.

## 5. Cross-fire with nodeterm's claude hook (measured)

With a matcher-bearing claude-format settings file, Cursor ran the claude hook command on its own
`sessionStart`/`preToolUse`/`postToolUse` (payload keys unchanged, `hook_event_name` camelCase).
A file with only matcher-less entries is NOT treated as claude-format (Cursor's `isClaudeFormat`
needs one `matcher`), but this machine's `~/.claude/settings.json` has other tools' matcher entries,
so nodeterm's `claude.sh` fires in every Cursor node here. **Inert:** `normalizeClaude` compares exact
PascalCase names and returns null for every captured cursor payload (pinned in
`normalize.cursor.test.ts`); the claude raw listener's only side effect is
`nodeContextSession.set(node, session_id)`, which nothing reads for a non-claude session. Cost: two
POSTs per event. Do not canonicalise claude's event-name compare.

## 6. Installer (`core/agents/hooks/cursor.ts`)

Merges into the SHARED `~/.cursor/hooks.json` (the real one holds another tool's `sessionStart`
entry) through `updateSettingsFile` (symlink-safe, locked, mode kept, ENOENT-only creation): our
entries are appended to the five events, ours are swept from any other event, every other
entry/key survives, an unparseable or mis-shaped file is left byte-for-byte, a second run writes
nothing. Only where `cursor-agent` is found (PATH, then `~/.local/bin`); one boot pass (no
login-shell re-probe like agy). Removal deletes only our entries and never creates the file. Ours =
command containing `.nodeterm/agent-hooks/cursor.sh`. Tests use a temp dir, never the real home.

## 7. Surfaces and what is not done

- Desktop and Server Edition: both via `installManagedAgentHooks`; no raw-listener branch needed
  (state comes from the normalizer, like antigravity). Mobile: status mirror is agent-agnostic.
- SSH: no remote installer, so `cursor` is in `LOCAL_ONLY_HOOK_AGENTS` (`--after` refuses it).
- Not joined (each is its own leaf; resume/mint/session end/model list are now in
  "Session continuity" below): chat/transfer/context link

- SSH: `RemoteHooks.installCursorRemote` (see "NEEDS YOU, SSH hooks and lost stop" below).
- Not joined (each is its own leaf): `RESUMABLE_AGENTS` (id is recorded and `--resume <id>` is
  verified; the launch grammar with the `agent` subcommand is not), chat/transfer/context link
  (transcript shape is only seen as JSONL user/assistant/tool_use lines), usage meter (`stop`
  carries token counts, window unmeasured), canvas control, rename, permission modes, model switch,
  subagents, `SESSION_END_CAPABLE`.

## 8. Device checklist (unverified)

1. Interactive TUI fires `beforeSubmitPrompt` and `stop` (headless never did). If not, the badge
   still runs from tool events but text-only turns never show RUNNING.
2. `stop` payload: `status` values (`completed|aborted|error` assumed), and that Esc fires it.
3. Bisect the 18-event stream failure (add events back one at a time in a headless run).
4. Subagent behaviour: is `parent_tool_call_id` set, which `conversation_id` do child events carry,
   does a child fire `stop`.
5. Does an interactive exit fire `sessionEnd` (would allow `SESSION_END_CAPABLE`).
6. Answered: no hook for either (measured in the TUI); approval is read from the pane, AskQuestion is not covered.
7. Hook latency inside a node (script backgrounds the POST; expected small).
8. Linux and Windows: hooks.json location, `cursor-agent` install dir.

## Model and permission flags

Measured on `cursor-agent` 2026.09.28-64d2043 (macOS). Cursor is in `MODEL_SWITCH_CAPABLE` and
`PERMISSION_MODE_CAPABLE`; the translation lives in `src/shared/agents/approval-mode.ts`
(`CURSOR_MODES`) and `withAgentModel` in `model-gateway.ts`.

### Where the flags go

The composed line is `cursor-agent [flags] agent '<prompt>'`, flags BEFORE `agent`. `agent` is a
commander subcommand with no options of its own; its action reads the root program's options
(`Ie()` is `root.opts()` in the bundle), and root parses `--model`, `--force`, `--mode` wherever they
sit. Measured in the TUI (no prompt, so no model cost) both `cursor-agent --model X agent` and
`cursor-agent agent --model X` show model X; the same for `--force` ("Run Everything"), `--mode plan`
and `--auto-review`. Both composers (`assembleLaunchCommand`, `core/agent-launch.ts`) are pinned by
tests.

### Mode table

| nodeterm mode | emitted | why |
|---|---|---|
| Ask each time (`manual`) | nothing | cursor's default is `approvalMode: allowlist`; a shell command off the allowlist stops at "Run this command? Not in allowlist" (measured) |
| Auto (`auto`, the default) | nothing | `--auto-review` would auto-run calls a bare cursor prompts for: widens every existing node at upgrade |
| Accept edits | nothing | no flag means "auto-approve edits, prompt for shell" |
| Plan | `--mode plan` | measured: a "create a file" prompt produced a written plan ("Ready to build?"), no file |
| Bypass all | `--force` | measured: the shell command ran with no prompt, footer "Run Everything" |

`auto` and `acceptEdits` show in `unsupportedModesNote`. `--sandbox` is a separate axis and is not
touched (cursor's sandbox is off by default, so the Bypass caveat does not claim one). `--mode ask`
has no nodeterm mode.

### Models

`--model <id>`, quoted by `withAgentModel`. The catalogue is `cursor-agent models` (about 250
account-scoped ids, `<id> - <label>` lines, some with zero-width spaces at the end). Cursor is in
`OWN_MODEL_CATALOGUE` with grok: it never receives the gateway's models (`modelsForAgent` returns
none, transfer targets stay flat, the gateway default model is not applied).

### Model and permission: not verified / not built

1. No model picker is reachable yet. The restart menu's "Switch model" needs a resumable agent with
   a session id, and cursor is neither (`--resume [chatId]` and `create-chat` exist). The transfer
   menu carries the gateway list only. When cursor joins `RESUMABLE_AGENTS`, add a `cursorModelsFrom`
   parser plus a memoized probe beside `grokModelsFrom` and return it from `modelsForAgent`.
2. `--auto-review` widening was read from the help text and the footer label, not measured behaviorally.
3. What cursor does with an unknown `--model` id is unmeasured.
4. `--model` in the TUI adds the id to `modelParameters` / `modelSelectionHistory` in
   `~/.cursor/cli-config.json` (seen on the real config); it did not change the saved default model.
5. A model can be rate-limited per account ("You've hit your usage limit" for `gpt-5.4-nano-none`);
   that error comes from the backend and proves the flag reached it.

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

## Context meter (`USAGE_CAPABLE`)

Source: the agent's OWN numbers (CLAUDE.md rule 6), not the `stop` payload's `input_tokens` /
`cache_read_tokens` (no window there). The store's root protobuf field 5 is `token_details` {1
used_tokens, 2 max_tokens}; it matches the TUI's `/context`, and `max` varies per session (200000 /
256000 / 300000 / 1000000), so it is read, never inferred. No `max`, no meter. Read by the one store
reader (`readCursorStore` returns `tokens`; `rootMessageIds` and `rootTokenDetails` share one protobuf
walker in `core/cursor-chat.ts`). No second SQLite reader.

**Tail choice.** `createContextTail` gained one option, `readSource(path, lastKey)`, replacing the
byte read for a source that is not a text file. Cursor's is `readCursorContextSource`: stat of
`store.db` + `store.db-wal` as the change key (WAL leaves the db file untouched between checkpoints),
then the store read for the numbers only, handed to `cursorContextParse` as one JSON line. The shared
1 Hz poll does the re-reading; cursor hook events (`trackCursorContext`) only locate and track the
store, strictly by `conversation_id` (`locateCursorChat`, chats root only, whole-UUID). ponytail: a
poll, not a hook-triggered reader; upgrade if the stat gate ever shows up in a profile.

**Jail.** No payload path is consumed: `transcript_path` names the redacted agent-transcripts jsonl and
is ignored, so there is nothing to widen in `safeTranscriptPath`; the only path is the one the locator
builds under `cursorConfigDir()` (honours `CURSOR_CONFIG_DIR` / `XDG_CONFIG_HOME`).

**Gates.** `hasUsage` also gates `context.ensure` (now a `cursor` case: `locateCursorChat(id)`, no cwd)
and the find-bar index and cold-resume stay on `readsClaudeTranscript`, which is false for cursor (pinned).

| Surface | Status |
|---|---|
| Desktop | yes: raw listener `agentId === 'cursor'` in `src/main/index.ts`; ensure routes to `cursorContextTail` |
| Server Edition | yes: same branch in `src/server/agent-status.ts` (parity), `tailFor` in `src/server/index.ts` |
| Mobile | meter rides the shared context mirror (agent-agnostic); not device-verified |
| SSH node | "not yet": raw branch returns for a remote node, `ensureRemote` is terminal `unresolved`, never this machine's disk |

Not read: account plan limits (CLI `/usage`, needs a login credential): out of scope. Model is not
shown (the store root states none cheaply; the popover omits it).
Unverified: a real interactive node end to end (no dev app run), a real store read in this branch's
tests (fixtures are synthesized), Mobile on device.

## Session continuity (resume, mint, session end, restart, models)

Measured on `cursor-agent` 2026.09.28 (macOS, tmux TUI, project-level hooks logger). One paid run
(composer-2.5), the rest zero cost.

**Grammar.** `--resume [chatId]` is a ROOT option with an OPTIONAL value: the id must directly follow
it, then `agent '<prompt>'` may follow. Resume is `cursor-agent --resume <id> [--mode/--force] [--model X]`
(no prompt); flags may sit either side of the id. Both composers (`resumeCommandWith` ->
`assembleResumeCommand`, and `core/agent-launch.ts` argv) emit it; pinned in `cursor-launch.test.ts`
and `agent-launch.test.ts`.

**Dead id is safe.** `--resume <unknown uuid>` opens an empty chat that ADOPTS that id (exit 0, no
error; a `chats/<bucket>/<id>/` dir appears). So a wrong id costs the history, never the launch.

**Minting (`SESSION_ID_CAPABLE`, unconditional like copilot).** Because an unknown id is adopted, a
fresh UUID on first launch IS minting, with no model call: `cursor-agent --resume <uuid> [flags] agent
'<prompt>'`. Paid run: that exact line answered "pong" and `stop` carried `conversation_id` == the uuid.
`create-chat` (1.5 s, network) is NOT used: it returns a cursor-chosen id, and nodeterm needs the id
before launch. No help probe: the flag is the one resume already needs, and the adopt behavior is not a
flag a probe could see. An id that already exists just resumes (never grok's "taken id" launch error).
If an older CLI ignored the unknown id, the node degrades to the hook-learned id.

**Session end (`SESSION_END_CAPABLE`).** `/quit` + Enter fires `sessionEnd` (also with a resumed
chat). `normalizeCursor` maps it to `sessionPhase: 'end'` (skipped when `is_background_agent`), AND
`sessionEnd` is added to `CURSOR_HOOK_EVENTS`: the list is inert, and every quit would read as a
DROPPED crash, without the subscription. Existing installs gain it on the next installer pass.

**In-place restart.** `EXIT_SEQUENCES.cursor = '/quit'` (bare). Enter is a SEPARATE write (150 ms
split, as opencode): text+Enter in one write is not submitted. Ctrl-U (`KILL_LINE`) clears a half-typed
draft in the cursor TUI (measured). The restart rejects `working` (cursor has no blocked state, so an
approval prompt reads as working and is refused too).

**Models.** `cursorModelsFrom` parses `cursor-agent models` (`<id> - <label>`, zero-width spaces
stripped; 246 of 246 lines matched, header and Tip ignored) into `{id, name}`. Probe: `core/cursor-cli.ts`
(`registerCursorCliIpc`, in BOTH shells), memoized, a failed/empty probe is retried, fails open to [].
Channel mirrors grok's: `IPC.cursorCliCaps`, `window.nodeTerminal.cursor.cliCaps()` (preload, ws-bridge,
stub), renderer memo `ensureCursorCliCaps`/`cursorCliCapsNow` warmed at boot, and `modelsForAgent(...,
cursorModels)` fed by Canvas. This lights the restart menu's "Switch model" for cursor.

**Cold-resume presence: not built.** `transcriptExists`/`shouldProbeTranscript` is claude-only and has
no agent argument on its channel; the store locator (`locateCursorChat`, strictly by id) could answer,
but the dead-id behavior makes it unnecessary: a missing chat resumes into an empty chat under the same
id instead of failing like claude. The only loss is the "lost session" notice.

| Capability | Desktop | Server Edition | Mobile | SSH-remote node |
|---|---|---|---|---|
| Resume / cold restore / restart / mint | yes | yes (core + shared composer) | N/A | `cursor` has no remote installer (`LOCAL_ONLY_HOOK_AGENTS`); no hook id, mint still gives one, remote run unverified |
| Session end (DROPPED chip) | yes | yes (normalizer is shared) | status mirror | no hooks over SSH, so no chip |
| Model catalogue | yes (IPC) | yes (WS-RPC handler) | N/A | lists THIS machine's account |

### Not verified (device checklist)

1. `sessionEnd` on Ctrl-C twice, SIGTERM, and a closed terminal (only `/quit` measured).
2. Mint on an older cursor-agent that may not adopt an unknown id.
3. `sessionEnd` of a subagent chat (`is_background_agent` only guards the flag, never seen true).
4. `--resume <id>` after the real chat has history inside a restart, including the Switch model path.
5. Windows `cursor-agent` argv for resume (composer pinned, never run).
6. Models list under an account switch (memoized per process) and offline.

## NEEDS YOU, SSH hooks and lost stop

Measured on `cursor-agent` 2026.09.28-64d2043, interactive TUI in a private tmux, project-level
hooks logger, 4 model runs (composer-2.5).

### NEEDS YOU (`core/agents/cursor-approval.ts`)

| case | hook events | pane |
|---|---|---|
| shell off allowlist | `preToolUse` (Shell), `beforeShellExecution`, then silence | `Run this command?` / `Not in allowlist: touch` / `→ Run (once) (y)` ... `Skip & tell the agent what to do instead (esc or n)`; tool row `$ touch x Waiting for approval...` |
| MCP tool | `preToolUse` (`MCP:ping`), `beforeMCPExecution`, then silence | `Run this MCP tool?` / `→ Run (once) (y)` ... `Skip (esc or n)` |
| approve (y) or skip (n) | `postToolUse` for the same `tool_use_id` (skip too), then `stop` | dialog gone |
| file write (default mode) | no dialog: auto-approved | n/a |
| AskQuestion | NO tool hook at all; Esc fires only `stop` | `Clarifying Questions` box |

Rule: a cursor `preToolUse` whose `tool_use_id` has no `postToolUse`/`postToolUseFailure` after
1.5 s gets ONE pane read (`ptyManager.captureSession`, bounded by `probeWithin`). If the last 30
non-blank lines hold an exact heading from the bundle's `decision-logic.ts` (`Run this command?`,
`Run this command outside the sandbox?`, `Run this MCP tool?`, `Delete this file?`, `Write to this
file?`, `Read this file?`, `Allow this web search?`, `Allow this web fetch?`) followed by an option
ending in `(y)`, the hook server emits `blocked` on the same listener as every hook event. The next
event (`postToolUse` on y/n, `stop` on Esc) replaces it. No pending tool = no timer, no read; one read
per call, so a long approved command never strobes. `stop`/`beforeSubmitPrompt` drop the node's
pending calls; subagent calls (`parent_tool_call_id`) are ignored.

| Surface | Desktop | Server Edition | Mobile | SSH-remote node |
|---|---|---|---|---|
| NEEDS YOU on approval | yes (`hookServer.setPaneReader` in main) | yes (same call in server) | yes (mirror is agent-agnostic) | yes: `captureSession` reads the remote tmux over the ControlMaster (one ssh child per pending call) |
| Kanban card, chips, card modal | `cardBadge` / `chatSendRefusal` read `blocked` for every agent | same | N/A | same |
| Chat send / agent messaging refuse while blocked | `chatSendRefusal` = `dialog`; `decideDelivery` = `targetBusy` | same | same | same |

Not covered: AskQuestion (no hook to hang a read on; the node shows RUNNING while it waits). The
headings other than shell and MCP are bundle-read, not seen in a pane.

### SSH hook installer (`RemoteHooks.installCursorRemote`)

`cursor` left `LOCAL_ONLY_HOOK_AGENTS`, so `--after` accepts a cursor node on an SSH project. On
connect, only where the host has `cursor-agent` (`command -v`, or `~/.local/bin/cursor-agent`, which a
non-login ssh shell often lacks): write `~/.nodeterm/agent-hooks/cursor.sh` (stdin), then merge into
the host's `~/.cursor/hooks.json` with the local installer's pure `applyCursorHooks` through
`updateRemoteSettingsFile` (content over stdin, lock dir, other tools' entries kept, an unparseable
file left byte-for-byte, a second run writes nothing). A command holding `//` is refused before
anything runs. Tested under a real `/bin/sh` against a fake host tree
(`remote-cursor-hooks.test.ts`). Removal on the host is not built (same as the other remote agents).

### Lost stop

A mid-turn network reconnect dropped `stop` (measured, wave 1). No new timer: the mirror's
`sweepStaleWorking` (core) and the renderer's `sweepStaleWorking` both match `state === 'working'` for
any agent, so a cursor node with a lost `stop` turns `done` after `WORKING_STALE_MS` (20 min) of
silence (pinned in `cursor-approval.test.ts`). `blocked` is not swept, by design (a person may take
long); its clearing event is the `postToolUse`/`stop` of the same turn.

### Device checklist (not verified)

1. A cursor node on the real canvas: NEEDS YOU badge, chime and phone card on the shell dialog;
   back to RUNNING on y.
2. Linux host over SSH: install lands, hooks fire through the tunnel, the remote pane read matches.
3. `Run this command outside the sandbox?` (sandbox on) and the Write/Delete/Read/web dialogs:
   heading text and a `(y)` option as rendered.
4. A very long command preview pushing the heading above the 30-line window (would degrade to RUNNING).
5. Two parallel tool calls with one approval: the other call's `postToolUse` returns the badge to
   RUNNING while the dialog is still up (no re-read).

