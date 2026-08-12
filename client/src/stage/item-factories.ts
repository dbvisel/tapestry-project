import { isHTTPURL } from 'tapestry-core/src/utils'
import { MediaItemSource } from '../lib/media'
import { createMediaItem, getMediaSourceText } from '../model/data/utils'
import { ItemCreateDto } from 'tapestry-shared/src/data-transfer/resources/dtos/item'
import {
  findWebSourceParser,
  WEB_SOURCE_PARSERS,
  WebSourceParser,
} from 'tapestry-core/src/web-sources'
import {
  iaAdvancedSearch,
  iaItemEmbedURL,
  IAMediaType,
  parseInternetArchiveSearchURL,
  parseInternetArchiveURL,
  IAItem,
  getIAItemMetadata,
  getIAPlaylistEntries,
  getNestedIAItems,
  getIAIIIFManifestURL,
} from 'tapestry-core/src/internet-archive'
import { fetchIIIFFirstCanvas } from 'tapestry-core/src/iiif'
import {
  CommonsFileInfo,
  CommonsMediaType,
  fetchCommonsCategoryFileCount,
  fetchCommonsFileInfo,
  parseCommonsCategoryURL,
  parseCommonsFileURL,
} from 'tapestry-core/src/wikimedia-commons'
import {
  fetchOpenverseImage,
  fetchOpenverseTagCollection,
  OpenverseImage,
  parseOpenverseImageURL,
  parseOpenverseTagCollectionURL,
} from 'tapestry-core/src/openverse'
import { MediaItemType, WebpageType } from 'tapestry-core/src/data-format/schemas/item'
import { getUserListItems } from '../lib/internet-archive'
import { parseMediaSource, parseStringTransferData } from './data-transfer-handler'
import { fileTypeFromBuffer } from 'file-type'
import { compact } from 'lodash-es'
import { parse } from 'ini'
import { IAImport } from '../pages/tapestry/view-model'

/**
 * Tries to extract a link from a url file. This is a shortcut file created on Windows in INI format
 */
async function parseUrlFile(source: File) {
  if (!source.name.endsWith('url')) {
    return
  }

  type URLSection = Record<'URL', string> | undefined
  const url = (parse(await source.text()).InternetShortcut as URLSection)?.URL

  return url
}

/**
 * Tries to extract a link from a webloc file. This is a shortcut file created on MacOS in XML format
 */
async function parseWeblocFile(source: File) {
  if (!source.name.endsWith('webloc')) {
    return
  }

  const fileType = await fileTypeFromBuffer(await source.arrayBuffer())

  if (fileType?.mime !== 'application/xml') {
    return
  }

  const children = new DOMParser()
    .parseFromString(await source.text(), 'application/xml')
    .querySelector('dict')?.children
  if (children?.length !== 2) {
    return
  }

  const [{ textContent: type }, { textContent: url }] = children
  if (type !== 'URL') {
    return
  }

  return url
}

/**
 * An ItemFactory takes a MediaItemSource (File or URL) and tries to produce one or more tapestry items from it.
 * If a factory doesn't know how to handle a given source, it returns null.
 */
export type ItemFactoryResult = { items: ItemCreateDto[]; iaImports: IAImport[] }
type ItemFactory = (
  source: MediaItemSource,
  mediaType: string | null,
  tapestryId: string,
) => Promise<ItemFactoryResult | null>

function createSimpleMediaItemFactory(
  itemType: MediaItemType,
  sourceMatches: (source: MediaItemSource, mediaType: string | null) => boolean,
): ItemFactory {
  return async (source, mediaType, tapestryId) => {
    if (!sourceMatches(source, mediaType)) return null

    return { items: [await createMediaItem(itemType, source, tapestryId)], iaImports: [] }
  }
}

const textItemFactory: ItemFactory = async (source, mediaType, tapestryId) => {
  if (mediaType !== 'text/plain') return null

  const sourceAsText = await getMediaSourceText(source)

  return await parseStringTransferData(sourceAsText, tapestryId)
}

const htmlFileItemFactory: ItemFactory = async (source, mediaType, tapestryId) => {
  if (!mediaType?.startsWith('application/xhtml') && mediaType !== 'text/html') return null

  return { items: [await createMediaItem('webpage', source, tapestryId)], iaImports: [] }
}

