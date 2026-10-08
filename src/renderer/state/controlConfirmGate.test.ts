// @vitest-environment jsdom
//
// jsdom for `window.nodeTerminal` alone: `useSettings.update` schedules a save through the preload
// bridge, and this file's whole subject is what that write persists.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  controlConfirmDecision,
  waiveControlConfirmForProject,
  activeControlConfirmWaivers
} from './controlConfirmGate'
import { useControlConfirm } from './controlConfirm'
import { useProjects } from './projects'
import { useSettings } from './settings'

/**
 * The store-bound half of the canvas-control confirm — `decideControlConfirm`'s wiring, where the
 * per-project waiver is granted and where "which project is this about" is answered.
 *
 * WHY THE PROJECT ARGUMENT IS THE WHOLE STORY HERE: canvas control routes by SOURCE, and since
 * `@shared/control-off-screen` a background agent's `write`/`close` is answered in ITS OWN project
 * without the user's tab moving. So "the active project" and "the project this call acts on" are
 * now routinely different, and every per-project fact the gate reads — the waiver AND the
 * permission mode the bypass lock weighs — has to follow the caller, not the human's screen.
 */
const setProjects = (projects: unknown[]): void => {
  useProjects.setState({ projects, activeProjectId: 'active' } as never)
}

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) }
  }
  useControlConfirm.setState({ sessionWaived: [], sessionWaivedSet: new Set() })
  useSettings.setState((s) => ({
    settings: { ...s.settings, controlConfirmWaivers: undefined }
  }))
  setProjects([
    { id: 'active', name: 'On screen', nodes: [] },
    { id: 'other', name: 'Background', nodes: [] }
  ])
})

describe('controlConfirmDecision — which project it asks about', () => {
  it('defaults to the active project, which is what every pre-existing caller means', () => {
    useSettings.setState((s) => ({
      settings: { ...s.settings, controlConfirmWaivers: { projects: { active: ['close'] } } }
    }))
    expect(controlConfirmDecision('close').via).toBe('project')
  })

  it('follows the caller’s project when one is passed', () => {
    useSettings.setState((s) => ({
      settings: { ...s.settings, controlConfirmWaivers: { projects: { other: ['close'] } } }
    }))
    // The background agent's own project is waived; the one on screen is not. Reading the active
    // project here would ASK about a call the user already said not to ask about…
    expect(controlConfirmDecision('close', 'other').via).toBe('project')
    // …and, the dangerous direction, would SKIP a call in a project the user never waived.
    useSettings.setState((s) => ({
      settings: { ...s.settings, controlConfirmWaivers: { projects: { active: ['close'] } } }
    }))
    expect(controlConfirmDecision('close', 'other')).toEqual({ skip: false, via: null })
  })

  it('reads the permission mode from the CALLER’s project too', () => {
    // The bypass lock weighs `project.defaultPermissionMode`, which is per project. Weighing the
    // project on screen would let one project's Bypass silence another project's dialog.
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        claudePermissionMode: 'manual',
        controlConfirmWaivers: { bypassMode: true }
      }
    }))
    setProjects([
      { id: 'active', name: 'On screen', nodes: [], defaultPermissionMode: 'bypassPermissions' },
      { id: 'other', name: 'Background', nodes: [] }
    ])
    // Even for the active project this must ask: the mode came from the PROJECT file, which is
    // git-shared — the cloned-repo trap, proven in shared/control-confirm.test.ts and re-checked
    // here because this is the layer that decides which project's file is read.
    expect(controlConfirmDecision('close').skip).toBe(false)
    expect(controlConfirmDecision('close', 'other').skip).toBe(false)
  })

  it('an unknown project id waives nothing — fail closed', () => {
    useSettings.setState((s) => ({
      settings: { ...s.settings, controlConfirmWaivers: { projects: { active: ['close'] } } }
    }))
    expect(controlConfirmDecision('close', 'no-such-project')).toEqual({ skip: false, via: null })
  })
})

describe('waiveControlConfirmForProject — the durable grant the dialog may make', () => {
  it('persists one verb for one project', () => {
    expect(waiveControlConfirmForProject('close', 'other')).toBe(true)
    expect(activeControlConfirmWaivers()).toEqual({ projects: { other: ['close'] } })
    expect(controlConfirmDecision('close', 'other').via).toBe('project')
    expect(controlConfirmDecision('close', 'active').skip).toBe(false)
  })

  it('adds beside an existing grant instead of replacing it', () => {
    waiveControlConfirmForProject('close', 'other')
    waiveControlConfirmForProject('write', 'other')
    waiveControlConfirmForProject('close', 'active')
    expect(activeControlConfirmWaivers().projects).toEqual({
      other: ['close', 'write'],
      active: ['close']
    })
  })

  it('is idempotent — a second tick does not duplicate the verb', () => {
    waiveControlConfirmForProject('close', 'other')
    waiveControlConfirmForProject('close', 'other')
    expect(activeControlConfirmWaivers().projects?.other).toEqual(['close'])
  })

  it('refuses a verb the shared table does not admit, and a missing project', () => {
    // The table decides here as well as in the decision: a caller cannot grant `settings` by
    // passing the wrong string into the wrong function. Returning false matters — the dialog falls
    // back to the app-run waiver on a false, so a silent no-op would lose the user's choice.
    expect(waiveControlConfirmForProject('settings', 'other')).toBe(false)
    expect(waiveControlConfirmForProject('close', undefined)).toBe(false)
    expect(useSettings.getState().settings.controlConfirmWaivers).toBeUndefined()
  })

  it('prunes dead projects on the way in — settings.json is forever', () => {
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        controlConfirmWaivers: { projects: { gone: ['write'], other: ['write'] } }
      }
    }))
    waiveControlConfirmForProject('close', 'active')
    expect(activeControlConfirmWaivers().projects).toEqual({
      other: ['write'],
      active: ['close']
    })
  })

  it('keeps the project being written even if the store no longer lists it', () => {
    // A project can go away between the dialog appearing and the user answering it; pruning it in
    // the same breath as granting it would swallow the answer they just gave. This holds because
    // the grant is merged AFTER the prune — there is deliberately no second mechanism exempting
    // the id, since nothing could turn such a safeguard red.
    setProjects([{ id: 'active', name: 'On screen', nodes: [] }])
    expect(waiveControlConfirmForProject('close', 'vanished')).toBe(true)
    expect(activeControlConfirmWaivers().projects).toEqual({ vanished: ['close'] })
  })

  it('the prune happens BEFORE the grant, so the two cannot fight', () => {
    // The ordering the test above rests on, asserted directly: a dead entry goes AND the new grant
    // lands, in one write. Reversing them would prune the grant that was just made.
    setProjects([{ id: 'active', name: 'On screen', nodes: [] }])
    useSettings.setState((s) => ({
      settings: { ...s.settings, controlConfirmWaivers: { projects: { gone: ['write'] } } }
    }))
    expect(waiveControlConfirmForProject('close', 'active')).toBe(true)
    expect(activeControlConfirmWaivers().projects).toEqual({ active: ['close'] })
  })

  it('leaves the machine-wide and bypass waivers alone', () => {
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        controlConfirmWaivers: { always: ['write'], bypassMode: true }
      }
    }))
    waiveControlConfirmForProject('close', 'other')
    expect(activeControlConfirmWaivers()).toEqual({
      always: ['write'],
      bypassMode: true,
      projects: { other: ['close'] }
    })
  })
})
