import { useMemo, useState } from 'react'
import { partial, range } from 'lodash-es'
import { Checkbox } from 'tapestry-core-client/src/components/lib/checkbox'
import { useObservable } from 'tapestry-core-client/src/components/lib/hooks/use-observable'
import { Text } from 'tapestry-core-client/src/components/lib/text/index'
import { fetchOpenverseTagCollection, OpenverseImage } from 'tapestry-core/src/openverse'
import { ListResponseDto } from 'tapestry-shared/src/data-transfer/resources/dtos/common'
import { ImportItemsListProps } from '..'
import { Breakpoint, useResponsive } from '../../../../providers/responsive-provider'
import { LazyList } from '../../../lazy-list'
import { LazyListLoader } from '../../../lazy-list/lazy-list-loader'
import { LoadingLogoIcon } from '../../../loading-logo-icon'
import { MAX_SELECTION } from '../..'
import { SelectAll } from '../select-all'
import styles from './styles.module.css'

// Openverse rejects (429) anonymous requests for a page_size above this, regardless of what window size
// the picker itself asks for - so the actual API calls always use this fixed page size, however many of
// them it takes to cover the requested [skip, skip + limit) range.
const OPENVERSE_ANONYMOUS_PAGE_SIZE = 20

/**
 * Openverse's search API is genuinely paginated server-side by page number, not by arbitrary offset, so a
 * requested `skip`/`limit` window is covered by fetching however many fixed-size API pages overlap it, then
 * slicing out exactly the requested range.
 */
export async function requestOpenverseCollection(
  tag: string,
  skip: number,
  limit: number,
  signal: AbortSignal,
): Promise<ListResponseDto<OpenverseImage>> {
  const pageSize = OPENVERSE_ANONYMOUS_PAGE_SIZE
  const firstApiPage = Math.floor(skip / pageSize) + 1
  const lastApiPage = Math.floor((skip + limit - 1) / pageSize) + 1

  const pages = await Promise.all(
    range(firstApiPage, lastApiPage + 1).map((page) =>
      fetchOpenverseTagCollection(tag, { page, pageSize }, signal),
    ),
  )

  // `fetchOpenverseTagCollection` returns `null` only on a failed request (a legitimately empty tag search
  // still succeeds, returning `{ images: [], total: 0 }`) - so a `null` page unambiguously means the load
  // failed, most likely Openverse rate-limiting anonymous requests. Throwing here (rather than silently
  // treating it as "no images") lets `LazyList`'s error state surface that distinction to the user.
  if (pages.some((page) => page === null)) {
    throw new Error(`Failed to load images tagged "${tag}" from Openverse`)
  }

  const total = pages[0]?.total ?? 0
  const combined = pages.flatMap((page) => page?.images ?? [])
  const offsetWithinFetchedPages = skip - (firstApiPage - 1) * pageSize
  const data = combined.slice(offsetWithinFetchedPages, offsetWithinFetchedPages + limit)

  return { skip, total, data }
}

interface OpenverseCollectionListProps extends Omit<ImportItemsListProps, 'iaImport'> {
  tag: string
}

export function OpenverseCollectionList({
  onSelect,
  onToggleAll,
  toggling,
  tag,
  selectedItems,
  header,
}: OpenverseCollectionListProps) {
  const mdOrLess = useResponsive() <= Breakpoint.MD
  const textVariant = mdOrLess ? 'bodyXs' : undefined

  const [listLoader, setListLoader] = useState<LazyListLoader<OpenverseImage> | null>(null)
  const state = useObservable(listLoader)
  const total = state?.total

  const requestItems = useMemo(() => partial(requestOpenverseCollection, tag), [tag])

  const selectedCount = selectedItems.length
  const hasSelection = selectedCount > 0

  const selectAll = (
    <SelectAll
      checked={hasSelection}
      onChange={() => onToggleAll(!hasSelection)}
      total={total}
      loading={toggling}
      classes={{ root: mdOrLess ? styles.mobileSelectAll : undefined, checkbox: styles.checkbox }}
      textVariant={textVariant}
    />
  )

  return (
    <div className={styles.root}>
      {!mdOrLess && <div className={styles.header}>{selectAll}</div>}
      <LazyList
        windowSize={100}
        requestItems={requestItems}
        loadingEdgeProximity={15}
        onLoaderInitialized={setListLoader}
        header={
          mdOrLess ? (
            <>
              {!state?.skip && header}
              {selectAll}
            </>
          ) : (
            header
          )
        }
        renderItem={(item) => {
          const checked = !!selectedItems.find((i) => i.id === item.id)
          return (
            <Checkbox
              checked={checked}
              onChange={() => onSelect({ id: item.id })}
              classes={{ checkbox: styles.checkbox }}
              disabled={!checked && selectedCount >= MAX_SELECTION}
              label={{
                content: (
                  <>
                    <img className={styles.itemImage} src={item.thumbnail ?? item.url} />
                    <Text lineClamp={2} variant={textVariant}>
                      {item.title || 'Untitled'}
                    </Text>
                  </>
                ),
                position: 'after',
              }}
            />
          )
        }}
        emptyPlaceholder={<Text>No images with this tag</Text>}
        errorPlaceholder={
          <Text>
            Couldn&apos;t load images from Openverse - it may be rate-limiting anonymous requests.
            Wait a moment, then reopen this dialog to try again.
          </Text>
        }
        loadingIndicator={<LoadingLogoIcon className={styles.loadingIndicator} />}
      />
    </div>
  )
}