const webpageItemFactory: ItemFactory = async (source, _mediaType, tapestryId) => {
  if (typeof source !== 'string' || !isHTTPURL(source)) return null

  const parser = await findWebSourceParser(source)
  const item = await createMediaItem('webpage', parser.construct(parser.parse(source)), tapestryId)
  item.webpageType = parser.webpageType
  item.skipSourceResolution = true

  return { items: [item], iaImports: [] }
}

/**
 * Some sites need their `source` resolved by a dedicated web-source parser before the generic webpage/iframe
 * path can be considered - either because the page can't be framed directly and must be rewritten to a
 * dedicated embed/widget URL (SoundCloud, Spotify), or because the item is rendered from fetched content
 * instead of an iframe (Wikipedia). These need their own factories ahead of htmlFileItemFactory: e.g.
 * soundcloud.com and wikipedia.org serve an exact `text/html` content type, which htmlFileItemFactory would
 * otherwise intercept into a (broken or suboptimal) generic webpage before the parser-aware
 * webpageItemFactory is reached.
 */
function createWebSourceEmbedFactory(parser: WebSourceParser<WebpageType>): ItemFactory {
  return async (source, _mediaType, tapestryId) => {
    if (typeof source !== 'string' || !isHTTPURL(source)) return null
    if (!(await parser.matches(source))) return null

    const item = await createMediaItem(
      'webpage',
      parser.construct(parser.parse(source)),
      tapestryId,
    )
    item.webpageType = parser.webpageType
    item.skipSourceResolution = true

    return { items: [item], iaImports: [] }
  }
}

const soundcloudItemFactory = createWebSourceEmbedFactory(WEB_SOURCE_PARSERS.soundcloud)
const spotifyItemFactory = createWebSourceEmbedFactory(WEB_SOURCE_PARSERS.spotify)
const wikipediaItemFactory = createWebSourceEmbedFactory(WEB_SOURCE_PARSERS.wikipedia)
const sketchfabItemFactory = createWebSourceEmbedFactory(WEB_SOURCE_PARSERS.sketchfab)

const COMMONS_MEDIA_ITEM_TYPES: Partial<Record<CommonsMediaType, 'image' | 'video' | 'model3d'>> = {
  BITMAP: 'image',
  DRAWING: 'image',
  VIDEO: 'video',
  '3D': 'model3d',
}

/**
 * Resolves a Commons file to the item type it should import as. Most cases are a straight lookup by
 * `mediatype`, but Commons' "OFFICE" mediatype covers PDFs as well as other document formats (DjVu, Word,
 * ...) we have no viewer for, so that one case is narrowed further by MIME type.
 */
function commonsItemType(file: CommonsFileInfo): MediaItemType | null {
  if (file.mediatype === 'OFFICE') {
    return file.mime === 'application/pdf' ? 'pdf' : null
  }
  return COMMONS_MEDIA_ITEM_TYPES[file.mediatype] ?? null
}

/**
 * A Wikimedia Commons file page (`commons.wikimedia.org/wiki/File:...`) is a wiki page describing a media
 * file, not the file itself - it needs its own factory (ahead of htmlFileItemFactory, which would otherwise
 * intercept its `text/html` content type into a plain webpage) to resolve it to the underlying file's direct
 * URL and import it as a regular image, video, 3D model, or PDF item. Only those are handled for now;
 * anything else (audio, non-PDF documents, ...) falls through to the remaining factories, which will import
 * the file page itself.
 */
const commonsFileItemFactory: ItemFactory = async (source, _mediaType, tapestryId) => {
  if (typeof source !== 'string' || !isHTTPURL(source)) return null

  const parsed = parseCommonsFileURL(source)
  if (!parsed) return null

  const fileInfo = await fetchCommonsFileInfo(parsed.filename)
  const itemType = fileInfo && commonsItemType(fileInfo)
  if (!itemType) return null

  return { items: [await createMediaItem(itemType, fileInfo.url, tapestryId)], iaImports: [] }
}

/**
 * Creates image/video/model3d/PDF items from a set of already-resolved Commons files (see
 * `HandleIAImportDialog`'s picker, whose selections are re-resolved via `fetchCommonsFileInfo` at confirm
 * time). Files whose media type isn't handled (audio, non-PDF documents, ...) are silently skipped,
 * mirroring `commonsFileItemFactory`.
 */
