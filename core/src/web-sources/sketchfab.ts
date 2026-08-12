import { BaseWebSourceParams, WebSourceParser } from './index.js'

const SKETCHFAB_HOST = 'sketchfab.com'
const SKETCHFAB_UID_RE = /^[0-9a-f]{32}$/i

/**
 * Sketchfab's regular model pages set `X-Frame-Options: SAMEORIGIN`, so a plain webpage embed fails. It
 * instead exposes an embeddable viewer at `sketchfab.com/models/<uid>/embed` (confirmed via its oEmbed
 * endpoint), which isn't so restricted. This parser rewrites a pasted model-page URL (or a bare
 * `/models/<uid>` URL) into that embed URL.
 *
 * `parse` and `construct` are both idempotent: they accept either a page URL or an already-built embed URL,
 * because the webpage viewer re-runs `construct({ source: <stored source> })` at render time.
 */
export class SketchfabSourceParser implements WebSourceParser<'sketchfab'> {
  readonly webpageType = 'sketchfab'

  matches(url: string) {
    try {
      const { host, pathname } = new URL(url)
      const isSketchfabHost = host === SKETCHFAB_HOST || host === `www.${SKETCHFAB_HOST}`
      return Promise.resolve(isSketchfabHost && /^\/(3d-models|models)\//.test(pathname))
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
   * Resolves any Sketchfab model URL to its embed URL. A model page's path is `/3d-models/<slug>-<uid>`,
   * where `<uid>` is the last hyphen-delimited segment of the slug; a bare model URL is `/models/<uid>`
   * (optionally already suffixed with `/embed`). Returns the input unchanged if no 32-character hex uid can
   * be found.
   */
  private toEmbed(source: string): string {
    try {
      const url = new URL(source)
      const segments = url.pathname.split('/').filter(Boolean)
      const last = segments.at(-1) === 'embed' ? segments.at(-2) : segments.at(-1)
      const uid = last?.split('-').at(-1)
      return uid && SKETCHFAB_UID_RE.test(uid)
        ? `https://${SKETCHFAB_HOST}/models/${uid}/embed`
        : source
    } catch {
      return source
    }
  }
}
