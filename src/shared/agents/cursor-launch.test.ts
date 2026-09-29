import { describe, expect, it } from 'vitest'
import { AGENT_BINARIES } from './pane-owner-predicate'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from './config'
import { assembleLaunchCommand } from './launch'

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
})