export async function createCommonsMediaItems(tapestryId: string, files: CommonsFileInfo[]) {
  const items = await Promise.all(
    files.map(async (file) => {
      const itemType = commonsItemType(file)
      return itemType ? await createMediaItem(itemType, file.url, tapestryId) : null
    }),
  )
  return compact(items)
}

/**
 * A Wikimedia Commons category page (`commons.wikimedia.org/wiki/Category:...`) can hold many files, so
 * (like an Internet Archive collection) it's imported via the picker dialog rather than dumping every
 * member onto the canvas at once. Just the (cheap) file count is needed to show the picker's header - the
 * full member listing (an expensive, potentially multi-request fetch) is left to the picker itself, and
 * only once the user actually opens it.
 */
const commonsCategoryFactory: ItemFactory = async (source, _mediaType, _tapestryId) => {
  if (typeof source !== 'string' || !isHTTPURL(source)) return null

  const parsed = parseCommonsCategoryURL(source)
  if (!parsed) return null

  const total = await fetchCommonsCategoryFileCount(parsed.category)
  if (total === undefined) return null

  return {
    items: [],
    iaImports: [{ type: 'CommonsCategory', category: parsed.category, total }],
  }
}

/** Creates image items from a set of already-resolved Openverse images (mirrors `createCommonsMediaItems`). */
export async function createOpenverseMediaItems(tapestryId: string, images: OpenverseImage[]) {
  return Promise.all(images.map((image) => createMediaItem('image', image.url, tapestryId)))
}

const openverseImageItemFactory: ItemFactory = async (source, _mediaType, tapestryId) => {
  if (typeof source !== 'string' || !isHTTPURL(source)) return null

  const parsed = parseOpenverseImageURL(source)
  if (!parsed) return null

  const image = await fetchOpenverseImage(parsed.id)
  if (!image) return null

  return { items: [await createMediaItem('image', image.url, tapestryId)], iaImports: [] }
}

/**
 * An Openverse tag-collection page (`openverse.org/image/collection?tag=...`) can hold many images, so -
 * like a Commons category - it's imported via the picker dialog rather than dumping every match onto the
 * canvas at once.
 */
const openverseCollectionFactory: ItemFactory = async (source, _mediaType, _tapestryId) => {
  if (typeof source !== 'string' || !isHTTPURL(source)) return null

  const parsed = parseOpenverseTagCollectionURL(source)
  if (!parsed) return null

  const result = await fetchOpenverseTagCollection(parsed.tag, { page: 1, pageSize: 1 })
  if (!result) return null

  return {
    items: [],
    iaImports: [{ type: 'OpenverseCollection', tag: parsed.tag, total: result.total }],
  }
}

const IA_MEDIA_TYPE_MAP: Partial<Record<IAMediaType, WebpageType>> = {
  audio: 'iaAudio',
  movies: 'iaVideo',
}

export async function createIAMediaItems(tapestryId: string, iaItems: IAItem[]) {
  return Promise.all(
    iaItems.map(async (iaItem) => {
      const item = await createMediaItem('webpage', iaItemEmbedURL(iaItem), tapestryId)
      item.webpageType = IA_MEDIA_TYPE_MAP[iaItem.mediaType] ?? null
      item.skipSourceResolution = true

      return item
    }),
  )
}

/**
 * Produces a deep-zoomable IIIF image item from either:
 *  - an Internet Archive item URL pointing at an image-type item (we derive its IIIF manifest), or
 *  - a direct IIIF Presentation manifest URL.
 * The manifest is resolved to its first canvas; the IIIF Image API service is stored on the item so the
 * viewer can render tiles on demand. Returns null for anything that isn't a usable IIIF image so that the
 * remaining factories (IA collections/playlists, plain webpages) can handle it.
 */
const iiifItemFactory: ItemFactory = async (source, mediaType, tapestryId) => {
  if (typeof source !== 'string' || !isHTTPURL(source)) return null

  let manifestUrl: string
  const descriptor = parseInternetArchiveURL(source)
  if (descriptor && descriptor.urlType !== 'user-list') {
    // Only handle image-type IA items here; let iaCollectionFactory deal with audio/video/collections/etc.
    if ((await getIAItemMetadata(descriptor.item.id))?.mediatype !== 'image') return null
    manifestUrl = getIAIIIFManifestURL(descriptor.item.id)
  } else if (mediaType?.includes('json') || /\/iiif\/|manifest/i.test(source)) {
    // A directly pasted IIIF manifest URL (any IIIF source, not just Internet Archive).
    manifestUrl = source
  } else {
    return null
  }

  const canvas = await fetchIIIFFirstCanvas(manifestUrl)
  if (!canvas) return null

  const item = await createMediaItem('iiif', manifestUrl, tapestryId)
  item.imageService = canvas.imageService
  // The client has already resolved the manifest and image service, so the server needn't redo it.
  item.skipSourceResolution = true

  return { items: [item], iaImports: [] }
}

