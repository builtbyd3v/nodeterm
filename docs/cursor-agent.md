# Cursor Agent (`cursor-agent`)

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

## Not verified / not built

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
