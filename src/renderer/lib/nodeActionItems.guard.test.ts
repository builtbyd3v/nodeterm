// Every surface that offers actions on a canvas node takes its rows from ONE builder,
// lib/nodeActionItems: the canvas node menu, the sessions-sidebar row menu, and the kanban card
// menus (per-project board and Omni lanes, through components/kanban/cardMenu.tsx). A second copy
// of these rows is how the board fell behind the canvas in the first place; this fails the moment
// one is written. Canvas.tsx cannot be mounted in a test, so the wiring is pinned at source level.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(RENDERER, rel), 'utf8').replace(/\r\n/g, '\n')

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** The source of one `const name = useCallback(…)` up to the next `const` at the same depth. */
function callback(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`)
  expect(at, name).toBeGreaterThan(-1)
  const end = src.indexOf('\n  const ', at + 10)
  return src.slice(at, end === -1 ? undefined : end)
}

describe('node actions: one builder for every surface', () => {
  const canvas = read('canvas/Canvas.tsx')

  it('the canvas node menu is the builder', () => {
    expect(callback(canvas, 'selectionItems')).toContain('buildNodeActionItems(ids, at, liveNodeActionCtx(), filter)')
  })

  it('the sessions-sidebar row menu is the builder minus Delete', () => {
    const row = canvas.slice(canvas.indexOf('const onRowContextMenu = useCallback('))
    const body = row.slice(0, row.indexOf('\n  // Stream live subagent'))
    expect(body).toContain("...selectionItems([id], undefined, { omit: ['delete'] }),")
    expect(body).not.toContain("it.label === 'Delete'")
  })

  it('both boards build their card menu with the shared card menu, fed by the builder', () => {
    expect(read('components/kanban/KanbanView.tsx')).toContain('buildCardMenuItems({')
    expect(read('components/kanban/GlobalKanbanView.tsx')).toContain('buildCardMenuItems({')
    expect(read('components/kanban/cardMenu.tsx')).toContain('...(a.nodeActions?.(card.id) ?? []),')
    expect(callback(canvas, 'boardNodeActionItems')).toContain('{ allow: BOARD_NODE_ACTION_IDS }')
  })

  it('no other renderer file defines the node rows again', () => {
    const owned = join(RENDERER, 'lib/nodeActionItems.tsx')
    const rows = ["label: 'Restart agent'", "label: 'Pause & end session'", "label: 'Switch Claude account'"]
    const offenders = sources(RENDERER)
      .filter((f) => f !== owned)
      .filter((f) => rows.some((r) => readFileSync(f, 'utf8').includes(r)))
      .map((f) => relative(RENDERER, f))
    expect(offenders).toEqual([])
  })
})
