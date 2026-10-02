/**
 * NEEDS YOU for Cursor (`cursor-agent`), which has NO hook for its approval prompt.
 *
 * Measured on cursor-agent 2026.09.28-64d2043 (interactive TUI, project-level hooks logger): a
 * pending "Run this command?" dialog is preceded by `preToolUse` (+ `beforeShellExecution`) and
 * then silence; an MCP one by `preToolUse` (+ `beforeMCPExecution`). No event, no payload flag.
 * Approve AND skip both end the call with `postToolUse` for the same `tool_use_id`.
 *
 * So: a cursor `preToolUse` whose `tool_use_id` has no `postToolUse`/`postToolUseFailure` after
 * CURSOR_APPROVAL_DELAY_MS gets ONE pane read (the same `captureSession` the context link uses).
 * If the bottom of the pane holds Cursor's own approval dialog, the node goes `blocked`. The next
 * hook event (postToolUse on approve or skip, stop on Esc) normalizes to `working`/`done` and
 * replaces it. Nothing polls: no pending tool = no timer and no read; one read per tool call, so a
 * long-running approved command never strobes (rule 7).
 *
 * The dialog test is a closed set (rule 7/14): an exact heading line from the bundle's
 * `decision-logic.ts` (`HR`) plus an option line ending in Cursor's approve hint `(y)`. Anything
 * else degrades to nothing: the node keeps RUNNING, exactly as before this file existed.
 *
 * NOT covered: the AskQuestion form ("Clarifying Questions"). Measured: it fires no tool hook at
 * all (no preToolUse, only `stop` on Esc), so there is no pending call to hang a read on.
 */
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { probeWithin } from './pane-probe'

/**
 * Every heading `decision-logic.ts` can render. Measured in the TUI: `Run this command?` (shell)
 * and `Run this MCP tool?` (MCP). Read from the bundle only: the rest (a default-mode file write
 * was auto-approved, measured, so `Write to this file?` needs a stricter user config).
 */
export const CURSOR_APPROVAL_HEADINGS: ReadonlySet<string> = new Set([
  'Run this command?',
  'Run this command outside the sandbox?',
  'Run this MCP tool?',
  'Delete this file?',
  'Write to this file?',
  'Read this file?',
  'Allow this web search?',
  'Allow this web fetch?'
])

/** Wait this long for the matching postToolUse before reading the pane. An auto-allowed tool
 *  posts well inside it; an approval waits on a human. */
export const CURSOR_APPROVAL_DELAY_MS = 1500

/**
 * The dialog sits at the bottom of the screen. Only the last few non-blank lines are looked at, so
 * a dialog left in scrollback by an earlier render cannot answer for the current one.
 * ponytail: fixed window, widen if a taller dialog (long command preview) is ever measured.
 */
const TAIL_LINES = 30

/** Strip the box-drawing border and padding Cursor may draw around a row. */
function bare(line: string): string {
  return line.replace(/^[\s│┃|]+|[\s│┃|]+$/g, '')
}

/** PURE. Does this pane capture end in a Cursor approval dialog? */
export function cursorApprovalIn(text: string): boolean {
  const lines = text.split('\n').map(bare).filter(Boolean).slice(-TAIL_LINES)
  const at = lines.findIndex((l) => CURSOR_APPROVAL_HEADINGS.has(l))
  if (at < 0) return false
  return lines.slice(at + 1).some((l) => l.endsWith('(y)'))
}

export interface CursorApprovalWatchDeps {
  /** The node's pane text ('' or null = cannot see it). */
  readPane: (nodeId: string) => Promise<string | null>
  /** Where the synthetic `blocked` goes: the hook server's normalized listener. */
  emit: (ev: NormalizedAgentEvent) => void
  delayMs?: number
}

export interface CursorApprovalWatch {
  /** Feed every cursor hook payload, after its normalized event was emitted. */
  observe(nodeId: string, payload: Record<string, unknown>, verified: boolean): void
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export function createCursorApprovalWatch(deps: CursorApprovalWatchDeps): CursorApprovalWatch {
  const delay = deps.delayMs ?? CURSOR_APPROVAL_DELAY_MS
  // nodeId → tool_use_id → its timer (null once the one read has been spent).
  const pending = new Map<string, Map<string, ReturnType<typeof setTimeout> | null>>()

  const drop = (nodeId: string, id?: string): void => {
    const calls = pending.get(nodeId)
    if (!calls) return
    for (const [k, t] of calls) {
      if (id !== undefined && k !== id) continue
      if (t) clearTimeout(t)
      calls.delete(k)
    }
    if (!calls.size) pending.delete(nodeId)
  }

  const check = async (nodeId: string, id: string, sessionId: string | undefined, verified: boolean): Promise<void> => {
    const calls = pending.get(nodeId)
    if (!calls?.has(id)) return
    calls.set(id, null)
    const text = await probeWithin(() => deps.readPane(nodeId))
    // Re-check: a postToolUse that landed during the read already ended the call.
    if (!text || !pending.get(nodeId)?.has(id) || !cursorApprovalIn(text)) return
    deps.emit({ nodeId, agentId: 'cursor', sessionId, kind: 'state', state: 'blocked', verified })
  }

  return {
    observe(nodeId, payload, verified) {
      const ev = payload.hook_event_name
      // A subagent's call is ignored, like normalizeCursor ignores it.
      if (str(payload.parent_tool_call_id)) return
      const id = str(payload.tool_use_id)
      if (ev === 'preToolUse' && id) {
        drop(nodeId, id)
        const sessionId = str(payload.conversation_id) ?? str(payload.session_id)
        let calls = pending.get(nodeId)
        if (!calls) pending.set(nodeId, (calls = new Map()))
        calls.set(id, setTimeout(() => void check(nodeId, id, sessionId, verified), delay))
      } else if ((ev === 'postToolUse' || ev === 'postToolUseFailure') && id) {
        drop(nodeId, id)
      } else if (ev === 'stop' || ev === 'beforeSubmitPrompt') {
        drop(nodeId) // turn edge: nothing of the old turn is still waiting
      }
    }
  }
}
