import { TapestryItem } from '../tapestry-item'
import { memo } from 'react'
import { TapestryElementComponentProps } from '../..'
import { ItemToolbar } from '../item-toolbar'
import { Model3dItemViewer } from './viewer'

export const Model3dItem = memo(({ id }: TapestryElementComponentProps) => {
  return (
    <TapestryItem id={id} halo={<ItemToolbar tapestryItemId={id} />}>
      <Model3dItemViewer id={id} />
    </TapestryItem>
  )
})
