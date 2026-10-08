// "Name with AI" on a session (sidebar row, per-project board card, Omni board card) all funnel
// through Canvas's `aiNameSession`. Pinned over the source: the funnel is a useCallback inside
// Canvas and no harness reaches it. A failed or thrown naming request must raise an error toast,
// never do nothing.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('aiNameSession reports its failures', () => {
  it('toasts on a not-ok result and on a throw', () => {
    const a = src.indexOf('const aiNameSession = useCallback(')
    expect(a).toBeGreaterThan(-1)
    const body = src.slice(a, src.indexOf('\n  )\n', a))
    expect(body).toContain("new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } })")
    expect(body).toContain("Couldn't name this session with AI")
    expect(body).toMatch(/if \(r\.ok\) renameSession\(projectId, id, r\.message\)\n\s*else failed\(r\.message\)/)
    expect(body).toMatch(/catch \(e\) \{\n\s*failed\(/)
  })
})
