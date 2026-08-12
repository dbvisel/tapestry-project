/**
 * Minimal support for importing a Wikimedia Commons file page (e.g.
 * `https://commons.wikimedia.org/wiki/File:Foo.jpg`) as a plain media item: given such a URL, resolve it to
 * the direct, hotlinkable URL of the underlying file (and its media type).
 */

import { maxBy } from 'lodash-es'

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

/** Returns the first element of an array, or undefined if it isn't a non-empty array. */
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined
}

const COMMONS_FILE_PATH_RE = /^\/wiki\/(File:.+)$/i
const COMMONS_FILE_HASH_RE = /^#\/media\/(File:.+)$/i

/**
 * Recognizes a Wikimedia Commons file page URL and extracts its (still URL-encoded, underscored) file
 * title, e.g. "File:STS-135_Atlantis%27_final_tow_back.jpg". Handles two forms:
 *  - a direct file page: `/wiki/File:Foo.jpg`, optionally with a `#/media/File:...` hash MediaViewer adds
 *    when the file is opened from a gallery (both parts name the same file, so either is enough).
 *  - the MediaViewer lightbox opened from a *different* page (a category, search results, Main_Page, ...):
 *    the path stays on that page (e.g. `/wiki/Main_Page`) and the file is named *only* in the hash.
 */
export function parseCommonsFileURL(url: string): { filename: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.hostname !== 'commons.wikimedia.org') return null

  const match = COMMONS_FILE_PATH_RE.exec(parsed.pathname) ?? COMMONS_FILE_HASH_RE.exec(parsed.hash)
  if (!match) return null

  return { filename: decodeURIComponent(match[1]) }
}

/**
 * MediaWiki's own broad classification of a file, independent of its container format. This is more useful
 * than the raw MIME type for deciding how to import a file: an Ogg container reports as the generic
 * "application/ogg" MIME type whether it holds a Theora video or a Vorbis audio stream, but `mediatype`
 * still correctly says "VIDEO" or "AUDIO". Commons uses a fixed, uppercase vocabulary; the ones relevant
 * here are BITMAP/DRAWING (images, including SVG), AUDIO, and VIDEO.
 */
export type CommonsMediaType = 'BITMAP' | 'DRAWING' | 'AUDIO' | 'VIDEO' | (string & {})

export interface CommonsFileInfo {
  /**
   * The direct, hotlinkable URL to use for the file: normally the original upload, but for a video that has
   * a WebM transcode available, the best (highest-resolution) WebM derivative instead (see below).
   */
  url: string
  /** The file's IANA media type, e.g. "image/jpeg" or "application/ogg". */
  mime: string
  mediatype: CommonsMediaType
}

interface CommonsDerivative {
  src: string
  /** The derivative's content type, e.g. `video/webm; codecs="vp9, opus"`. */
  type: string
  height?: number
}

function parseDerivatives(value: unknown): CommonsDerivative[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    const record = asRecord(entry)
    const src = asString(record?.src)
    const type = asString(record?.type)
    return src && type ? [{ src, type, height: asNumber(record?.height) }] : []
  })
}

/**
 * Commons transcodes every uploaded video (via the TimedMediaHandler extension) into one or more WebM
 * (VP8/VP9) renditions, alongside the original upload. This matters because modern Chrome and Safari can no
 * longer decode Ogg Theora - the original codec for a lot of older Commons video - so a Theora file plays
 * audio only, with no visible frames, unless one of these WebM transcodes is used instead. Returns the
 * highest-resolution WebM derivative, or undefined if the file has none (e.g. it's already WebM/not a video).
 */
function bestWebmDerivative(derivatives: CommonsDerivative[]): CommonsDerivative | undefined {
  return maxBy(
    derivatives.filter((derivative) => derivative.type.startsWith('video/webm')),
    (derivative) => derivative.height ?? 0,
  )
}

/**
 * Resolves one `videoinfo` API record (see `fetchCommonsFileInfo`/`fetchCommonsCategoryMembers`) into the
 * file URL and media type to actually use, preferring a WebM transcode over the original for videos.
 */
