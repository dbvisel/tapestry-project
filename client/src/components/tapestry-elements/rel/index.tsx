import { getBounds } from 'tapestry-core-client/src/view-model/utils'
import { RelToolbar } from '../rel-toolbar'
import { useTapestryData } from '../../../pages/tapestry/tapestry-providers'
import { memo } from 'react'

interface RelProps {
  id: string
}

export const Rel = memo(({ id }: RelProps) => {
  const rel = useTapestryData(`rels.${id}`)!
  const { interactiveElement, items } = useTapestryData(['interactiveElement', 'items'])
  const isActive = rel.dto.id === interactiveElement?.modelId

  const bounds = getBounds(rel.dto, items)

  return isActive && <RelToolbar rel={rel} relBounds={bounds} />
})
