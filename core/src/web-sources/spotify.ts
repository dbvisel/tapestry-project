import { BaseWebSourceParams, WebSourceParser } from './index.js'

const SPOTIFY_EMBED_BASE = 'https://open.spotify.com/embed'

// The content types Spotify can embed (the first path segment of a Spotify URL).
const SPOTIFY_CONTENT_TYPES = ['track', 'album', 'playlist', 'artist', 'show', 'episode']

/**
 * Spotify's regular pages set a restrictive `frame-ancestors` CSP, so a plain webpage embed of an
 * open.spotify.com URL is blocked. Spotify instead provides an embeddable player at
 * `open.spotify.com/embed/<type>/<id>`. This parser rewrites a pasted Spotify URL into that embed URL.
 *
 * `parse` and `construct` are both idempotent (they accept a regular Spotify URL or an already-built embed
 * URL), because the webpage viewer re-runs `construct({ source: <stored source> })` at render time.
 */
export class SpotifySourceParser implements WebSourceParser<'spotify'> {
  readonly webpageType = 'spotify'

  matches(url: string) {
    try {
      const { host } = new URL(url)
      return Promise.resolve(host === 'spotify.com' || host.endsWith('.spotify.com'))
    } catch {
      return Promise.resolve(false)
    }
  }

  parse(source: string): BaseWebSourceParams {
    return { source: this.toEmbed(source) }
  }

  construct({ source }: BaseWebSourceParams) {
    return this.toEmbed(source)
  }

  /**
   * Resolves any Spotify URL to its embed URL. Tolerates an optional locale prefix (e.g. `/intl-de`) and an
   * already-present `/embed` prefix. Returns the input unchanged if it isn't a recognizable Spotify entity.
   */
  private toEmbed(source: string): string {
    try {
      const segments = new URL(source).pathname.split('/').filter(Boolean)
      if (segments[0] === 'embed') segments.shift()
      if (segments[0]?.startsWith('intl-')) segments.shift()
      const [type, id] = segments
      if (id && SPOTIFY_CONTENT_TYPES.includes(type)) {
        return `${SPOTIFY_EMBED_BASE}/${type}/${id}`
      }
      return source
    } catch {
      return source
    }
  }
}