function toFileInfo(videoInfo: Record<string, unknown> | undefined): CommonsFileInfo | null {
  const fileURL = asString(videoInfo?.url)
  const mime = asString(videoInfo?.mime)
  const mediatype = asString(videoInfo?.mediatype)
  if (!fileURL || !mime || !mediatype) return null

  const webm =
    mediatype === 'VIDEO' ? bestWebmDerivative(parseDerivatives(videoInfo?.derivatives)) : undefined

  return webm
    ? { url: webm.src, mime: webm.type.split(';')[0].trim(), mediatype }
    : { url: fileURL, mime, mediatype }
}

/**
 * Resolves a Commons file title to the direct file URL to use, and its media type, via the
 * `action=query&prop=videoinfo` endpoint (a superset of `prop=imageinfo` that also reports video transcodes).
 * `origin=*` opts the response into CORS so this can be called directly from the browser. Returns `null` if
 * the file doesn't exist or the request fails.
 */
export async function fetchCommonsFileInfo(
  filename: string,
  signal?: AbortSignal,
): Promise<CommonsFileInfo | null> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('prop', 'videoinfo')
  url.searchParams.set('titles', filename)
  url.searchParams.set('viprop', 'url|mime|mediatype|derivatives')
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')
  url.searchParams.set('origin', '*')

  const response = await fetch(url, { signal })
  if (!response.ok) return null

  const data: unknown = await response.json()
  const page = first(asRecord(asRecord(data)?.query)?.pages)
  return toFileInfo(asRecord(first(asRecord(page)?.videoinfo)))
}

const COMMONS_CATEGORY_PATH_RE = /^\/wiki\/(Category:.+)$/i

/**
 * Recognizes a Wikimedia Commons category page URL and extracts its (still URL-encoded, underscored)
 * category title, e.g. "Category:Cats".
 */
export function parseCommonsCategoryURL(url: string): { category: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.hostname !== 'commons.wikimedia.org') return null

  const match = COMMONS_CATEGORY_PATH_RE.exec(parsed.pathname)
  if (!match) return null

  return { category: decodeURIComponent(match[1]) }
}

export interface CommonsCategoryMember extends CommonsFileInfo {
  /** The file's title (e.g. "File:Foo.jpg"), used as a stable identifier. */
  id: string
  /** A small preview image, for a picker to show - always present for images, but not for audio/video. */
  thumbnailUrl?: string
}

export interface CommonsCategoryMembers {
  members: CommonsCategoryMember[]
  /** The category's total file count (from `prop=categoryinfo`), which may exceed `members.length`. */
  total: number
}

// The max `gcmlimit`/page size an anonymous (unauthenticated) request is allowed to ask for. Capping
// listing at this size keeps category browsing to a single request; a picker also caps how many files can
// be selected at once, so there's little value in paginating further just to browse a huge category.
const CATEGORY_MEMBERS_LIMIT = 500
const CATEGORY_THUMBNAIL_WIDTH = 200

/**
 * Fetches just a Commons category's total file count, via the lightweight `prop=categoryinfo` endpoint -
 * cheap enough (no thumbnails, no per-file lookups) to call just to show a count before the user has
 * committed to opening the full picker (see `commonsCategoryFactory`), unlike `fetchCommonsCategoryMembers`.
 */
export async function fetchCommonsCategoryFileCount(
  category: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('prop', 'categoryinfo')
  url.searchParams.set('titles', category)
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')
  url.searchParams.set('origin', '*')

  const response = await fetch(url, { signal })
  if (!response.ok) return undefined

  const data: unknown = await response.json()
  const page = asRecord(first(asRecord(asRecord(data)?.query)?.pages))
  return asNumber(asRecord(page?.categoryinfo)?.files)
}

// MediaWiki batches thumbnail generation within a single `prop=videoinfo` response, which is much more
// expensive for file types that need rendering (a PDF's first page) than for a plain image - a category
// with a lot of PDFs can easily need several `vicontinue` round trips before every member has come back
// with its videoinfo, even though `gcmlimit` above means the member listing itself never needs its own
// continuation. This just bounds how many such round trips are followed before giving up.
const MAX_VIDEOINFO_CONTINUATION_ROUNDS = 20

// Every consumer that wants a category's full member listing (the picker's list and its "select all") wants
// the exact same data, and each fetch is now potentially many sequential requests (see
// `MAX_VIDEOINFO_CONTINUATION_ROUNDS`) - without sharing, opening one category import can multiply into
// dozens of requests to Commons for what is, from the user's perspective, a single action. Keyed by
// category; a failed fetch is evicted so a transient error doesn't permanently poison it for the session.
// The underlying fetch intentionally isn't tied to any one caller's `AbortSignal`, since aborting it would
// also break every other caller currently sharing it.
const categoryMembersCache = new Map<string, Promise<CommonsCategoryMembers | null>>()

