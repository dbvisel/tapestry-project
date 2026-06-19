import { BaseWebSourceParams, WebSourceParser } from './index.js'

const SOUNDCLOUD_WIDGET_URL = 'https://w.soundcloud.com/player/'

/**
 * SoundCloud blocks framing of its public pages, so a plain webpage embed of a soundcloud.com URL fails.
 * Instead, SoundCloud exposes an embeddable widget player at w.soundcloud.com/player/ which accepts the
 * public track/set/user permalink via its `url` query parameter. This parser turns a pasted SoundCloud URL
 * into that widget URL.
 *
 * `parse` and `construct` are both idempotent: they accept either a public permalink or an already-built
 * widget URL, because the webpage viewer re-runs `construct({ source: <stored source>, ... })` at render
 * time (the stored source is the widget URL).
 */
export class SoundcloudSourceParser implements WebSourceParser<'soundcloud'> {
  readonly webpageType = 'soundcloud'

  matches(url: string) {
    try {
      const { host } = new URL(url)
      return Promise.resolve(host === 'soundcloud.com' || host.endsWith('.soundcloud.com'))
    } catch {
      return Promise.resolve(false)
    }
  }

  parse(source: string): BaseWebSourceParams {
    return { source: this.toPermalink(source) }
  }

  construct({ source }: BaseWebSourceParams) {
    const params = new URLSearchParams({
      url: this.toPermalink(source),
      color: '#ff5500',
      auto_play: 'false',
      hide_related: 'false',
      show_comments: 'true',
      show_user: 'true',
      show_reposts: 'false',
      show_teaser: 'true',
      visual: 'true',
    })
    return `${SOUNDCLOUD_WIDGET_URL}?${params.toString()}`
  }

  /**
   * Resolves any SoundCloud source to the public permalink the widget should play: if given a widget URL,
   * returns its inner `url` parameter; otherwise returns the permalink without its query string or hash.
   */
  private toPermalink(source: string): string {
    try {
      const url = new URL(source)
      if (url.hostname === 'w.soundcloud.com' || url.pathname.startsWith('/player')) {
        const inner = url.searchParams.get('url')
        if (inner) return inner
      }
      return `${url.origin}${url.pathname}`
    } catch {
      return source
    }
  }
}
