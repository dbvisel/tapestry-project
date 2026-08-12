import clsx from 'clsx'
import { compact } from 'lodash-es'
import { useState } from 'react'
import { useAsyncAction } from 'tapestry-core-client/src/components/lib/hooks/use-async-action'
import { SimpleModal } from 'tapestry-core-client/src/components/lib/modal/index'
import { IAMediaType } from 'tapestry-core/src/internet-archive'
import { toggleElement } from 'tapestry-core/src/lib/array'
import { fetchCommonsFileInfo } from 'tapestry-core/src/wikimedia-commons'
import { fetchOpenverseImage } from 'tapestry-core/src/openverse'
import { useDispatch, useTapestryData } from '../../pages/tapestry/tapestry-providers'
import { IAImport } from '../../pages/tapestry/view-model/index'
import { addAndPositionItems } from '../../pages/tapestry/view-model/store-commands/items'
import { setIAImport } from '../../pages/tapestry/view-model/store-commands/tapestry'
import { createItemViewModel } from '../../pages/tapestry/view-model/utils'
import { Breakpoint, useResponsive } from '../../providers/responsive-provider'
import {
  createCommonsMediaItems,
  createIAMediaItems,
  createOpenverseMediaItems,
} from '../../stage/item-factories'
import { ImportDetails } from './import-details/index'
import { requestCollectionItems } from './import-items-list/collection-list/index'
import { requestCategoryMembers } from './import-items-list/commons-category-list/index'
import { ImportItemsList } from './import-items-list/index'
import { requestOpenverseCollection } from './import-items-list/openverse-collection-list/index'
import { requestIASearchResults } from './import-items-list/ia-search-list/index'
import styles from './styles.module.css'

export interface ImportItem {
  id: string
  mediaType?: IAMediaType
}

const IA_IMPORT_TITLE_MAP: Record<IAImport['type'], string> = {
  IACollection: 'Choose collection items',
  IAPlaylist: 'Choose playlist items',
  CommonsCategory: 'Choose files to import',
  OpenverseCollection: 'Choose images to import',
  IASearch: 'Choose items to import',
}

const IA_IMPORT_CLASS_MAP: Record<IAImport['type'], string> = {
  IACollection: styles.collectionList,
  IAPlaylist: styles.playlist,
  CommonsCategory: styles.collectionList,
  OpenverseCollection: styles.collectionList,
  IASearch: styles.collectionList,
}

async function createNewItems(iaImport: IAImport, items: ImportItem[], tapestryId: string) {
  if (iaImport.type === 'CommonsCategory') {
    const fileInfos = compact(await Promise.all(items.map(({ id }) => fetchCommonsFileInfo(id))))
    return createCommonsMediaItems(tapestryId, fileInfos)
  }

  if (iaImport.type === 'OpenverseCollection') {
    const images = compact(await Promise.all(items.map(({ id }) => fetchOpenverseImage(id))))
    return createOpenverseMediaItems(tapestryId, images)
  }

  if (iaImport.type === 'IASearch') {
    return createIAMediaItems(
      tapestryId,
      compact(items.map(({ id, mediaType }) => mediaType && { id, mediaType })),
    )
  }

  const {
    type,
    id,
    metadata: { mediatype: mediaType },
  } = iaImport

  if (type === 'IACollection') {
    return createIAMediaItems(
      tapestryId,
      compact(items.map(({ id, mediaType }) => mediaType && { id, mediaType })),
    )
  }

  return createIAMediaItems(
    tapestryId,
    items.map(({ id: file }) => ({ id, mediaType, pathParams: [encodeURIComponent(file)] })),
  )
}

function getTitle(imports: IAImport[], index: number) {
  const total = imports.length
  const title = IA_IMPORT_TITLE_MAP[imports[index].type]
  return total > 1 ? `(${index + 1} / ${total}) ${title}` : title
}

export const MAX_SELECTION = 75

export function HandleIAImportDialog() {
  const { iaImports, id: tapestryId } = useTapestryData(['iaImports', 'id'])
  const dispatch = useDispatch()
  const [selectedItems, setSelectedItems] = useState<ImportItem[]>([])
  const mdOrLess = useResponsive() <= Breakpoint.MD

  const [importIndex, setImportIndex] = useState(0)
  const iaImport = iaImports[importIndex] as IAImport | undefined

  const { trigger: toggleAll, loading } = useAsyncAction(async ({ signal }, check: boolean) => {
    if (!iaImport) {
      return
    }
    if (!check) {
      setSelectedItems([])
      return
    }

    if (iaImport.type === 'IAPlaylist') {
      setSelectedItems(iaImport.entries.slice(0, MAX_SELECTION).map((e) => ({ id: e.filename })))
    } else if (iaImport.type === 'CommonsCategory') {
      setSelectedItems(
        (await requestCategoryMembers(iaImport.category, 0, MAX_SELECTION, signal)).data.map(
          (m) => ({ id: m.id }),
        ),
      )
    } else if (iaImport.type === 'OpenverseCollection') {
      // Selecting all doesn't have anywhere of its own to show a failure (e.g. Openverse rate-limiting
      // anonymous requests) - the list below is fetching the same data independently and will surface it
      // via its own error state, so this just leaves the selection unchanged rather than throwing.
      try {
        setSelectedItems(
          (await requestOpenverseCollection(iaImport.tag, 0, MAX_SELECTION, signal)).data.map(
            (i) => ({ id: i.id }),
          ),
        )
      } catch (error) {
        console.warn('Failed to select all Openverse collection items', error)
      }
    } else if (iaImport.type === 'IASearch') {
      setSelectedItems(
        (await requestIASearchResults(iaImport.query, 0, MAX_SELECTION, signal)).data.map((i) => ({
          id: i.id,
          mediaType: i.mediatype,
        })),
      )
    } else {
      setSelectedItems(
        (await requestCollectionItems(iaImport.id, 0, MAX_SELECTION, signal)).data.map((i) => ({
          id: i.id,
          mediaType: i.mediatype,
        })),
      )
    }
  })

  if (!iaImport) {
    return null
  }

  const onClose = () => {
    setSelectedItems([])
    if (importIndex === iaImports.length - 1) {
      dispatch(setIAImport([]))
      setImportIndex(0)
    } else {
      setImportIndex(importIndex + 1)
    }
  }

  const header = <ImportDetails import={iaImport} />

  return (
    <SimpleModal
      classes={{ root: clsx(styles.modal, IA_IMPORT_CLASS_MAP[iaImport.type]) }}
      title={getTitle(iaImports, importIndex)}
      cancel={{ onClick: onClose }}
      confirm={{
        text: `Save selection${selectedItems.length > 0 ? ` (${selectedItems.length})` : ''}`,
        disabled: selectedItems.length === 0,
        onClick: async () => {
          const viewModels = (await createNewItems(iaImport, selectedItems, tapestryId)).map(
            createItemViewModel,
          )
          dispatch(viewModels.length > 0 && addAndPositionItems(viewModels))

          onClose()
        },
      }}
    >
      <div className={styles.content}>
        {!mdOrLess && header}
        <ImportItemsList
          onSelect={(item) => setSelectedItems((current) => toggleElement(current, item))}
          onToggleAll={toggleAll}
          toggling={loading}
          selectedItems={selectedItems}
          iaImport={iaImport}
          header={mdOrLess && header}
        />
      </div>
    </SimpleModal>
  )
}