/**
 * Lists the image/video/audio/document files directly in a Commons category (not its subcategories), via
 * `generator=categorymembers` + `prop=videoinfo` - fetching membership and file info (including a
 * thumbnail and, for video, the best WebM transcode) together, rather than as separate round trips per
 * file. Returns `null` if the category doesn't exist or the request fails. Results are cached per category
 * for the lifetime of the page (see `categoryMembersCache`).
 */
export function fetchCommonsCategoryMembers(
  category: string,
): Promise<CommonsCategoryMembers | null> {
  let pending = categoryMembersCache.get(category)
  if (!pending) {
    pending = fetchCommonsCategoryMembersUncached(category)
    categoryMembersCache.set(category, pending)
    void pending.then((result) => {
      if (!result) categoryMembersCache.delete(category)
    })
  }
  return pending
}

async function fetchCommonsCategoryMembersUncached(
  category: string,
): Promise<CommonsCategoryMembers | null> {
  const membersById = new Map<string, CommonsCategoryMember>()
  let continuation: Record<string, string> | undefined

  const fileCountPromise = fetchCommonsCategoryFileCount(category)

  for (let round = 0; round < MAX_VIDEOINFO_CONTINUATION_ROUNDS; round++) {
    const url = new URL('https://commons.wikimedia.org/w/api.php')
    url.searchParams.set('action', 'query')
    url.searchParams.set('generator', 'categorymembers')
    url.searchParams.set('gcmtitle', category)
    url.searchParams.set('gcmtype', 'file')
    url.searchParams.set('gcmnamespace', '6')
    url.searchParams.set('gcmlimit', String(CATEGORY_MEMBERS_LIMIT))
    url.searchParams.set('prop', 'videoinfo')
    url.searchParams.set('viprop', 'url|mime|mediatype|derivatives')
    url.searchParams.set('viurlwidth', String(CATEGORY_THUMBNAIL_WIDTH))
    url.searchParams.set('format', 'json')
    url.searchParams.set('formatversion', '2')
    url.searchParams.set('origin', '*')
    // Only the `videoinfo` prop's own continuation is followed here (never `gcmcontinue`, which MediaWiki
    // would also offer once a category has more than `gcmlimit` members) - browsing beyond that cap isn't
    // supported (see `CATEGORY_MEMBERS_LIMIT`), so only `vicontinue`/`continue` are copied onto the next
    // round's request.
    if (continuation?.vicontinue) url.searchParams.set('vicontinue', continuation.vicontinue)
    if (continuation?.continue) url.searchParams.set('continue', continuation.continue)

    const response = await fetch(url)
    if (!response.ok) {
      // A later round failing (e.g. a transient network error) shouldn't discard members already resolved
      // in earlier rounds - only a first-round failure means the category couldn't be listed at all.
      if (round === 0) return null
      break
    }

    const data: unknown = await response.json()
    const pages = asRecord(asRecord(data)?.query)?.pages
    if (Array.isArray(pages)) {
      for (const member of pages.flatMap(parseCategoryMember)) {
        // A page not yet resolved in an earlier round comes back with no `videoinfo` at all in this one
        // (rather than repeating what's already been delivered), so an already-resolved member must never
        // be overwritten by a later, still-unresolved appearance of the same file.
        if (!membersById.has(member.id)) membersById.set(member.id, member)
      }
    }

    const cont = asRecord(asRecord(data)?.continue)
    const vicontinue = asString(cont?.vicontinue)
    if (!vicontinue) break
    continuation = { vicontinue, continue: asString(cont?.continue) ?? '' }
  }

  const fileCount = await fileCountPromise
  const members = [...membersById.values()]
  return { members, total: fileCount ?? members.length }
}

function parseCategoryMember(page: unknown): CommonsCategoryMember[] {
  const record = asRecord(page)
  const title = asString(record?.title)
  const videoInfo = asRecord(first(record?.videoinfo))
  const info = toFileInfo(videoInfo)
  if (!title || !info) return []

  return [{ id: title, thumbnailUrl: asString(videoInfo?.thumburl), ...info }]
}
