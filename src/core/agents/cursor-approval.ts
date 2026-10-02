/**
 * NEEDS YOU for Cursor (`cursor-agent`), which has NO hook for its approval prompt.
 *
 * Measured on cursor-agent 2026.09.28-64d2043 (interactive TUI, project-level hooks logger): a
 * pending "Run this command?" dialog is preceded by `preToolUse` (+ `beforeShellExecution`) and
 * then silence; an MCP one by `preToolUse` (+ `beforeMCPExecution`). No event, no payload flag.
 * Approve AND skip both end the call with `postToolUse` for the same `tool_use_id`.
 *
 * So: a cursor `preToolUse` whose `tool_use_id` has no `postToolUse`/`postToolUseFailure` gets a
 * pane read at each of CURSOR_APPROVAL_READS_MS (the same `captureSession` the context link uses),
 * stopping at the first that shows Cursor's own approval dialog: the node goes `blocked`. The next
 * hook event (postToolUse on approve or skip, stop on Esc) normalizes to `working`/`done` and
 * replaces it. Nothing polls open-endedly: no pending tool = no timer and no read; at most
 * CURSOR_APPROVAL_READS_MS.length reads per tool call and `blocked` is emitted once, so a
 * long-running approved command never strobes (rule 7).
 *
 * Why more than one read: MEASURED in the dev app (2026-10-02), a single read 1.5 s after
 * `preToolUse` found no dialog yet and the node sat on RUNNING while the dialog waited ~30 s; the
 * same pane text captured later matched. The dialog's draw time is not ours to know.
 *
 * The dialog test is a closed set (rule 7/14): an exact heading line from the bundle's
 * `decision-logic.ts` (`HR`) plus an option line ending in Cursor's approve hint `(y)`. Anything
 * else degrades to nothing: the node keeps RUNNING, exactly as before this file existed.
 *
 * A SUBAGENT's tool call is watched too: its dialog is drawn on the parent's pane. Its `blocked` (and
 * the `working` that clears it, since normalizeCursor drops child events) carries the PARENT's chat id.
 * A parent `stop` with status `completed` arms the same reads for plan mode's `Ready to build?`.
 *
 * NOT covered: the AskQuestion form ("Clarifying Questions"). Measured: it fires no tool hook at
 * all (no preToolUse, only `stop` on Esc), so there is no pending call to hang a read on.
 */
import { isCursorChildToolEvent, type NormalizedAgentEvent } from '../../shared/agents/normalize'
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

/** Wait this long for the matching postToolUse before the first pane read. An auto-allowed tool
 *  posts well inside it; an approval waits on a human. */
export const CURSOR_APPROVAL_DELAY_MS = 1500
/** When (ms after `preToolUse`) a still-pending call reads the pane; the first match wins.
 *  ponytail: fixed bounded schedule; a dialog first drawn after the last read stays RUNNING. */
export const CURSOR_APPROVAL_READS_MS: readonly number[] = [CURSOR_APPROVAL_DELAY_MS, 4000, 10000]

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

/** PURE. Does the bottom of this capture hold one of `headings` followed by an option ending `hint`? */
function dialogIn(text: string, headings: ReadonlySet<string>, hint: string): boolean {
  const lines = text.split('\n').map(bare).filter(Boolean).slice(-TAIL_LINES)
  const at = lines.findIndex((l) => headings.has(l))
  if (at < 0) return false
  return lines.slice(at + 1).some((l) => l.endsWith(hint))
}

/** PURE. Does this pane capture end in a Cursor approval dialog? */
export function cursorApprovalIn(text: string): boolean {
  return dialogIn(text, CURSOR_APPROVAL_HEADINGS, '(y)')
}

