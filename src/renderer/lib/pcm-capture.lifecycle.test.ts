// A cancel()/stop() that lands while start() is still opening the microphone. getUserMedia, the
// AudioContext and the worklet module are all awaits, and the caller gives up inside that window
// routinely (hold-to-talk: a sub-400 ms tap, a ⌘⌥<key> shortcut, a window blur). The stream that
// arrives afterwards has no owner left to stop it — so start() must release it itself, and must
// say it did not start, instead of adopting it into a capture nobody will ever end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PcmCapture } from './pcm-capture'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

let track: { stop: ReturnType<typeof vi.fn> }
let stream: { getTracks: () => (typeof track)[] }
let gum: Deferred<typeof stream>
let addModule: Deferred<void>
let contexts: FakeAudioContext[]
let workletNodes: number

class FakeAudioContext {
  state: 'running' | 'closed' = 'running'
  audioWorklet = { addModule: () => addModule.promise }
  destination = {}
  constructor() {
    contexts.push(this)
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() }
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}

class FakeAudioWorkletNode {
  port = { onmessage: null as unknown }
  constructor() {
    workletNodes += 1
  }
  disconnect() {}
}

beforeEach(() => {
  track = { stop: vi.fn() }
  stream = { getTracks: () => [track] }
  gum = deferred()
  addModule = deferred()
  contexts = []
  workletNodes = 0
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => gum.promise } })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PcmCapture.start — cancelled while the microphone is still opening', () => {
  it('cancel() during getUserMedia: the late stream is stopped and start() reports false', async () => {
    const capture = new PcmCapture()
    const started = capture.start()
    capture.cancel()
    gum.resolve(stream)

    await expect(started).resolves.toBe(false)
    expect(track.stop).toHaveBeenCalled()
    expect(contexts).toHaveLength(0) // never went on to build an audio graph
  })

  it('stop() during getUserMedia: same — an empty take, and no live mic left behind', async () => {
    const capture = new PcmCapture()
    const started = capture.start()
    expect(capture.stop()).toHaveLength(0)
    gum.resolve(stream)

    await expect(started).resolves.toBe(false)
    expect(track.stop).toHaveBeenCalled()
  })

  it('cancel() while the worklet module loads: no node is built on the dead graph', async () => {
    const capture = new PcmCapture()
    const started = capture.start()
    gum.resolve(stream)
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    capture.cancel()
    addModule.resolve()

    await expect(started).resolves.toBe(false)
    expect(track.stop).toHaveBeenCalled()
    expect(contexts[0].state).toBe('closed')
    expect(workletNodes).toBe(0)
  })

  it('a start() that runs to completion reports true', async () => {
    const capture = new PcmCapture()
    const started = capture.start()
    gum.resolve(stream)
    addModule.resolve()

    await expect(started).resolves.toBe(true)
    expect(workletNodes).toBe(1)
    expect(track.stop).not.toHaveBeenCalled()
    capture.cancel()
    expect(track.stop).toHaveBeenCalled()
  })

  it('the same instance starts cleanly again after a cancelled start', async () => {
    const capture = new PcmCapture()
    const first = capture.start()
    capture.cancel()
    gum.resolve(stream)
    await expect(first).resolves.toBe(false)

    gum = deferred()
    const secondTrack = { stop: vi.fn() }
    const second = capture.start()
    gum.resolve({ getTracks: () => [secondTrack] } as unknown as typeof stream)
    addModule.resolve()

    await expect(second).resolves.toBe(true)
    expect(secondTrack.stop).not.toHaveBeenCalled()
  })
})
