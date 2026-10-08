import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isDestructiveVerb, DESTRUCTIVE_VERBS } from '@shared/control-verbs'
import { CONFIRM_WAIVABLE_VERBS, isWaivableVerb } from '@shared/control-confirm'

/**
 * A STRUCTURAL test on purpose.
 *
 * `DESTRUCTIVE` / `isDestructiveVerb` named `write` and `close` as "the confirm-gated set" and was
 * read by nothing but its own unit test — it could not be anything else, because it lived in
 * `src/main` and the dispatch is in the renderer, which cannot import from there. The refusal was
 * a hand-written `if (confirmBusy())` inside each of the two `switch (verb)` cases, so the SET
 * decided nothing, while `TOLERANT_CONTROL_VERBS`' doc comment, `hook-server.ts`'s `buildPtyEnv`
 * note and `docs/node-identity.md:65` all name it as what decides.
 *
 * WHAT THIS FILE IS: a drift alarm, not proof of a gate. The dialog is still hand-written in each
 * case, so these assertions cannot show that a verb IS confirmed — only that the set and the cases
 * that read it still agree, in both directions. That is the thing that had already broken once.
 * `close-worktree --mode remove` is confirmed by a human through `requestRemoveWorktree` and is
 * deliberately outside the set, so it is invisible here by design.
 *
 * Structural because there is no unit seam — the switch lives inside a 7000-line React component's
 * IPC listener — and because the failure mode being pinned is exactly "a reader trusts the
 * constant", which is a property of the SOURCE. So the source is the subject.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

/** The body of one `case '<verb>': {` in the control dispatch, up to the next case label. */
function caseBody(verb: string): string {
  const start = src.indexOf(`case '${verb}': {`)
  if (start === -1) return ''
  const rest = src.slice(start + verb.length + 10)
  const end = rest.search(/\n {10}case '/)
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * Every verb dispatched BEFORE the `switch (verb)` — derived from the source, never listed here.
 *
 * The list used to be hand-written (`['open-project']`, then `['open-project', 'settings']`), and
 * that is a trap with a confusing failure: the final assertion below compares the gated verbs it
 * FINDS against `DESTRUCTIVE_VERBS`, so an early-handled verb missing from the list makes a
 * CORRECT implementation red with "two Sets differ" and no hint that a list in the test is the
 * problem. It fails closed, which is the right direction, and it costs a diagnosis every time.
 *
 * COMPOUND GUARDS are the reason this is not a one-line regex: `send`/`reply`/`notify` share a
 * single `if (verb === 'send' || verb === 'reply' || verb === 'notify')`, so a scan keyed on
 * `if (verb === '<verb>')` discovers `send` and silently misses the other two.
 */
const EARLY_GUARD_RE = /\n {6}if \(verb === '([a-z-]+)'((?: \|\| verb === '[a-z-]+')*)\)/g

/** verb → the index in `src` where its early-handled guard begins (shared for a compound guard). */
function earlyGuardStarts(): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of src.matchAll(EARLY_GUARD_RE)) {
    const at = m.index! + 1
    for (const alt of m[0].matchAll(/verb === '([a-z-]+)'/g)) out.set(alt[1], at)
  }
  return out
}

/** The early-handled verbs, in source order. */
function earlyHandledVerbs(): string[] {
  return [...earlyGuardStarts().keys()]
}

/**
 * The body of an EARLY-HANDLED verb's block, delimited by its guard and the next section-comment
 * rule (`// ──`), the same way the switch slice above is delimited by the next case label.
 *
 * A MISSING terminator THROWS rather than returning the rest of the slice. The old version fell
 * back to `rest` — the entire remainder of the file — which does not merely swallow the next
 * block: it makes `/isDestructiveVerb\(verb\)/.test(earlyBody(v))` match some later, unrelated
 * call and report the verb as GATED when it is not. A false PASS in a security drift alarm is the
 * one outcome worth an exception, so the convention is enforced instead of assumed.
 */
function earlyBody(verb: string): string {
  const start = earlyGuardStarts().get(verb)
  if (start === undefined) return ''
  const rest = src.slice(start)
  const end = rest.indexOf('// ──', 10)
  if (end === -1) {
    throw new Error(
      `the early-handled block for '${verb}' has no '// ──' section rule after it, so its body ` +
        'cannot be delimited. Slicing to the end of the file would make the isDestructiveVerb ' +
        'check below a FALSE PASS. Add the section rule, or teach earlyBody a second terminator.'
    )
  }
  return rest.slice(0, end)
}

/** A verb's dispatch body wherever it lives: its switch case, or its early-handled block. */
function dispatchBody(verb: string): string {
  return caseBody(verb) || earlyBody(verb)
}

