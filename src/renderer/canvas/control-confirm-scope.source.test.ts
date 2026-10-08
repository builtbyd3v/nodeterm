import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { CONFIRM_WAIVABLE_VERBS } from '@shared/control-confirm'

/**
 * STRUCTURAL pins for the canvas-control confirm's "Don't ask again" SCOPE — three radios, visible
 * from the start: ask next time (selected, not a waiver), never again for the agents in the
 * caller's project, or never again in any project until nodeterm quits (@shared/control-confirm
 * `waiveChoices`, whose labels are tested there).
 *
 * Source-level for the usual reason: the dialog is built inline in a 14,000-line component's render
 * and the grant happens in its `onConfirm`, neither of which has a unit seam. The BEHAVIOUR of both
 * halves is proven against real primitives elsewhere — the decision table in
 * `shared/control-confirm.test.ts`, the store write in `state/controlConfirmGate.test.ts`, the
 * Settings row in `AgentsSection.controlConfirm.test.tsx`. What is pinned here is the wiring
 * between them, where a mistake is silent: a waiver granted for the wrong project, granted on a
 * DENIAL, or carried over from the previous dialog.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** How many times a literal appears. Deliberately NOT a regex: the needles here carry `.` and `?`,
 *  and hand-escaping a literal into a pattern is the idiom that quietly drops a character nobody
 *  thought to list (CodeQL's js/incomplete-sanitization caught exactly that here — `\` was missing).
 *  Counting with `split` asks no escaping question at all. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** The control confirm's dialog element, from its option block to its `onCancel`. */
function dialogBody(): string {
  const start = src.indexOf('confirm.waiveVerb\n              ? {')
  expect(start, 'the waive option').toBeGreaterThan(-1)
  const end = src.indexOf('onCancel={() => {', start)
  expect(end, 'the cancel handler after it').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('the "Don’t ask again" scope (source pins)', () => {
  /** One per waivable verb: write, close and open-project each raise this dialog. Derived from the
   *  table so a verb that joins it must bring every pin below with it. */
  const RAISERS = CONFIRM_WAIVABLE_VERBS.size

  it('defaults to "ask" — an untouched dialog grants nothing', () => {
    // A dialog that appeared under the user's hands must not pre-select any waiver. The per-project
    // choice is now VISIBLE from the start (it used to hide behind a checkbox, which read as
    // missing), so this default is the whole of the old guarantee.
    expect(src).toContain(
      "const [controlWaiveChoice, setControlWaiveChoice] = useState<ConfirmWaiveChoice>('ask')"
    )
  })

  it('resets the choice every time the dispatch raises one', () => {
    // A choice carried over from the previous dialog would grant a durable, project-scoped waiver
    // to a user who never picked it this time. Every raiser resets it immediately before raising.
    const resets = [...src.matchAll(/setControlWaiveChoice\('ask'\)\n\s*setConfirm\(\{/g)]
    expect(resets.length, 'every waivable verb resets before raising').toBe(RAISERS)
    // …and nothing else sets a non-default choice: only the dialog's own radios may.
    const sets = [...src.matchAll(/setControlWaiveChoice\(/g)]
    expect(sets.length, 'the resets plus the one radio onChange').toBe(RAISERS + 1)
  })

  it('offers the choices from the shared, tested list, with the project by NAME', () => {
    // Canvas control answers a background agent in its OWN project without moving the user's tab,
    // so "this project" would name whatever they happen to be looking at while the waiver landed
    // somewhere else. `waiveChoices` names it (and drops the choice when there is none).
    const body = dialogBody()
    expect(body).toContain('waiveChoices({')
    expect(body).toContain('id: confirm.waiveProjectId')
    expect(body).toContain('name: confirm.waiveProjectName')
    // Radios from the start (`choice`), not a checkbox whose reaches appear only once ticked.
    expect(src).toMatch(/choice=\{\s*confirm\.waiveVerb/)
    expect(src).not.toMatch(/option=\{\s*confirm\.waiveVerb/)
  })

  it('grants on CONFIRM only — a denial must never widen anything', () => {
    const start = src.indexOf('onConfirm={() => {', src.indexOf('confirm.waiveVerb\n              ? {'))
    const end = src.indexOf('onCancel={() => {', start)
    const onConfirm = src.slice(start, end)
    const onCancel = src.slice(end, src.indexOf('/>', end))
    expect(onConfirm).toContain('waiveControlConfirmForProject(confirm.waiveVerb, confirm.waiveProjectId)')
    expect(onConfirm).toContain('waiveForSession(confirm.waiveVerb)')
    // "ask" is not a waiver: the grant is gated on a choice other than it.
    expect(onConfirm).toContain("controlWaiveChoice !== 'ask'")
    // Nothing that grants anything may appear on the cancel path.
    expect(onCancel).not.toContain('waiveControlConfirmForProject')
    expect(onCancel).not.toContain('waiveForSession')
  })

  it('the durable grant uses the CALLER’s project id, never the active one', () => {
    // `waiveProjectId` is set from `ctlProject`, which is the source's project. Reading
    // `activeProjectId` at the grant site would waive the confirm in the project the human is
    // looking at — a waiver in the wrong repo, which is the exact failure this scope prevents.
    const onConfirm = src.slice(
      src.indexOf('onConfirm={() => {', src.indexOf('confirm.waiveVerb\n              ? {')),
      src.indexOf('onCancel={() => {', src.indexOf('confirm.waiveVerb\n              ? {'))
    )
    expect(onConfirm).not.toContain('activeProjectId')
    for (const field of ['waiveProjectId: ctlProject?.id', 'waiveProjectName: ctlProject?.name']) {
      expect(countOf(src, field), field).toBe(RAISERS)
    }
  })

  it('a failed durable grant falls back to the app-run waiver, never to nothing', () => {
    // `waiveControlConfirmForProject` returns false when no project owns the call. Losing the
    // choice there would silently give the user nothing — and they would find out by being asked
    // again on the very next call.
    const onConfirm = src.slice(
      src.indexOf('onConfirm={() => {', src.indexOf('confirm.waiveVerb\n              ? {')),
      src.indexOf('onCancel={() => {', src.indexOf('confirm.waiveVerb\n              ? {'))
    )
    expect(onConfirm).toMatch(/if \(!scoped\) useControlConfirm\.getState\(\)\.waiveForSession/)
  })

  it('the gate is asked about the CALLER’s project, in every waivable case', () => {
    // The per-project waiver AND the permission mode the bypass lock reads both belong to the
    // project the call acts on. Off canvas that is not the active one — and `open-project` runs
    // before the dispatch's own `ctlProject`, so it resolves the caller's project itself under the
    // same name.
    expect(countOf(src, 'controlConfirmDecision(verb, ctlProject?.id)')).toBe(RAISERS)
    expect(src).not.toMatch(/controlConfirmDecision\(verb\)/)
  })

  it('the waived NOTICE names the project, in every case', () => {
    // Losing the dialog must not mean losing the record, and "which waiver let this through" is
    // the part of the record that lets a user revoke the right one.
    const calls = src.split('waivedNotice(').slice(1)
    expect(calls.length).toBe(RAISERS)
    for (const call of calls) {
      // The project name is the call's LAST argument — read the call up to its own closing paren.
      const head = call.slice(0, 400)
      expect(head, 'every notice passes the project name').toMatch(/ctlProject\?\.name\s*\)/)
    }
  })
})
