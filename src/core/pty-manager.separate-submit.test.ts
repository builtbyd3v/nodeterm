import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { submitsSeparately } from '../shared/agents/config'

// Review 2026-10-02: cursor ignores an Enter bundled into the same tmux invocation as a bracketed
// paste, and only the rename path split it, so chat sends, phone sends, canvas `write` and trigger
// deliveries to a Cursor node sat unsubmitted. The split now lives in the ONE funnel every one-way
// writer reaches, `PtyManager.sendText`. A full PtyManager rig is out of reach here, so this pins
// the wiring at source level; the behaviour itself was checked live (chat send to a Cursor node).
const src = readFileSync(path.join(__dirname, 'pty-manager.ts'), 'utf8').replace(/\r\n/g, '\n')
const sendText = src.slice(src.indexOf('  async sendText('), src.indexOf('  private async deliverText('))

describe('PtyManager.sendText separate submit', () => {
  it('cursor is the agent that needs it, and the pane learns its agent at create', () => {
    expect(submitsSeparately('cursor')).toBe(true)
    expect(submitsSeparately('claude')).toBe(false)
    expect(src).toMatch(/if \(options\.agentId\) this\.agentByKey\.set\(key, options\.agentId\)/)
  })

  it('pastes without Enter, then sends a bare Enter, on the tmux paths only', () => {
    expect(sendText).toContain('submitsSeparately(capabilityAgentId(')
    expect(sendText).toContain("this.deliverText(persistKey, text, false, live)")
    expect(sendText).toContain("this.deliverText(persistKey, '', true, live)")
    expect(sendText).toContain('!live?.nativeWindowsPane')
    expect(sendText).toContain('!live?.sessionHost')
    // A paste that landed but whose Enter did not is never reported as delivered.
    expect(sendText).toContain("'pasted-not-submitted'")
  })
})
