// FIXTURE PROVENANCE: `__fixtures__/cursor/hook-payloads.json` was captured live from
// cursor-agent 2026.09.28-64d2043 (headless runs, macOS). It holds NO `beforeSubmitPrompt`, `stop`
// or `postToolUseFailure`: headless runs never fired the first two. Those three cases below use
// payloads built from the bundle's proto, and say so: they pin OUR reading, not Cursor's wire.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { normalizeClaude, normalizeCursor, normalizeFor, type RawHookEnvelope } from './normalize'

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__/cursor/hook-payloads.json'), 'utf8')
) as { events: Record<string, unknown>[] }

const pick = (name: string, ok?: (p: Record<string, unknown>) => boolean) => {
  const hit = fixture.events.filter((e) => e.hook_event_name === name && (ok ? ok(e) : true))
  if (hit.length !== 1) throw new Error(`fixture needs exactly one ${name}, got ${hit.length}`)
  return hit[0]
}
const env = (payload: Record<string, unknown>): RawHookEnvelope => ({ nodeId: 'n1', agentId: 'cursor', payload })
const CONV = '5a27c746-14a7-472d-8e3f-7f335a9df0db'

describe('normalizeCursor over captured cursor-agent payloads', () => {
  it('records conversation_id (== session_id on the wire) as the session id', () => {
    const e = pick('preToolUse')
    expect(e.conversation_id).toBe(e.session_id)
    expect(normalizeCursor(env(e))).toEqual({ nodeId: 'n1', agentId: 'cursor', sessionId: CONV, kind: 'state', state: 'working' })
    // Either spelling alone is enough.
    expect(normalizeCursor(env({ hook_event_name: 'postToolUse', session_id: 's' }))?.sessionId).toBe('s')
    expect(normalizeCursor(env({ hook_event_name: 'postToolUse' }))?.sessionId).toBeUndefined()
  })

  it('maps tool events to working', () => {
    expect(normalizeCursor(env(pick('postToolUse')))?.state).toBe('working')
  })

  it('ignores every captured event it does not subscribe to', () => {
    for (const n of ['sessionStart', 'sessionEnd', 'beforeShellExecution', 'afterShellExecution', 'afterAgentThought'])
      for (const e of fixture.events.filter((x) => x.hook_event_name === n)) expect(normalizeCursor(env(e)), n).toBeNull()
  })

  it('matches the event name exactly, never as a substring', () => {
    for (const n of ['PreToolUse', 'pretooluse', 'preToolUseX', 'stopped', 'beforeSubmitPromptNow', '', 5])
      expect(normalizeCursor(env({ hook_event_name: n, conversation_id: 'c' })), String(n)).toBeNull()
    expect(normalizeCursor(env({}))).toBeNull()
  })

  it('a subagent tool call (parent_tool_call_id) drives nothing and records no session', () => {
    // UNMEASURED marker, from the bundle's PreToolUseRequestQuery field 10.
    const child = { hook_event_name: 'preToolUse', conversation_id: 'child', parent_tool_call_id: 't1' }
    expect(normalizeCursor(env(child))).toBeNull()
    expect(normalizeCursor(env({ ...child, parent_tool_call_id: undefined }))?.state).toBe('working')
  })

  it('beforeSubmitPrompt starts a turn (built from the bundle schema, never captured)', () => {
    expect(normalizeCursor(env({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c', prompt: 'x' }))).toEqual({
      nodeId: 'n1', agentId: 'cursor', sessionId: 'c', kind: 'state', state: 'working', newTurn: true
    })
  })

  it('stop ends the turn; aborted is interrupted, error is errored, anything else is plain done (never captured)', () => {
    const stop = (status?: unknown) => normalizeCursor(env({ hook_event_name: 'stop', conversation_id: 'c', status }))
    expect(stop('completed')).toEqual({ nodeId: 'n1', agentId: 'cursor', sessionId: 'c', kind: 'state', state: 'done' })
    expect(stop('aborted')?.interrupted).toBe(true)
    expect(stop('aborted')?.errored).toBeUndefined()
    expect(stop('error')?.errored).toBe(true)
    expect(stop('error')?.interrupted).toBeUndefined()
    expect(stop('surprise')).toMatchObject({ state: 'done' })
    expect(stop(undefined)).toMatchObject({ state: 'done' })
  })

  it('never claims NEEDS YOU (no measured signal exists)', () => {
    for (const e of fixture.events) {
      const r = normalizeCursor(env(e))
      expect(r?.state === 'waiting' || r?.state === 'blocked').toBe(false)
    }
  })

  it('is what the hook server dispatches for the cursor route', () => {
    expect(normalizeFor('cursor', env(pick('preToolUse')))?.state).toBe('working')
  })

  it('cross-fire is inert: nodeterm\'s claude hook also runs under cursor and finds nothing it knows', () => {
    // cursor-agent loads ~/.claude/settings.json hooks (measured: a matcher-bearing claude-format
    // project file fired on cursor's preToolUse/postToolUse/sessionStart), so /hook/claude receives
    // cursor's camelCase payloads for the same node. normalizeClaude compares exact PascalCase names.
    for (const e of fixture.events)
      expect(normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: e }), String(e.hook_event_name)).toBeNull()
    for (const n of ['beforeSubmitPrompt', 'stop', 'postToolUseFailure'])
      expect(normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hook_event_name: n, session_id: 'c' } }), n).toBeNull()
  })
})
