import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { applyCursorRaw } from './cursor-chat'
import { createCursorSubagentTracker } from './cursor-subagents'
import type { SubagentTail } from './subagent-tail'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { _inboxSnapshot, _resetForTest } from './agent-status-mirror'

// Review 2026-10-02: both shells returned from their first cursor branch, so the subagent tracker
// below it never ran, and a child's tool events re-pointed the node's session (and leaked a tail).
// This replays the captured interactive subagent turn through the ONE step both shells now call.
const fx = JSON.parse(
  readFileSync(path.join(__dirname, '../shared/agents/__fixtures__/cursor/subagent-payloads.json'), 'utf8')
) as { events: Record<string, unknown>[] }
const CONFIG = '/cfg/.cursor'
const ev = fx.events.map((e) =>
  typeof e.transcript_path === 'string'
    ? { ...e, transcript_path: (e.transcript_path as string).replace('<home>/.cursor', CONFIG) }
    : e
)
const PARENT = ev[0].conversation_id as string
const CHILD = ev.find((e) => e.tool_name === 'Read')!.conversation_id as string

function rig(isRemote = false) {
  const emitted: NormalizedAgentEvent[] = []
  const tracked: string[] = []
  const tail: SubagentTail = { track: () => {}, trackFile: () => {}, finish: () => {} }
  const subagents = createCursorSubagentTracker({ tail, emit: (e) => void emitted.push(e), configDir: () => CONFIG })
  const nodeSession = new Map<string, string>()
  const ctx = { track: (id: string) => void tracked.push(id), pathFor: () => undefined }
  const deps = { tail: ctx, subagents, nodeSession, isRemote: () => isRemote }
  return { emitted, tracked, nodeSession, run: (p: Record<string, unknown>) => applyCursorRaw(deps, 'n1', p) }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('applyCursorRaw over the captured subagent turn', () => {
  it('ends the subagent card on the parent stop (the tracker is reachable)', async () => {
    const r = rig()
    for (const e of ev) {
      r.run(e)
      await settle()
    }
    const kinds = r.emitted.map((e) => e.kind)
    expect(kinds).toContain('subagent-end')
  })

  it("keeps the node on the PARENT chat: a child's tool events never re-point it", async () => {
    const r = rig()
    for (const e of ev) {
      r.run(e)
      await settle()
      expect(r.nodeSession.get('n1')).toBe(PARENT)
    }
    expect(r.nodeSession.get('n1')).not.toBe(CHILD)
  })

  it('a remote node still gets subagent cards but no local meter or session association', async () => {
    const r = rig(true)
    for (const e of ev) {
      r.run(e)
      await settle()
    }
    expect(r.emitted.map((e) => e.kind)).toContain('subagent-end')
    expect(r.nodeSession.size).toBe(0)
  })
})

describe("applyCursorRaw feeds the phone's activity line", () => {
  const activity = () => _inboxSnapshot().nodes['n1']?.activity
  it('a parent tool call is the activity, a child one is not, and stop clears it', () => {
    _resetForTest()
    const r = rig(true) // remote too: the line needs no file
    r.run({ hook_event_name: 'preToolUse', conversation_id: PARENT, generation_id: 'g1', tool_name: 'Shell', tool_input: { command: 'npm test' } })
    expect(activity()).toBe('Running npm test')
    r.run(ev.find((e) => e.hook_event_name === 'preToolUse' && e.tool_name === 'Read')!) // the child's Read
    expect(activity()).toBe('Running npm test')
    r.run({ hook_event_name: 'stop', conversation_id: PARENT, status: 'completed' })
    expect(activity()).toBeUndefined()
    _resetForTest()
  })
})

describe('both shells run the shared step and nothing else for cursor', () => {
  it('calls applyCursorRaw and has no second, unreachable cursor branch', () => {
    for (const f of ['src/main/index.ts', 'src/server/agent-status.ts']) {
      const src = readFileSync(path.join(__dirname, '../..', f), 'utf8').replace(/\r\n/g, '\n')
      expect(src, f).toContain('applyCursorRaw(')
      expect(src.match(/agentId === 'cursor'\) \{/g)?.length ?? 0, f).toBe(1)
      expect(src, f).not.toContain('cursorSubagents.onRaw(')
      // Parity for the two fixes the desktop has no harness for (the server's are behavioural tests):
      // the claude branch ignores Cursor's claude.sh payloads, and a closed node releases its Tasks.
      expect(src, f).toContain('if (isCursorPayload(payload)) return')
      expect(src, f).toContain('cursorSubagents.release(nodeId)')
    }
  })
})
