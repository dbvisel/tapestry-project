/**
 * Fetches a Wikipedia article's main content as HTML via the REST API's `page/html` endpoint (Parsoid
 * output), which contains only the parsed article body - no site chrome, navigation, or sidebars. The
 * endpoint is served with permissive CORS, so this can be called directly from the browser.
 */
export async function fetchWikipediaArticleHTML(
  lang: string,
  title: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title)}`
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Failed to fetch Wikipedia article "${title}" (${lang}): ${response.status}`)
  }
  return response.text()
}

/**
 * The article title, as HTML (e.g. italicized for a film/book/ship title). This isn't part of the
 * `page/html` body - MediaWiki's skin renders it separately as the page's `<h1>` heading - so it's fetched
 * from the REST API's summary endpoint instead. Falls back to the plain title on any failure.
 */
export async function fetchWikipediaDisplayTitle(
  lang: string,
  title: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    const response = await fetch(url, { signal })
    if (!response.ok) return title

    const data: unknown = await response.json()
    const displayTitle =
      data && typeof data === 'object' && 'displaytitle' in data ? data.displaytitle : undefined
    return typeof displayTitle === 'string' ? displayTitle : title
  } catch {
    return title
  }
}

export interface WikipediaCategory {
  /** The category's page title, with its "Category:" namespace prefix removed. */
  title: string
}

/**
 * The article's (non-hidden) categories. Like the title, these are part of the skin's `main#content`
 * region but not the `page/html` body, so they're fetched separately - via the `action=query` API (with
 * `origin=*` to opt into CORS, since only the REST API is CORS-enabled by default). Returns an empty array
 * on any failure, since the categories footer is a supplementary addition, not core article content.
 */
export async function fetchWikipediaCategories(
  lang: string,
  title: string,
  signal?: AbortSignal,
): Promise<WikipediaCategory[]> {
  try {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`)
    url.searchParams.set('action', 'query')
    url.searchParams.set('prop', 'categories')
    url.searchParams.set('titles', title)
    url.searchParams.set('format', 'json')
    url.searchParams.set('formatversion', '2')
    url.searchParams.set('clshow', '!hidden')
    url.searchParams.set('cllimit', '50')
    url.searchParams.set('origin', '*')

    const response = await fetch(url, { signal })
    if (!response.ok) return []

    const data: unknown = await response.json()
    const categories = extractCategories(data)
    return categories.map((category) => ({ title: category.replace(/^[^:]+:/, '') }))
  } catch {
    return []
  }
}

function extractCategories(data: unknown): string[] {
  if (!data || typeof data !== 'object' || !('query' in data)) return []
  const query = (data as { query?: unknown }).query
  if (!query || typeof query !== 'object' || !('pages' in query)) return []
  const pages = (query as { pages?: unknown }).pages
  if (!Array.isArray(pages)) return []
  const firstPage: unknown = pages[0]
  if (!firstPage || typeof firstPage !== 'object' || !('categories' in firstPage)) return []
  const categories = (firstPage as { categories?: unknown }).categories
  if (!Array.isArray(categories)) return []

  return categories
    .map((category: unknown) =>
      category && typeof category === 'object' && 'title' in category
        ? (category as { title?: unknown }).title
        : undefined,
    )
    .filter((title): title is string => typeof title === 'string')
}
