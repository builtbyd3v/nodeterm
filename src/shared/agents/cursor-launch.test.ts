import { describe, expect, it } from 'vitest'
import { AGENT_BINARIES } from './pane-owner-predicate'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from './config'
import { assembleLaunchCommand, assembleResumeCommand } from './launch'

// cursor-agent's usage is `agent [options] [command] [prompt...]`, and measured on 2026.09.23 its
// parser ignores `--` for subcommand dispatch (`cursor-agent -- whoami` still runs whoami). The
// prompt therefore rides behind the `agent` subcommand, which has no subcommands of its own.
describe('cursor launch line', () => {
  const launch = (initialPrompt?: string) =>
    assembleLaunchCommand({ agentId: 'cursor', initialPrompt }, {}).command

  it('is offered as a builtin that runs cursor-agent, never the ambiguous `agent` alias', () => {
    expect(BUILTIN_AGENT_IDS).toContain('cursor')
    expect(AGENT_CONFIG.cursor.launchCmd).toBe('cursor-agent')
    expect(AGENT_BINARIES.cursor).toEqual(['cursor-agent'])
  })

  it('puts a one-word prompt that names a subcommand behind `agent`', () => {
    expect(launch('login')).toBe("cursor-agent agent 'login'")
    expect(launch('update')).toBe("cursor-agent agent 'update'")
  })

  it('launches bare with no prompt', () => {
    expect(launch()).toBe('cursor-agent')
  })

  // MEASURED (cursor-agent 2026.09.28): root flags reach the session from BEFORE `agent` (real run:
  // `--model composer-2.5 --force agent '<prompt>'` ran the shell command unprompted, footer "Run
  // Everything"). So the composed line is `cursor-agent [flags] agent '<prompt>'`, never flags last.
  it('puts model and permission flags BEFORE the `agent` separator', () => {
    const line = (inputs: object): string =>
      assembleLaunchCommand({ agentId: 'cursor', initialPrompt: 'hi', ...inputs }, {}).command
    expect(line({ permissionMode: 'bypassPermissions' })).toBe("cursor-agent --force agent 'hi'")
    expect(line({ permissionMode: 'plan', model: 'composer-2.5' })).toBe(
      "cursor-agent --mode plan --model 'composer-2.5' agent 'hi'"
    )
    // The default mode is bare: nothing widens on upgrade.
    expect(line({ permissionMode: 'auto' })).toBe("cursor-agent agent 'hi'")
    expect(
      assembleLaunchCommand({ agentId: 'cursor', permissionMode: 'plan', model: 'composer-2.5' }, {})
        .command
    ).toBe("cursor-agent --mode plan --model 'composer-2.5'")
  })

  it('flags a relaunch through the same funnel (cursor is not resumable)', () => {
    expect(
      assembleResumeCommand({ agentId: 'cursor', permissionMode: 'bypassPermissions' }, {}).command
    ).toBe('cursor-agent --force')
  })
})
