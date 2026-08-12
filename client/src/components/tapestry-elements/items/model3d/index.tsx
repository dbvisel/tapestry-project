import { memo } from 'react'
import { Model3dItemViewer } from 'tapestry-core-client/src/components/tapestry/items/model3d/viewer'
import { Model3dItemDto } from 'tapestry-shared/src/data-transfer/resources/dtos/item'
import { TapestryItemProps } from '..'
import { useTapestryData } from '../../../../pages/tapestry/tapestry-providers'
import { buildToolbarMenu } from '../../item-toolbar'
import { useItemToolbar } from '../../item-toolbar/use-item-toolbar'
import { TapestryItem } from '../tapestry-item'

export const Model3dItem = memo(({ id }: TapestryItemProps) => {
  const isEdit = useTapestryData('interactionMode') === 'edit'
  const dto = useTapestryData(`items.${id}.dto`) as Model3dItemDto

  const { toolbar } = useItemToolbar(id, { items: buildToolbarMenu({ dto, isEdit }) })

  return (
    <TapestryItem id={id} halo={toolbar}>
      <Model3dItemViewer id={id} />
    </TapestryItem>
  )
})