const iaCollectionFactory: ItemFactory = async (source, _, tapestryId) => {
  const descriptor = parseInternetArchiveURL(source)
  if (!descriptor) return null

  if (descriptor.urlType === 'user-list') {
    return {
      items: await createIAMediaItems(tapestryId, await getUserListItems(source as string)),
      iaImports: [],
    }
  }

  const { id } = descriptor.item
  const metadata = await getIAItemMetadata(id)

  if (metadata?.mediatype === 'collection') {
    return { items: [], iaImports: [{ type: 'IACollection', metadata, id }] }
  }

  if (metadata?.mediatype === 'movies' || metadata?.mediatype === 'audio') {
    const plst = (await getIAPlaylistEntries(descriptor.item)) ?? []
    if (plst.length > 1) {
      const entries = plst.map(({ title, orig, duration }) => ({ title, filename: orig, duration }))
      return { items: [], iaImports: [{ type: 'IAPlaylist', id, metadata, entries }] }
    }
  }

  return {
    items: await createIAMediaItems(tapestryId, await getNestedIAItems(descriptor.item)),
    iaImports: [],
  }
}

const iaSearchFactory: ItemFactory = async (source, _mediaType, _tapestryId) => {
  if (typeof source !== 'string' || !isHTTPURL(source)) return null

  const parsed = parseInternetArchiveSearchURL(source)
  if (!parsed) return null

  const result = await iaAdvancedSearch({
    q: `(${parsed.query}) AND NOT mediatype:collection`,
    pageSize: 1,
    page: 1,
  })
  if (!result) return null

  return {
    items: [],
    iaImports: [{ type: 'IASearch', query: parsed.query, total: result.response.numFound }],
  }
}

const linkFileFactory: ItemFactory = async (source, _, tapestryId) => {
  if (!(source instanceof File)) {
    return null
  }

  const url = (await parseUrlFile(source)) ?? (await parseWeblocFile(source))

  if (!url) {
    return null
  }

  return parseMediaSource(url, tapestryId)
}

/**
 * A sequence of item factories that can be tried consecutively when importing a file or text to the tapestry.
 * If all of these factories fail to produce tapestry items, then the given source is of unknown format and cannot
 * be imported.
 *
 * Note that for the most part the types of sources that each factory in this array can handle, don't overlap, so
 * their order is not critically important. However, the last factory in the array acts as a kind of "catchall"
 * which creates a "webpage" item for all unhandled URLs.
 */
export const ITEM_FACTORIES: ItemFactory[] = [
  createSimpleMediaItemFactory('image', (_, mediaType) => !!mediaType?.startsWith('image/')),
  createSimpleMediaItemFactory('book', (_, mediaType) => mediaType === 'application/epub+zip'),
  createSimpleMediaItemFactory('pdf', (_, mediaType) => mediaType === 'application/pdf'),
  createSimpleMediaItemFactory('video', (_, mediaType) => !!mediaType?.startsWith('video/')),
  createSimpleMediaItemFactory('audio', (_, mediaType) => !!mediaType?.startsWith('audio/')),
  // STL has no single standard MIME type ("model/stl" and the older "application/sla" are both common,
  // and browsers frequently report neither at all for a locally-picked file), so the filename extension is
  // checked as a fallback.
  createSimpleMediaItemFactory(
    'model3d',
    (source, mediaType) =>
      mediaType === 'model/stl' ||
      mediaType === 'application/sla' ||
      (source instanceof File && source.name.toLowerCase().endsWith('.stl')),
  ),
  linkFileFactory,
  textItemFactory,
  soundcloudItemFactory,
  spotifyItemFactory,
  sketchfabItemFactory,
  wikipediaItemFactory,
  commonsFileItemFactory,
  commonsCategoryFactory,
  openverseImageItemFactory,
  openverseCollectionFactory,
  htmlFileItemFactory,
  iiifItemFactory,
  iaSearchFactory,
  iaCollectionFactory,
  webpageItemFactory,
]
