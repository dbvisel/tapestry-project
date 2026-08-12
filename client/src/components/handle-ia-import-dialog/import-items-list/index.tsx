import { ImportItem } from '..'
import { IAImport } from '../../../pages/tapestry/view-model'
import { CommonsCategoryList } from './commons-category-list'
import { IACollectionList } from './collection-list'
import { OpenverseCollectionList } from './openverse-collection-list'
import { IASearchList } from './ia-search-list'
import { IAPlaylistEntries } from './playlist'
import { ReactNode } from 'react'

export interface ImportItemsListProps {
  onSelect: (item: ImportItem) => unknown
  onToggleAll: (checked: boolean) => unknown
  toggling: boolean
  iaImport: IAImport
  selectedItems: ImportItem[]
  header?: ReactNode
}

export function ImportItemsList({ iaImport, ...props }: ImportItemsListProps) {
  if (iaImport.type === 'IACollection') {
    return <IACollectionList collectionId={iaImport.id} {...props} />
  }
  if (iaImport.type === 'CommonsCategory') {
    return <CommonsCategoryList category={iaImport.category} {...props} />
  }
  if (iaImport.type === 'OpenverseCollection') {
    return <OpenverseCollectionList tag={iaImport.tag} {...props} />
  }
  if (iaImport.type === 'IASearch') {
    return <IASearchList query={iaImport.query} {...props} />
  }
  return <IAPlaylistEntries entries={iaImport.entries} {...props} />
}
