import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { submitsSeparately } from '../shared/agents/config'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

vi.mock('child_process', () => ({
  execFile: (_f: string, _a: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as ((e: null, r: { stdout: string; stderr: string }) => void) | undefined
    cb?.(null, { stdout: '', stderr: '' })
    return {}
  },
  execFileSync: (): string => ''
}))
vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
vi.mock('node-pty', () => ({ spawn: () => ({}) }))

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

/** The two tmux calls a separate-submit send makes, recorded in order on a real PtyManager. */
interface Internals {
  agentByKey: Map<string, string>
  liveSessionForPersistKey(k: string): unknown
  deliverText(k: string, text: string, enter: boolean): Promise<true | false | 'pasted-not-submitted'>
  sendText(k: string, text: string, opts?: { enter?: boolean }): Promise<unknown>
}

describe('PtyManager.sendText: overlapping separate-submit sends do not interleave (review 2026-10-03)', () => {
  beforeEach(() => {
    initPlatform(fakePlatform())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function rig(agent: string, paste: (text: string) => true | false = () => true) {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager() as unknown as Internals
    mgr.agentByKey.set('n1', agent)
    mgr.liveSessionForPersistKey = () => ({})
    const calls: [string, boolean][] = []
    mgr.deliverText = async (_k, text, enter) => {
      calls.push([text, enter])
      return text ? paste(text) : true
    }
    return { mgr, calls }
  }

  it('cursor: paste1, Enter, paste2, Enter', async () => {
    const { mgr, calls } = await rig('cursor')
    const sends = Promise.all([mgr.sendText('n1', 'first'), mgr.sendText('n1', 'second')])
    await vi.advanceTimersByTimeAsync(400)
    expect(await sends).toEqual([true, true])
    expect(calls).toEqual([
      ['first', false],
      ['', true],
      ['second', false],
      ['', true]
    ])
  })

  it('a failed paste keeps its own result and does not stall the next send', async () => {
    const { mgr, calls } = await rig('cursor', (t) => t !== 'first')
    const sends = Promise.all([mgr.sendText('n1', 'first'), mgr.sendText('n1', 'second')])
    await vi.advanceTimersByTimeAsync(400)
    expect(await sends).toEqual([false, true])
    expect(calls).toEqual([
      ['first', false],
      ['second', false],
      ['', true]
    ])
  })

  it('claude keeps its one-shot paste+Enter, unchained', async () => {
    const { mgr, calls } = await rig('claude')
    expect(await Promise.all([mgr.sendText('n1', 'first'), mgr.sendText('n1', 'second')])).toEqual([true, true])
    expect(calls).toEqual([
      ['first', true],
      ['second', true]
    ])
  })
})

describe('PtyManager forgets a deleted node\'s agent', () => {
  it('drops agentByKey on delete, keeps it across a recycle', () => {
    const end = src.slice(src.indexOf("if (intent === 'delete') {"), src.indexOf('} else this.tombstones.delete(persistKey)'))
    expect(end).toContain('this.agentByKey.delete(persistKey)')
  })
})