/**
 * Plan mode's hand-off. MEASURED on 2026.10.01-e373342 (`--mode plan`): the turn ENDS (`stop`,
 * status `completed`, normalized `done`) and then the pane shows `Ready to build?` /
 * `→ 1. Yes, build locally (b)` / [`2. Yes, build in cloud (c)`] / `No, propose changes (p or Esc)`.
 * No hook marks it. Claude's equivalent (ExitPlanMode, a PermissionRequest) is `blocked`, so this is
 * too. Answering `b` fires no beforeSubmitPrompt; the build's first parent tool event clears it.
 */
export const CURSOR_PLAN_HEADINGS: ReadonlySet<string> = new Set(['Ready to build?'])

/** A plan box border row once `bare` has stripped its side bars. */
const BORDER = /^[─━└┘╰╯┌┐╭╮\s]+$/

/**
 * PURE. Does this pane capture END in plan mode's "Ready to build?" prompt? Stricter than the
 * approval test: the answered prompt STAYS in the transcript, and measured, the build's own `stop`
 * found it 30 lines up with the finished build below it. So nothing but option rows (ending in a
 * `(key)` hint) and the box border may follow the heading.
 */
export function cursorPlanPromptIn(text: string): boolean {
  const lines = text.split('\n').map(bare).filter(Boolean).slice(-TAIL_LINES)
  let at = lines.length - 1
  while (at >= 0 && !CURSOR_PLAN_HEADINGS.has(lines[at])) at--
  if (at < 0) return false
  const tail = lines.slice(at + 1)
  return tail.some((l) => l.endsWith('(b)')) && tail.every((l) => /\([^()]*\)$/.test(l) || BORDER.test(l))
}

export interface CursorApprovalWatchDeps {
  /** The node's pane text ('' or null = cannot see it). */
  readPane: (nodeId: string) => Promise<string | null>
  /** Where the synthetic `blocked` goes: the hook server's normalized listener. */
  emit: (ev: NormalizedAgentEvent) => void
  delayMs?: number
  /** Override the whole read schedule (tests). Default CURSOR_APPROVAL_READS_MS, or [delayMs]. */
  readsMs?: readonly number[]
}

