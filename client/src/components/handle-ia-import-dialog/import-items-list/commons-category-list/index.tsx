import { useMemo, useState } from 'react'
import { partial } from 'lodash-es'
import { Checkbox } from 'tapestry-core-client/src/components/lib/checkbox'
import { useObservable } from 'tapestry-core-client/src/components/lib/hooks/use-observable'
import { Text } from 'tapestry-core-client/src/components/lib/text/index'
import {
  CommonsCategoryMember,
  fetchCommonsCategoryMembers,
} from 'tapestry-core/src/wikimedia-commons'
import { ListResponseDto } from 'tapestry-shared/src/data-transfer/resources/dtos/common'
import { ImportItemsListProps } from '..'
import { Breakpoint, useResponsive } from '../../../../providers/responsive-provider'
import { LazyList } from '../../../lazy-list'
import { LazyListLoader } from '../../../lazy-list/lazy-list-loader'
import { LoadingLogoIcon } from '../../../loading-logo-icon'
import { MAX_SELECTION } from '../..'
import { SelectAll } from '../select-all'
import styles from './styles.module.css'

/**
 * Unlike IA's collection search, `fetchCommonsCategoryMembers` always fetches an entire category (up to its
 * cap) rather than a genuine server-side page, so `skip`/`limit` here just slice that result in memory. This
 * still fits `<LazyList>`'s windowed `requestItems` contract. `fetchCommonsCategoryMembers` caches its
 * result per category, so this "re-fetching" on each call (including the dialog's own "select all", which
 * calls this same function) is cheap after the first: it's the same shared promise, not a repeat network
 * round trip - important now that a category with a lot of PDFs can take several requests to resolve (see
 * `MAX_VIDEOINFO_CONTINUATION_ROUNDS` in `wikimedia-commons.ts`).
 */
export async function requestCategoryMembers(
  category: string,
  skip: number,
  limit: number,
  _signal: AbortSignal,
): Promise<ListResponseDto<CommonsCategoryMember>> {
  const result = await fetchCommonsCategoryMembers(category)
  return {
    skip,
    total: result?.total ?? 0,
    data: (result?.members ?? []).slice(skip, skip + limit),
  }
}

interface CommonsCategoryListProps extends Omit<ImportItemsListProps, 'iaImport'> {
  category: string
}

export function CommonsCategoryList({
  onSelect,
  onToggleAll,
  toggling,
  category,
  selectedItems,
  header,
}: CommonsCategoryListProps) {
  const mdOrLess = useResponsive() <= Breakpoint.MD
  const textVariant = mdOrLess ? 'bodyXs' : undefined

  const [listLoader, setListLoader] = useState<LazyListLoader<CommonsCategoryMember> | null>(null)
  const state = useObservable(listLoader)
  const total = state?.total

  const requestItems = useMemo(() => partial(requestCategoryMembers, category), [category])

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
                    {item.thumbnailUrl && (
                      <img className={styles.itemImage} src={item.thumbnailUrl} />
                    )}
                    <Text lineClamp={2} variant={textVariant}>
                      {item.id.replace(/^File:/, '')}
                    </Text>
                  </>
                ),
                position: 'after',
              }}
            />
          )
        }}
        emptyPlaceholder={<Text>No files in this category</Text>}
        loadingIndicator={<LoadingLogoIcon className={styles.loadingIndicator} />}
      />
    </div>
  )
}
