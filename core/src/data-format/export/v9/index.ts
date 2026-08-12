import z from 'zod/v4'
import { ExportV8Schema } from '../v8'
import { ItemSchema } from '../../schemas/item'

// V9 introduces the "model3d" item type (STL 3D model viewer). The change is purely additive at the
// item level, so the only structural difference from V8 is the version literal. Tapestries that contain
// "model3d" items are tagged as V9 so that older clients, which don't know how to render them, can detect
// the newer format.
export const ExportV9Schema = z.object({
  ...ExportV8Schema.shape,
  version: z.literal(9),
  items: z.array(ItemSchema).nullish(),
})

export type ExportV9 = z.infer<typeof ExportV9Schema>
