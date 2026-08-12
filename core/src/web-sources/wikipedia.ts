import { BaseWebSourceParams, WebSourceParser } from './index.js'

interface WikipediaSourceParams extends BaseWebSourceParams {
  lang?: string
  title?: string
}

const WIKIPEDIA_HOST_RE = /^([a-z0-9-]+)\.(m\.)?wikipedia\.org$/

/**
 * Wikipedia article pages (`<lang>.wikipedia.org/wiki/<Title>`) are recognized so their main content can be
 * fetched from the Wikipedia REST API and rendered directly, instead of framing the whole page (which carries
 * site chrome, navigation, and Wikipedia's own layout that doesn't fit well in a Tapestry item).
 *
 * Only the main article namespace is matched (a title with no `Namespace:` prefix, e.g. not
 * `Special:`/`Talk:`/`File:`), since non-article pages aren't meaningfully renderable via the summary/HTML
 * REST endpoints this parser is meant to feed.
 */
export class WikipediaSourceParser implements WebSourceParser<'wikipedia', WikipediaSourceParams> {
  readonly webpageType = 'wikipedia'

  matches(url: string) {
    return Promise.resolve(this.tryParse(url) !== null)
  }

  parse(url: string): WikipediaSourceParams {
    const parsed = this.tryParse(url)
    if (!parsed) return { source: url }

    return { source: this.toCanonicalURL(parsed.lang, parsed.title), ...parsed }
  }

  construct({ source, lang, title }: WikipediaSourceParams) {
    if (!lang || !title) return source
    return this.toCanonicalURL(lang, title)
  }

  private toCanonicalURL(lang: string, title: string) {
    return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%20/g, '_')}`
  }

  private tryParse(url: string): { lang: string; title: string } | null {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }

    const hostMatch = WIKIPEDIA_HOST_RE.exec(parsed.hostname)
    if (!hostMatch) return null
    const lang = hostMatch[1]
    if (lang === 'www') return null

    const wikiMatch = /^\/wiki\/([^/]+)$/.exec(parsed.pathname)
    const rawTitle = wikiMatch
      ? wikiMatch[1]
      : parsed.pathname === '/w/index.php' && parsed.searchParams.get('title')

    if (!rawTitle) return null

    const title = decodeURIComponent(rawTitle).replace(/_/g, ' ')
    // Restrict to the main article namespace: page titles outside it look like "Namespace:Page".
    if (/^[A-Za-z0-9_ -]+:/.test(title)) return null

    return { lang, title }
  }
}
