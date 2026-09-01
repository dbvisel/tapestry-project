import { Patch, produce } from 'immer'
import { BaseUndoStack } from '.'
import { compact } from 'lodash-es'
import { isItemViewModel, isRelViewModel } from 'tapestry-core-client/src/view-model/utils'
import { GroupViewModel } from 'tapestry-core-client/src/view-model'
import { EditableTapestryElementViewModel, EditableTapestryViewModel } from '..'
import { UndoStackPatchHandler } from 'tapestry-core-client/src/lib/store/index'
import { getNewValueFromPatch, getPatchedPathSegment } from './utils'

function sanitizeViewModel(model: EditableTapestryElementViewModel | GroupViewModel) {
  return produce(model, (draft) => {
    if (isItemViewModel(draft)) {
      draft.dragState = undefined
      draft.previewBounds = undefined
      draft.resizeState = undefined
    } else if (isRelViewModel(draft)) {
      draft.dragState = undefined
    }
  })
}

export class TapestryUndoStack extends BaseUndoStack<EditableTapestryViewModel> {
  constructor(model: EditableTapestryViewModel, applyPatches: UndoStackPatchHandler) {
    super(model, applyPatches, { batchPeriod: 200 })
  }

  protected sanitizePatches(patches: Patch[]): Patch[] {
    return compact(
      patches.map((patch) => {
        // Ignore patches unrelated to items, groups or rels
        if (!['items', 'rels', 'groups'].includes(patch.path[0] as string)) return

        // When adding, deleting, or replacing items, groups or rels, sanitize the view model.
        if (patch.path.length === 2) {
          return {
            ...patch,
            value: patch.value
              ? sanitizeViewModel(patch.value as EditableTapestryElementViewModel | GroupViewModel)
              : undefined,
          }
        }

        // When modifying item, group or rel DTOs with paths like ["items", <id>, "dto", ...], accept the patch as-is
        if (patch.path[2] === 'dto') {
          return patch
        }
      }),
    )
  }

  protected canApply(patches: Patch[]): boolean {
    // Patches will be applies only if they refer to existing or newly created elements.
    // TODO: We will probably need more sophisticated conflict resolution when fetching updates from the server.
    //       For example, we should filter out only patches refering to non-existent elements, and apply the others.
    const newPaths = patches
      .filter((patch) => patch.op === 'add' && patch.path.length === 2)
      .map((p) => p.path)

    const referredItemIds = compact([
      ...patches.map((patch) => getPatchedPathSegment(patch, ['items', '^'])),
      ...patches.map((patch) =>
        getNewValueFromPatch<string>(patch, ['rels', '*', 'dto', 'from', 'itemId']),
      ),
      ...patches.map((patch) =>
        getNewValueFromPatch<string>(patch, ['rels', '*', 'dto', 'to', 'itemId']),
      ),
    ])

    const referredRelIds = compact(
      patches.map((patch) => getPatchedPathSegment(patch, ['rels', '^'])),
    )

    const referredGroupIds = compact([
      ...patches.map((patch) => getPatchedPathSegment(patch, ['groups', '^'])),
      ...patches.map((patch) =>
        getNewValueFromPatch<string>(patch, ['items', '*', 'dto', 'groupId']),
      ),
    ])

    return (
      referredItemIds.every(
        (id) =>
          id in this.model.items || newPaths.some((path) => path[0] === 'items' && path[1] === id),
      ) &&
      referredRelIds.every(
        (id) =>
          id in this.model.rels || newPaths.some((path) => path[0] === 'rels' && path[1] === id),
      ) &&
      referredGroupIds.every(
        (id) =>
          id in this.model.groups ||
          newPaths.some((path) => path[0] === 'groups' && path[1] === id),
      )
    )
  }
}
