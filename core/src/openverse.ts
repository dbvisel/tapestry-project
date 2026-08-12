/**
 * Minimal support for importing images from Openverse (https://openverse.org): a single image page
 * (`openverse.org/image/<uuid>`) resolves to a plain image item, and a tag collection page
 * (`openverse.org/image/collection?tag=<tag>`) is listed via the public Openverse API for a picker to
 * choose from - the same shape of feature as the existing Wikimedia Commons file/category import.
 */

const OPENVERSE_API = 'https://api.openverse.org/v1/images/'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export interface OpenverseImage {
  id: string
  /** The direct, hotlinkable URL of the image, on whichever third-party site originally hosts it. */
  url: string
  title?: string
  /** A small preview image, for a picker to show. */
  thumbnail?: string
}

function parseOpenverseImage(record: unknown): OpenverseImage | null {
  const image = asRecord(record)
  const id = asString(image?.id)
  const url = asString(image?.url)
  return id && url
    ? { id, url, title: asString(image?.title), thumbnail: asString(image?.thumbnail) }
    : null
}

const OPENVERSE_IMAGE_PATH_RE = /^\/image\/([0-9a-f-]{36})(?:\/|$)/i

/**
 * Recognizes a single Openverse image page URL (e.g. `openverse.org/image/<uuid>?p=15` - the `p` param is
 * just the search results page the user came from, irrelevant to the image itself) and extracts its id.
 */
export function parseOpenverseImageURL(url: string): { id: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.hostname !== 'openverse.org') return null

  const match = OPENVERSE_IMAGE_PATH_RE.exec(parsed.pathname)
  return match ? { id: match[1] } : null
}

/** Fetches a single Openverse image's details by id. Returns `null` if it doesn't exist or the request fails. */
export async function fetchOpenverseImage(
  id: string,
  signal?: AbortSignal,
): Promise<OpenverseImage | null> {
  try {
    const response = await fetch(`${OPENVERSE_API}${id}/`, { signal })
    if (!response.ok) return null

    return parseOpenverseImage(await response.json())
  } catch (error) {
    console.warn('Failed to fetch Openverse image', error)
    return null
  }
}

/**
 * Recognizes an Openverse tag-collection page URL (e.g. `openverse.org/image/collection?tag=aztec`) and
 * extracts the tag. Openverse's collection page also supports `creator`/`source` collections, but only the
 * tag form is handled here for now.
 */
export function parseOpenverseTagCollectionURL(url: string): { tag: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.hostname !== 'openverse.org' || parsed.pathname !== '/image/collection') return null

  const tag = parsed.searchParams.get('tag')
  return tag ? { tag } : null
}

export interface OpenverseImagePage {
  images: OpenverseImage[]
  total: number
}

/**
 * Lists images tagged with a given tag, via Openverse's public search API (`tags=` is documented as an
 * exact, tag-only filter - see the `wikimedia-commons`-style skill this mirrors). Genuinely paginated
 * server-side (unlike the Commons category listing), so callers can request any page/pageSize directly.
 * Returns `null` if the request fails.
 */
export async function fetchOpenverseTagCollection(
  tag: string,
  { page, pageSize }: { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<OpenverseImagePage | null> {
  try {
    const url = new URL(OPENVERSE_API)
    url.searchParams.set('tags', tag)
    url.searchParams.set('page', String(page))
    url.searchParams.set('page_size', String(pageSize))

    const response = await fetch(url, { signal })
    if (!response.ok) return null

    const data: unknown = await response.json()
    const results = asRecord(data)?.results
    const images = Array.isArray(results)
      ? results.flatMap((r) => parseOpenverseImage(r) ?? [])
      : []

    return { images, total: asNumber(asRecord(data)?.result_count) ?? images.length }
  } catch (error) {
    console.warn('Failed to fetch Openverse tag collection', error)
    return null
  }
}
