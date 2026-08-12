import { iaAdvancedSearch, IAMediaType } from 'tapestry-core/src/internet-archive'

/**
 * The shape of an Internet Archive advanced-search result item, as used by any picker backed by
 * `advancedsearch.php` (an IA collection's members, or a raw search query's results).
 */
export interface IASearchResultItem {
  id: string
  identifier: string
  mediatype: IAMediaType
  title: string
  creator?: string | undefined
  publicdate: string
  downloads: number
}

const SEARCH_FIELDS = {
  identifier: true,
  mediatype: true,
  title: true,
  creator: true,
  publicdate: true,
  downloads: true,
} as const
const SEARCH_SORT = ['downloads desc', 'identifier desc']

/**
 * Runs an IA advanced-search query for the [skip, skip + limit) window, using the same two-page-straddle
 * trick regardless of the query: IA's search API is genuinely paginated server-side by page number, not by
 * arbitrary offset, so a window that doesn't align to a page boundary needs up to two page fetches
 * straddled together and re-sliced.
 */
export async function requestIAAdvancedSearchPage(
  q: string,
  skip: number,
  limit: number,
  signal: AbortSignal,
) {
  const opts = { q, fields: SEARCH_FIELDS, sort: SEARCH_SORT }
  const firstPage = Math.floor(skip / limit) + 1

  const firstPageResult = await iaAdvancedSearch(
    { ...opts, page: firstPage, pageSize: limit },
    signal,
  )
  const totalCount = firstPageResult?.response.numFound

  const extra = skip % limit
  const secondPageResult = extra
    ? await iaAdvancedSearch({ ...opts, page: firstPage + 1, pageSize: limit }, signal)
    : null

  const finalResult: IASearchResultItem[] = [
    ...(firstPageResult?.response.docs ?? []),
    ...(secondPageResult?.response.docs ?? []),
  ]
    .slice(extra, extra + limit)
    .map((doc) => ({ ...doc, id: doc.identifier }))

  return {
    skip,
    total: totalCount ?? finalResult.length,
    data: finalResult,
  }
}
