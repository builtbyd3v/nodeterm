/**
 * Writes to ONE node of ONE project, routed to wherever that node lives right now.
 *
 * React Flow is the source of truth only for the project it currently holds (`liveCanvasHolds`);
 * every other project's nodes live in the projects store, and a write there must go to the store
 * and then to disk, or it is lost (a live-canvas callback like `setNodesColor` simply finds no such
 * node and does nothing). That is the trap the kanban card menus — the Omni board above all — walk
 * into, because they act on nodes of projects that are not on the canvas.
 *
 * Never silent: a node that is no longer in its project (on the live canvas or in the store), a
 * save that fails, and an icon picker that fails to open each raise a `nodeterm:toast` (the
 * caller's `toast`).
 */
import type { NodeIcon } from '@shared/node-icon'
import type { CanvasNodeState } from '@shared/types'
import type { NodeIconChoice } from '../components/NodeIconPicker'
import { applyIconChoice } from './nodeIconChoice'

export const NODE_GONE_MESSAGE = 'That session is no longer in its project — nothing was changed.'
export const SAVE_FAILED_MESSAGE = 'The change could not be saved to disk.'
export const ICON_PICKER_FAILED_MESSAGE = "Couldn't open the icon picker."

export interface NodeWrites {
  setColor: (ids: string[], color: string) => void
  setIcon: (nodeId: string, icon: NodeIcon | undefined) => void
  /** Open the icon picker for the node, then write the answer. */
  pickIcon: (nodeId: string) => void
}

export interface NodeWriteRouterDeps {
  /** React Flow holds this project right now. Asked on every write, never cached. */
  isLive: () => boolean
  /** The node is on the live canvas right now (the live funnels do nothing for a missing id). */
  liveHas: (nodeId: string) => boolean
  /** The live canvas's own funnels (Canvas `setNodesColor` / `setNodeIcon` / `pickNodeIcon`). */
  live: NodeWrites
  /** The node in the project's stored copy, or undefined when it is gone. */
  storedNode: (nodeId: string) => CanvasNodeState | undefined
  recolorStored: (nodeId: string, color: string) => void
  setStoredIcon: (nodeId: string, icon: NodeIcon | undefined) => void
  /** Canvas `persist` (commit the live canvas, then write): false when the save was refused. */
  persist: () => Promise<boolean>
  iconDialog: (opts: { nodeId: string; title: string; icon?: NodeIcon }) => Promise<NodeIconChoice>
  toast: (message: string) => void
}

export function createNodeWriteRouter(d: NodeWriteRouterDeps): NodeWrites {
  const save = async (): Promise<void> => {
    if (!(await d.persist())) d.toast(SAVE_FAILED_MESSAGE)
  }
  const setIcon = (nodeId: string, icon: NodeIcon | undefined): void => {
    if (d.isLive()) {
      if (d.liveHas(nodeId)) d.live.setIcon(nodeId, icon)
      else d.toast(NODE_GONE_MESSAGE)
      return
    }
    if (!d.storedNode(nodeId)) {
      d.toast(NODE_GONE_MESSAGE)
      return
    }
    d.setStoredIcon(nodeId, icon)
    void save()
  }
  return {
    setColor(ids, color) {
      if (d.isLive()) {
        const live = ids.filter((id) => d.liveHas(id))
        if (live.length < ids.length) d.toast(NODE_GONE_MESSAGE)
        if (live.length > 0) d.live.setColor(live, color)
        return
      }
      const present = ids.filter((id) => d.storedNode(id))
      if (present.length < ids.length) d.toast(NODE_GONE_MESSAGE)
      if (present.length === 0) return
      for (const id of present) d.recolorStored(id, color)
      void save()
    },
    setIcon,
    pickIcon(nodeId) {
      if (d.isLive()) {
        if (d.liveHas(nodeId)) d.live.pickIcon(nodeId)
        else d.toast(NODE_GONE_MESSAGE)
        return
      }
      const node = d.storedNode(nodeId)
      if (!node) {
        d.toast(NODE_GONE_MESSAGE)
        return
      }
      // The rejection handler covers the DIALOG only: a failure after a successful pick is not "the
      // picker failed to open", and the write path reports its own failures (NODE_GONE / save).
      void d
        .iconDialog({ nodeId, title: node.title ?? '', icon: node.icon })
        .then(
          (choice) => applyIconChoice(choice, (icon) => setIcon(nodeId, icon)),
          () => d.toast(ICON_PICKER_FAILED_MESSAGE)
        )
    }
  }
}
