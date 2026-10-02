import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCursorApprovalWatch,
  cursorApprovalIn,
  CURSOR_APPROVAL_DELAY_MS,
  CURSOR_APPROVAL_READS_MS
} from './cursor-approval'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { _resetForTest, mirrorEntry, recordAgentEvent, sweepStaleWorking } from '../agent-status-mirror'
import { WORKING_STALE_MS } from '../../shared/agents/stale'
import { decideDelivery } from './agent-message-decide'

// Captured from cursor-agent 2026.09.28-64d2043 in tmux (capture-pane -p), blank lines dropped.
const SHELL = `  Run the shell command: touch approve-me.txt (use the shell tool, nothing else)
  $ touch approve-me.txt Waiting for approval...
────────────────────────────────────────────────────────────
 $  touch approve-me.txt in .
 Run this command?
 Not in allowlist: touch
  → Run (once) (y)
    Add Shell(touch) to allowlist? (tab)
    Run Everything (shift+tab)
    Skip & tell the agent what to do instead (esc or n)
`
const MCP = `  Call the MCP tool ping from the ntc server once. Nothing else.
    Explored available MCP tools ntc · ping
    ntc ping
────────────────────────────────────────────────────────────
 ntc: ping
 Run this MCP tool?
  → Run (once) (y)
    Allowlist MCP Tool (tab)
    Reject & propose changes (p)
    Skip (esc or n)
`
const ASK = ` ┌──────────────────────────────┐
 │ Clarifying Questions         │
 │ Question 1 of 1              │
 │ 1. Red or blue?              │
 │   › [ ] Red                  │
 │ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip │
 └──────────────────────────────┘
`
const RUNNING = `  Run the shell command: sleep 30
  $ sleep 30 5s
  → Add a follow-up
  Composer 2.5 · 11.5%
`

describe('cursorApprovalIn', () => {
  it('matches the measured shell and MCP dialogs', () => {
    expect(cursorApprovalIn(SHELL)).toBe(true)
    expect(cursorApprovalIn(MCP)).toBe(true)
  })
  it('matches a bordered heading', () => {
    expect(cursorApprovalIn(' │ Delete this file? │\n │  → Delete (y) │\n')).toBe(true)
  })
  it('refuses a running tool, the AskQuestion form, prose, and a heading with no (y) option', () => {
    expect(cursorApprovalIn(RUNNING)).toBe(false)
    expect(cursorApprovalIn(ASK)).toBe(false)
    expect(cursorApprovalIn('the model said: Run this command? (y)')).toBe(false)
    expect(cursorApprovalIn(' Run this command?\n Not in allowlist: touch\n')).toBe(false)
    expect(cursorApprovalIn('')).toBe(false)
  })
  it('ignores a dialog that scrolled out of the bottom window', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(cursorApprovalIn(`${SHELL}${filler}\n`)).toBe(false)
  })
})