describe('the confirm-gated set and the dispatch that reads it stay in agreement', () => {
  it('the dispatch imports the set rather than restating it', () => {
    expect(src).toMatch(/import \{[^}]*isDestructiveVerb[^}]*\} from '@shared\/control-verbs'/)
  })

  // Derived from the set itself: a verb added to DESTRUCTIVE_VERBS must bring its confirm with
  // it, and nobody should have to remember to extend a list in this file to find that out.
  for (const verb of DESTRUCTIVE_VERBS) {
    it(`${verb} reaches its confirm through isDestructiveVerb`, () => {
      expect(isDestructiveVerb(verb)).toBe(true)
      const body = dispatchBody(verb)
      expect(body).not.toBe('')
      // The guard CALL, not a hardcoded truth: adding a verb to the set must change behaviour.
      expect(body).toMatch(/isDestructiveVerb\(verb\) && confirmBusy\(\)/)
      // …and no leftover bare gate beside it, which would make the set decorative again.
      expect(body).not.toMatch(/\bif \(confirmBusy\(\)\)/)
      expect(body).toContain('setConfirm({')
      // Denial is honored on every confirm this set gates (spec P4): the cancel leg replies the
      // shared refusal instead of hanging the CLI to its 120s timeout.
      expect(body).toContain("'denied by user'")
    })
  }

  /**
   * The WAIVER gate (@shared/control-confirm) is the second thing every gated case must read, and
   * a case that forgot it would keep asking forever — annoying but safe — while a case that read
   * the wrong thing (or hard-coded a skip) would be a destructive verb with no human gate and no
   * failing test. So it is pinned in both directions, exactly like the set above.
   */
  // Derived from the waivable table too, so the last hand-written verb list in this file is gone.
  // A list here fails the same silent way the destructive one did: by covering less.
  for (const verb of CONFIRM_WAIVABLE_VERBS) {
    it(`${verb} reaches its confirm through the shared waiver decision`, () => {
      expect(isWaivableVerb(verb)).toBe(true)
      const body = dispatchBody(verb)
      // The DECISION comes from the shared, tested table — never an inline condition here, and it
      // is asked about the CALLER's project (`ctlProject`), not the active one: canvas control
      // answers a background agent in its own project without moving the user's tab, so reading
      // the project on screen would weigh the wrong project's waiver and the wrong project's
      // permission mode.
      expect(body).toMatch(/controlConfirmDecision\(verb, ctlProject\?\.id\)/)
      // A skip must announce itself. `waivedNotice` is what puts the action on screen when the
      // dialog is gone; without it a waiver makes destructive work silent.
      expect(body).toContain('waivedNotice(')
      // And the dialog it raises must offer the app-run waiver, gated on the same table.
      expect(body).toContain('waiveVerb: isWaivableVerb(verb) ? verb : undefined')
      // The request deadline, so an abandoned dialog cannot hold `confirmBusy` for the app run.
      expect(body).toContain('expiresAt: confirmExpiresAt(')
      expect(body).toContain('onExpire:')
    })
  }

  it('open-project raises the SAME dialog, and its waived and confirmed legs register the SAME thing', () => {
    // It joined CONFIRM_WAIVABLE_VERBS in 2026-10: the old reason to keep it out ("already deduped
    // per (caller, project)") did not hold, because that dedupe is per caller NODE per app run.
    // The derived loop above already pins the decision, the notice and the waiver field; what is
    // specific to this verb is that a waiver must change WHETHER the human is asked and nothing
    // else — so both legs go through one `opFinish(opAdopt)`, never two hand-built registrations.
    expect(isWaivableVerb('open-project')).toBe(true)
    const body = dispatchBody('open-project')
    expect(body.split('opFinish(opAdopt)').length - 1, 'the waived leg and the confirm leg').toBe(2)
    // The decision runs AFTER the idempotent-hit shortcut (a silent repeat needs no waiver) and
    // BEFORE the one-dialog-at-a-time refusal (a waived call never needed a dialog slot).
    const silent = body.indexOf("opPlan.kind === 'silent'")
    const decide = body.indexOf('controlConfirmDecision(verb, ctlProject?.id)')
    const busy = body.indexOf('isDestructiveVerb(verb) && confirmBusy()')
    expect(silent).toBeGreaterThan(-1)
    expect(decide).toBeGreaterThan(silent)
    expect(busy).toBeGreaterThan(decide)
    expect(body).toContain('expiresAt: confirmExpiresAt(')
  })

  it('settings raises the SAME dialog on every change and can never be waived', () => {
    // A settings change can GRANT a capability (agentMessaging). A standing "don't ask again" that
    // covered it would let an agent waive its own consent, so: outside the waivable table, no
    // waiver field on its dialog, no waiver decision read, and still a deadline.
    expect(isWaivableVerb('settings')).toBe(false)
    const body = dispatchBody('settings')
    expect(body).not.toMatch(/waiveVerb:/)
    expect(body).not.toContain('controlConfirmDecision(')
    expect(body).toContain('expiresAt: confirmExpiresAt(')
    // The write happens only on the confirm leg, through the shared applier — never before the
    // dialog and never on cancel/expiry.
    const confirmLeg = body.slice(body.indexOf('onConfirm:'), body.indexOf('onCancel:'))
    expect(confirmLeg).toContain('applySettingsChange(')
    expect(body.split('applySettingsChange(').length - 1).toBe(1)
    expect(body.slice(0, body.indexOf('setConfirm({'))).not.toContain('applySettingsChange(')
  })

  it('no case hard-codes a skip of its confirm', () => {
    // The only admissible way past one of these dialogs is `controlConfirmDecision`. A literal
    // shortcut (an env check, a `true`, a settings flag read inline) would be a silent loosening.
    for (const verb of DESTRUCTIVE_VERBS) {
      const body = dispatchBody(verb)
      expect(body).not.toMatch(/skipConfirm|dontAskAgain|SKIP_CONFIRM/)
    }
  })

  it('a DENIAL never grants a waiver', () => {
    // The checkbox is ticked before the user has decided, so the grant must hang off the confirm
    // button and nothing else. Cancelling a dialog with "Don't ask again" ticked has to leave the
    // gate exactly where it was — the opposite would turn a refusal into a permanent yes.
    const site = src.slice(src.indexOf('{confirm && ('), src.indexOf('{pendingPeer && ('))
    expect(site).toContain('waiveForSession(confirm.waiveVerb)')
    expect(site.slice(site.indexOf('onCancel={'))).not.toContain('waiveForSession')
    // Only ever the app-run waiver from a dialog: the permanent one is a Settings write, and
    // `controlConfirmWaivers` must not be reachable from here.
    expect(site).not.toContain('controlConfirmWaivers')
  })

  /**
   * The DERIVATION is now load-bearing, so it gets its own assertions. Both of these would have
   * been satisfied by the hand-written list too — the point is that they fail when the SCAN breaks,
   * which the list could not tell us.
   */
  it('the per-verb checks are driven by the SET, not by a list in this file', () => {
    // MEASURED, and it is why a pin is needed rather than an assertion: reverting the loop below
    // to a hand-written `['write', 'close', 'open-project']` generated one FEWER test and the
    // suite stayed GREEN (14 → 13). A list here fails by covering LESS, and nothing inside the
    // remaining tests can see that — the coverage itself has to be the thing asserted.
    const self = readFileSync(new URL('./control-destructive.test.ts', import.meta.url), 'utf8')
    expect(self).toContain('for (const verb of DESTRUCTIVE_VERBS) {')
    // …and no hand-written verb list creeps back in beside it.
    expect(self).not.toMatch(/for \(const verb of \[[^\]]*\] as const\)/)
  })

  it('finds every early-handled verb, compound guards included', () => {
    const early = earlyHandledVerbs()
    // `send`/`reply`/`notify` share one `if (... || ... || ...)`. A scan keyed on
    // `if (verb === '<verb>')` finds only the first, which is exactly the miss this closes.
    for (const v of ['send', 'reply', 'notify']) expect(early).toContain(v)
    // …and the single-verb guards still resolve.
    for (const v of ['open-project', 'settings']) expect(early).toContain(v)
    // Nothing invented: every discovered verb must really be a control verb the dispatch handles.
    for (const v of early) expect(src).toContain(`verb === '${v}'`)
  })

  it('every early-handled body stops at its own block', () => {
    // The guard that makes the scan safe. A block whose `// ──` terminator is missing slices
    // onward and reports itself as gated off some later, unrelated `isDestructiveVerb` call — a
    // false PASS. `earlyBody` throws in that case; these are the structural properties that catch
    // a body which ran away WITHOUT reaching the end of the file, which a length heuristic missed
    // (measured: an early guard sits ~2/3 through Canvas.tsx, so "less than half the file" is
    // satisfied by a body that swallowed everything after it).
    const starts = earlyGuardStarts()
    for (const v of earlyHandledVerbs()) {
      const body = earlyBody(v)
      expect(body).toContain(`verb === '${v}'`)
      // It must end before the dispatch switch: a body that reaches it has left its own block.
      expect(body).not.toContain('switch (verb)')
      // …and it must not contain ANOTHER guard's start, i.e. it never swallows the next block.
      for (const [other, at] of starts) {
        if (at !== starts.get(v)) expect(body).not.toContain(`if (verb === '${other}'`)
      }
    }
  })

  it('no other case reads isDestructiveVerb', () => {
    // Every `isDestructiveVerb(verb)` in the dispatch must sit in a case the set actually holds.
    // If a third case ever grows one, either the set or the dispatch is wrong — say so here rather
    // than let the two drift apart the way the constant and the switch already did once.
    //
    // This scans for the CALL, so a hand-written confirm that never reads the set is invisible to
    // it — `close-worktree --mode remove` is exactly that, on purpose. This is not "no other verb
    // is confirm-gated"; it is "no other case claims to be gated by this set".
    const labels = [...src.matchAll(/\n {10}case '([a-z-]+)': \{/g)].map((m) => m[1])
    const gated = labels.filter((v) => /isDestructiveVerb\(verb\)/.test(caseBody(v)))
    // The early-handled blocks are counted the same way, off their own slices — and WHICH verbs
    // those are is read from the source (see `earlyHandledVerbs`), so a new one cannot be missed.
    for (const early of earlyHandledVerbs()) {
      if (/isDestructiveVerb\(verb\)/.test(earlyBody(early))) gated.push(early)
    }
    expect(new Set(gated)).toEqual(new Set(DESTRUCTIVE_VERBS))
  })
})
