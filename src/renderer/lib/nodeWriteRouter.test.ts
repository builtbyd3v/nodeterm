import { describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState } from '@shared/types'
import {
  createNodeWriteRouter,
  ICON_PICKER_FAILED_MESSAGE,
  NODE_GONE_MESSAGE,
  SAVE_FAILED_MESSAGE,
  type NodeWriteRouterDeps
} from './nodeWriteRouter'

const stored = (id: string): CanvasNodeState => ({ id, title: `T ${id}` }) as unknown as CanvasNodeState
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function deps(over: Partial<NodeWriteRouterDeps> = {}): NodeWriteRouterDeps {
  return {
    isLive: () => false,
    liveHas: (id) => id === 'n1',
    live: { setColor: vi.fn(), setIcon: vi.fn(), pickIcon: vi.fn() },
    storedNode: (id) => (id === 'n1' ? stored('n1') : undefined),
    recolorStored: vi.fn(),
    setStoredIcon: vi.fn(),
    persist: vi.fn(async () => true),
    iconDialog: vi.fn(async () => ({ type: 'emoji', value: '🚀' }) as never),
    toast: vi.fn(),
    ...over
  }
}

describe('createNodeWriteRouter', () => {
  it('the project on the canvas writes through the live funnels, never the store', () => {
    const d = deps({ isLive: () => true })
    const w = createNodeWriteRouter(d)
    w.setColor(['n1'], '#0a84ff')
    w.pickIcon('n1')
    expect(d.live.setColor).toHaveBeenCalledWith(['n1'], '#0a84ff')
    expect(d.live.pickIcon).toHaveBeenCalledWith('n1')
    expect(d.recolorStored).not.toHaveBeenCalled()
    expect(d.persist).not.toHaveBeenCalled()
  })

  it('a project off the canvas writes to the store, then to disk', async () => {
    const d = deps()
    createNodeWriteRouter(d).setColor(['n1'], '#0a84ff')
    await flush()
    expect(d.recolorStored).toHaveBeenCalledWith('n1', '#0a84ff')
    expect(d.persist).toHaveBeenCalledTimes(1)
    expect(d.toast).not.toHaveBeenCalled()
  })

  it('a node that is gone is reported, not silently skipped', () => {
    const d = deps()
    createNodeWriteRouter(d).setColor(['gone'], '#0a84ff')
    expect(d.toast).toHaveBeenCalledWith(NODE_GONE_MESSAGE)
    expect(d.recolorStored).not.toHaveBeenCalled()
    expect(d.persist).not.toHaveBeenCalled()
  })

  it('a refused save is reported', async () => {
    const d = deps({ persist: vi.fn(async () => false) })
    createNodeWriteRouter(d).setIcon('n1', undefined)
    await flush()
    expect(d.setStoredIcon).toHaveBeenCalledWith('n1', undefined)
    expect(d.toast).toHaveBeenCalledWith(SAVE_FAILED_MESSAGE)
  })

  it('the icon picker for a stored node writes its answer to the store', async () => {
    const d = deps()
    createNodeWriteRouter(d).pickIcon('n1')
    await flush()
    expect(d.iconDialog).toHaveBeenCalledWith({ nodeId: 'n1', title: 'T n1', icon: undefined })
    expect(d.setStoredIcon).toHaveBeenCalledWith('n1', { type: 'emoji', value: '🚀' })
  })

  it('a cancelled picker writes nothing', async () => {
    const d = deps({ iconDialog: vi.fn(async () => undefined) })
    createNodeWriteRouter(d).pickIcon('n1')
    await flush()
    expect(d.setStoredIcon).not.toHaveBeenCalled()
  })

  it('a live node that is gone is reported and nothing is written', () => {
    const d = deps({ isLive: () => true })
    const w = createNodeWriteRouter(d)
    w.setColor(['gone'], '#0a84ff')
    w.setIcon('gone', undefined)
    w.pickIcon('gone')
    expect(d.toast).toHaveBeenCalledTimes(3)
    expect(d.toast).toHaveBeenCalledWith(NODE_GONE_MESSAGE)
    expect(d.live.setColor).not.toHaveBeenCalled()
    expect(d.live.setIcon).not.toHaveBeenCalled()
    expect(d.live.pickIcon).not.toHaveBeenCalled()
  })

  it('a live recolor writes the present nodes and reports the missing ones once', () => {
    const d = deps({ isLive: () => true })
    createNodeWriteRouter(d).setColor(['n1', 'gone', 'gone2'], '#0a84ff')
    expect(d.live.setColor).toHaveBeenCalledWith(['n1'], '#0a84ff')
    expect(d.toast).toHaveBeenCalledTimes(1)
    expect(d.toast).toHaveBeenCalledWith(NODE_GONE_MESSAGE)
  })

  it('an icon picker that fails to open is reported', async () => {
    const d = deps({ iconDialog: vi.fn(async () => { throw new Error('boom') }) })
    createNodeWriteRouter(d).pickIcon('n1')
    await flush()
    expect(d.toast).toHaveBeenCalledWith(ICON_PICKER_FAILED_MESSAGE)
    expect(d.setStoredIcon).not.toHaveBeenCalled()
  })
})