export interface CursorApprovalWatch {
  /** Feed every cursor hook payload, after its normalized event was emitted. */
  observe(nodeId: string, payload: Record<string, unknown>, verified: boolean): void
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** The pending key of the one plan-prompt watch per node (a tool_use_id is never empty). */
const PLAN = ''

interface Pending {
  /** The next read, null while a read is in flight or once the reads are spent. */
  timer: ReturnType<typeof setTimeout> | null
  /** A SUBAGENT's tool call: normalizeCursor drops its events, so this watch also clears its block. */
  child: boolean
  /** `blocked` was emitted for it (at most once). */
  blocked: boolean
}

export function createCursorApprovalWatch(deps: CursorApprovalWatchDeps): CursorApprovalWatch {
  const reads = deps.readsMs ?? (deps.delayMs !== undefined ? [deps.delayMs] : CURSOR_APPROVAL_READS_MS)
  // nodeId → tool_use_id (or PLAN) → its watch.
  const pending = new Map<string, Map<string, Pending>>()
  // nodeId → the PARENT chat id, learned from the parent's own events. A synthetic event for a
  // child's call carries this, never the child's id, which would overwrite the node's resume id.
  const parentSession = new Map<string, string>()
  // Nodes this watch has put in `blocked`. One dialog is one `blocked`, however many pending
  // watches see it (measured: a parent call and a child call both read the child's dialog).
  const blockedNodes = new Set<string>()

  const drop = (nodeId: string, id?: string): void => {
    const calls = pending.get(nodeId)
    if (!calls) return
    if (id === undefined) blockedNodes.delete(nodeId)
    for (const [k, p] of calls) {
      if (id !== undefined && k !== id) continue
      if (p.timer) clearTimeout(p.timer)
      calls.delete(k)
    }
    if (!calls.size) pending.delete(nodeId)
  }

  const emit = (nodeId: string, state: 'blocked' | 'working', verified: boolean): void => {
    const sessionId = parentSession.get(nodeId)
    deps.emit({ nodeId, agentId: 'cursor', ...(sessionId ? { sessionId } : {}), kind: 'state', state, verified })
  }

  const check = async (nodeId: string, id: string, verified: boolean, step: number): Promise<void> => {
    const p = pending.get(nodeId)?.get(id)
    if (!p) return
    p.timer = null
    const text = await probeWithin(() => deps.readPane(nodeId))
    // Re-check: a post (or a new turn) that landed during the read already ended the watch.
    if (pending.get(nodeId)?.get(id) !== p) return
    if (text && (id === PLAN ? cursorPlanPromptIn(text) : cursorApprovalIn(text))) {
      p.blocked = true
      if (!blockedNodes.has(nodeId)) emit(nodeId, 'blocked', verified)
      blockedNodes.add(nodeId)
      return // emitted once; the call stays pending only so a post can still end it
    }
    const next = step + 1
    if (next >= reads.length) return
    p.timer = setTimeout(() => void check(nodeId, id, verified, next), reads[next] - reads[step])
  }

  const arm = (nodeId: string, id: string, child: boolean, verified: boolean): void => {
    drop(nodeId, id)
    let calls = pending.get(nodeId)
    if (!calls) pending.set(nodeId, (calls = new Map()))
    const p: Pending = { timer: null, child, blocked: false }
    calls.set(id, p)
    p.timer = setTimeout(() => void check(nodeId, id, verified, 0), reads[0])
  }

  return {
    observe(nodeId, payload, verified) {
      const ev = payload.hook_event_name
      const isTool = ev === 'preToolUse' || ev === 'postToolUse' || ev === 'postToolUseFailure'
      // A subagent's tool call (the SAME predicate normalizeCursor uses: captured children carry no
      // parent_tool_call_id, only generation_id === conversation_id). Its approval dialog is drawn on
      // the PARENT's pane (measured 2026.10.01), so it is watched like the parent's own, but its id
      // never names the node's session. Any other child-looking event is ignored, as before.
      const child = isCursorChildToolEvent(payload)
      if (child && !isTool) return
      if (!child) {
        const sid = str(payload.conversation_id) ?? str(payload.session_id)
        if (sid) parentSession.set(nodeId, sid)
        // A parent tool event normalizes to `working`, which already replaced any block.
        if (isTool) blockedNodes.delete(nodeId)
      }
      const id = str(payload.tool_use_id)
      if (ev === 'preToolUse' && id) {
        drop(nodeId, PLAN) // the agent is building after all
        // The parent's `Task` never gets a postToolUse (measured), so a read hung on it could only
        // see its CHILD's dialog, which the child's own call already watches and later clears.
        if (!child && payload.tool_name === 'Task') return
        arm(nodeId, id, child, verified)
      } else if ((ev === 'postToolUse' || ev === 'postToolUseFailure') && id) {
        const p = pending.get(nodeId)?.get(id)
        drop(nodeId, id)
        if (!p?.blocked) return
        const stillBlocked = [...(pending.get(nodeId)?.values() ?? [])].some((q) => q.blocked)
        if (stillBlocked) return
        blockedNodes.delete(nodeId)
        // The parent's own post normalizes to `working`; a child's normalizes to nothing, so the
        // block this watch raised would stick without this.
        if (p.child) emit(nodeId, 'working', verified)
      } else if (ev === 'sessionEnd') {
        drop(nodeId)
        parentSession.delete(nodeId)
      } else if (ev === 'stop' || ev === 'beforeSubmitPrompt') {
        drop(nodeId) // turn edge: nothing of the old turn is still waiting
        // A completed turn may end on plan mode's "Ready to build?": the same bounded reads.
        if (ev === 'stop' && payload.status === 'completed') arm(nodeId, PLAN, false, verified)
      }
    }
  }
}
