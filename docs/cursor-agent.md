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

**No NEEDS YOU.** Measured: the `AskQuestion` tool ran in a headless turn (auto-skipped) and fired
no `preToolUse`/`postToolUse`; Cursor's own approval prompt has no hook either. Guessing one would
strobe (rule 7). A Cursor node shows RUNNING while it waits on a person.

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
6. Any hook for the approval prompt or a live `AskQuestion` (needed for NEEDS YOU).
7. Hook latency inside a node (script backgrounds the POST; expected small).
8. Linux and Windows: hooks.json location, `cursor-agent` install dir.