describe('createCursorApprovalWatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (pane: string | null = SHELL) => {
    const readPane = vi.fn(async () => pane)
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    const post = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
      watch.observe('n1', { hook_event_name, conversation_id: 'c1', ...extra }, true)
    return { readPane, emitted, post }
  }

  it('a pending tool past the delay reads the pane once and goes blocked', async () => {
    const { readPane, emitted, post } = setup()
    post('preToolUse', { tool_use_id: 't1', tool_name: 'Shell' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS - 1)
    expect(readPane).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(readPane).toHaveBeenCalledWith('n1')
    expect(emitted).toEqual([
      { nodeId: 'n1', agentId: 'cursor', sessionId: 'c1', kind: 'state', state: 'blocked', verified: true }
    ])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(1) // never polls
  })

  it('a tool that posts in time costs nothing', async () => {
    const { readPane, emitted, post } = setup()
    post('preToolUse', { tool_use_id: 't1' })
    post('postToolUse', { tool_use_id: 't1' })
    post('preToolUse', { tool_use_id: 't2' })
    post('postToolUseFailure', { tool_use_id: 't2' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).not.toHaveBeenCalled()
    expect(emitted).toEqual([])
  })

  it('stop and a new prompt drop every pending call of the node', async () => {
    const { readPane, post } = setup()
    post('preToolUse', { tool_use_id: 't1' })
    post('stop')
    post('preToolUse', { tool_use_id: 't2' })
    post('beforeSubmitPrompt')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).not.toHaveBeenCalled()
  })

  it('a long approved command (no dialog on screen) stays quiet after a bounded number of reads', async () => {
    const { readPane, emitted, post } = setup(RUNNING)
    post('preToolUse', { tool_use_id: 't1' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(CURSOR_APPROVAL_READS_MS.length)
    expect(emitted).toEqual([])
  })

  it('a dialog drawn after the first read is caught by a later one, and emitted once', async () => {
    // Measured in the dev app: the first read 1.5 s after preToolUse saw no dialog yet.
    let n = 0
    const readPane = vi.fn(async () => (++n === 1 ? RUNNING : SHELL))
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    watch.observe('n1', { hook_event_name: 'preToolUse', tool_use_id: 't1', conversation_id: 'c1' }, true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(2)
    expect(emitted.map((e) => e.state)).toEqual(['blocked'])
  })

  it('a post that lands during the read wins', async () => {
    let release: (s: string) => void = () => {}
    const readPane = vi.fn(() => new Promise<string>((r) => (release = r)))
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    watch.observe('n1', { hook_event_name: 'preToolUse', tool_use_id: 't1' }, true)
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    watch.observe('n1', { hook_event_name: 'postToolUse', tool_use_id: 't1' }, true)
    release(SHELL)
    await vi.advanceTimersByTimeAsync(0)
    expect(emitted).toEqual([])
  })

  it('an unreadable pane and a subagent call degrade to nothing', async () => {
    const { readPane, emitted, post } = setup(null)
    post('preToolUse', { tool_use_id: 't1' })
    post('preToolUse', { tool_use_id: 't2', parent_tool_call_id: 'p' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(CURSOR_APPROVAL_READS_MS.length) // t1 only; t2 never read
    expect(emitted).toEqual([])
  })
})

describe('a cursor blocked through the mirror and the messaging gate', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('holds blocked until the next hook event, and messaging refuses it meanwhile', () => {
    const base = { nodeId: 'n9', agentId: 'cursor', sessionId: 'c1', kind: 'state' as const, verified: true }
    recordAgentEvent({ ...base, state: 'working', newTurn: true })
    recordAgentEvent({ ...base, state: 'working' }) // preToolUse
    const out = recordAgentEvent({ ...base, state: 'blocked' }) // the watch's synthetic event
    expect(out.state).toBe('blocked')
    const entry = mirrorEntry('n9')
    expect(entry?.state).toBe('blocked')
    const o = decideDelivery({ targetLive: true, pane: 'agent', target: entry, tokenFilePresent: true, pasteAware: true })
    expect(o).toEqual({ kind: 'targetBusy', state: 'blocked' })
    recordAgentEvent({ ...base, state: 'working' }) // postToolUse after y / n
    expect(mirrorEntry('n9')?.state).toBe('working')
  })

  it('a lost stop (network reconnect) is caught by the existing WORKING_STALE_MS sweep', () => {
    recordAgentEvent({ nodeId: 'n8', agentId: 'cursor', sessionId: 'c2', kind: 'state', state: 'working', newTurn: true })
    const at = mirrorEntry('n8')!.updatedAt
    expect(sweepStaleWorking(at + WORKING_STALE_MS)).toEqual([])
    expect(sweepStaleWorking(at + WORKING_STALE_MS + 1)).toEqual(['n8'])
    expect(mirrorEntry('n8')?.state).toBe('done')
  })
})
