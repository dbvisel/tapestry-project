import { Patch } from 'immer'
import { BaseUndoStack } from '.'
import { EditableTapestryViewModel } from '..'
import { compact } from 'lodash-es'
import { UndoStackPatchHandler } from 'tapestry-core-client/src/lib/store/index'
import { getNewValueFromPatch, getPatchedPathSegment } from './utils'

export class PresentationOrderUndoStack extends BaseUndoStack<EditableTapestryViewModel> {
  constructor(model: EditableTapestryViewModel, applyPatches: UndoStackPatchHandler) {
    super(model, applyPatches, { batchPeriod: 0 })
  }

  protected sanitizePatches(patches: Patch[]): Patch[] {
    return patches.filter(({ path }) => path[0] === 'presentationSteps')
  }

  protected canApply(patches: Patch[]): boolean {
    const newPresentationStepIds = patches
      .filter((patch) => patch.op === 'add' && patch.path.length === 2)
      .map(({ path }) => path[1])

    const referredPresentationStepIds = compact([
      ...patches.map((patch) => getPatchedPathSegment(patch, ['presentationSteps', '^'])),
      ...patches.map((patch) =>
        getNewValueFromPatch<string>(patch, ['presentationSteps', '*', 'dto', 'prevStepId']),
      ),
    ])

    // XXX: This expression doesn't handle the case where the whole `presentationSteps` ID map is replaced.
    const referredItemIds = compact(
      patches.map((patch) =>
        getNewValueFromPatch<string>(patch, ['presentationSteps', '*', 'dto', 'itemId']),
      ),
    )

    const referredGroupIds = compact(
      patches.map((patch) =>
        getNewValueFromPatch<string>(patch, ['presentationSteps', '*', 'dto', 'groupId']),
      ),
    )

    return (
      referredPresentationStepIds.every(
        (id) => id in this.model.presentationSteps || newPresentationStepIds.includes(id),
      ) &&
      referredItemIds.every((id) => id in this.model.items) &&
      referredGroupIds.every((id) => id in this.model.groups)
    )
  }
}
